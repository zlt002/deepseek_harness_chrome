import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { TeamDocRecordStore } from './team-doc-record-store.mjs'
import { PmdDeliveryRecordStore } from './pmd-delivery-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from './team-knowledge-batch-record-store.mjs'
import { OfficeDocumentWriteRecordStore } from './office-document-write-record-store.mjs'
import { OfficeSpreadsheetWriteRecordStore } from './office-spreadsheet-write-record-store.mjs'

const REQUEST_TIMEOUT_MS = 15_000
// A Team Knowledge write includes navigation, editor-frame readiness, write
// readback, and restoration of the parent page. Those are legitimate browser
// operations, not a long-running knowledge retrieval. Batch and PMD delivery
// issue one Extension request per item, so this cap applies per item.
const TEAM_KNOWLEDGE_WRITE_REQUEST_TIMEOUT_MS = 120_000
const KNOWLEDGE_REQUEST_TIMEOUT_MS = 30 * 60_000
const KNOWLEDGE_CATALOG_TIMEOUT_MS = 15_000
const OFFICE_DOCUMENT_CHALLENGE_TTL_MS = 60_000
const OFFICE_DOCUMENT_MAX_RECORDS = 256
const MCP_PATH = '/mcp'
const MAX_SPREADSHEET_TOOL_RESPONSE_BYTES = 128 * 1024
const MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES = 128 * 1024
// Operations without a stable public API and operation-specific readback are
// deliberately absent. Accepting them and failing after a mutation is unsafe.
const LIGHT_DOCUMENT_OPERATIONS = ['replace', 'delete', 'format', 'title', 'set_title', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format', 'blocks_insert', 'insert_drawing', 'selection_insert', 'selection_replace', 'selection_blocks_replace']

function spreadsheetArtifactSummary(result) {
  const artifact = result?.observed?.artifact
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return result
  const { dataUrl: _dataUrl, ...artifactMetadata } = artifact
  return {
    status: result.status,
    operation: result.operation,
    requested: result.requested,
    observed: { range: result.observed?.range, verified: result.observed?.verified, artifact: artifactMetadata },
  }
}

function spreadsheetResponseSummary(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const requested = result.requested && typeof result.requested === 'object' && !Array.isArray(result.requested)
    ? Object.fromEntries(Object.entries(result.requested).filter(([key]) => !['values', 'formulas'].includes(key))) : undefined
  const observed = result.observed && typeof result.observed === 'object' && !Array.isArray(result.observed)
    ? Object.fromEntries(Object.entries(result.observed).filter(([key]) => !['values', 'formulas', 'text', 'rows'].includes(key)).map(([key, value]) => key === 'artifact' && value && typeof value === 'object' ? [key, Object.fromEntries(Object.entries(value).filter(([artifactKey]) => artifactKey !== 'dataUrl'))] : [key, value])) : undefined
  return {
    ...(typeof result.runId === 'string' ? { runId: result.runId } : {}),
    ...(typeof result.requestId === 'string' ? { requestId: result.requestId } : {}),
    ...(typeof result.generation === 'string' ? { generation: result.generation } : {}),
    ...(result.browserTarget && typeof result.browserTarget === 'object' ? { browserTarget: result.browserTarget } : {}),
    ...(typeof result.status === 'string' ? { status: result.status } : {}),
    ...(result.resource && typeof result.resource === 'object' ? { resource: result.resource } : {}),
    ...(typeof result.operation === 'string' ? { operation: result.operation } : {}),
    ...(requested ? { requested } : {}),
    ...(observed ? { observed } : {}),
  }
}

function spreadsheetToolResponse(id, structuredContent) {
  const content = spreadsheetArtifactSummary(structuredContent)
  const body = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent } }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_SPREADSHEET_TOOL_RESPONSE_BYTES) return body
  const compact = spreadsheetResponseSummary(structuredContent)
  const compactBody = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(compact) }], structuredContent: compact } }
  if (Buffer.byteLength(JSON.stringify(compactBody), 'utf8') <= MAX_SPREADSHEET_TOOL_RESPONSE_BYTES) return compactBody
  const minimal = { status: structuredContent?.status, operation: structuredContent?.operation, observed: { verified: structuredContent?.observed?.verified === true } }
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(minimal) }], structuredContent: minimal } }
}

function lightDocumentToolResponse(id, structuredContent) {
  const body = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES) return body
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Light-document result exceeds the ${MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES}-byte response limit; no payload was returned.` }], isError: true } }
}

const knowledgeSearchTool = {
  name: 'knowledge_search',
  title: 'Search knowledge base',
  description: 'Search the knowledge range selected by the user for this Harness session. The selected range and continuation identity are not model-controlled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } } },
}

const codeSearchTool = {
  name: 'code_search',
  title: 'Search code base',
  description: 'Search the code repositories selected by the user for this Harness session. The selected repositories and continuation identity are not model-controlled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } } },
}

const selectedSourceScopeTool = {
  name: 'selected_source_scope',
  title: 'Read selected source scope',
  description: 'Read the repository and knowledge names currently selected in this Harness session composer. This is a read-only echo of the session selection. It does not search, retrieve, or authorize a query. Call it from the parent session with no arguments when you need to confirm what is selected. Never ask the user to read the two composer-strip labels.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}

function validKnowledgeArguments(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.question === 'string'
    && value.question.trim().length > 0 && value.question.length <= 4000
}

function validHarnessSessionIdentity(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

function harnessIdentity(message) {
  const meta = message.params?._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const sessionId = meta['io.deepseek.harness/sessionId']
  const parentSessionId = meta['io.deepseek.harness/parentSessionId']
  if (!validHarnessSessionIdentity(sessionId) || (parentSessionId !== undefined && !validHarnessSessionIdentity(parentSessionId))) return undefined
  return { sessionId, ...(parentSessionId === undefined ? {} : { parentSessionId }) }
}

function validKnowledgeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!['complete', 'partial', 'truncated'].includes(value.status) || typeof value.answer !== 'string' || value.answer.length > 16000 || !Array.isArray(value.sources) || value.sources.length > 20) return false
  return value.sources.every((source) => source && typeof source === 'object' && !Array.isArray(source)
    && typeof source.id === 'string' && source.id.length > 0 && typeof source.title === 'string' && source.title.length > 0)
}

function validSelectedSourceScopeArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 0
}

function validSelectedSourceScopeName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function validSelectedSourceScopeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.enabled !== 'boolean' || typeof value.codeSelected !== 'boolean' || typeof value.knowledgeSelected !== 'boolean') return false
  if (!Array.isArray(value.repositories) || value.repositories.length > 50 || !value.repositories.every(validSelectedSourceScopeName)) return false
  if (!Array.isArray(value.knowledge) || value.knowledge.length > 50 || !value.knowledge.every(validSelectedSourceScopeName)) return false
  return value.codeSelected === value.repositories.length > 0 && value.knowledgeSelected === value.knowledge.length > 0
}

const browserTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['browser', 'windowId', 'tabId', 'url'],
  properties: {
    browser: { const: 'chrome' },
    windowId: { type: 'integer', minimum: 0 },
    tabId: { type: 'integer', minimum: 0 },
    url: { type: 'string', format: 'uri' },
  },
}

const officeContextSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'pageIdentity', 'documentIdentity'],
  properties: {
    status: { const: 'browser_target_verified' },
    pageIdentity: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'url'],
      properties: {
        title: { type: 'string' },
        url: { type: 'string', format: 'uri' },
      },
    },
    // The extension probes every webedit frame on both editor channels and
    // reports the best ready frame's kind and identity so the model can route
    // to office_spreadsheet / office_document without guessing from the title.
    // null means no webedit frame answered ready — not "no document exists".
    documentIdentity: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          required: ['kind', 'workbookName', 'sheetName', 'hasContent', 'webeditFrames'],
          properties: {
            kind: { enum: ['webedit_spreadsheet', 'webedit_light_document'] },
            workbookName: { type: ['string', 'null'] },
            sheetName: { type: ['string', 'null'] },
            hasContent: { type: ['boolean', 'null'] },
            webeditFrames: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      ],
    },
    primaryBrowserTarget: browserTargetSchema,
    pages: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['browserTarget', 'pageIdentity', 'documentIdentity', 'isPrimary'],
        properties: { browserTarget: browserTargetSchema, pageIdentity: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } } }, documentIdentity: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['kind', 'workbookName', 'sheetName', 'hasContent', 'webeditFrames'], properties: { kind: { enum: ['webedit_spreadsheet', 'webedit_light_document'] }, workbookName: { type: ['string', 'null'] }, sheetName: { type: ['string', 'null'] }, hasContent: { type: ['boolean', 'null'] }, webeditFrames: { type: 'integer', minimum: 1, maximum: 50 } } }] }, isPrimary: { type: 'boolean' } },
      },
    },
    unavailableBrowserTargets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'reason'], properties: { browserTarget: browserTargetSchema, reason: { const: 'closed_or_changed' } } } },
  },
}

const officeGetContextTool = {
  name: 'office_get_context',
  title: 'Get Office context',
  description: 'Read the trusted browser context bound to this Harness Run. In fixed-tab mode it returns every selected available page, marks the primary page, and reports selected pages that closed or changed. When multiple pages are returned, treat all of them as the current context and enumerate or use all of them unless the user explicitly asks only for the primary page. The model cannot select tabs. documentIdentity reports the probed WebEdit editor of each page: kind webedit_spreadsheet means call office_spreadsheet (action=selection reports the selected cells; view is only freeze/zoom), kind webedit_light_document means call office_document. A Team Knowledge light-document page can also preload a blank spreadsheet iframe; a blank spreadsheet next to a ready light document is reported as webedit_light_document, not a spreadsheet. null only means no webedit frame answered the quick probe yet, so retry office_spreadsheet context or selection rather than read as "no document" or "no selected cells".',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['runId', 'requestId', 'generation', 'browserTarget', 'officeContext'],
    properties: {
      runId: { type: 'string', minLength: 1 },
      requestId: { type: 'string', minLength: 1 },
      generation: { type: 'string', minLength: 1 },
      browserTarget: browserTargetSchema,
      officeContext: officeContextSchema,
      primaryBrowserTarget: browserTargetSchema,
      browserTargets: { type: 'array', minItems: 1, items: browserTargetSchema },
      unavailableBrowserTargets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'reason'], properties: { browserTarget: browserTargetSchema, reason: { const: 'closed_or_changed' } } } },
    },
  },
}

const cellSchema = {
  type: 'object', additionalProperties: false,
  required: ['address', 'row', 'column', 'text', 'value', 'formula'],
  properties: {
    address: { type: 'string', minLength: 1 }, row: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
    text: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] }, formula: { type: ['string', 'null'] },
  },
}

const officeReadRangeTool = {
  name: 'office_read_range',
  title: 'Read spreadsheet range',
  description: 'Read a small A1 range from the WebEdit spreadsheet in the Browser Target explicitly bound to this Harness Run. This tool never changes the document and cannot select a tab or a frame.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['range'],
    properties: { range: { type: 'string', minLength: 1, maxLength: 128, description: 'A bounded A1 range, for example Summary!A1:C10.' } },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['runId', 'requestId', 'generation', 'browserTarget', 'resource', 'range'],
    properties: {
      runId: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 }, browserTarget: browserTargetSchema,
      resource: { type: 'object', additionalProperties: false, required: ['kind', 'origin', 'workbookName', 'sheetName', 'fingerprint'], properties: { kind: { const: 'webedit_spreadsheet' }, origin: { const: 'https://webedit.midea.com' }, workbookName: { type: ['string', 'null'] }, sheetName: { type: ['string', 'null'] }, fingerprint: { type: 'string', minLength: 1, maxLength: 128 } } },
      range: { type: 'object', additionalProperties: false, required: ['address', 'rowCount', 'columnCount', 'rows'], properties: { address: { type: 'string', minLength: 1 }, rowCount: { type: 'integer', minimum: 1, maximum: 100 }, columnCount: { type: 'integer', minimum: 1, maximum: 50 }, rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['index', 'cells'], properties: { index: { type: 'integer', minimum: 1 }, cells: { type: 'array', minItems: 1, maxItems: 50, items: cellSchema } } } } } },
    },
  },
}

const officeResourceSchema = {
  type: 'object', additionalProperties: false, required: ['kind', 'origin', 'workbookName', 'sheetName', 'fingerprint'],
  properties: { kind: { const: 'webedit_spreadsheet' }, origin: { const: 'https://webedit.midea.com' }, workbookName: { type: ['string', 'null'] }, sheetName: { type: ['string', 'null'] }, fingerprint: { type: 'string', minLength: 1, maxLength: 128 } },
}

const officeWriteRangeTool = {
  name: 'office_write_range', title: 'Write spreadsheet range',
  description: 'Write one bounded rectangular A1 range in the exact WebEdit spreadsheet previously read from this Browser Target. Requires user approval in clients that honor MCP destructive tool annotations; it never selects a tab or frame.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['range', 'values', 'resource'],
    properties: { range: { type: 'string', minLength: 1, maxLength: 128 }, values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: ['string', 'number', 'boolean', 'null'] } } }, resource: officeResourceSchema },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['runId', 'requestId', 'generation', 'browserTarget', 'resource', 'requested', 'observed'],
    properties: { runId: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 }, browserTarget: browserTargetSchema, resource: officeResourceSchema, requested: { type: 'object' }, observed: { type: 'object' } },
  },
}

// A single dispatch tool keeps light-document operations out of the spreadsheet
// A1 surface.  The extension owns the document-specific adapter; the model can
// neither pick a tab/frame nor provide a browser identity.
const lightDocumentResourceSchema = {
  type: 'object', additionalProperties: false, required: ['kind', 'origin', 'documentName', 'fingerprint'],
  properties: {
    kind: { const: 'webedit_light_document' }, origin: { const: 'https://webedit.midea.com' },
    documentName: { type: ['string', 'null'] }, fingerprint: { type: 'string', minLength: 1, maxLength: 128 },
  },
}

const officeDocumentTool = {
  name: 'office_document', title: 'Read or edit light document',
  description: 'Legacy dispatch for a bound WebEdit light document, never a spreadsheet. For selected-content optimization and replacement, prefer light_document_selection_read plus light_document_selection_replace_preview/commit: those flat tools prevent parameter guessing and preserve the approved structured payload. This dispatch remains for insert/delete/format and existing callers. Every write is bound to the Browser Target, resource fingerprint, one-time approval, and same-target readback.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { enum: ['read', 'search', 'selection', 'inspect_write', 'write'] },
      offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, query: { type: 'string', minLength: 1, maxLength: 500 },
      challenge: { type: 'string', minLength: 1 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 },
      operation: { enum: LIGHT_DOCUMENT_OPERATIONS }, payload: { type: 'object', additionalProperties: true },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: true,
    required: ['runId', 'requestId', 'generation', 'browserTarget', 'resource'],
    properties: {
      runId: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 }, browserTarget: browserTargetSchema,
      resource: lightDocumentResourceSchema, status: { enum: ['ok', 'verified_write'] }, document: { type: 'object' }, requested: { type: 'object' }, observed: { type: 'object' }, challenge: { type: 'string' },
    },
  },
}

const lightDocumentBlockSchema = { type: 'object', additionalProperties: false, properties: {
  type: { enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol', 'table', 'codeblock'] },
  text: { type: 'string', maxLength: 20000 }, markdown: { type: 'string', maxLength: 20000 }, html: { type: 'string', maxLength: 20000 },
  items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 20000 } },
  rows: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 2000 } } },
  language: { type: 'string', minLength: 1, maxLength: 32 },
} }
const lightDocumentReadTool = {
  name: 'light_document_read', title: 'Read light document',
  description: 'Read a bounded page of the light document on this Browser Target. No target, tab, frame, or resource is model-controlled.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
}
const lightDocumentSelectionReadTool = {
  name: 'light_document_selection_read', title: 'Read selected light-document content',
  description: 'Read the current light-document selection and its stable fingerprint. Use immediately before preparing a replacement.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}
const lightDocumentSelectionReplacePreviewTool = {
  name: 'light_document_selection_replace_preview', title: 'Preview selected-content replacement',
  description: 'Preview a rich replacement for the current complete multi-block selection. Supply only the desired blocks. This reads the selection, binds its fingerprint, checks the Browser Target, and returns a one-time approval challenge. It does not write.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['blocks'], properties: { blocks: { type: 'array', minItems: 1, maxItems: 50, items: lightDocumentBlockSchema } } },
}
const lightDocumentSelectionReplaceCommitTool = {
  name: 'light_document_selection_replace_commit', title: 'Commit approved selected-content replacement',
  description: 'After user approval, commit exactly the structured replacement captured by preview. This tool intentionally accepts only the one-time challenge: the approved body and internal write identity are not model-controlled. On any failure, stop and report the exact error; do not retry through office_document or blocks_batch_edit. Success requires an atomic write and same-target structural readback.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['challenge'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 } } },
}

const officeSpreadsheetTool = {
  name: 'office_spreadsheet', title: 'Read or edit spreadsheet',
  description: 'Use only for a bound WebEdit spreadsheet. Reads return bounded context, the current selection, the used range, ranges, searches, or sheet lists. action=selection is AccrUI webedit_get_selection: it returns address, rowsCount, columnsCount, value2, and the active cell even when view.supported is false. action=used_range is AccrUI webedit_get_used_range. Do not treat view.supported=false as "no selection". office_get_context documentIdentity=null only means no webedit frame answered the quick probe; retry office_spreadsheet context or selection instead of telling the user the editor is missing. Any mutation first obtains a one-time inspect_write challenge; its operation, payload, Browser Target, and workbook fingerprint are revalidated and the same frame is read back.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['context', 'selection', 'used_range', 'range', 'range_features', 'search', 'sheets', 'defined_names', 'capabilities', 'view', 'print_settings', 'outline', 'dimensions', 'special_cells', 'inspect_write', 'write'] }, range: { type: 'string', minLength: 1, maxLength: 128 }, axis: { enum: ['row', 'column'] }, kind: { enum: ['blanks', 'constants', 'formulas', 'lastCell', 'visible'] }, sheetName: { type: 'string', minLength: 1, maxLength: 120 }, query: { type: 'string', minLength: 1, maxLength: 500 }, matchCase: { type: 'boolean' }, matchEntireCell: { type: 'boolean' }, searchBy: { enum: ['value', 'text', 'formula'] }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    challenge: { type: 'string', minLength: 1 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 }, resource: officeResourceSchema,
    operation: { enum: ['set_values', 'set_formula', 'clear', 'format', 'merge', 'unmerge', 'row_height', 'column_width', 'fill_range', 'batch_write', 'sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_conditional_format', 'clear_conditional_formats', 'set_zoom', 'set_freeze_panes', 'set_print_settings', 'set_outline_group', 'set_rows_hidden', 'set_columns_hidden', 'auto_fit', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'move_range', 'create_defined_name', 'delete_defined_name', 'activate_worksheet', 'move_worksheet', 'set_worksheet_visibility'] }, payload: { type: 'object', additionalProperties: true },
  } },
}

const teamDocCreateTool = {
  name: 'team_doc_create', title: 'Create Team Knowledge light document',
  description: 'Browser-authenticated and self-contained: inspect the bound Chrome Team Knowledge parent, then create exactly one approved light document with readback verification. Do not call local midea-knowledge auth.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['phase'], properties: { phase: { enum: ['inspect', 'create'] }, challenge: { type: 'string' }, idempotencyIdentity: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' } } },
}

const teamKnowledgeItemTool = {
  name: 'team_knowledge_item', title: 'Create or verify one Team Knowledge spreadsheet',
  description: 'Legacy compatibility endpoint retained for existing callers. It is not model-facing; models use the flat team_knowledge_spreadsheet_* tools for a spreadsheet or team_knowledge_batch_* tools for light documents.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', oneOf: [
    { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { const: 'inspect_parent' } } },
    { type: 'object', additionalProperties: false, required: ['action', 'parentFingerprint', 'kind', 'name', 'body'], properties: { action: { const: 'preview' }, parentFingerprint: { type: 'string', minLength: 1, maxLength: 256 }, kind: { const: 'spreadsheet' }, name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 100000 } } },
    { type: 'object', additionalProperties: false, required: ['action', 'challenge', 'idempotencyIdentity', 'kind', 'name', 'body'], properties: { action: { const: 'create' }, challenge: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 }, kind: { const: 'spreadsheet' }, name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 100000 } } },
    { type: 'object', additionalProperties: false, required: ['action', 'kind', 'catalogId'], properties: { action: { const: 'readback' }, kind: { const: 'spreadsheet' }, catalogId: { type: 'string', pattern: '^\\d+$' } } },
  ] },
}

const teamKnowledgeSpreadsheetPreviewTool = {
  name: 'team_knowledge_spreadsheet_preview', title: 'Preview one Team Knowledge spreadsheet',
  description: 'Preview one named Team Knowledge spreadsheet in the current bound parent. This checks the parent and returns a one-time approval challenge. Do not create it in this step.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 100000 } } },
}

const teamKnowledgeSpreadsheetCreateTool = {
  name: 'team_knowledge_spreadsheet_create', title: 'Create the approved Team Knowledge spreadsheet',
  description: 'After explicit approval, create exactly the previewed Team Knowledge spreadsheet using its challenge, idempotency identity, name, and unchanged body. Success requires business success, same-parent catalog rediscovery, and spreadsheet identity readback.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['challenge', 'idempotencyIdentity', 'name', 'body'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 100000 } } },
}

const teamKnowledgeSpreadsheetReadbackTool = {
  name: 'team_knowledge_spreadsheet_readback', title: 'Read a created Team Knowledge spreadsheet identity',
  description: 'Read back the verified identity of one Team Knowledge spreadsheet by catalog ID.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['catalogId'], properties: { catalogId: { type: 'string', pattern: '^\\d+$' } } },
}

const teamKnowledgeBatchItemSchema = { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 100000 } } }

// Kept callable for existing integrations. It is deliberately not returned by
// tools/list because Harness currently ignores oneOf branches when forming the
// model-visible argument surface.
const teamKnowledgeBatchTool = {
  name: 'team_knowledge_batch', title: 'Create a batch of Team Knowledge light documents',
  description: 'Legacy compatibility endpoint retained for existing callers. It is not model-facing; models use team_knowledge_batch_preview, team_knowledge_batch_create, and team_knowledge_batch_status.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', oneOf: [
    { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { const: 'inspect_parent' } } },
    { type: 'object', additionalProperties: false, required: ['action', 'batchId', 'parentFingerprint', 'items'], properties: { action: { const: 'preview' }, batchId: { type: 'string', minLength: 1, maxLength: 128 }, parentFingerprint: { type: 'string', minLength: 1, maxLength: 256 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } },
    { type: 'object', additionalProperties: false, required: ['action', 'batchId', 'challenge', 'items'], properties: { action: { const: 'create' }, batchId: { type: 'string', minLength: 1, maxLength: 128 }, challenge: { type: 'string', minLength: 1, maxLength: 256 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } },
    { type: 'object', additionalProperties: false, required: ['action', 'batchId'], properties: { action: { const: 'status' }, batchId: { type: 'string', minLength: 1, maxLength: 128 } } },
  ] },
}

const teamKnowledgeBatchPreviewTool = {
  name: 'team_knowledge_batch_preview', title: 'Preview one to ten Team Knowledge light documents',
  description: 'The first step for one to ten light documents. Provide a stable batchId and the exact ordered names and bodies. This inspects the currently bound parent itself and returns its fingerprint plus a one-time approval challenge. Do not create documents in this step.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'items'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } },
}

const teamKnowledgeBatchCreateTool = {
  name: 'team_knowledge_batch_create', title: 'Create the approved Team Knowledge light-document batch',
  description: 'After explicit approval, provide the batchId, preview challenge, and the unchanged ordered items. The parent is rechecked and every item is created only after business success, same-parent catalog rediscovery, and WebEdit readback. Reuse the same batchId to resume unfinished items.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'challenge', 'items'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, challenge: { type: 'string', minLength: 1, maxLength: 256 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } },
}

const teamKnowledgeBatchStatusTool = {
  name: 'team_knowledge_batch_status', title: 'Read Team Knowledge batch delivery status',
  description: 'Read the current status of a previously previewed or created light-document batch. Provide only its batchId.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['batchId'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 } } },
}

const pmdPrdDeliveryTool = {
  name: 'pmd_prd_delivery', title: 'Deliver the two approved PMD documents',
  description: 'Fixed two-document delivery for /pmd-prd. Inspect the bound Team Knowledge parent, preview exactly the approved analysis and PRD light documents, obtain explicit user confirmation, then create or resume only unfinished items with persistent readback evidence.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { enum: ['inspect_parent', 'preview', 'create', 'status'] },
      requirementId: { type: 'string', minLength: 1, maxLength: 64 },
      deliveryRunId: { type: 'string', minLength: 1, maxLength: 80 },
      parentFingerprint: { type: 'string', minLength: 1, maxLength: 256 },
      challenge: { type: 'string', minLength: 1, maxLength: 256 },
      documents: {
        type: 'array', minItems: 2, maxItems: 2,
        items: { type: 'object', additionalProperties: false, required: ['kind', 'name', 'body'], properties: {
          kind: { enum: ['analysis', 'prd'] }, name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 100000 },
        } },
      },
    },
  },
}

const pageIdentitySchema = {
  type: 'object', additionalProperties: false, required: ['title', 'url'],
  properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } },
}

const browserOpenTabTool = {
  name: 'browser_open_tab',
  title: 'Open Browser tab',
  description: 'Open a URL in Chrome and explicitly transfer the trusted Browser Target to this Harness Run.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: { url: { type: 'string', format: 'uri', minLength: 1 } },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['runId', 'requestId', 'generation', 'browserTarget', 'pageIdentity'],
    properties: {
      runId: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1 }, generation: { type: 'string', minLength: 1 },
      browserTarget: browserTargetSchema, pageIdentity: pageIdentitySchema,
    },
  },
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function validBrowserTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value
  return Object.keys(target).length === 4
    && target.browser === 'chrome'
    && Number.isInteger(target.windowId) && target.windowId >= 0
    && Number.isInteger(target.tabId) && target.tabId >= 0
    && typeof target.url === 'string' && target.url.length > 0
}

function sameBrowserTarget(left, right) {
  return validBrowserTarget(left)
    && validBrowserTarget(right)
    && left.browser === right.browser
    && left.windowId === right.windowId
    && left.tabId === right.tabId
    && left.url === right.url
}

function validUnavailableBrowserTarget(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && value.reason === 'closed_or_changed'
    && validBrowserTarget(value.browserTarget)
}

function sameBrowserTargetList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((target, index) => sameBrowserTarget(target, right[index]))
}

function sameUnavailableBrowserTargetList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((item, index) => item.reason === right[index]?.reason && sameBrowserTarget(item.browserTarget, right[index]?.browserTarget))
}

function validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets) {
  const targets = browserTargets ?? [browserTarget]
  const unavailable = unavailableBrowserTargets ?? []
  return validBrowserTarget(browserTarget)
    && Array.isArray(targets) && targets.length > 0 && targets.every(validBrowserTarget)
    && targets.some((target) => sameBrowserTarget(target, browserTarget))
    && new Set(targets.map((target) => `${target.windowId}:${target.tabId}:${target.url}`)).size === targets.length
    && Array.isArray(unavailable) && unavailable.every(validUnavailableBrowserTarget)
}

function validOfficeDocumentIdentity(value) {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 5
    && (value.kind === 'webedit_spreadsheet' || value.kind === 'webedit_light_document')
    && (typeof value.workbookName === 'string' || value.workbookName === null)
    && (typeof value.sheetName === 'string' || value.sheetName === null)
    && (typeof value.hasContent === 'boolean' || value.hasContent === null)
    && Number.isInteger(value.webeditFrames) && value.webeditFrames >= 1 && value.webeditFrames <= 50
}

function validOfficeContext(value, browserTarget) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!(Object.keys(value).length === 3 || Object.keys(value).length === 6)) return false
  if (!(value.status === 'browser_target_verified'
    && validOfficeDocumentIdentity(value.documentIdentity)
    && value.pageIdentity !== null && typeof value.pageIdentity === 'object' && !Array.isArray(value.pageIdentity)
    && Object.keys(value.pageIdentity).length === 2
    && typeof value.pageIdentity.title === 'string'
    && value.pageIdentity.url === browserTarget.url)) return false
  if (Object.keys(value).length === 3) return true
  return validBrowserTarget(value.primaryBrowserTarget)
    && sameBrowserTarget(value.primaryBrowserTarget, browserTarget)
    && Array.isArray(value.pages) && value.pages.length > 0
    && value.pages.every((page) => page && typeof page === 'object' && !Array.isArray(page)
      && Object.keys(page).length === 4 && validBrowserTarget(page.browserTarget)
      && page.pageIdentity && typeof page.pageIdentity === 'object' && !Array.isArray(page.pageIdentity)
      && Object.keys(page.pageIdentity).length === 2 && typeof page.pageIdentity.title === 'string'
      && page.pageIdentity.url === page.browserTarget.url && validOfficeDocumentIdentity(page.documentIdentity) && typeof page.isPrimary === 'boolean')
    && value.pages.filter((page) => page.isPrimary).length === 1
    && value.pages.some((page) => page.isPrimary && sameBrowserTarget(page.browserTarget, browserTarget))
    && Array.isArray(value.unavailableBrowserTargets) && value.unavailableBrowserTargets.every(validUnavailableBrowserTarget)
}

function validOfficeGetContextOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!(Object.keys(value).length === 5 || Object.keys(value).length === 8)) return false
  if (!(typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.generation === 'string' && value.generation.length > 0
    && validBrowserTarget(value.browserTarget)
    && validOfficeContext(value.officeContext, value.browserTarget))) return false
  if (Object.keys(value).length === 5) return true
  return typeof value.runId === 'string' && value.runId.length > 0
    && validBrowserTarget(value.primaryBrowserTarget)
    && sameBrowserTarget(value.primaryBrowserTarget, value.browserTarget)
    && validBrowserTargetSet(value.browserTarget, value.browserTargets, value.unavailableBrowserTargets)
}

function validOfficeGetContextArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 0
}

function validOfficeReadRangeArguments(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.range === 'string'
    && value.range.trim().length > 0 && value.range.length <= 128
}

function validOfficeReadRangeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || value.status !== 'ok') return false
  const resource = value.resource
  const range = value.range
  if (!resource || typeof resource !== 'object' || Array.isArray(resource) || Object.keys(resource).length !== 5
    || resource.kind !== 'webedit_spreadsheet' || resource.origin !== 'https://webedit.midea.com'
    || !(typeof resource.workbookName === 'string' || resource.workbookName === null)
    || !(typeof resource.sheetName === 'string' || resource.sheetName === null)
    || typeof resource.fingerprint !== 'string' || resource.fingerprint.length === 0 || resource.fingerprint.length > 128) return false
  if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).length !== 4
    || typeof range.address !== 'string' || range.address.length === 0
    || !Number.isInteger(range.rowCount) || range.rowCount < 1 || range.rowCount > 100
    || !Number.isInteger(range.columnCount) || range.columnCount < 1 || range.columnCount > 50
    || !Array.isArray(range.rows) || range.rows.length !== range.rowCount) return false
  return range.rows.every((row, rowOffset) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === 2 && row.index === rowOffset + 1 && Array.isArray(row.cells) && row.cells.length === range.columnCount
    && row.cells.every((cell, columnOffset) => cell && typeof cell === 'object' && !Array.isArray(cell)
      && Object.keys(cell).length === 6 && typeof cell.address === 'string' && cell.address.length > 0
      && cell.row === row.index && cell.column === columnOffset + 1 && typeof cell.text === 'string'
      && (typeof cell.value === 'string' || typeof cell.value === 'number' || typeof cell.value === 'boolean' || cell.value === null)
      && (typeof cell.formula === 'string' || cell.formula === null)))
}

function validOfficeReadRangeOutput(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 6
    && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.generation === 'string' && value.generation.length > 0 && validBrowserTarget(value.browserTarget)
    && validOfficeReadRangeResult({ status: 'ok', resource: value.resource, range: value.range })
}

function validOfficeResource(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 5
    && value.kind === 'webedit_spreadsheet' && value.origin === 'https://webedit.midea.com'
    && (typeof value.workbookName === 'string' || value.workbookName === null)
    && (typeof value.sheetName === 'string' || value.sheetName === null)
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0 && value.fingerprint.length <= 128
}
function sameOfficeResource(left, right) {
  return validOfficeResource(left) && validOfficeResource(right)
    && left.kind === right.kind && left.origin === right.origin && left.workbookName === right.workbookName && left.sheetName === right.sheetName && left.fingerprint === right.fingerprint
}

function validOfficeWriteRangeArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || typeof value.range !== 'string' || value.range.trim().length === 0 || value.range.length > 128 || !validOfficeResource(value.resource)) return false
  if (!Array.isArray(value.values) || value.values.length === 0 || value.values.length > 100) return false
  const width = Array.isArray(value.values[0]) ? value.values[0].length : 0
  return width > 0 && width <= 50 && value.values.every((row) => Array.isArray(row) && row.length === width
    && row.every((cell) => typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean' || cell === null))
}

function validOfficeWriteRangeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || value.status !== 'verified_write' || !validOfficeResource(value.resource)) return false
  const requested = value.requested; const observed = value.observed
  return requested && observed && typeof requested === 'object' && typeof observed === 'object' && !Array.isArray(requested) && !Array.isArray(observed)
    && Object.keys(requested).length === 2 && Object.keys(observed).length === 2 && typeof requested.range === 'string' && requested.range.length > 0
    && observed.range === requested.range && Array.isArray(requested.values) && Array.isArray(observed.values)
    && JSON.stringify(requested.values) === JSON.stringify(observed.values)
}

function validOfficeWriteRangeOutput(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 7
    && typeof value.runId === 'string' && value.runId.length > 0 && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.generation === 'string' && value.generation.length > 0 && validBrowserTarget(value.browserTarget)
    && validOfficeWriteRangeResult({ status: 'verified_write', resource: value.resource, requested: value.requested, observed: value.observed })
}

function validLightDocumentResource(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4
    && value.kind === 'webedit_light_document' && value.origin === 'https://webedit.midea.com'
    && (typeof value.documentName === 'string' || value.documentName === null)
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0 && value.fingerprint.length <= 128
}

function officeDocumentArgumentsHint(args) {
  const action = args && typeof args === 'object' && !Array.isArray(args) ? args.action : undefined
  if (action === 'inspect_write') {
    if (typeof args.operation !== 'string' || !args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
      return 'office_document inspect_write requires the final operation and payload. For an empty document, first call selection, then inspect_write with operation=selection_insert and payload {text|markdown|html, expectedSelectionFingerprint} from that selection read.'
    }
    if ((args.operation === 'selection_insert' || args.operation === 'selection_replace') && selectionInsertFragments(args.payload) === null) {
      return `office_document ${args.operation} requires exactly one of text/markdown/html plus expectedSelectionFingerprint from a prior selection read; inspect_write and write must reuse that exact payload.`
    }
    if (args.operation === 'insert_drawing' && lightDocumentInsertFragments('insert_drawing', args.payload) === null) {
      return 'office_document insert_drawing requires mermaid source (flowchart, sequenceDiagram, or pie) and optional position start/end/before/after; before/after also need id or index.'
    }
    if (args.operation === 'blocks_insert' && lightDocumentInsertFragments('blocks_insert', args.payload) === null) {
      return 'office_document blocks_insert requires payload.blocks of h1-h6/p/blockquote/ul/ol/table/codeblock items and optional position start/end/before/after; before/after also need id or index.'
    }
    return 'office_document inspect_write requires a supported operation and the exact final payload that write will reuse; extra keys and preview payloads are rejected.'
  }
  if (action === 'write') return 'office_document write requires challenge, idempotencyIdentity, operation, and the same payload approved by inspect_write.'
  if (action === 'search') return 'office_document search requires a non-empty query'
  return 'office_document requires a bounded read/search/selection action, or a challenged verified write'
}

function validOfficeDocumentArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') return false
  const keys = Object.keys(value)
  const validPayload = value.payload === undefined || (value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000)
  if (value.action === 'read') return keys.every((key) => ['action', 'offset', 'limit', 'payload'].includes(key))
    && (value.offset === undefined || (Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000))
    && (value.limit === undefined || (Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)) && validPayload
  if (value.action === 'search') return keys.every((key) => ['action', 'query', 'offset', 'limit'].includes(key))
    && typeof value.query === 'string' && value.query.trim().length > 0 && value.query.length <= 500
    && (value.offset === undefined || (Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000))
    && (value.limit === undefined || (Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200))
  if (value.action === 'selection') return keys.every((key) => ['action', 'payload'].includes(key)) && validPayload
  if (value.action === 'inspect_write') return keys.length === 3 && typeof value.operation === 'string' && LIGHT_DOCUMENT_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000
    && validLightDocumentOperationPayload(value.operation, value.payload)
  if (value.action !== 'write' || keys.length !== 5) return false
  return typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
    && typeof value.idempotencyIdentity === 'string' && value.idempotencyIdentity.length > 0 && value.idempotencyIdentity.length <= 128
    && LIGHT_DOCUMENT_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    && JSON.stringify(value.payload).length <= 100000 && validLightDocumentOperationPayload(value.operation, value.payload)
}

function validFlatLightDocumentArguments(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (name === 'light_document_read') return keys.every((key) => ['offset', 'limit'].includes(key))
    && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
  if (name === 'light_document_selection_read') return keys.length === 0
  if (name === 'light_document_selection_replace_preview') return keys.length === 1 && selectionBlocksReplaceFragments({ blocks: value.blocks, expectedSelectionFingerprint: 'selection-v3-00000000' }) !== null
  return name === 'light_document_selection_replace_commit' && keys.length === 1
    && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
}

function validOfficeDocumentReadResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'ok'
    && validLightDocumentResource(value.resource) && value.document && typeof value.document === 'object' && !Array.isArray(value.document)
}

function validOfficeDocumentWriteResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'verified_write'
    && validLightDocumentResource(value.resource) && value.requested && typeof value.requested === 'object'
    && value.observed && typeof value.observed === 'object'
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function lightDocumentWriteHash(operation, payload) { return createHash('sha256').update(canonicalJson({ operation, payload })).digest('hex') }
function sameLightDocumentTarget(left, right) {
  return validLightDocumentResource(left) && validLightDocumentResource(right)
    && left.kind === right.kind && left.origin === right.origin && left.documentName === right.documentName
}
function lightDocumentBatchItems(operation, payload) {
  if (!['blocks_delete', 'blocks_format'].includes(operation)) return null
  const source = Array.isArray(payload?.blocks) ? payload.blocks
    : operation === 'blocks_delete' && Array.isArray(payload?.deletions) ? payload.deletions
      : operation === 'blocks_delete' && Array.isArray(payload?.ids) ? payload.ids.map((id) => ({ id }))
        : operation === 'blocks_format' && Array.isArray(payload?.formats) ? payload.formats
          : [payload]
  if (source.length < 1 || source.length > 50) return null
  const seen = new Set(); const items = []
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || item.id.length > 256 || seen.has(item.id)) return null
    seen.add(item.id)
    if (operation === 'blocks_delete') { items.push({ id: item.id }); continue }
    const style = item.style ?? payload?.style
    if (!style || typeof style !== 'object' || Array.isArray(style) || Object.keys(style).length < 1 || !Object.keys(style).every((key) => ['bold', 'italic', 'blockType'].includes(key))) return null
    if ((style.bold !== undefined && typeof style.bold !== 'boolean') || (style.italic !== undefined && typeof style.italic !== 'boolean') || (style.blockType !== undefined && (typeof style.blockType !== 'string' || !/^(p|h[1-6]|li|blockquote|pre|codeBlock)$/i.test(style.blockType)))) return null
    items.push({ id: item.id, style: { ...(style.bold === undefined ? {} : { bold: style.bold }), ...(style.italic === undefined ? {} : { italic: style.italic }), ...(style.blockType === undefined ? {} : { blockType: style.blockType.toLowerCase() }) } })
  }
  return items
}
function distinctiveLightDocumentFragments(value) {
  const plain = String(value ?? '')
    .replace(/```[\w-]*\n?/g, ' ')
    .replace(/\[[ xX]\]/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_#>~\-|:]/g, ' ')
  return [...new Set(plain.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((part) => part.length >= 2).slice(0, 100)
}
function lightDocumentStructuredBlockValid(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const type = String(item.type ?? item.blockType ?? '').toLowerCase()
  if (!/^(h[1-6]|p|blockquote|ul|ol|table|codeblock)$/.test(type)) return false
  const text = typeof item.text === 'string' ? item.text : typeof item.markdown === 'string' ? item.markdown : ''
  const html = typeof item.html === 'string' ? item.html : ''
  const language = item.language === undefined ? undefined : String(item.language)
  if (language !== undefined && (language.length < 1 || language.length > 32 || !/^[a-z0-9_+#.-]+$/i.test(language))) return false
  if (type === 'ul' || type === 'ol') {
    const list = Array.isArray(item.items) ? item.items : text ? text.split('\n') : []
    return list.length >= 1 && list.length <= 50 && list.every((line) => typeof line === 'string' && line.trim() && line.length <= 20_000)
  }
  if (type === 'table') {
    const rows = Array.isArray(item.rows) ? item.rows : text ? text.split('\n').map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean)) : []
    return rows.length >= 1 && rows.length <= 30 && rows.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 12 && row.every((cell) => typeof cell === 'string' && cell.length <= 2_000))
  }
  return !!(text.trim() || html.trim()) && text.length <= 20_000 && html.length <= 20_000
}
function lightDocumentStructuredBlockText(item) {
  if (Array.isArray(item?.items)) return item.items.filter((line) => typeof line === 'string').join('\n')
  if (Array.isArray(item?.rows)) return item.rows.flat().filter((cell) => typeof cell === 'string').join('\n')
  if (typeof item?.text === 'string') return item.text
  if (typeof item?.markdown === 'string') return item.markdown
  if (typeof item?.html === 'string') return item.html.replace(/<[^>]*>/g, ' ')
  return ''
}
function lightDocumentInsertFragments(operation, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const position = payload.position === undefined ? 'end' : payload.position
  if (!['start', 'end', 'before', 'after'].includes(position)) return null
  if ((position === 'before' || position === 'after') && !(typeof payload.id === 'string' && payload.id) && !Number.isInteger(payload.index)) return null
  const allowed = operation === 'insert_drawing' ? ['mermaid', 'position', 'id', 'index'] : ['blocks', 'position', 'id', 'index']
  if (!Object.keys(payload).every((key) => allowed.includes(key))) return null
  if (operation === 'insert_drawing') {
    if (typeof payload.mermaid !== 'string' || !payload.mermaid.trim() || payload.mermaid.length > 20_000) return null
    const fragments = distinctiveLightDocumentFragments(payload.mermaid)
    return fragments.length ? { kind: 'mermaid', fragments, position } : null
  }
  if (!Array.isArray(payload.blocks) || payload.blocks.length < 1 || payload.blocks.length > 50 || !payload.blocks.every(lightDocumentStructuredBlockValid)) return null
  const fragments = distinctiveLightDocumentFragments(payload.blocks.map(lightDocumentStructuredBlockText).join('\n'))
  return fragments.length ? { kind: 'blocks', fragments, position } : null
}
function selectionInsertFragments(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const kinds = ['markdown', 'html', 'text'].filter((key) => typeof payload[key] === 'string')
  if (kinds.length !== 1 || !Object.keys(payload).every((key) => ['markdown', 'html', 'text', 'insertBelow', 'expectedSelectionFingerprint'].includes(key))) return null
  const kind = kinds[0]; const value = payload[kind]
  if (!value.trim() || value.length > 20_000 || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v3-[0-9a-f]{8}$/.test(payload.expectedSelectionFingerprint) || (payload.insertBelow !== undefined && typeof payload.insertBelow !== 'boolean')) return null
  const fragments = distinctiveLightDocumentFragments(kind === 'html' ? value.replace(/<[^>]*>/g, ' ') : value)
  return fragments.length ? { kind, fragments } : null
}
function selectionBlocksReplaceFragments(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Object.keys(payload).every((key) => ['blocks', 'expectedSelectionFingerprint'].includes(key))
    || !Array.isArray(payload.blocks) || payload.blocks.length < 1 || payload.blocks.length > 50
    || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v3-[0-9a-f]{8}$/.test(payload.expectedSelectionFingerprint)
    || !payload.blocks.every(lightDocumentStructuredBlockValid)) return null
  const fragments = distinctiveLightDocumentFragments(payload.blocks.map(lightDocumentStructuredBlockText).join('\n'))
  return fragments.length ? { fragments } : null
}
function validLightDocumentOperationPayload(operation, payload) {
  if (operation === 'selection_insert' || operation === 'selection_replace') return selectionInsertFragments(payload) !== null
  if (operation === 'selection_blocks_replace') return selectionBlocksReplaceFragments(payload) !== null
  if (operation === 'insert_drawing' || operation === 'blocks_insert') return lightDocumentInsertFragments(operation, payload) !== null
  return !['blocks_delete', 'blocks_format'].includes(operation) || lightDocumentBatchItems(operation, payload) !== null
}
function verifiedFragmentEvidence(request, result, requested) {
  const observed = result.observed
  if (!requested || !Array.isArray(observed?.verifiedFragments) || !Array.isArray(observed?.fragmentEvidence) || !Array.isArray(observed?.observedBlocks)) return false
  if (canonicalJson(observed.verifiedFragments) !== canonicalJson(requested.fragments) || observed.fragmentEvidence.length !== requested.fragments.length || observed.observedBlocks.length < 1) return false
  return observed.fragmentEvidence.every((evidence, index) => evidence && evidence.fragment === requested.fragments[index] && Array.isArray(evidence.blockIds) && evidence.blockIds.length > 0)
}
function verifiedLightDocumentWriteMatches(result, request) {
  const matchesRequest = validOfficeDocumentWriteResult(result) && result.requested?.operation === request.operation
    && canonicalJson(result.requested?.payload) === canonicalJson(request.payload)
    && result.observed?.verified === true && sameLightDocumentTarget(result.resource, request.resource)
  if (!matchesRequest) return false
  if (request.operation === 'selection_insert' || request.operation === 'selection_replace') return verifiedFragmentEvidence(request, result, selectionInsertFragments(request.payload))
  if (request.operation === 'selection_blocks_replace') {
    const requested = selectionBlocksReplaceFragments(request.payload)
    return verifiedFragmentEvidence(request, result, requested)
      && Array.isArray(result.observed?.replacedTagIds) && result.observed.replacedTagIds.length >= 1
      && Array.isArray(result.observed?.observedBlocks) && result.observed.observedBlocks.length >= 1
  }
  if (request.operation === 'insert_drawing' || request.operation === 'blocks_insert') return verifiedFragmentEvidence(request, result, lightDocumentInsertFragments(request.operation, request.payload))
  if (!['blocks_delete', 'blocks_format'].includes(request.operation)) return true
  const expected = lightDocumentBatchItems(request.operation, request.payload); const observed = result.observed?.verifiedBlocks
  if (!expected || result.requested?.count !== expected.length || !Array.isArray(observed) || observed.length !== expected.length) return false
  return expected.every((item, index) => request.operation === 'blocks_delete'
    ? observed[index]?.id === item.id && observed[index]?.deleted === true
    : observed[index]?.id === item.id && canonicalJson(observed[index]?.style) === canonicalJson(item.style) && typeof observed[index]?.text === 'string' && typeof observed[index]?.type === 'string'
      && (item.style.blockType === undefined || observed[index].type === item.style.blockType))
}
const SPREADSHEET_OPERATIONS = ['set_values', 'set_formula', 'clear', 'format', 'merge', 'unmerge', 'row_height', 'column_width', 'fill_range', 'batch_write', 'sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_conditional_format', 'clear_conditional_formats', 'set_zoom', 'set_freeze_panes', 'set_print_settings', 'set_outline_group', 'set_rows_hidden', 'set_columns_hidden', 'auto_fit', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'move_range', 'create_defined_name', 'delete_defined_name', 'activate_worksheet', 'move_worksheet', 'set_worksheet_visibility']
const SPREADSHEET_VALIDATION_TYPES = { wholeNumber: 1, decimal: 2, list: 3, date: 4, time: 5, textLength: 6, custom: 7 }
const SPREADSHEET_VALIDATION_ALERT_STYLES = { stop: 1, warning: 2, information: 3 }
const SPREADSHEET_VALIDATION_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }
function spreadsheetRequestedValidation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'validationType', 'alertStyle', 'operator', 'formula1', 'formula2', 'ignoreBlank', 'showError', 'errorTitle', 'errorMessage'].includes(key))) return null
  const type = SPREADSHEET_VALIDATION_TYPES[payload.validationType]; const alertStyle = SPREADSHEET_VALIDATION_ALERT_STYLES[payload.alertStyle ?? 'stop']; const operator = SPREADSHEET_VALIDATION_OPERATORS[payload.operator ?? 'between']; const formula1 = payload.formula1; const formula2 = payload.formula2 ?? ''
  if (!type || !alertStyle || !operator || typeof formula1 !== 'string' || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || ((operator === 1 || operator === 2) && payload.formula2 === undefined) || (payload.ignoreBlank !== undefined && typeof payload.ignoreBlank !== 'boolean') || (payload.showError !== undefined && typeof payload.showError !== 'boolean') || (payload.errorTitle !== undefined && (typeof payload.errorTitle !== 'string' || payload.errorTitle.length > 255)) || (payload.errorMessage !== undefined && (typeof payload.errorMessage !== 'string' || payload.errorMessage.length > 1024))) return null
  return { type, alertStyle, operator, formula1, formula2, ignoreBlank: payload.ignoreBlank ?? true, showError: payload.showError ?? true, errorTitle: payload.errorTitle ?? '', errorMessage: payload.errorMessage ?? '' }
}
function validSpreadsheetValidation(value) { return value === null || value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 8 && Number.isInteger(value.type) && value.type >= 1 && value.type <= 7 && Number.isInteger(value.alertStyle) && Number.isInteger(value.operator) && typeof value.formula1 === 'string' && value.formula1.length <= 1024 && typeof value.formula2 === 'string' && value.formula2.length <= 1024 && typeof value.ignoreBlank === 'boolean' && typeof value.showError === 'boolean' && typeof value.errorTitle === 'string' && value.errorTitle.length <= 255 && typeof value.errorMessage === 'string' && value.errorMessage.length <= 1024 }
function validSpreadsheetHyperlink(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => ['address', 'subAddress', 'textToDisplay', 'name', 'type', 'screenTip'].includes(key)) && ['address', 'subAddress', 'textToDisplay', 'name', 'type'].every((key) => Object.hasOwn(value, key)) && typeof value.address === 'string' && value.address.length <= 2048 && typeof value.subAddress === 'string' && value.subAddress.length <= 256 && typeof value.textToDisplay === 'string' && value.textToDisplay.length <= 500 && typeof value.name === 'string' && value.name.length <= 500 && (typeof value.type === 'string' || typeof value.type === 'number') && (value.screenTip === undefined || typeof value.screenTip === 'string' && value.screenTip.length <= 500) }
function validSpreadsheetHyperlinks(value) { return Array.isArray(value) && value.length <= 200 && value.every(validSpreadsheetHyperlink) }
function isSafeInternalHyperlinkReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f\[\]]/.test(value)) return false
  const a1 = '\\$?[A-Z]{1,3}\\$?[1-9][0-9]{0,6}(?::\\$?[A-Z]{1,3}\\$?[1-9][0-9]{0,6})?'
  const sheet = "(?:[A-Za-z_][A-Za-z0-9_.]{0,30}|'(?:[^'\\[\\]\\u0000-\\u001f\\u007f]|''){1,62}')!"
  return new RegExp(`^(?:${sheet})?${a1}$`).test(value) || /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(value)
}
function spreadsheetRequestedHyperlink(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'url', 'subAddress', 'screenTip', 'textToDisplay'].includes(key))) return null
  const url = payload.url ?? ''; const subAddress = payload.subAddress ?? ''; const screenTip = payload.screenTip; const textToDisplay = payload.textToDisplay
  if (typeof url !== 'string' || url.length > 2048 || typeof subAddress !== 'string' || subAddress.length > 256 || typeof textToDisplay !== 'string' || textToDisplay.length > 500 || (screenTip !== undefined && (typeof screenTip !== 'string' || screenTip.length > 500)) || /[\u0000-\u001f\u007f]/.test(url) || /[\u0000-\u001f\u007f]/.test(subAddress)) return null
  if (subAddress && !isSafeInternalHyperlinkReference(subAddress)) return null
  if (url) { try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.href !== url) return null } catch { return null } } else if (!isSafeInternalHyperlinkReference(subAddress)) return null
  return { url, subAddress, textToDisplay, ...(screenTip === undefined ? {} : { screenTip }) }
}
const SPREADSHEET_CONDITIONAL_FORMAT_TYPES = { cellValue: 1, expression: 2 }
const SPREADSHEET_CONDITIONAL_FORMAT_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }
function spreadsheetCanonicalColor(value) { if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase(); if (Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) return `#${value.toString(16).padStart(6, '0').toUpperCase()}`; return null }
function validSpreadsheetConditionalFormat(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 9 && ['type', 'operator', 'formula1', 'formula2', 'priority', 'fillColor', 'fontColor', 'bold', 'italic'].every((key) => Object.hasOwn(value, key)) && Object.values(SPREADSHEET_CONDITIONAL_FORMAT_TYPES).includes(value.type) && Object.values(SPREADSHEET_CONDITIONAL_FORMAT_OPERATORS).includes(value.operator) && typeof value.formula1 === 'string' && value.formula1.length > 0 && value.formula1.length <= 1024 && typeof value.formula2 === 'string' && value.formula2.length <= 1024 && (!([1, 2].includes(value.operator)) || value.formula2.length > 0) && Number.isInteger(value.priority) && value.priority >= 1 && value.priority <= 200 && spreadsheetCanonicalColor(value.fillColor) === value.fillColor && spreadsheetCanonicalColor(value.fontColor) === value.fontColor && typeof value.bold === 'boolean' && typeof value.italic === 'boolean' }
function validSpreadsheetConditionalFormats(value) { return Array.isArray(value) && value.length <= 200 && value.every(validSpreadsheetConditionalFormat) }
function spreadsheetRequestedConditionalFormat(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'conditionType', 'operator', 'formula1', 'formula2', 'fillColor', 'fontColor', 'bold', 'italic'].includes(key))) return null
  const type = SPREADSHEET_CONDITIONAL_FORMAT_TYPES[payload.conditionType]; const operator = SPREADSHEET_CONDITIONAL_FORMAT_OPERATORS[payload.operator ?? 'equal']; const formula1 = payload.formula1; const formula2 = payload.formula2 ?? ''; const fillColor = payload.fillColor === undefined ? undefined : spreadsheetCanonicalColor(payload.fillColor); const fontColor = payload.fontColor === undefined ? undefined : spreadsheetCanonicalColor(payload.fontColor)
  if (!type || !operator || typeof formula1 !== 'string' || formula1.length === 0 || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || ((operator === 1 || operator === 2) && (payload.formula2 === undefined || formula2.length === 0)) || (payload.fillColor !== undefined && !fillColor) || (payload.fontColor !== undefined && !fontColor) || (payload.bold !== undefined && typeof payload.bold !== 'boolean') || (payload.italic !== undefined && typeof payload.italic !== 'boolean')) return null
  return { type, operator, formula1, formula2, ...(fillColor === undefined ? {} : { fillColor }), ...(fontColor === undefined ? {} : { fontColor }), ...(payload.bold === undefined ? {} : { bold: payload.bold }), ...(payload.italic === undefined ? {} : { italic: payload.italic }) }
}
function validSpreadsheetMatrix(value) { return Array.isArray(value) && value.every((row) => Array.isArray(row)) }
function spreadsheetMatrixMatchesAddress(value, address) { const parsed = parseSpreadsheetAddress(address); const rows = parsed ? parsed.rowTo - parsed.rowFrom + 1 : 0; const columns = parsed ? parsed.colTo - parsed.colFrom + 1 : 0; return rows > 0 && columns > 0 && validSpreadsheetMatrix(value) && value.length === rows && value.every((row) => row.length === columns) }
function validWorkbookSheet(value) { return value && typeof value === 'object' && Number.isInteger(value.index) && value.index >= 1 && value.index <= 200 && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 31 && (value.visible === null || typeof value.visible === 'boolean') && (value.active === null || typeof value.active === 'boolean') }
function validWorkbookSheets(value) { return Array.isArray(value) && value.length >= 1 && value.length <= 200 && value.every(validWorkbookSheet) && value.every((item, index) => item.index === index + 1) && new Set(value.map((item) => item.name)).size === value.length }
function hasSingleReadableActiveSheet(value) { return validWorkbookSheets(value) && value.every((item) => typeof item.active === 'boolean') && value.filter((item) => item.active === true).length === 1 }
function validDefinedName(value) { return value && typeof value === 'object' && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 255 && typeof value.refersTo === 'string' && value.refersTo.length > 0 && value.refersTo.length <= 1024 && (value.visible === null || typeof value.visible === 'boolean') && (value.scope === null || typeof value.scope === 'string' || typeof value.scope === 'number') }
const SPREADSHEET_PRINT_KEYS = ['printArea', 'printTitleRows', 'printTitleColumns', 'orientation', 'zoom', 'fitToPagesWide', 'fitToPagesTall', 'centerHorizontally', 'centerVertically', 'leftMargin', 'rightMargin', 'topMargin', 'bottomMargin', 'headerMargin', 'footerMargin']
function parseSpreadsheetOutlineRange(range, axis) {
  const row = typeof range === 'string' && /^\$?([1-9]\d{0,6}):\$?([1-9]\d{0,6})$/.exec(range); const column = typeof range === 'string' && /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(range)
  if (axis === 'row' && row) { const from = Number(row[1]); const to = Number(row[2]); return from <= to && to <= 1048576 && to - from < 1000 ? { range: `${from}:${to}`, from, to } : null }
  if (axis === 'column' && column) { const from = spreadsheetColumnNumber(column[1]); const to = spreadsheetColumnNumber(column[2]); return from <= to && to <= 16384 && to - from < 1000 ? { range: `${column[1].toUpperCase()}:${column[2].toUpperCase()}`, from, to } : null }
  return null
}
function validSpreadsheetDimensions(value) {
  const target = parseSpreadsheetOutlineRange(value?.range, value?.axis)
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 && typeof value.sheetName === 'string' && value.sheetName.length > 0 && !!target && Array.isArray(value.items) && value.items.length === target.to - target.from + 1 && value.items.every((item, offset) => item && typeof item === 'object' && Object.keys(item).length === 3 && item.index === target.from + offset && typeof item.hidden === 'boolean' && typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 && item.size <= 10000)
}
function spreadsheetDimensionOperation(operation, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const axis = operation === 'set_rows_hidden' ? 'row' : operation === 'set_columns_hidden' ? 'column' : payload.axis
  if ((axis !== 'row' && axis !== 'column') || !Object.keys(payload).every((key) => ['sheetName', 'range', 'hidden', 'axis'].includes(key))) return null
  if ((operation === 'set_rows_hidden' || operation === 'set_columns_hidden') && (Object.hasOwn(payload, 'axis') || typeof payload.hidden !== 'boolean')) return null
  if (operation === 'auto_fit' && (!Object.hasOwn(payload, 'axis') || payload.hidden !== undefined)) return null
  const target = parseSpreadsheetOutlineRange(payload.range, axis)
  return target ? { ...target, axis, ...(operation === 'auto_fit' ? {} : { hidden: payload.hidden }) } : null
}
function validSpreadsheetPrintValue(key, value) {
  if (key === 'printArea') return typeof value === 'string' && value.length <= 128 && (value === '' || !!parseSpreadsheetAddress(value))
  if (key === 'printTitleRows') { const match = typeof value === 'string' && value.length <= 64 && /^\$?([1-9]\d{0,6}):\$?([1-9]\d{0,6})$/.exec(value); return value === '' || !!match && Number(match[1]) <= Number(match[2]) && Number(match[2]) <= 1048576 }
  if (key === 'printTitleColumns') { const match = typeof value === 'string' && value.length <= 32 && /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(value); return value === '' || !!match && spreadsheetColumnNumber(match[1]) <= spreadsheetColumnNumber(match[2]) && spreadsheetColumnNumber(match[2]) <= 16384 }
  if (key === 'orientation') return value === 'portrait' || value === 'landscape'
  if (key === 'zoom') return value === false || Number.isInteger(value) && value >= 10 && value <= 400
  if (key === 'fitToPagesWide' || key === 'fitToPagesTall') return Number.isInteger(value) && value >= 1 && value <= 100
  if (key === 'centerHorizontally' || key === 'centerVertically') return typeof value === 'boolean'
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 720
}
function validSpreadsheetPrintSettings(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 16 && typeof value.sheetName === 'string' && value.sheetName.length > 0 && SPREADSHEET_PRINT_KEYS.every((key) => validSpreadsheetPrintValue(key, value[key])) }
function validSpreadsheetOutline(value) { const target = parseSpreadsheetOutlineRange(value?.range, value?.axis); return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 && typeof value.sheetName === 'string' && value.sheetName.length > 0 && !!target && Array.isArray(value.levels) && value.levels.length === target.to - target.from + 1 && value.levels.every((level) => Number.isInteger(level) && level >= 0 && level <= 8) }
function validSpreadsheetPrecondition(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 7 && validSpreadsheetDimensions(value.dimensions)) return JSON.stringify(value).length <= 100_000
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 6 && validSpreadsheetOutline(value.outline)) return JSON.stringify(value).length <= 100_000
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 5 && validSpreadsheetPrintSettings(value.printSettings)) return JSON.stringify(value).length <= 100_000
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 4 && value.view && typeof value.view === 'object' && Object.keys(value.view).length === 8 && typeof value.view.sheetName === 'string' && value.view.sheetName.length > 0 && typeof value.view.activeCell === 'string' && !!parseSpreadsheetAddress(value.view.activeCell) && typeof value.view.freezePanes === 'boolean' && Number.isInteger(value.view.splitRow) && value.view.splitRow >= 0 && Number.isInteger(value.view.splitColumn) && value.view.splitColumn >= 0 && Number.isInteger(value.view.zoom) && value.view.zoom >= 10 && value.view.zoom <= 400 && Number.isInteger(value.view.scrollRow) && value.view.scrollRow >= 1 && Number.isInteger(value.view.scrollColumn) && value.view.scrollColumn >= 1) return JSON.stringify(value).length <= 100_000
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 3 && validWorkbookSheets(value.sheets) && (value.definedNames === undefined || Array.isArray(value.definedNames) && value.definedNames.length <= 200 && value.definedNames.every(validDefinedName))) return JSON.stringify(value).length <= 100_000
  if (value && typeof value === 'object' && !Array.isArray(value) && value.version === 2 && Array.isArray(value.targets) && value.targets.length >= 1 && value.targets.length <= 2) return value.targets.every((target) => validSpreadsheetPrecondition({ version: 1, range: target?.range, state: target?.state })) && JSON.stringify(value).length <= 100_000
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.range !== 'string' || value.range.length === 0 || value.range.length > 128 || !value.state || typeof value.state !== 'object' || Array.isArray(value.state)) return false
  const state = value.state
  if (!['values', 'formulas', 'merged', 'filter', 'rowHeight', 'columnWidth', 'format'].every((key) => Object.hasOwn(state, key)) || !spreadsheetMatrixMatchesAddress(state.values, value.range) || !spreadsheetMatrixMatchesAddress(state.formulas, value.range)) return false
  if (!(state.merged === null || typeof state.merged === 'boolean') || !(state.rowHeight === null || typeof state.rowHeight === 'number') || !(state.columnWidth === null || typeof state.columnWidth === 'number')) return false
  if (!(state.filter === null || typeof state.filter === 'object' && !Array.isArray(state.filter) && typeof state.filter.operator === 'string' && state.filter.operator.length <= 64)) return false
  if (!state.format || typeof state.format !== 'object' || Array.isArray(state.format) || (state.validation !== undefined && !validSpreadsheetValidation(state.validation)) || (state.hyperlinks !== undefined && !validSpreadsheetHyperlinks(state.hyperlinks)) || (state.conditionalFormats !== undefined && !validSpreadsheetConditionalFormats(state.conditionalFormats))) return false
  return JSON.stringify(value).length <= 100_000
}
function validSpreadsheetOperationPayload(operation, payload) {
  if (operation === 'fill_range') return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every((key) => ['range', 'sheetName', 'direction'].includes(key)) && !!parseSpreadsheetAddress(payload.range) && ['down', 'up', 'left', 'right'].includes(payload.direction)
  if (operation === 'batch_write') return spreadsheetBatchWrite(payload) !== null
  if (['set_rows_hidden', 'set_columns_hidden', 'auto_fit'].includes(operation)) return spreadsheetDimensionOperation(operation, payload) !== null
  if (operation === 'set_print_settings') return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every((key) => key === 'sheetName' || SPREADSHEET_PRINT_KEYS.includes(key)) && SPREADSHEET_PRINT_KEYS.some((key) => Object.hasOwn(payload, key)) && SPREADSHEET_PRINT_KEYS.filter((key) => Object.hasOwn(payload, key)).every((key) => key === 'zoom' ? Number.isInteger(payload[key]) && payload[key] >= 10 && payload[key] <= 400 : validSpreadsheetPrintValue(key, payload[key])) && !(Object.hasOwn(payload, 'zoom') && (Object.hasOwn(payload, 'fitToPagesWide') || Object.hasOwn(payload, 'fitToPagesTall')))
  if (operation === 'set_outline_group') { const target = parseSpreadsheetOutlineRange(payload?.range, payload?.axis); return !!payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).every((key) => ['sheetName', 'range', 'axis', 'grouped'].includes(key)) && !!target && typeof payload.grouped === 'boolean' }
  if (operation === 'set_zoom') return !!payload && Object.keys(payload).every((key) => ['sheetName', 'zoom'].includes(key)) && Number.isInteger(payload.zoom) && payload.zoom >= 10 && payload.zoom <= 400
  if (operation === 'set_freeze_panes') { const parsed = parseSpreadsheetAddress(payload?.target); return !!payload && Object.keys(payload).every((key) => ['sheetName', 'freeze', 'target'].includes(key)) && typeof payload.freeze === 'boolean' && (payload.freeze ? typeof payload.target === 'string' && !!parsed && parsed.rowFrom === parsed.rowTo && parsed.colFrom === parsed.colTo : payload.target === undefined) }
  if (operation === 'add_hyperlink') return spreadsheetRequestedHyperlink(payload) !== null && typeof payload.range === 'string' && payload.range.length > 0 && payload.range.length <= 128
  if (operation === 'delete_hyperlinks') return !!payload && typeof payload.range === 'string' && payload.range.length > 0 && payload.range.length <= 128 && Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))
  if (operation === 'add_conditional_format') return spreadsheetRequestedConditionalFormat(payload) !== null && typeof payload.range === 'string' && payload.range.length > 0 && payload.range.length <= 128
  if (operation === 'clear_conditional_formats') return !!payload && typeof payload.range === 'string' && payload.range.length > 0 && payload.range.length <= 128 && Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))
  if (!['set_data_validation', 'clear_data_validation'].includes(operation)) return true
  return !!payload && typeof payload.range === 'string' && payload.range.length > 0 && payload.range.length <= 128
    && (operation === 'clear_data_validation' ? Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key)) : spreadsheetRequestedValidation(payload) !== null)
}
function completeSpreadsheetDataValidationState(state) {
  const format = state?.format
  return !!state && typeof state === 'object' && typeof state.merged === 'boolean' && !!state.filter && typeof state.filter.operator === 'string' && typeof state.rowHeight === 'number' && Number.isFinite(state.rowHeight) && typeof state.columnWidth === 'number' && Number.isFinite(state.columnWidth)
    && !!format && typeof format === 'object' && ['bold', 'italic', 'underline', 'size', 'name', 'color', 'fill', 'numberFormat', 'alignment', 'wrap'].every((key) => Object.hasOwn(format, key) && format[key] !== null)
}
function spreadsheetSheetPrefix(address) {
  const match = typeof address === 'string' ? /^\s*(?:'((?:[^']|'')+)'|([^'!:\s]+))!\s*(.+?)\s*$/.exec(address) : null
  return match ? { sheetName: (match[1] ?? match[2]).replace(/''/g, "'"), range: match[3] } : null
}
function normalizeOfficeSpreadsheetArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const output = { ...args }
  const prefix = spreadsheetSheetPrefix(output.range)
  if (prefix) {
    output.range = prefix.range
    if (output.sheetName === undefined) output.sheetName = prefix.sheetName
  }
  if (output.payload && typeof output.payload === 'object' && !Array.isArray(output.payload)) {
    const rangePrefix = spreadsheetSheetPrefix(output.payload.range)
    const targetPrefix = rangePrefix ? null : spreadsheetSheetPrefix(output.payload.target)
    const hit = rangePrefix ?? targetPrefix
    if (hit) {
      output.payload = { ...output.payload }
      if (rangePrefix) output.payload.range = hit.range; else output.payload.target = hit.range
      if (output.payload.sheetName === undefined) output.payload.sheetName = hit.sheetName
    }
  }
  return output
}
function spreadsheetArgumentsHint(args) {
  const action = args && typeof args === 'object' && !Array.isArray(args) ? args.action : undefined
  if (action === 'special_cells') return 'office_spreadsheet special_cells requires a bounded bare range (for example A1:C10), a supported kind, and optional offset/limit'
  if (action === 'dimensions' || action === 'outline') return `office_spreadsheet ${action} requires a bounded whole-row or whole-column range and a matching axis`
  if (action === 'range') return 'office_spreadsheet range requires a bounded bare range (for example A1:C10); qualify the sheet through sheetName'
  if (action === 'search') return 'office_spreadsheet search requires a bounded bare range and a non-empty query'
  if (action === 'selection') return 'office_spreadsheet selection takes no range; it reads the current selected cells and active cell'
  if (action === 'used_range') return 'office_spreadsheet used_range takes no range; it reads the active sheet used rectangle'
  return 'office_spreadsheet requires a bounded read action, inspect_write, or challenged verified write'
}
function validOfficeSpreadsheetArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') return false
  const keys = Object.keys(value)
  if (['context', 'sheets', 'defined_names'].includes(value.action)) return keys.length === 1
  if (value.action === 'selection') return keys.every((key) => ['action', 'sheetName'].includes(key)) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'used_range') return keys.every((key) => ['action', 'sheetName'].includes(key)) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'view') return keys.every((key) => ['action', 'sheetName'].includes(key)) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'print_settings') return keys.every((key) => ['action', 'sheetName'].includes(key)) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'outline') return keys.every((key) => ['action', 'range', 'axis', 'sheetName'].includes(key)) && !!parseSpreadsheetOutlineRange(value.range, value.axis) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'dimensions') return keys.every((key) => ['action', 'range', 'axis', 'sheetName'].includes(key)) && !!parseSpreadsheetOutlineRange(value.range, value.axis) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120)
  if (value.action === 'special_cells') { const target = parseSpreadsheetAddress(value.range); return keys.every((key) => ['action', 'range', 'kind', 'sheetName', 'offset', 'limit'].includes(key)) && !!target && (target.rowTo - target.rowFrom + 1) * (target.colTo - target.colFrom + 1) <= 100000 && ['blanks', 'constants', 'formulas', 'lastCell', 'visible'].includes(value.kind) && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000) && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200) && (value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.length > 0 && value.sheetName.length <= 120) }
  if (value.action === 'inspect_write') return keys.length === 3 && SPREADSHEET_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000 && validSpreadsheetOperationPayload(value.operation, value.payload)
  if (value.action === 'capabilities' || value.action === 'range_features') return keys.every((key) => ['action', 'range', 'sheetName'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && (value.sheetName === undefined || typeof value.sheetName === 'string')
  if (value.action === 'range') return keys.every((key) => ['action', 'range', 'sheetName'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && (value.sheetName === undefined || typeof value.sheetName === 'string')
  if (value.action === 'search') return keys.every((key) => ['action', 'range', 'sheetName', 'query', 'matchCase', 'matchEntireCell', 'searchBy', 'offset', 'limit'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && typeof value.query === 'string' && value.query.trim().length > 0 && value.query.length <= 500 && (value.searchBy === undefined || ['value', 'text', 'formula'].includes(value.searchBy)) && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000) && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
  return value.action === 'write' && keys.length === 6 && typeof value.challenge === 'string' && value.challenge.length > 0 && typeof value.idempotencyIdentity === 'string' && value.idempotencyIdentity.length > 0 && value.idempotencyIdentity.length <= 128 && validOfficeResource(value.resource) && SPREADSHEET_OPERATIONS.includes(value.operation) && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000 && validSpreadsheetOperationPayload(value.operation, value.payload)
}
function validSpreadsheetSpecialCells(value, resource, request) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 12 || value.range !== request?.range || value.kind !== request?.kind || value.offset !== (request?.offset ?? 0) || value.limit !== (request?.limit ?? 200) || (request?.sheetName !== undefined && value.sheetName !== request.sheetName) || typeof value.range !== 'string' || !parseSpreadsheetAddress(value.range) || value.sheetName !== resource.sheetName || !['blanks', 'constants', 'formulas', 'lastCell', 'visible'].includes(value.kind) || !Number.isInteger(value.count) || value.count < 0 || value.count > 100000 || !Number.isInteger(value.areaCount) || value.areaCount < 0 || value.areaCount > 100000 || value.areaCount > value.count || !Number.isInteger(value.offset) || value.offset < 0 || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200 || !Number.isInteger(value.returned) || value.returned < 0 || typeof value.hasMore !== 'boolean' || typeof value.truncated !== 'boolean' || value.truncated !== value.hasMore || !(value.nextOffset === null || Number.isInteger(value.nextOffset)) || !Array.isArray(value.areas) || value.areas.length !== value.returned) return false; const target = parseSpreadsheetAddress(value.range); const ranges = []; let cells = 0; for (let index = 0; index < value.areas.length; index += 1) { const area = value.areas[index]; const parsed = parseSpreadsheetAddress(area?.address); if (!area || typeof area !== 'object' || Object.keys(area).length !== 7 || area.index !== value.offset + index + 1 || !parsed || ranges.some((candidate) => spreadsheetRangesOverlap(candidate, parsed)) || parsed.rowFrom !== area.row || parsed.colFrom !== area.column || parsed.rowTo - parsed.rowFrom + 1 !== area.rowsCount || parsed.colTo - parsed.colFrom + 1 !== area.columnsCount || area.count !== area.rowsCount * area.columnsCount || !Number.isInteger(area.count) || !Number.isInteger(area.row) || !Number.isInteger(area.column) || !Number.isInteger(area.rowsCount) || !Number.isInteger(area.columnsCount) || parsed.rowFrom < target.rowFrom || parsed.rowTo > target.rowTo || parsed.colFrom < target.colFrom || parsed.colTo > target.colTo) return false; ranges.push(parsed); cells += area.count; if (cells > value.count) return false } return value.returned === Math.min(value.limit, Math.max(0, value.areaCount - value.offset)) && value.hasMore === (value.offset + value.returned < value.areaCount) && value.nextOffset === (value.hasMore ? value.offset + value.returned : null) && (value.offset !== 0 || value.hasMore || cells === value.count) }
function validOfficeSpreadsheetReadResult(value, action, request) { return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'ok' && validOfficeResource(value.resource) && (action !== 'special_cells' || validSpreadsheetSpecialCells(value.specialCells, value.resource, request)) }
function validOfficeSpreadsheetWriteResult(value) { return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'verified_write' && validOfficeResource(value.resource) && SPREADSHEET_OPERATIONS.includes(value.operation) && value.requested && typeof value.requested === 'object' && value.observed && typeof value.observed === 'object' }
function spreadsheetWriteHash(operation, payload) { return hash(canonicalJson({ operation, payload })) }
function jsonMatches(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function hasVerifiedSpreadsheetRange(result, payload) { return result.requested.range === payload.range && result.observed.range === payload.range && result.observed.verified === true }
function requestedFormatMatches(requested, payload) {
  return requested && jsonMatches(requested.format, payload)
}
function observedFormatMatches(observed, payload) {
  if (!observed || typeof observed !== 'object') return false
  if (payload.font !== undefined && (!observed.font || typeof observed.font !== 'object' || !Object.entries(payload.font).every(([key, value]) => jsonMatches(observed.font[key], value)))) return false
  return (payload.fill === undefined || jsonMatches(observed.fill, payload.fill))
    && (payload.numberFormat === undefined || jsonMatches(observed.numberFormat, payload.numberFormat))
    && (payload.alignment === undefined || jsonMatches(observed.alignment, payload.alignment))
    && (payload.wrap === undefined || jsonMatches(observed.wrap, payload.wrap))
}
function spreadsheetColumnNumber(name) { return name.toUpperCase().split('').reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) }
function spreadsheetColumnName(value) { let output = ''; for (let current = value; current > 0; current = Math.floor((current - 1) / 26)) output = String.fromCharCode(65 + ((current - 1) % 26)) + output; return output }
function parseSpreadsheetAddress(address) {
  const match = typeof address === 'string' && address.match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/i)
  if (!match) return null
  const rowFrom = Number(match[2]); const colFrom = spreadsheetColumnNumber(match[1]); const rowTo = Number(match[4] ?? match[2]); const colTo = spreadsheetColumnNumber(match[3] ?? match[1])
  return rowFrom > 0 && rowTo >= rowFrom && rowTo <= 1048576 && colFrom > 0 && colTo >= colFrom && colTo <= 16384 ? { rowFrom, rowTo, colFrom, colTo } : null
}
function spreadsheetBatchWrite(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['sheetName', 'cells'].includes(key)) || !Array.isArray(payload.cells) || payload.cells.length < 1 || payload.cells.length > 500) return null
  const cells = []; const seen = new Set()
  for (const item of payload.cells) { const parsed = parseSpreadsheetAddress(item?.cell); if (!parsed || parsed.rowFrom !== parsed.rowTo || parsed.colFrom !== parsed.colTo || seen.has(item.cell.toUpperCase()) || !(typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean' || item.value === null) || !item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).every((key) => ['cell', 'value'].includes(key))) return null; seen.add(item.cell.toUpperCase()); cells.push({ cell: item.cell.toUpperCase(), value: item.value, ...parsed }) }
  const rowFrom = Math.min(...cells.map((item) => item.rowFrom)); const rowTo = Math.max(...cells.map((item) => item.rowTo)); const colFrom = Math.min(...cells.map((item) => item.colFrom)); const colTo = Math.max(...cells.map((item) => item.colTo)); const count = (rowTo - rowFrom + 1) * (colTo - colFrom + 1)
  if (count !== cells.length || count > 500) return null
  const values = Array.from({ length: rowTo - rowFrom + 1 }, () => Array(colTo - colFrom + 1).fill(null)); for (const item of cells) values[item.rowFrom - rowFrom][item.colFrom - colFrom] = item.value
  return { range: spreadsheetAddressFor({ rowFrom, rowTo, colFrom, colTo }), cells: cells.map(({ cell, value }) => ({ cell, value })), values }
}
function spreadsheetAddressFor(parsed) { return `${spreadsheetColumnName(parsed.colFrom)}${parsed.rowFrom}:${spreadsheetColumnName(parsed.colTo)}${parsed.rowTo}` }
function spreadsheetRangesOverlap(left, right) { return left.rowFrom <= right.rowTo && left.rowTo >= right.rowFrom && left.colFrom <= right.colTo && left.colTo >= right.colFrom }
function spreadsheetCanonicalTarget(address, expected) { const parsed = parseSpreadsheetAddress(address); return !!parsed && address === address.toUpperCase() && parsed.rowFrom === expected.rowFrom && parsed.rowTo === expected.rowTo && parsed.colFrom === expected.colFrom && parsed.colTo === expected.colTo }
function spreadsheetBlank(value) { return value === null || value === undefined || value === '' }
function spreadsheetBlankMatrix(value) { return Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every(spreadsheetBlank)) }
function spreadsheetSameShape(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((row, index) => Array.isArray(row) && Array.isArray(right[index]) && row.length === right[index].length) }
const SPREADSHEET_MOVE_DEFAULT_FORMATS = {
  bold: [false, 0], italic: [false, 0], underline: [false, 0, 'none'], size: [10, 11, 12],
  name: ['Arial', 'Calibri', '宋体', '等线'], color: ['#000000', '#FF000000', 0, -16777216, 'rgb(0,0,0)'],
  fill: ['#FFFFFF', '#FFFFFFFF', 16777215, -1, 'rgb(255,255,255)'], numberFormat: ['General', '通用格式', '常规'],
  alignment: ['general', 'General', 0, -4105], wrap: [false, 0],
}
function spreadsheetSplitDelimited(value, delimiter, consecutive) {
  if (typeof value !== 'string') return [value]
  const output = []; let current = ''; let quoted = false
  for (let index = 0; index < value.length; index += 1) { const character = value[index]; if (character === '"') { if (quoted && value[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted; continue }; if (!quoted && character === delimiter) { output.push(current); current = ''; if (consecutive) while (value[index + 1] === delimiter) index += 1; continue }; current += character }
  output.push(current); return output
}
function spreadsheetHasUnclosedQuote(value) { let quoted = false; for (let index = 0; index < String(value).length; index += 1) { if (value[index] !== '"') continue; if (quoted && value[index + 1] === '"') { index += 1; continue }; quoted = !quoted }; return quoted }
function spreadsheetTypeAmbiguous(value) { return typeof value === 'string' && /^(?:[+-]?\d+(?:\.\d+)?|\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4})$/.test(value.trim()) }
function spreadsheetReplacement(value, what, replacement, whole, matchCase) {
  if (typeof value !== 'string') return { value, count: 0 }
  if (whole) { const matched = matchCase ? value === what : value.toLocaleLowerCase() === what.toLocaleLowerCase(); return { value: matched ? replacement : value, count: matched ? 1 : 0 } }
  const expression = new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi'); let count = 0
  return { value: value.replace(expression, () => { count += 1; return replacement }), count }
}
function spreadsheetDuplicateKey(value) { return spreadsheetBlank(value) ? 'blank:' : typeof value === 'string' ? `string:${value.toLocaleLowerCase()}` : `${typeof value}:${String(value)}` }
function spreadsheetDefaultMoveState(state) { return state?.merged === false && state?.format && typeof state.format === 'object' && !Array.isArray(state.format) && Object.entries(SPREADSHEET_MOVE_DEFAULT_FORMATS).every(([key, allowed]) => Object.hasOwn(state.format, key) && allowed.some((value) => jsonMatches(value, state.format[key]))) }
function spreadsheetP0Plan(operation, payload, precondition) {
  if (!precondition || precondition.version !== 2 || !Array.isArray(precondition.targets)) return null
  const source = parseSpreadsheetAddress(payload?.range); if (!source || !precondition.targets[0] || precondition.targets[0].range !== payload.range) return null
  if (operation === 'replace_range_text' || operation === 'remove_duplicates') return precondition.targets.length === 1 ? { source, sourceState: precondition.targets[0].state, targets: [payload.range] } : null
  if (operation === 'text_to_columns') {
    const delimiter = ({ comma: ',', tab: '\t', semicolon: ';', space: ' ', other: payload.otherDelimiter })[payload.delimiter ?? 'comma']
    const sourceState = precondition.targets[0].state
    if (source.colFrom !== source.colTo || typeof delimiter !== 'string' || delimiter.length !== 1 || !Array.isArray(sourceState.values) || !Array.isArray(sourceState.formulas) || sourceState.values.some((row) => !Array.isArray(row) || row.length !== 1) || sourceState.formulas.some((row) => !Array.isArray(row) || row.length !== 1 || !spreadsheetBlank(row[0])) || sourceState.values.some((row) => spreadsheetHasUnclosedQuote(row[0]) || spreadsheetSplitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true).some(spreadsheetTypeAmbiguous))) return null
    const split = sourceState.values.map((row) => spreadsheetSplitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true)); const width = split.reduce((maximum, row) => Math.max(maximum, row.length), 1)
    if (width > 50 || split.length * width > 20_000) return null
    const output = spreadsheetAddressFor({ ...source, colTo: source.colFrom + width - 1 }); const outputState = precondition.targets[1]?.state
    if (precondition.targets.length !== 2 || precondition.targets[1]?.range !== output || !validSpreadsheetMatrix(outputState?.values) || !validSpreadsheetMatrix(outputState?.formulas) || outputState.values.length !== sourceState.values.length) return null
    const outputMatchesSource = outputState.values.every((row, index) => row.length === width && outputState.formulas[index]?.length === width && row[0] === sourceState.values[index][0] && spreadsheetBlank(outputState.formulas[index][0]))
    const outputIsSafe = payload.overwrite === true || outputState.values.every((row, index) => row.slice(1).every(spreadsheetBlank) && outputState.formulas[index].slice(1).every(spreadsheetBlank))
    if (!outputMatchesSource || !outputIsSafe) return null
    return { source, sourceState, delimiter, split, width, output, targets: [payload.range, output] }
  }
  if (operation === 'move_range') {
    const requested = parseSpreadsheetAddress(payload.destination); if (!requested) return null
    const rows = source.rowTo - source.rowFrom + 1; const columns = source.colTo - source.colFrom + 1
    if (!((requested.rowTo === requested.rowFrom && requested.colTo === requested.colFrom) || (requested.rowTo - requested.rowFrom + 1 === rows && requested.colTo - requested.colFrom + 1 === columns))) return null
    const outputRange = { rowFrom: requested.rowFrom, colFrom: requested.colFrom, rowTo: requested.rowFrom + rows - 1, colTo: requested.colFrom + columns - 1 }
    const output = spreadsheetAddressFor(outputRange)
    const sourceState = precondition.targets[0].state; const destinationState = precondition.targets[1]?.state
    if (precondition.targets.length !== 2 || !spreadsheetCanonicalTarget(precondition.targets[0]?.range, source) || !spreadsheetCanonicalTarget(precondition.targets[1]?.range, outputRange) || precondition.targets[0].range === precondition.targets[1].range || spreadsheetRangesOverlap(source, outputRange) || !spreadsheetDefaultMoveState(sourceState) || !spreadsheetDefaultMoveState(destinationState) || (payload.overwrite !== true && (!spreadsheetBlankMatrix(destinationState.values) || !spreadsheetBlankMatrix(destinationState.formulas)))) return null
    return { source, sourceState, destinationState, output, targets: [payload.range, output] }
  }
  return null
}
function validSpreadsheetOperationPrecondition(operation, payload, precondition) {
  if (operation === 'batch_write') { const batch = spreadsheetBatchWrite(payload); return !!batch && precondition?.version === 1 && precondition.range === batch.range && validSpreadsheetMatrix(precondition.state?.values) && validSpreadsheetMatrix(precondition.state?.formulas) && precondition.state.formulas.every((row) => row.every(spreadsheetBlank)) }
  if (operation === 'fill_range') return precondition?.version === 1 && precondition.range === payload?.range && validSpreadsheetOperationPayload(operation, payload) && validSpreadsheetMatrix(precondition.state?.formulas) && precondition.state.formulas.every((row) => row.every(spreadsheetBlank))
  if (['set_rows_hidden', 'set_columns_hidden', 'auto_fit'].includes(operation)) { const target = spreadsheetDimensionOperation(operation, payload); return precondition?.version === 7 && validSpreadsheetDimensions(precondition.dimensions) && !!target && precondition.dimensions.range === target.range && precondition.dimensions.axis === target.axis && precondition.dimensions.sheetName === (payload.sheetName ?? precondition.dimensions.sheetName) }
  if (operation === 'set_print_settings') return precondition?.version === 5 && validSpreadsheetPrintSettings(precondition.printSettings) && validSpreadsheetOperationPayload(operation, payload) && precondition.printSettings.sheetName === (payload.sheetName ?? precondition.printSettings.sheetName)
  if (operation === 'set_outline_group') { const target = parseSpreadsheetOutlineRange(payload?.range, payload?.axis); return precondition?.version === 6 && validSpreadsheetOutline(precondition.outline) && !!target && precondition.outline.range === target.range && precondition.outline.axis === payload.axis && precondition.outline.sheetName === (payload.sheetName ?? precondition.outline.sheetName) }
  if (['set_zoom', 'set_freeze_panes'].includes(operation)) return precondition?.version === 4 && validSpreadsheetOperationPayload(operation, payload) && precondition.view?.sheetName === (payload.sheetName ?? precondition.view.sheetName)
  if (['set_data_validation', 'clear_data_validation'].includes(operation)) return precondition?.version === 1 && precondition.range === payload?.range && validSpreadsheetOperationPayload(operation, payload) && Object.hasOwn(precondition.state ?? {}, 'validation') && validSpreadsheetValidation(precondition.state?.validation) && completeSpreadsheetDataValidationState(precondition.state)
  if (['add_hyperlink', 'delete_hyperlinks'].includes(operation)) return precondition?.version === 1 && precondition.range === payload?.range && validSpreadsheetOperationPayload(operation, payload) && Object.hasOwn(precondition.state ?? {}, 'validation') && validSpreadsheetValidation(precondition.state?.validation) && Object.hasOwn(precondition.state ?? {}, 'hyperlinks') && validSpreadsheetHyperlinks(precondition.state?.hyperlinks) && completeSpreadsheetDataValidationState(precondition.state) && (operation !== 'add_hyperlink' || payload.screenTip === undefined || precondition.state.hyperlinks.length > 0 && precondition.state.hyperlinks.every((item) => typeof item.screenTip === 'string'))
  if (['add_conditional_format', 'clear_conditional_formats'].includes(operation)) return precondition?.version === 1 && precondition.range === payload?.range && validSpreadsheetOperationPayload(operation, payload) && Object.hasOwn(precondition.state ?? {}, 'conditionalFormats') && validSpreadsheetConditionalFormats(precondition.state?.conditionalFormats) && completeSpreadsheetDataValidationState(precondition.state)
  if (['replace_range_text', 'text_to_columns', 'remove_duplicates', 'move_range'].includes(operation)) return spreadsheetP0Plan(operation, payload, precondition) !== null
  if (!['create_defined_name', 'delete_defined_name', 'activate_worksheet', 'move_worksheet', 'set_worksheet_visibility'].includes(operation)) return true
  if (precondition?.version !== 3 || !Array.isArray(precondition.sheets)) return false
  const name = typeof payload?.name === 'string' ? payload.name.trim() : typeof payload?.sourceName === 'string' ? payload.sourceName : typeof payload?.sheetName === 'string' ? payload.sheetName : ''
  if (operation === 'create_defined_name') return Array.isArray(precondition.definedNames) && typeof payload.refersTo === 'string' && (payload.scope === undefined || payload.scope === 'workbook') && !precondition.definedNames.some((item) => item.name === name)
  if (operation === 'delete_defined_name') return Array.isArray(precondition.definedNames) && precondition.definedNames.some((item) => item.name === name)
  if (operation === 'activate_worksheet') return Object.keys(payload ?? {}).length === 1 && typeof payload.sheetName === 'string' && hasSingleReadableActiveSheet(precondition.sheets) && precondition.sheets.some((item) => item.name === payload.sheetName)
  if (operation === 'move_worksheet') return precondition.sheets.some((item) => item.name === name) && Number.isInteger(payload.index) && payload.index >= 1 && payload.index <= precondition.sheets.length
  return precondition.sheets.some((item) => item.name === name) && typeof payload.visible === 'boolean' && (payload.visible || precondition.sheets.filter((item) => item.visible === true).length > 1)
}
function verifiedSpreadsheetWriteMatches(result, operation, payload, approvedResource, precondition) {
  if (!validOfficeSpreadsheetWriteResult(result) || result.operation !== operation || !sameOfficeResource(result.resource, approvedResource)) return false
  if (operation === 'set_values') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.values, payload.values) && jsonMatches(result.observed.values, payload.values)
  if (operation === 'set_formula') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.formulas, payload.formulas) && jsonMatches(result.observed.formulas, payload.formulas)
  if (operation === 'clear') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && result.observed.isBlank === true && Array.isArray(result.observed.values) && Array.isArray(result.observed.formulas)
  if (operation === 'fill_range') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.direction === payload.direction && result.requested.strategy === 'atomic_set_values' && Array.isArray(result.observed.values) && Array.isArray(result.observed.formulas) && result.observed.verified === true && !!precondition?.state && jsonMatches({ ...result.observed.state, values: precondition.state.values, formulas: precondition.state.formulas }, precondition.state)
  if (operation === 'batch_write') { const batch = spreadsheetBatchWrite(payload); return !!batch && result.requested?.range === batch.range && jsonMatches(result.requested?.cells, batch.cells) && result.observed?.range === batch.range && jsonMatches(result.observed?.values, batch.values) && Array.isArray(result.observed?.formulas) && result.observed.verified === true && !!precondition?.state && jsonMatches(result.observed?.state, { ...precondition.state, values: batch.values, formulas: precondition.state.formulas }) }
  if (operation === 'format') return hasVerifiedSpreadsheetRange(result, payload) && requestedFormatMatches(result.requested, payload) && observedFormatMatches(result.observed.format, payload)
  if (operation === 'merge' || operation === 'unmerge') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.merged === (operation === 'merge') && result.observed.merged === (operation === 'merge')
  if (operation === 'row_height') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.RowHeight === payload.value && result.observed.RowHeight === payload.value
  if (operation === 'column_width') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.ColumnWidth === payload.value && result.observed.ColumnWidth === payload.value
  if (operation === 'sort') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.sorts, payload.sorts) && result.requested.hasHeader === (payload.hasHeader !== false) && Array.isArray(result.observed.values)
  if (operation === 'set_auto_filter') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.enabled === payload.enabled && result.observed.enabled === payload.enabled
  if (operation === 'clear_filters') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && result.observed.after?.operator === 'none'
  if (['set_rows_hidden', 'set_columns_hidden', 'auto_fit'].includes(operation)) {
    const target = spreadsheetDimensionOperation(operation, payload); const before = precondition?.dimensions; const after = result.observed?.dimensions
    if (!target || !before || !validSpreadsheetDimensions(after) || result.observed?.verified !== true || after.sheetName !== before.sheetName || after.range !== target.range || after.axis !== target.axis) return false
    if (operation === 'auto_fit') return result.requested?.range === target.range && result.requested?.axis === target.axis && result.observed?.invocationObserved === true && after.items.every((item, index) => item.hidden === before.items[index]?.hidden)
    return result.requested?.range === target.range && result.requested?.axis === target.axis && result.requested?.hidden === target.hidden && after.items.every((item, index) => item.hidden === target.hidden && item.size === before.items[index]?.size)
  }
  if (operation === 'set_print_settings') { const before = precondition?.printSettings; const after = result.observed?.printSettings; if (!before || !validSpreadsheetPrintSettings(after) || result.observed.verified !== true) return false; const expected = { ...before, ...Object.fromEntries(SPREADSHEET_PRINT_KEYS.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]])), ...((Object.hasOwn(payload, 'fitToPagesWide') || Object.hasOwn(payload, 'fitToPagesTall')) ? { zoom: false } : {}) }; return jsonMatches(after, expected) && SPREADSHEET_PRINT_KEYS.filter((key) => Object.hasOwn(payload, key)).every((key) => jsonMatches(result.requested?.[key], expected[key])) && (expected.zoom === false ? result.requested?.zoom === false : true) }
  if (operation === 'set_outline_group') { const before = precondition?.outline; const after = result.observed?.outline; const target = parseSpreadsheetOutlineRange(payload?.range, payload?.axis); const expectedLevels = before?.levels?.map((level) => payload.grouped ? level + 1 : level - 1); return !!before && !!target && validSpreadsheetOutline(after) && result.observed.verified === true && result.requested?.range === target.range && result.requested?.axis === payload.axis && result.requested?.grouped === payload.grouped && after.sheetName === before.sheetName && after.range === target.range && after.axis === payload.axis && jsonMatches(after.levels, expectedLevels) }
  if (operation === 'set_zoom') { const before = precondition?.view; const after = result.observed?.view; return !!before && !!after && result.requested?.zoom === payload.zoom && after.zoom === payload.zoom && jsonMatches({ ...after, zoom: before.zoom }, before) && result.observed.verified === true }
  if (operation === 'set_freeze_panes') { const before = precondition?.view; const after = result.observed?.view; const parsed = parseSpreadsheetAddress(payload.target); if (!before || !after || result.observed.verified !== true) return false; if (payload.freeze !== true) return result.requested?.freeze === false && after.freezePanes === false && after.zoom === before.zoom && after.scrollRow === before.scrollRow && after.scrollColumn === before.scrollColumn && after.sheetName === before.sheetName && after.activeCell === before.activeCell; return result.requested?.freeze === true && result.requested?.target === payload.target && !!parsed && after.freezePanes === true && after.activeCell === payload.target && after.splitRow === parsed.rowFrom - 1 && after.splitColumn === parsed.colFrom - 1 && after.zoom === before.zoom && after.scrollRow === before.scrollRow && after.scrollColumn === before.scrollColumn && after.sheetName === before.sheetName }
  if (operation === 'set_data_validation') {
    const expected = spreadsheetRequestedValidation(payload); const expectedState = expected && precondition?.state ? { ...precondition.state, validation: expected } : null
    return !!expected && !!expectedState && hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.validation, expected) && jsonMatches(result.observed.validation, expected) && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'clear_data_validation') {
    const expectedState = precondition?.state ? { ...precondition.state, validation: null } : null
    return !!expectedState && hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && result.requested.validation === null && result.observed.validation === null && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'add_hyperlink') {
    const expected = spreadsheetRequestedHyperlink(payload); const before = precondition?.state?.hyperlinks
    if (!expected || !validSpreadsheetHyperlinks(before) || !validSpreadsheetHyperlinks(result.observed.hyperlinks) || !validSpreadsheetHyperlink(result.observed.newItem)) return false
    const added = result.observed.hyperlinks.filter((item) => !before.some((prior) => jsonMatches(prior, item))); const expectedState = { ...precondition.state, hyperlinks: result.observed.hyperlinks }
    return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.hyperlink, expected) && result.observed.hyperlinks.length === before.length + 1 && added.length === 1 && jsonMatches(result.observed.newItem, added[0]) && added[0].address === expected.url && added[0].subAddress === expected.subAddress && added[0].textToDisplay === expected.textToDisplay && (expected.screenTip === undefined || added[0].screenTip === expected.screenTip) && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'delete_hyperlinks') {
    const before = precondition?.state?.hyperlinks; const expectedState = precondition?.state ? { ...precondition.state, hyperlinks: [] } : null
    return validSpreadsheetHyperlinks(before) && !!expectedState && hasVerifiedSpreadsheetRange(result, payload) && result.requested.delete === true && validSpreadsheetHyperlinks(result.observed.hyperlinks) && result.observed.hyperlinks.length === 0 && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'add_conditional_format') {
    const expected = spreadsheetRequestedConditionalFormat(payload); const before = precondition?.state?.conditionalFormats
    if (!expected || !validSpreadsheetConditionalFormats(before) || !validSpreadsheetConditionalFormats(result.observed.conditionalFormats) || !validSpreadsheetConditionalFormat(result.observed.newItem)) return false
    const added = result.observed.conditionalFormats.filter((item) => !before.some((prior) => jsonMatches(prior, item))); const expectedState = { ...precondition.state, conditionalFormats: result.observed.conditionalFormats }
    const matches = (item) => item.type === expected.type && item.operator === expected.operator && item.formula1 === expected.formula1 && item.formula2 === expected.formula2 && (expected.fillColor === undefined || item.fillColor === expected.fillColor) && (expected.fontColor === undefined || item.fontColor === expected.fontColor) && (expected.bold === undefined || item.bold === expected.bold) && (expected.italic === undefined || item.italic === expected.italic)
    return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.conditionalFormat, expected) && result.observed.conditionalFormats.length === before.length + 1 && added.length === 1 && jsonMatches(result.observed.newItem, added[0]) && matches(added[0]) && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'clear_conditional_formats') {
    const before = precondition?.state?.conditionalFormats; const expectedState = precondition?.state ? { ...precondition.state, conditionalFormats: [] } : null
    return validSpreadsheetConditionalFormats(before) && !!expectedState && hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && validSpreadsheetConditionalFormats(result.observed.conditionalFormats) && result.observed.conditionalFormats.length === 0 && jsonMatches(result.observed.state, expectedState)
  }
  if (operation === 'create_defined_name') {
    const expected = precondition?.definedNames?.find((item) => item.name === payload.name?.trim()); return precondition?.version === 3 && !expected && result.requested.name === payload.name?.trim() && result.requested.refersTo === payload.refersTo?.trim() && result.requested.visible === (payload.visible ?? true) && result.requested.scope === 'workbook' && result.observed.name === payload.name?.trim() && result.observed.refersTo === payload.refersTo?.trim() && result.observed.visible === (payload.visible ?? true) && result.observed.scope === 'workbook' && Array.isArray(result.observed.names) && jsonMatches(result.observed.names.filter((item) => item.name !== payload.name?.trim()), precondition.definedNames) && result.observed.verified === true
  }
  if (operation === 'delete_defined_name') {
    const expected = precondition?.definedNames?.find((item) => item.name === payload.name?.trim()); return precondition?.version === 3 && !!expected && result.requested.name === expected.name && jsonMatches(result.requested.refersTo, expected.refersTo) && result.observed.name === expected.name && result.observed.deleted === true && jsonMatches(result.observed.names, precondition.definedNames.filter((item) => item.name !== expected.name)) && result.observed.verified === true
  }
  if (operation === 'activate_worksheet') {
    const sheets = precondition?.sheets; const source = payload.sheetName
    const expected = Array.isArray(sheets) ? sheets.map((sheet) => ({ ...sheet, active: sheet.name === source })) : null
    return precondition?.version === 3 && typeof source === 'string' && Object.keys(payload ?? {}).length === 1 && hasSingleReadableActiveSheet(sheets) && !!expected && validWorkbookSheets(result.observed.sheets) && result.requested.sheetName === source && result.observed.sheetName === source && jsonMatches(result.observed.sheets, expected) && result.observed.verified === true
  }
  if (operation === 'move_worksheet') {
    const sheets = precondition?.sheets; const source = payload.sourceName ?? payload.sheetName; if (precondition?.version !== 3 || !validWorkbookSheets(sheets) || !Number.isInteger(payload.index) || !sheets.some((item) => item.name === source)) return false
    const expected = sheets.filter((item) => item.name !== source); expected.splice(payload.index - 1, 0, sheets.find((item) => item.name === source)); const expectedSnapshot = expected.map((item, index) => ({ ...item, index: index + 1 }))
    return result.requested.sourceName === source && result.requested.index === payload.index && jsonMatches(result.observed.order, expectedSnapshot.map((item) => item.name)) && validWorkbookSheets(result.observed.sheets) && jsonMatches(result.observed.sheets, expectedSnapshot) && result.observed.verified === true
  }
  if (operation === 'set_worksheet_visibility') {
    const sheets = precondition?.sheets; const source = payload.sourceName ?? payload.sheetName; const expected = Array.isArray(sheets) ? sheets.map((item) => item.name === source ? { ...item, visible: payload.visible } : item) : null
    return precondition?.version === 3 && validWorkbookSheets(sheets) && sheets.every((item) => typeof item.visible === 'boolean') && sheets.some((item) => item.name === source) && typeof payload.visible === 'boolean' && !(payload.visible === false && sheets.find((item) => item.name === source)?.active === true) && !!expected && result.requested.sheetName === source && result.requested.visible === payload.visible && result.observed.sheetName === source && result.observed.visible === payload.visible && validWorkbookSheets(result.observed.sheets) && jsonMatches(result.observed.sheets, expected) && result.observed.verified === true
  }
  if (operation === 'replace_range_text') {
    const plan = spreadsheetP0Plan(operation, payload, precondition); const what = payload.what; const replacement = payload.replacement ?? ''
    if (!plan || typeof what !== 'string' || !what || typeof replacement !== 'string') return false
    let count = 0; const expectedValues = plan.sourceState.values.map((row) => row.map((value) => { const next = spreadsheetReplacement(value, what, replacement, payload.matchEntireCell === true, payload.matchCase === true); count += next.count; return next.value }))
    const expectedFormulas = plan.sourceState.formulas.map((row) => row.map((formula) => typeof formula === 'string' && formula.startsWith('=') ? spreadsheetReplacement(formula, what, replacement, payload.matchEntireCell === true, payload.matchCase === true).value : formula))
    const formulaChanged = !jsonMatches(expectedFormulas, plan.sourceState.formulas)
    return hasVerifiedSpreadsheetRange(result, payload) && result.requested.what === what && result.requested.replacement === replacement && result.requested.matchEntireCell === (payload.matchEntireCell === true) && result.requested.matchCase === (payload.matchCase === true) && result.requested.allowFormulaChanges === (payload.allowFormulaChanges === true) && (!formulaChanged || payload.allowFormulaChanges === true) && jsonMatches(result.observed.values, expectedValues) && jsonMatches(result.observed.formulas, expectedFormulas) && result.observed.replacementCount === count
  }
  if (operation === 'text_to_columns') {
    const plan = spreadsheetP0Plan(operation, payload, precondition); if (!plan) return false
    const expectedValues = plan.split.map((row) => [...row, ...Array(plan.width - row.length).fill(null)])
    return result.requested.range === payload.range && result.requested.outputRange === plan.output && result.requested.delimiter === (payload.delimiter ?? 'comma') && result.requested.consecutiveDelimiter === (payload.consecutiveDelimiter === true) && result.observed.range === payload.range && result.observed.outputRange === plan.output && jsonMatches(result.observed.values, expectedValues) && spreadsheetSameShape(result.observed.formulas, expectedValues) && spreadsheetBlankMatrix(result.observed.formulas) && result.observed.verified === true
  }
  if (operation === 'remove_duplicates') {
    const plan = spreadsheetP0Plan(operation, payload, precondition); const columns = payload.columns; const hasHeader = payload.hasHeader !== false
    if (!plan || !Array.isArray(columns) || columns.length === 0 || columns.some((column) => !Number.isInteger(column) || column < 1 || column > plan.sourceState.values[0]?.length) || new Set(columns).size !== columns.length) return false
    const expectedValues = hasHeader ? [plan.sourceState.values[0].slice()] : []; const expectedFormulas = hasHeader ? [plan.sourceState.formulas[0].slice()] : []; const seen = new Set(); let removed = 0
    for (let index = hasHeader ? 1 : 0; index < plan.sourceState.values.length; index += 1) { const value = plan.sourceState.values[index]; const key = columns.map((column) => spreadsheetDuplicateKey(value[column - 1])).join('\u001f'); if (seen.has(key)) removed += 1; else { seen.add(key); expectedValues.push(value.slice()); expectedFormulas.push(plan.sourceState.formulas[index].slice()) } }
    while (expectedValues.length < plan.sourceState.values.length) { expectedValues.push(Array(plan.sourceState.values[0].length).fill(null)); expectedFormulas.push(Array(plan.sourceState.values[0].length).fill('')) }
    return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.columns, columns) && result.requested.hasHeader === hasHeader && jsonMatches(result.observed.values, expectedValues) && jsonMatches(result.observed.formulas, expectedFormulas) && result.observed.duplicateRowsRemoved === removed
  }
  if (operation === 'move_range') {
    const plan = spreadsheetP0Plan(operation, payload, precondition); if (!plan) return false
    return result.requested.range === payload.range && result.requested.destination === payload.destination && result.requested.outputRange === plan.output && result.observed.range === payload.range && result.observed.outputRange === plan.output && result.observed.sourceBlank === true && spreadsheetSameShape(result.observed.sourceValues, plan.sourceState.values) && spreadsheetSameShape(result.observed.sourceFormulas, plan.sourceState.formulas) && spreadsheetBlankMatrix(result.observed.sourceValues) && spreadsheetBlankMatrix(result.observed.sourceFormulas) && jsonMatches(result.observed.values, plan.sourceState.values) && jsonMatches(result.observed.formulas, plan.sourceState.formulas) && jsonMatches(result.observed.format, plan.sourceState.format) && result.observed.merged === plan.sourceState.merged && result.observed.verified === true
  }
  return false
}

function validTeamParent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => ['parentId', 'bookId', 'parentName', 'parentType', 'fingerprint', 'canRead', 'canCreate'].includes(key))
    && ['parentId', 'bookId', 'parentName', 'fingerprint'].every((key) => typeof value[key] === 'string' && value[key].length > 0)
    && value.canRead === true && value.canCreate === true
}
function validTeamKnowledgeParent(value) {
  return validTeamParent(value) && typeof value.parentType === 'string' && value.parentType.length > 0
}
const TEAM_KNOWLEDGE_LIGHT_STAGES = ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified']
const TEAM_KNOWLEDGE_SPREADSHEET_STAGES = ['parent_inspected', 'created', 'rediscovered', 'identity_readback_verified']
function validTeamKnowledgeItem(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.catalogId === 'string' && /^\d+$/.test(value.catalogId)
    && ['light_document', 'spreadsheet'].includes(value.kind)
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.url === 'string' && value.url.startsWith('https://doc.midea.com/')
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0
}
function validTeamKnowledgeStages(value, kind) {
  const expected = kind === 'light_document' ? TEAM_KNOWLEDGE_LIGHT_STAGES : TEAM_KNOWLEDGE_SPREADSHEET_STAGES
  if (!Array.isArray(value)) return false
  let previous = -1
  for (const stage of value) { const index = expected.indexOf(stage); if (index <= previous) return false; previous = index }
  return true
}
function validTeamKnowledgeItemResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['verified_write', 'partial_delivery', 'ok'].includes(value.status)) return false
  if (value.status === 'ok') return validTeamKnowledgeParent(value.parent) || (validTeamKnowledgeItem(value.item) && value.readback && typeof value.readback === 'object')
  if (value.status === 'verified_write') return validTeamKnowledgeItem(value.item)
    && validTeamKnowledgeStages(value.stages, value.item.kind) && value.stages.length === (value.item.kind === 'light_document' ? 5 : 4)
    && value.readback && typeof value.readback === 'object'
  if ((value.item !== null && !validTeamKnowledgeItem(value.item)) || !Array.isArray(value.stages) || !['inspect', 'create', 'rediscover', 'write', 'readback', 'unsupported'].includes(value.failedAt)
    || typeof value.error !== 'string' || value.error.length === 0) return false
  return value.diagnostic === undefined || (value.diagnostic && typeof value.diagnostic === 'object' && Number.isInteger(value.diagnostic.httpStatus) && (typeof value.diagnostic.errorCode === 'string' || value.diagnostic.errorCode === null))
}
function teamKnowledgeTargetFingerprint(target, parent, kind) {
  return hash(JSON.stringify({ browser: target.browser, windowId: target.windowId, tabId: target.tabId, url: target.url, parentFingerprint: parent.fingerprint, kind }))
}
function teamKnowledgeContentHash(kind, name, body) { return hash(JSON.stringify({ kind, name, body })) }
function validTeamKnowledgeItemArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string') return false
  const keys = Object.keys(args)
  if (args.action === 'inspect_parent') return keys.length === 1
  if (args.action === 'preview') return (keys.length === 4 || keys.length === 5) && (args.parentFingerprint === undefined || typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0)
    && ['light_document', 'spreadsheet'].includes(args.kind) && typeof args.name === 'string' && args.name.trim().length > 0 && args.name.length <= 120
    && typeof args.body === 'string' && args.body.length <= 100000 && (args.kind === 'spreadsheet' || args.body.trim().length > 0)
  if (args.action === 'create') return keys.length === 6 && typeof args.challenge === 'string' && args.challenge.length > 0
    && typeof args.idempotencyIdentity === 'string' && args.idempotencyIdentity.length > 0 && args.idempotencyIdentity.length <= 128
    && ['light_document', 'spreadsheet'].includes(args.kind) && typeof args.name === 'string' && args.name.trim().length > 0 && args.name.length <= 120
    && typeof args.body === 'string' && args.body.length <= 100000 && (args.kind === 'spreadsheet' || args.body.trim().length > 0)
  return args.action === 'readback' && keys.length === 3 && ['light_document', 'spreadsheet'].includes(args.kind) && typeof args.catalogId === 'string' && /^\d+$/.test(args.catalogId)
}
function validTeamKnowledgeBatchItems(items) {
  return Array.isArray(items) && items.length >= 1 && items.length <= 10
    && items.every((item) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2
      && typeof item.name === 'string' && item.name === item.name.trim() && item.name.length > 0 && item.name.length <= 120
      && typeof item.body === 'string' && item.body.trim().length > 0 && item.body.length <= 100000)
    && new Set(items.map((item) => item.name.normalize('NFKC'))).size === items.length
}
function validTeamKnowledgeBatchArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string') return false
  const keys = Object.keys(args)
  if (args.action === 'inspect_parent') return keys.length === 1
  if (args.action === 'status') return keys.length === 2 && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
  if (args.action === 'preview') return (keys.length === 3 || keys.length === 4) && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
    && (args.parentFingerprint === undefined || typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0 && args.parentFingerprint.length <= 256) && validTeamKnowledgeBatchItems(args.items)
  return args.action === 'create' && keys.length === 4 && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
    && typeof args.challenge === 'string' && args.challenge.length > 0 && args.challenge.length <= 256 && validTeamKnowledgeBatchItems(args.items)
}
function teamKnowledgeBatchFingerprint(items) {
  return hash(JSON.stringify(items.map((item) => ({ name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) }))))
}
function validVerifiedTeamKnowledgeBatchItem(result, approved, persisted = false) {
  if (!validTeamKnowledgeItemResult(result) || result.status !== 'verified_write' || result.item?.kind !== 'light_document' || result.item?.name !== approved.name) return false
  if (typeof result.item.catalogId !== 'string' || !/^\d+$/.test(result.item.catalogId) || !Array.isArray(result.stages)) return false
  if (!['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'].every((stage) => result.stages.includes(stage))) return false
  try {
    const url = new URL(result.item.url)
    if (url.origin !== 'https://doc.midea.com' || !url.pathname.includes(result.item.catalogId)) return false
  } catch { return false }
  return persisted || result.readback?.body === approved.body
}

const PMD_DOCUMENT_KINDS = ['analysis', 'prd']
function validPmdDocuments(value, requirementId) {
  if (!Array.isArray(value) || value.length !== 2) return false
  const byKind = new Map(value.map((item) => [item?.kind, item]))
  if (byKind.size !== 2 || PMD_DOCUMENT_KINDS.some((kind) => !byKind.has(kind))) return false
  return PMD_DOCUMENT_KINDS.every((kind) => {
    const item = byKind.get(kind)
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3) return false
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 120 || typeof item.body !== 'string' || item.body.trim().length === 0 || item.body.length > 100000) return false
    const suffix = kind === 'analysis' ? '_01_需求分析与研发交付' : '_02_PRD'
    return item.name.startsWith(`${requirementId}_`) && item.name.endsWith(suffix)
  })
}
function normalizedPmdDocuments(value) {
  return PMD_DOCUMENT_KINDS.map((kind) => value.find((item) => item.kind === kind))
}
function pmdContentFingerprint(documents) {
  return hash(JSON.stringify(normalizedPmdDocuments(documents).map((item) => ({ kind: item.kind, name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) }))))
}
function validPmdDeliveryArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string') return false
  const keys = Object.keys(args)
  if (args.action === 'inspect_parent') return keys.length === 1
  const validIdentity = typeof args.requirementId === 'string' && args.requirementId.trim().length > 0 && args.requirementId.length <= 64
    && typeof args.deliveryRunId === 'string' && args.deliveryRunId.trim().length > 0 && args.deliveryRunId.length <= 80
  if (args.action === 'status') return keys.length === 3 && validIdentity
  if (args.action === 'preview') return keys.length === 5 && validIdentity && typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0 && args.parentFingerprint.length <= 256 && validPmdDocuments(args.documents, args.requirementId)
  return args.action === 'create' && keys.length === 5 && validIdentity && typeof args.challenge === 'string' && args.challenge.length > 0 && args.challenge.length <= 256 && validPmdDocuments(args.documents, args.requirementId)
}
const TEAM_DOC_STAGES = ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified']
function validTeamDocStages(value) {
  if (!Array.isArray(value)) return false
  let previous = -1
  for (const stage of value) {
    const index = TEAM_DOC_STAGES.indexOf(stage)
    if (index <= previous) return false
    previous = index
  }
  return true
}
function validTeamDocResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !validTeamDocStages(value.stages)) return false
  if (value.status === 'verified_write') {
    return typeof value.documentId === 'string' && /^\d+$/.test(value.documentId)
      && value.readbackMatches === true
      && JSON.stringify(value.stages) === JSON.stringify(TEAM_DOC_STAGES)
      && (value.observedBody === undefined || typeof value.observedBody === 'string')
  }
  if (value.status !== 'partial_delivery' || value.readbackMatches !== false
    || !((typeof value.documentId === 'string' && /^\d+$/.test(value.documentId)) || value.documentId === null)
    || !['inspect', 'create', 'rediscover', 'write', 'readback'].includes(value.failedAt)
    || typeof value.error !== 'string' || value.error.length === 0) return false
  if (value.diagnostic !== undefined && (!value.diagnostic || typeof value.diagnostic !== 'object'
    || !Number.isInteger(value.diagnostic.httpStatus)
    || !(typeof value.diagnostic.errorCode === 'string' || value.diagnostic.errorCode === null))) return false
  return value.observedBody === undefined || typeof value.observedBody === 'string'
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function flatSelectionReplaceIdentity(challenge) {
  // Challenge values are server-generated one-time random values. Hashing keeps
  // them out of storage/logs while this namespace cannot collide with a model
  // supplied office_document identity.
  return `flat-selection:${hash(challenge).slice(0, 48)}`
}
function teamDocTargetFingerprint(target, parent) {
  return hash(JSON.stringify({ browser: target.browser, windowId: target.windowId, tabId: target.tabId, url: target.url, parentFingerprint: parent.fingerprint }))
}
function validTeamDocInspectArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || args.phase !== 'inspect') return false
  const allowed = new Set(['phase', 'challenge', 'idempotencyIdentity', 'name', 'body'])
  return Object.keys(args).every((key) => allowed.has(key)
    && (key === 'phase' || args[key] === ''))
}
function teamDocInspectFailureText(result) {
  const diagnostic = result?.diagnostic
  if (!diagnostic || typeof diagnostic !== 'object' || typeof diagnostic.stage !== 'string'
    || !Number.isInteger(diagnostic.httpStatus)
    || !(typeof diagnostic.errorCode === 'string' || diagnostic.errorCode === null)) return result.error
  const attempts = Array.isArray(diagnostic.attempts)
    ? diagnostic.attempts.filter((attempt) => attempt && typeof attempt === 'object'
      && typeof attempt.stage === 'string' && Number.isInteger(attempt.httpStatus)
      && (typeof attempt.errorCode === 'string' || attempt.errorCode === null))
    : []
  const attemptsText = attempts.length === 0
    ? ''
    : `; attempts=${attempts.map((attempt) => `${attempt.stage}:${attempt.httpStatus}/${attempt.errorCode ?? 'null'}`).join(',')}`
  return `${result.error}; stage=${diagnostic.stage}; httpStatus=${diagnostic.httpStatus}; errorCode=${diagnostic.errorCode ?? 'null'}${attemptsText}`
}

function validOfficeReadFailure(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
    && ['unsupported', 'preview', 'readonly', 'invalid_range', 'navigation', 'iframe_replaced', 'timeout', 'cancelled', 'fingerprint_mismatch', 'readback_mismatch', 'runtime_error'].includes(value.code)
    && typeof value.message === 'string' && value.message.length > 0
}

function validBrowserOpenTabArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.url !== 'string') return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function validPageIdentity(value, browserTarget) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && typeof value.title === 'string' && value.url === browserTarget.url
}

function validBrowserOpenTabOutput(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 5
    && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.generation === 'string' && value.generation.length > 0
    && validBrowserTarget(value.browserTarget)
    && validPageIdentity(value.pageIdentity, value.browserTarget)
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON-RPC request')
  }
}

const KNOWLEDGE_API_ORIGIN = 'https://anapi-uat.annto.com'
const KNOWLEDGE_API_PREFIX = '/api-sse-kd'
const KNOWLEDGE_PROXY_PATH = '/knowledge-proxy'
const KNOWLEDGE_MAX_COOKIE_HEADER_LENGTH = 64_000
const KNOWLEDGE_ALLOWED_GET_PATHS = new Set(['/api/auth/me', '/api/tags/controlled-vocabulary', '/api/domains', '/api/domains/systems', '/api/repos'])
const KNOWLEDGE_ALLOWED_POST_PATHS = new Set(['/api/rag/retrieval', '/api/rag/repo-search'])
const KNOWLEDGE_TRANSPORT_RETRY_LIMIT = 2
const KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS = 250
const RETRYABLE_KNOWLEDGE_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/** Render a thrown value with its cause chain so undici's `fetch failed` stays diagnostic. */
export function knowledgeErrorChain(value) {
  const path = new Set()
  const render = (current) => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const message = typeof current.message === 'string' ? current.message : undefined
          const code = typeof current.code === 'string' ? current.code : undefined
          if (message && code && !message.includes(code)) return `${message}: ${code}`
          if (message) return message
          if (code) return code
          try { return JSON.stringify(current) } catch { return Object.prototype.toString.call(current) }
        }
        return String(current)
      }
      const code = typeof current.code === 'string' ? current.code : undefined
      let text = current.message || current.name
      if (code && !text.includes(code)) text = `${text}: ${code}`
      if (current.cause !== undefined) {
        const cause = render(current.cause)
        if (cause && cause !== text && !text.includes(cause)) text = `${text}: ${cause}`
      }
      return text
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

function knowledgeTransportCode(value) {
  let current = value
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && typeof current.code === 'string' && current.code.length > 0) return current.code
    current = typeof current === 'object' && current !== null ? current.cause : undefined
  }
  return undefined
}

export function isRetryableKnowledgeTransport(error) {
  const code = knowledgeTransportCode(error)
  if (code !== undefined && RETRYABLE_KNOWLEDGE_TRANSPORT_CODES.has(code)) return true
  const text = knowledgeErrorChain(error)
  return /fetch failed|socket hang up|network error|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|other side closed/i.test(text)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validKnowledgeProxyRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.method !== 'GET' && value.method !== 'POST') return false
  if (typeof value.path !== 'string' || typeof value.cookie !== 'string' || value.cookie.length > KNOWLEDGE_MAX_COOKIE_HEADER_LENGTH || /[\r\n]/.test(value.cookie)) return false
  if (value.body !== undefined && (typeof value.body !== 'string' || value.body.length > 1_000_000)) return false
  if (value.headers !== undefined && (!Array.isArray(value.headers) || !value.headers.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === 'string')))) return false
  let target
  try { target = new URL(value.path, KNOWLEDGE_API_ORIGIN) } catch { return false }
  if (target.origin !== KNOWLEDGE_API_ORIGIN || !target.pathname.startsWith(`${KNOWLEDGE_API_PREFIX}/`)) return false
  const relative = target.pathname.slice(KNOWLEDGE_API_PREFIX.length)
  return value.method === 'GET' ? KNOWLEDGE_ALLOWED_GET_PATHS.has(relative) : KNOWLEDGE_ALLOWED_POST_PATHS.has(relative)
}

function knowledgeProxyHeaders(entries, cookie) {
  const allowed = new Set(['accept', 'content-type'])
  const headers = new Headers((entries ?? []).filter(([name]) => allowed.has(name.toLowerCase())))
  headers.set('cookie', cookie)
  headers.set('origin', 'https://wb-uat.annto.com')
  headers.set('referer', 'https://wb-uat.annto.com/')
  headers.set('cache-control', 'no-cache')
  return headers
}

/**
 * Stateless, authenticated MCP endpoint managed by the Native Host. It is
 * deliberately the narrow Issue #2 tracer-bullet: only office_get_context
 * crosses into Native Messaging.
 */
export class BrowserConnector {
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number, teamKnowledgeWriteRequestTimeoutMs?: number, knowledgeRequestTimeoutMs?: number, knowledgeCatalogTimeoutMs?: number, onToolsListed?: () => void, fetch?: typeof fetch, teamDocStore?: TeamDocRecordStore, teamKnowledgeBatchStore?: TeamKnowledgeBatchRecordStore, pmdDeliveryStore?: PmdDeliveryRecordStore, officeDocumentWriteStore?: OfficeDocumentWriteRecordStore, officeSpreadsheetWriteStore?: OfficeSpreadsheetWriteRecordStore }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.teamKnowledgeWriteRequestTimeoutMs = options.teamKnowledgeWriteRequestTimeoutMs ?? TEAM_KNOWLEDGE_WRITE_REQUEST_TIMEOUT_MS
    this.knowledgeRequestTimeoutMs = options.knowledgeRequestTimeoutMs ?? KNOWLEDGE_REQUEST_TIMEOUT_MS
    this.knowledgeCatalogTimeoutMs = options.knowledgeCatalogTimeoutMs ?? KNOWLEDGE_CATALOG_TIMEOUT_MS
    this.onToolsListed = options.onToolsListed
    this.fetch = options.fetch ?? fetch
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    this.browserTargets = new Map()
    this.browserTargetSets = new Map()
    this.unavailableBrowserTargets = new Map()
    this.currentRunId = undefined
    this.pending = new Map()
    this.teamDocChallenges = new Map()
    this.teamDocStore = options.teamDocStore ?? new TeamDocRecordStore()
    this.teamKnowledgeItemChallenges = new Map()
    this.teamKnowledgeBatchStore = options.teamKnowledgeBatchStore ?? new TeamKnowledgeBatchRecordStore()
    this.teamKnowledgeBatchChallenges = new Map()
    this.teamKnowledgeBatchLocks = new Map()
    this.pmdDeliveryStore = options.pmdDeliveryStore ?? new PmdDeliveryRecordStore()
    this.pmdDeliveryChallenges = new Map()
    this.pmdDeliveryLocks = new Map()
    this.officeDocumentChallenges = new Map()
    this.officeDocumentWrites = new Map()
    this.officeDocumentWriteStore = options.officeDocumentWriteStore ?? new OfficeDocumentWriteRecordStore()
    this.officeSpreadsheetChallenges = new Map()
    this.officeSpreadsheetWrites = new Map()
    this.officeSpreadsheetWriteStore = options.officeSpreadsheetWriteStore ?? new OfficeSpreadsheetWriteRecordStore()
  }

  /** @returns {Promise<{ url: string, token: string, generation: string }>} */
  start() {
    if (this.url && this.token && this.generation) {
      return Promise.resolve({ url: this.url, token: this.token, generation: this.generation })
    }
    this.token = randomBytes(32).toString('base64url')
    this.generation = randomUUID()
    this.server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    // Node's default requestTimeout is 300s and would cut a long RAG stream
    // before the product-owned knowledgeRequestTimeoutMs (30 minutes).
    this.server.requestTimeout = this.knowledgeRequestTimeoutMs
    this.server.headersTimeout = this.knowledgeRequestTimeoutMs
    this.server.keepAliveTimeout = 60_000
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Connector did not expose a TCP address'))
          return
        }
        this.url = `http://127.0.0.1:${String(address.port)}`
        resolve({ url: this.url, token: this.token, generation: this.generation })
      })
    })
  }

  /** @returns {Promise<void>} */
  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Browser Connector stopped'))
    }
    this.pending.clear()
    this.officeDocumentChallenges.clear()
    this.officeDocumentWrites.clear()
    this.officeSpreadsheetChallenges.clear()
    this.officeSpreadsheetWrites.clear()
    this.teamKnowledgeItemChallenges.clear()
    this.teamKnowledgeBatchChallenges.clear()
    this.pmdDeliveryChallenges.clear()
    this.browserTargets.clear()
    this.browserTargetSets.clear()
    this.unavailableBrowserTargets.clear()
    this.currentRunId = undefined
    const server = this.server
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** Register the Run selected by the Native Host, with or without browser capability. */
  registerRun(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (typeof runId !== 'string' || runId.length === 0) return false
    if (browserTarget !== undefined && !validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets)) return false
    if (this.currentRunId !== undefined && this.currentRunId !== runId) {
      this.officeDocumentChallenges.clear()
      this.officeDocumentWrites.clear()
      this.officeSpreadsheetChallenges.clear()
      this.officeSpreadsheetWrites.clear()
      this.teamKnowledgeItemChallenges.clear()
      this.teamKnowledgeBatchChallenges.clear()
      this.pmdDeliveryChallenges.clear()
    }
    this.currentRunId = runId
    if (validBrowserTarget(browserTarget)) {
      const targets = browserTargets ?? [browserTarget]
      const unavailable = unavailableBrowserTargets ?? []
      this.browserTargets.set(runId, Object.freeze({ ...browserTarget }))
      this.browserTargetSets.set(runId, Object.freeze(targets.map((target) => Object.freeze({ ...target }))))
      this.unavailableBrowserTargets.set(runId, Object.freeze(unavailable.map((item) => Object.freeze({ browserTarget: Object.freeze({ ...item.browserTarget }), reason: item.reason }))))
    }
    return true
  }

  /** Store one Browser Target that the trusted Extension confirmed for a Run. */
  bindBrowserTarget(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (!validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets)) return false
    return this.registerRun(runId, browserTarget, browserTargets, unavailableBrowserTargets)
  }

  /** Accept one correlated response received from the Extension peer. */
  acceptExtensionResponse(response) {
    if (!response || typeof response !== 'object' || response.type !== 'connector_response'
      || typeof response.requestId !== 'string') return false
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    const isOfficeContextRequest = pending.request.tool === 'office_get_context'
    const isOfficeReadRangeRequest = pending.request.tool === 'office_read_range'
    const isOfficeWriteRangeRequest = pending.request.tool === 'office_write_range'
    const isOfficeDocumentRequest = pending.request.tool === 'office_document'
    const isOfficeSpreadsheetRequest = pending.request.tool === 'office_spreadsheet'
    const isTeamDocRequest = pending.request.tool === 'team_doc_create'
    const isTeamKnowledgeItemRequest = pending.request.tool === 'team_knowledge_item'
    const isKnowledgeRequest = pending.request.tool === 'knowledge_search' || pending.request.tool === 'code_search'
    const isSelectedSourceScopeRequest = pending.request.tool === 'selected_source_scope'
    const isOfficeRequest = isOfficeContextRequest || isOfficeReadRangeRequest || isOfficeWriteRangeRequest || isOfficeDocumentRequest || isOfficeSpreadsheetRequest || isTeamDocRequest || isTeamKnowledgeItemRequest
    const sameOpenIdentity = response.runId === pending.request.runId && response.generation === pending.request.generation
    const currentTarget = this.browserTargets.get(pending.request.runId)
    const currentTargets = this.browserTargetSets.get(pending.request.runId) ?? (currentTarget === undefined ? undefined : [currentTarget])
    const currentUnavailable = this.unavailableBrowserTargets.get(pending.request.runId) ?? []
    const responseTargets = response.browserTargets ?? (response.browserTarget === undefined ? undefined : [response.browserTarget])
    const responseUnavailable = response.unavailableBrowserTargets ?? []
    const sameOfficeIdentity = sameOpenIdentity && sameBrowserTarget(response.browserTarget, currentTarget)
      && sameBrowserTargetList(responseTargets, currentTargets)
      && sameUnavailableBrowserTargetList(responseUnavailable, currentUnavailable)
    if ((isOfficeRequest && !sameOfficeIdentity) || (!isOfficeRequest && !sameOpenIdentity)) return false
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (!Object.hasOwn(response, 'result')) {
      // Office failures carry a structured {code, message} from the runtime;
      // transparency requires surfacing it verbatim (AGENTS §4) for every
      // office tool, not only the range/document ones. A spreadsheet failure
      // must never collapse into a generic "no Connector result".
      if ((isOfficeReadRangeRequest || isOfficeWriteRangeRequest || isOfficeDocumentRequest || isOfficeSpreadsheetRequest) && validOfficeReadFailure(response.error)) {
        pending.reject(new Error(JSON.stringify(response.error)))
      } else if (typeof response.error === 'string' && response.error.length > 0) {
        pending.reject(new Error(response.error))
      } else {
        pending.reject(new Error('Extension peer returned no Connector result'))
      }
      return true
    }
    if (isTeamDocRequest) {
      if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) { pending.reject(new Error('Extension peer returned an invalid Team Doc result')); return true }
      pending.resolve({ browserTarget: response.browserTarget, teamDoc: response.result }); return true
    }
    if (isTeamKnowledgeItemRequest) {
      if (!validTeamKnowledgeItemResult(response.result)) { pending.reject(new Error('Extension peer returned an invalid Team Knowledge item result')); return true }
      pending.resolve({ browserTarget: response.browserTarget, teamKnowledgeItem: response.result }); return true
    }
    if (isOfficeSpreadsheetRequest && ((pending.request.action === 'write' && !validOfficeSpreadsheetWriteResult(response.result)) || (pending.request.action !== 'write' && !validOfficeSpreadsheetReadResult(response.result, pending.request.action, pending.request)))) {
      pending.reject(new Error('Extension peer returned an invalid spreadsheet result')); return true
    }
    if (isKnowledgeRequest) {
      if (!validKnowledgeResult(response.result)) { pending.reject(new Error('Extension peer returned an invalid Knowledge Platform result')); return true }
      pending.resolve(response.result)
      return true
    }
    if (isSelectedSourceScopeRequest) {
      if (!validSelectedSourceScopeResult(response.result)) { pending.reject(new Error('Extension peer returned an invalid selected-source scope result')); return true }
      pending.resolve(response.result)
      return true
    }
    if (isOfficeContextRequest && !validOfficeContext(response.result, response.browserTarget)) {
      pending.reject(new Error('Extension peer returned an invalid canonical Office context schema'))
      return true
    }
    if (isOfficeReadRangeRequest && !validOfficeReadRangeResult(response.result)) {
      pending.reject(new Error('Extension peer returned an invalid bounded Office range schema'))
      return true
    }
    if (isOfficeWriteRangeRequest && !validOfficeWriteRangeResult(response.result)) {
      pending.reject(new Error('Extension peer returned an invalid verified Office write schema'))
      return true
    }
    if (isOfficeDocumentRequest && ((pending.request.action === 'write' && !verifiedLightDocumentWriteMatches(response.result, pending.request))
      || (pending.request.action !== 'write' && !validOfficeDocumentReadResult(response.result)))) {
      pending.reject(new Error('Extension peer returned an invalid light-document result'))
      return true
    }
    if (!isOfficeRequest) {
      if (!validBrowserTarget(response.browserTarget) || !validPageIdentity(response.result.pageIdentity, response.browserTarget)) {
        pending.reject(new Error('Extension peer returned an invalid browser_open_tab result'))
        return true
      }
      pending.resolve({ browserTarget: response.browserTarget, pageIdentity: response.result.pageIdentity })
      return true
    }
    pending.resolve(isOfficeSpreadsheetRequest ? { browserTarget: response.browserTarget, result: response.result } : isOfficeWriteRangeRequest ? {
      browserTarget: response.browserTarget, resource: response.result.resource, requested: response.result.requested, observed: response.result.observed,
    } : isOfficeReadRangeRequest ? {
      browserTarget: response.browserTarget,
      range: response.result.range,
      resource: response.result.resource,
    } : isOfficeDocumentRequest ? {
      browserTarget: response.browserTarget,
      result: response.result,
    } : {
      browserTarget: response.browserTarget,
      browserTargets: responseTargets,
      unavailableBrowserTargets: response.result.unavailableBrowserTargets ?? responseUnavailable,
      officeContext: response.result,
    })
    return true
  }

  async #handle(request, response) {
    if (request.url !== MCP_PATH && request.url !== KNOWLEDGE_PROXY_PATH) {
      response.writeHead(404)
      response.end()
      return
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }

    if (request.url === KNOWLEDGE_PROXY_PATH) {
      await this.#proxyKnowledge(request, response)
      return
    }

    let message
    try {
      message = await readJson(request)
    } catch (error) {
      this.#reply(response, errorResponse(null, -32700, error.message))
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      this.#reply(response, errorResponse(message?.id, -32600, 'invalid JSON-RPC request'))
      return
    }

    if (message.method === 'notifications/initialized') {
      response.writeHead(202)
      response.end()
      return
    }
    if (message.method === 'initialize') {
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'deepseek-harness-browser-connector', version: '0.1.0' },
        },
      })
      return
    }
    if (message.method === 'tools/list') {
      this.onToolsListed?.()
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: [officeGetContextTool, officeReadRangeTool, officeWriteRangeTool, officeDocumentTool, lightDocumentReadTool, lightDocumentSelectionReadTool, lightDocumentSelectionReplacePreviewTool, lightDocumentSelectionReplaceCommitTool, officeSpreadsheetTool, teamKnowledgeSpreadsheetPreviewTool, teamKnowledgeSpreadsheetCreateTool, teamKnowledgeSpreadsheetReadbackTool, teamKnowledgeBatchPreviewTool, teamKnowledgeBatchCreateTool, teamKnowledgeBatchStatusTool, pmdPrdDeliveryTool, browserOpenTabTool, knowledgeSearchTool, codeSearchTool, selectedSourceScopeTool] } })
      return
    }
    if (message.method !== 'tools/call') {
      this.#reply(response, errorResponse(message.id, -32601, 'method not found'))
      return
    }
    if (message.params?.name === 'browser_open_tab') {
      await this.#openBrowserTab(message, response)
      return
    }
    if (message.params?.name === 'office_read_range') {
      await this.#readOfficeRange(message, response)
      return
    }
    if (message.params?.name === 'office_write_range') {
      await this.#writeOfficeRange(message, response)
      return
    }
    if (message.params?.name === 'office_document') {
      await this.#officeDocument(message, response)
      return
    }
    if (['light_document_read', 'light_document_selection_read', 'light_document_selection_replace_preview', 'light_document_selection_replace_commit'].includes(message.params?.name)) {
      await this.#flatLightDocument(message, response)
      return
    }
    if (message.params?.name === 'office_spreadsheet') {
      await this.#officeSpreadsheet(message, response)
      return
    }
    if (message.params?.name === 'team_doc_create') {
      await this.#teamDoc(message, response)
      return
    }
    if (message.params?.name === 'team_knowledge_item') {
      await this.#teamKnowledgeItem(message, response)
      return
    }
    const spreadsheetAction = ({ team_knowledge_spreadsheet_preview: 'preview', team_knowledge_spreadsheet_create: 'create', team_knowledge_spreadsheet_readback: 'readback' })[message.params?.name]
    if (spreadsheetAction !== undefined) {
      await this.#teamKnowledgeItem({ ...message, params: { ...message.params, arguments: { ...(message.params?.arguments ?? {}), action: spreadsheetAction, kind: 'spreadsheet' } } }, response)
      return
    }
    if (message.params?.name === 'team_knowledge_batch') {
      await this.#teamKnowledgeBatch(message, response)
      return
    }
    const batchAction = ({ team_knowledge_batch_preview: 'preview', team_knowledge_batch_create: 'create', team_knowledge_batch_status: 'status' })[message.params?.name]
    if (batchAction !== undefined) {
      await this.#teamKnowledgeBatch({ ...message, params: { ...message.params, arguments: { ...(message.params?.arguments ?? {}), action: batchAction } } }, response)
      return
    }
    if (message.params?.name === 'pmd_prd_delivery') {
      await this.#pmdPrdDelivery(message, response)
      return
    }
    if (message.params?.name === 'knowledge_search' || message.params?.name === 'code_search') {
      await this.#knowledgeSearch(message, response)
      return
    }
    if (message.params?.name === 'selected_source_scope') {
      await this.#selectedSourceScope(message, response)
      return
    }
    if (message.params?.name !== 'office_get_context' || !validOfficeGetContextArguments(message.params.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'office_get_context accepts no model-controlled target arguments'))
      return
    }

    const runId = this.currentRunId
    const boundTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }

    const requestId = randomUUID()
    const browserTargets = this.browserTargetSets.get(runId) ?? [boundTarget]
    const unavailableBrowserTargets = this.unavailableBrowserTargets.get(runId) ?? []
    const isMultiTarget = browserTargets.length > 1 || unavailableBrowserTargets.length > 0
    const correlation = {
      type: 'connector_request',
      requestId,
      runId,
      generation: this.generation,
      browserTarget: boundTarget,
      ...(isMultiTarget ? { browserTargets, unavailableBrowserTargets } : {}),
      tool: 'office_get_context',
    }
    try {
      const resolved = await this.#requestExtension(correlation)
      const structuredContent = {
        runId: correlation.runId,
        requestId: correlation.requestId,
        generation: correlation.generation,
        browserTarget: resolved.browserTarget,
        officeContext: resolved.officeContext,
        ...(isMultiTarget ? {
          primaryBrowserTarget: resolved.browserTarget,
          browserTargets: resolved.browserTargets,
          unavailableBrowserTargets: resolved.unavailableBrowserTargets,
        } : {}),
      }
      if (!validOfficeGetContextOutput(structuredContent)) {
        throw new Error('Browser Connector produced an invalid canonical Office context schema')
      }
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
        },
      })
    } catch (error) {
      this.#reply(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Browser Connector request failed' }],
          isError: true,
        },
      })
    }
  }

  async #proxyKnowledge(request, response) {
    let message
    try { message = await readJson(request) } catch {
      response.writeHead(400); response.end('invalid knowledge proxy request'); return
    }
    if (!validKnowledgeProxyRequest(message)) {
      response.writeHead(400); response.end('invalid knowledge proxy request'); return
    }
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    request.once('aborted', abortUpstream)
    response.once('close', abortUpstream)
    const timeout = setTimeout(() => controller.abort(), message.method === 'GET' ? this.knowledgeCatalogTimeoutMs : this.knowledgeRequestTimeoutMs)
    try {
      const target = new URL(message.path, `${KNOWLEDGE_API_ORIGIN}${KNOWLEDGE_API_PREFIX}/`)
      const init = {
        method: message.method,
        headers: knowledgeProxyHeaders(message.headers, message.cookie),
        redirect: 'follow',
        signal: controller.signal,
        ...(message.method === 'POST' ? { body: message.body ?? '' } : {}),
      }
      let lastError
      let upstream
      for (let attempt = 0; attempt <= KNOWLEDGE_TRANSPORT_RETRY_LIMIT; attempt += 1) {
        try {
          upstream = await this.fetch(target, init)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          const aborted = controller.signal.aborted
          if (aborted || !isRetryableKnowledgeTransport(error) || attempt === KNOWLEDGE_TRANSPORT_RETRY_LIMIT) throw error
          await delay(KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS * (attempt + 1))
        }
      }
      if (upstream === undefined) throw lastError ?? new Error('knowledge_proxy_unreachable')
      // Undici has already decoded the upstream body. Forwarding the original
      // content-encoding would make Chrome decode the same bytes a second time.
      const responseHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())))
      responseHeaders['x-knowledge-final-url'] = upstream.url
      responseHeaders['x-knowledge-redirected'] = String(upstream.redirected)
      response.writeHead(upstream.status, responseHeaders)
      if (upstream.body === null) { response.end(); return }
      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) await new Promise((resolve) => response.once('drain', resolve))
      }
      response.end()
    } catch (error) {
      if (controller.signal.aborted && (request.aborted || response.destroyed)) return
      if (!response.headersSent) response.writeHead(502)
      if (!response.destroyed) response.end(`Knowledge proxy failed: ${knowledgeErrorChain(error)}`)
    } finally {
      clearTimeout(timeout)
      request.off('aborted', abortUpstream)
      response.off('close', abortUpstream)
    }
  }

  async #readOfficeRange(message, response) {
    if (!validOfficeReadRangeArguments(message.params?.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'office_read_range requires one bounded A1 range argument'))
      return
    }
    const runId = this.currentRunId
    const boundTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }
    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation,
      browserTarget: boundTarget, tool: 'office_read_range', range: message.params.arguments.range.trim(),
    }
    try {
      const resolved = await this.#requestExtension(correlation)
      const structuredContent = {
        runId: correlation.runId, requestId: correlation.requestId, generation: correlation.generation,
        browserTarget: resolved.browserTarget, resource: resolved.resource, range: resolved.range,
      }
      if (!validOfficeReadRangeOutput(structuredContent)) throw new Error('Browser Connector produced an invalid bounded Office range schema')
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Browser Connector request failed'
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: failure }], isError: true } })
    }
  }

  async #knowledgeSearch(message, response) {
    const kind = message.params.name === 'knowledge_search' ? 'knowledge_search' : 'code_search'
    if (!validKnowledgeArguments(message.params.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, `${kind} requires one bounded question argument`))
      return
    }
    const identity = harnessIdentity(message)
    if (identity === undefined || identity.parentSessionId === undefined) {
      const wrapper = kind === 'code_search' ? 'search_selected_remote_code' : 'search_selected_knowledge'
      const label = kind === 'code_search' ? 'Code search' : 'Knowledge search'
      this.#toolError(response, message.id, `${label} is available only inside the continuable ${kind === 'code_search' ? 'remote-code' : 'Knowledge'} subagent. From the parent session, call ${wrapper} with description and prompt.`)
      return
    }
    const runId = this.currentRunId
    if (runId === undefined) {
      this.#toolError(response, message.id, 'No active Harness Run is available for Knowledge search.')
      return
    }
    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, tool: kind,
      harnessSessionId: identity.sessionId, ...(identity.parentSessionId === undefined ? {} : { harnessParentSessionId: identity.parentSessionId }),
      question: message.params.arguments.question.trim(),
    }
    try {
      const result = await this.#requestExtension(correlation, response, this.knowledgeRequestTimeoutMs)
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) {
      this.#toolError(response, message.id, knowledgeErrorChain(error))
    }
  }

  async #selectedSourceScope(message, response) {
    if (!validSelectedSourceScopeArguments(message.params?.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'selected_source_scope accepts no model-controlled arguments'))
      return
    }
    const identity = harnessIdentity(message)
    if (identity === undefined) {
      this.#toolError(response, message.id, 'selected_source_scope requires a Harness session identity.')
      return
    }
    const runId = this.currentRunId
    if (runId === undefined) {
      this.#toolError(response, message.id, 'No active Harness Run is available for selected-source scope.')
      return
    }
    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, tool: 'selected_source_scope',
      harnessSessionId: identity.sessionId, ...(identity.parentSessionId === undefined ? {} : { harnessParentSessionId: identity.parentSessionId }),
    }
    try {
      const result = await this.#requestExtension(correlation, response)
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Selected-source scope request failed')
    }
  }

  async #writeOfficeRange(message, response) {
    if (!validOfficeWriteRangeArguments(message.params?.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'office_write_range requires a bounded A1 range, rectangular values, and a prior read resource fingerprint'))
      return
    }
    const runId = this.currentRunId
    const boundTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }
    const args = message.params.arguments
    const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: boundTarget, tool: 'office_write_range', range: args.range.trim(), values: args.values, resource: args.resource }
    try {
      const resolved = await this.#requestExtension(correlation)
      const structuredContent = { runId: correlation.runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, resource: resolved.resource, requested: resolved.requested, observed: resolved.observed }
      if (!validOfficeWriteRangeOutput(structuredContent)) throw new Error('Browser Connector produced an invalid verified Office write schema')
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Browser Connector write request failed'
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: failure }], isError: true } })
    }
  }

  async #flatLightDocument(message, response) {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (!validFlatLightDocumentArguments(name, args)) {
      this.#reply(response, errorResponse(message.id, -32602, `${name} received invalid arguments; use its flat schema exactly.`))
      return
    }
    // Read-only flat tools deliberately reuse the proven office_document
    // routing path.  The extension still owns frame discovery and the model
    // cannot supply a Browser Target or resource identity.
    if (name === 'light_document_read' || name === 'light_document_selection_read') {
      await this.#officeDocument({ ...message, params: { ...message.params, arguments: name === 'light_document_read' ? { action: 'read', ...args } : { action: 'selection' } } }, response)
      return
    }
    const runId = this.currentRunId
    const browserTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (name === 'light_document_selection_replace_commit') {
      const grant = this.officeDocumentChallenges.get(args.challenge)
      if (!grant || grant.flatSelectionReplace !== true || !grant.payload || typeof grant.idempotencyIdentity !== 'string') { this.#toolError(response, message.id, 'Selected-content approval challenge is missing, stale, or not issued by preview.'); return }
      // Do not permit any raw action, operation, target, or body to enter this
      // endpoint.  Commit reconstitutes exactly what preview approved.
      await this.#officeDocument({ ...message, params: { ...message.params, arguments: { action: 'write', challenge: args.challenge, idempotencyIdentity: grant.idempotencyIdentity, operation: 'selection_blocks_replace', payload: grant.payload } } }, response)
      return
    }
    const selectionCorrelation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_document', action: 'selection' }
    try {
      const selected = await this.#requestExtension(selectionCorrelation)
      if (!validOfficeDocumentReadResult(selected.result)) throw new Error('Browser Connector produced an invalid light-document selection')
      const selection = selected.result.document?.selection
      const selectionFingerprint = selection?.selectionFingerprint
      if (!selection?.supported || selection?.truncated || selection?.isCollapsed || selection?.stable !== true || typeof selectionFingerprint !== 'string') throw new Error('The current light-document selection is not a complete stable non-collapsed selection.')
      const payload = { blocks: args.blocks, expectedSelectionFingerprint: selectionFingerprint }
      if (!validLightDocumentOperationPayload('selection_blocks_replace', payload)) throw new Error('The requested replacement blocks are invalid.')
      // Re-inspect after selection.  The resulting resource identity is the
      // write approval fence, so a navigation/content change cannot be hidden
      // between preview and commit.
      const inspectCorrelation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_document', action: 'inspect_write', operation: 'selection_blocks_replace', payload }
      const inspected = await this.#requestExtension(inspectCorrelation)
      if (!validOfficeDocumentReadResult(inspected.result) || inspected.result.resource.fingerprint !== selected.result.resource.fingerprint) throw new Error('The light document changed while preparing selected-content replacement.')
      const challenge = randomBytes(32).toString('base64url')
      for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
      if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
      this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: inspected.result.resource, operation: 'selection_blocks_replace', payload, payloadHash: lightDocumentWriteHash('selection_blocks_replace', payload), idempotencyIdentity: flatSelectionReplaceIdentity(challenge), flatSelectionReplace: true, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
      const result = { runId, requestId: inspectCorrelation.requestId, generation: this.generation, browserTarget: inspected.browserTarget, action: 'selection_blocks_replace_preview', resource: inspected.result.resource, selection, blocks: args.blocks, challenge }
      this.#reply(response, lightDocumentToolResponse(message.id, result))
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document selection preview failed')
    }
  }

  async #officeDocument(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validOfficeDocumentArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, officeDocumentArgumentsHint(args)))
      return
    }
    const runId = this.currentRunId
    const browserTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(browserTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }

    if (args.action === 'write') {
      const grant = this.officeDocumentChallenges.get(args.challenge)
      this.officeDocumentChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) {
        this.#toolError(response, message.id, 'Light-document approval challenge is missing, stale, or already used.')
        return
      }
      const payloadHash = lightDocumentWriteHash(args.operation, args.payload)
      if (grant.operation !== args.operation || grant.payloadHash !== payloadHash) {
        this.#toolError(response, message.id, 'Light-document approval does not match this operation and payload.')
        return
      }
      const requestFingerprint = hash(canonicalJson([grant.resource.fingerprint, args.operation, args.payload]))
      const existing = this.officeDocumentWrites.get(args.idempotencyIdentity)
      if (existing !== undefined) {
        if (existing.fingerprint !== requestFingerprint) {
          this.#toolError(response, message.id, 'Light-document idempotency identity conflicts with the approved document or payload.')
          return
        }
        this.#reply(response, lightDocumentToolResponse(message.id, existing.result))
        return
      }
      let checkpoint
      try {
        checkpoint = await this.officeDocumentWriteStore.create({
          idempotencyIdentity: args.idempotencyIdentity, targetFingerprint: hash(canonicalJson(browserTarget)), resourceFingerprint: grant.resource.fingerprint,
          operation: args.operation, payloadHash,
        })
      } catch (error) {
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Could not persist the light-document write fence.')
        return
      }
      if (!checkpoint.createdNew) {
        this.#toolError(response, message.id, checkpoint.record.state === 'verified'
          ? 'This idempotency identity was already verified; reread the document before continuing.'
          : 'This idempotency identity is uncertain after an interrupted write; automatic retry is forbidden. Reread and resolve manually.')
        return
      }
      const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_document', action: 'write', operation: args.operation, payload: args.payload, resource: grant.resource }
      try {
        const resolved = await this.#requestExtension(correlation)
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        if (!verifiedLightDocumentWriteMatches(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid verified light-document write')
        await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'verified')
        if (this.officeDocumentWrites.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentWrites.delete(this.officeDocumentWrites.keys().next().value)
        this.officeDocumentWrites.set(args.idempotencyIdentity, { fingerprint: requestFingerprint, result })
        this.#reply(response, lightDocumentToolResponse(message.id, result))
      } catch (error) {
        try { await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document write failed')
      }
      return
    }

    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_document', action: args.action,
      ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.query === undefined ? {} : { query: args.query.trim() }), ...(args.payload === undefined ? {} : { payload: args.payload }), ...(args.operation === undefined ? {} : { operation: args.operation }),
    }
    try {
      const resolved = await this.#requestExtension(correlation)
      if (!validOfficeDocumentReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid bounded light-document read')
      if (args.action === 'inspect_write') {
        const blockCount = Number.isInteger(resolved.result.document?.blockCount) ? resolved.result.document.blockCount : undefined
        if (['replace', 'delete', 'format', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format'].includes(args.operation) && blockCount === 0) {
          this.#toolError(response, message.id, 'This light document has no public replaceable block (blockCount 0). Call selection then selection_insert, or inspect_write with blocks_insert / insert_drawing to add body content.')
          return
        }
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
        if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
        this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payloadHash: lightDocumentWriteHash(args.operation, args.payload), expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action: 'inspect_write', resource: resolved.result.resource, operation: args.operation, challenge }
        this.#reply(response, lightDocumentToolResponse(message.id, result))
        return
      }
      const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
      this.#reply(response, lightDocumentToolResponse(message.id, result))
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document read failed')
    }
  }

  async #officeSpreadsheet(message, response) {
    let args = message.params?.arguments ?? {}
    args = normalizeOfficeSpreadsheetArguments(args)
    if (!validOfficeSpreadsheetArguments(args)) { this.#reply(response, errorResponse(message.id, -32602, spreadsheetArgumentsHint(args))); return }
    const runId = this.currentRunId; const browserTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (args.action === 'write') {
      const grant = this.officeSpreadsheetChallenges.get(args.challenge); this.officeSpreadsheetChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) { this.#toolError(response, message.id, 'Spreadsheet approval challenge is missing, stale, or already used.'); return }
      if (grant.operation !== args.operation || grant.payloadHash !== spreadsheetWriteHash(args.operation, args.payload)) { this.#toolError(response, message.id, 'Spreadsheet approval does not match this operation and payload.'); return }
      if (!validOfficeResource(args.resource) || args.resource.fingerprint !== grant.resource.fingerprint || args.resource.sheetName !== grant.resource.sheetName) { this.#toolError(response, message.id, 'Spreadsheet resource differs from the approved inspection.'); return }
      const fingerprint = spreadsheetWriteHash(args.operation, args.payload)
      const existing = this.officeSpreadsheetWrites.get(args.idempotencyIdentity)
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.resourceFingerprint !== grant.resource.fingerprint) { this.#toolError(response, message.id, 'Spreadsheet idempotency identity conflicts with the approved operation or payload.'); return }
        this.#reply(response, spreadsheetToolResponse(message.id, existing.result)); return
      }
      let checkpoint
      try {
        checkpoint = await this.officeSpreadsheetWriteStore.create({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint: hash(canonicalJson(browserTarget)), resourceFingerprint: grant.resource.fingerprint, operation: args.operation, payloadHash: fingerprint })
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Could not persist spreadsheet write fence.'); return }
      if (!checkpoint.createdNew) {
        this.#toolError(response, message.id, checkpoint.record.state === 'verified'
          ? 'This idempotency identity was already verified; reread the spreadsheet before continuing.'
          : 'This idempotency identity is uncertain after an interrupted write; automatic retry is forbidden. Reread and resolve manually.')
        return
      }
      const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_spreadsheet', action: 'write', resource: grant.resource, operation: args.operation, payload: args.payload, precondition: grant.precondition }
      try {
        const resolved = await this.#requestExtension(correlation)
        if (!verifiedSpreadsheetWriteMatches(resolved.result, args.operation, args.payload, grant.resource, grant.precondition)) throw new Error('Browser Connector produced an invalid verified spreadsheet write')
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        await this.officeSpreadsheetWriteStore.setState(args.idempotencyIdentity, 'verified')
        if (this.officeSpreadsheetWrites.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeSpreadsheetWrites.delete(this.officeSpreadsheetWrites.keys().next().value)
        this.officeSpreadsheetWrites.set(args.idempotencyIdentity, { fingerprint, resourceFingerprint: grant.resource.fingerprint, result })
        this.#reply(response, spreadsheetToolResponse(message.id, result))
      } catch (error) { try { await this.officeSpreadsheetWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}; this.#toolError(response, message.id, error instanceof Error ? error.message : 'Spreadsheet write failed') }
      return
    }
    const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_spreadsheet', action: args.action, ...(args.range === undefined ? {} : { range: args.range }), ...(args.axis === undefined ? {} : { axis: args.axis }), ...(args.kind === undefined ? {} : { kind: args.kind }), ...(args.sheetName === undefined ? {} : { sheetName: args.sheetName }), ...(args.query === undefined ? {} : { query: args.query }), ...(args.matchCase === undefined ? {} : { matchCase: args.matchCase }), ...(args.matchEntireCell === undefined ? {} : { matchEntireCell: args.matchEntireCell }), ...(args.searchBy === undefined ? {} : { searchBy: args.searchBy }), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.operation === undefined ? {} : { operation: args.operation }), ...(args.payload === undefined ? {} : { payload: args.payload }) }
    try {
      const resolved = await this.#requestExtension(correlation)
      if (!validOfficeSpreadsheetReadResult(resolved.result, args.action, args)) throw new Error('Browser Connector produced an invalid bounded spreadsheet read')
      if (args.action === 'inspect_write') {
        if (!validSpreadsheetPrecondition(resolved.result.precondition) || !validSpreadsheetOperationPrecondition(args.operation, args.payload, resolved.result.precondition)) throw new Error('Browser Connector produced an invalid spreadsheet write precondition')
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.officeSpreadsheetChallenges) if (candidate.expiresAt < Date.now()) this.officeSpreadsheetChallenges.delete(key)
        if (this.officeSpreadsheetChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeSpreadsheetChallenges.delete(this.officeSpreadsheetChallenges.keys().next().value)
        this.officeSpreadsheetChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payloadHash: spreadsheetWriteHash(args.operation, args.payload), precondition: resolved.result.precondition, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action: 'inspect_write', resource: resolved.result.resource, operation: args.operation, challenge }
        this.#reply(response, spreadsheetToolResponse(message.id, result)); return
      }
      const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
      this.#reply(response, spreadsheetToolResponse(message.id, result))
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Spreadsheet read failed') }
  }

  async #teamDoc(message, response) {
    const args = message.params?.arguments ?? {}
    const runId = this.currentRunId; const target = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (args.phase === 'inspect') {
      if (!validTeamDocInspectArguments(args)) {
        this.#reply(response, errorResponse(message.id, -32602, 'team_doc_create inspect accepts only empty known placeholder fields'))
        return
      }
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_doc_create', phase: 'inspect' }
      try {
        const resolved = await this.#requestExtension(request)
        if (validTeamDocResult(resolved.teamDoc) && resolved.teamDoc.status === 'partial_delivery'
          && resolved.teamDoc.failedAt === 'inspect') throw new Error(teamDocInspectFailureText(resolved.teamDoc))
        const parent = resolved.teamDoc.parent
        if (!validTeamParent(parent)) throw new Error('Extension peer returned an invalid Team Doc parent')
        const challenge = randomBytes(32).toString('base64url')
        this.teamDocChallenges.set(challenge, { runId, generation: this.generation, target: resolved.browserTarget, parent })
        const result = { phase: 'inspect', browserTarget: resolved.browserTarget, parent, challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Doc inspect failed') }
      return
    }
    if (args.phase !== 'create' || !['challenge', 'idempotencyIdentity', 'name', 'body', 'phase'].every((key) => typeof args[key] === 'string') || Object.keys(args).length !== 5) { this.#reply(response, errorResponse(message.id, -32602, 'team_doc_create create requires challenge, idempotencyIdentity, name, and body')); return }
    const grant = this.teamDocChallenges.get(args.challenge)
    this.teamDocChallenges.delete(args.challenge)
    if (!grant || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.target, target)) { this.#toolError(response, message.id, 'Team Doc approval challenge is missing, stale, or already used.'); return }
    const contentHash = hash(args.body); const targetFingerprint = teamDocTargetFingerprint(grant.target, grant.parent)
    const existing = await this.teamDocStore.load(args.idempotencyIdentity)
    if (existing) {
      if (existing.targetFingerprint !== targetFingerprint || existing.contentHash !== contentHash) { this.#toolError(response, message.id, 'Team Doc idempotency identity conflicts with target or body.'); return }
      if (existing.verified) { this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(existing.result) }], structuredContent: existing.result } }); return }
    }
    const recovery = existing ? { documentId: existing.documentId ?? null, stages: existing.stages ?? [] } : undefined
    await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, stages: recovery?.stages ?? [], documentId: recovery?.documentId ?? null, verified: false, ...(existing?.result ? { result: existing.result } : {}) })
    const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_doc_create', phase: 'create', parent: grant.parent, idempotencyIdentity: args.idempotencyIdentity, name: args.name, body: args.body, ...(recovery ? { recovery } : {}) }
    try {
      const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const result = resolved.teamDoc
      if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('Team Doc Browser Target changed after confirmation.')
      if (!validTeamDocResult(result)) throw new Error('Extension peer returned an invalid canonical Team Doc result')
      await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, stages: result.stages, documentId: result.documentId, verified: result.status === 'verified_write', result })
      const content = { ...result, browserTarget: grant.target }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Doc create failed') }
  }

  async #teamKnowledgeItem(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validTeamKnowledgeItemArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, 'team_knowledge_item requires a valid action-specific payload'))
      return
    }
    const runId = this.currentRunId; const target = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    const inspect = async () => {
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'inspect_parent' }
      const resolved = await this.#requestExtension(request)
      const result = resolved.teamKnowledgeItem
      if (validTeamKnowledgeItemResult(result) && result.status === 'partial_delivery' && result.failedAt === 'inspect') throw new Error(teamDocInspectFailureText(result))
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid Team Knowledge parent')
      return { request, target: resolved.browserTarget, result }
    }
    try {
      if (args.action === 'inspect_parent') {
        const resolved = await inspect()
        const result = { action: 'inspect_parent', browserTarget: resolved.target, parent: resolved.result.parent, capabilities: resolved.result.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (args.action === 'preview') {
        const resolved = await inspect(); const parent = resolved.result.parent
        if (args.parentFingerprint !== undefined && parent.fingerprint !== args.parentFingerprint) { this.#toolError(response, message.id, 'Team Knowledge parent changed; inspect and confirm the directory again.'); return }
        const supported = resolved.result.capabilities?.[args.kind]
        if (supported === false) { this.#toolError(response, message.id, `team_knowledge_${args.kind}_unsupported`); return }
        for (const [key, grant] of this.teamKnowledgeItemChallenges) if (grant.expiresAt < Date.now()) this.teamKnowledgeItemChallenges.delete(key)
        const challenge = randomBytes(32).toString('base64url')
        const contentHash = teamKnowledgeContentHash(args.kind, args.name, args.body)
        this.teamKnowledgeItemChallenges.set(challenge, { runId, generation: this.generation, target: resolved.target, parent, kind: args.kind, name: args.name, contentHash, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', browserTarget: resolved.target, parent, kind: args.kind, name: args.name, contentHash, challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (args.action === 'readback') {
        const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'readback', kind: args.kind, catalogId: args.catalogId }
        const resolved = await this.#requestExtension(request); const result = resolved.teamKnowledgeItem
        if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok') throw new Error('Extension peer returned an invalid Team Knowledge item readback')
        const content = { runId, requestId: request.requestId, generation: request.generation, browserTarget: resolved.browserTarget, ...result }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content } })
        return
      }
      const grant = this.teamKnowledgeItemChallenges.get(args.challenge)
      this.teamKnowledgeItemChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.target, target)) {
        this.#toolError(response, message.id, 'Team Knowledge approval challenge is missing, stale, or already used.'); return
      }
      const contentHash = teamKnowledgeContentHash(args.kind, args.name, args.body)
      if (grant.kind !== args.kind || grant.name !== args.name || grant.contentHash !== contentHash) {
        this.#toolError(response, message.id, 'Team Knowledge approval challenge conflicts with the confirmed kind, name, or body.'); return
      }
      const targetFingerprint = teamKnowledgeTargetFingerprint(grant.target, grant.parent, args.kind)
      const existing = await this.teamDocStore.load(args.idempotencyIdentity)
      if (existing) {
        if (existing.targetFingerprint !== targetFingerprint || existing.contentHash !== contentHash || existing.kind !== args.kind || existing.name !== args.name) {
          this.#toolError(response, message.id, 'Team Knowledge idempotency identity conflicts with the parent, kind, name, or body.'); return
        }
        if (existing.verified) { this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(existing.result) }], structuredContent: existing.result } }); return }
      }
      const recovery = existing ? { catalogId: existing.catalogId ?? null, stages: existing.stages ?? [] } : undefined
      await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, kind: args.kind, name: args.name, stages: recovery?.stages ?? [], catalogId: recovery?.catalogId ?? null, verified: false, ...(existing?.result ? { result: existing.result } : {}) })
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: args.kind, name: args.name, body: args.body, idempotencyIdentity: args.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
      const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const result = resolved.teamKnowledgeItem
      if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('Team Knowledge Browser Target changed after confirmation.')
      if (!validTeamKnowledgeItemResult(result) || !['verified_write', 'partial_delivery'].includes(result.status)) throw new Error('Extension peer returned an invalid Team Knowledge item create result')
      await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, kind: args.kind, name: args.name, stages: result.stages, catalogId: result.item?.catalogId ?? null, verified: result.status === 'verified_write', result })
      const content = { ...result, browserTarget: grant.target }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Knowledge item operation failed') }
  }

  async #withTeamKnowledgeBatchLock(key, work) {
    const previous = this.teamKnowledgeBatchLocks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => gate)
    this.teamKnowledgeBatchLocks.set(key, queued)
    await previous.catch(() => undefined)
    try { return await work() } finally {
      release()
      if (this.teamKnowledgeBatchLocks.get(key) === queued) this.teamKnowledgeBatchLocks.delete(key)
    }
  }

  async #teamKnowledgeBatch(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validTeamKnowledgeBatchArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, 'team_knowledge_batch requires a valid action-specific payload'))
      return
    }
    const runId = this.currentRunId; const target = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    const inspectParent = async () => {
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'inspect_parent' }
      const resolved = await this.#requestExtension(request); const result = resolved.teamKnowledgeItem
      if (validTeamKnowledgeItemResult(result) && result.status === 'partial_delivery' && result.failedAt === 'inspect') throw new Error(teamDocInspectFailureText(result))
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid Team Knowledge batch parent')
      if (result.capabilities?.light_document === false) throw new Error('team_knowledge_light_document_unsupported')
      return { target: resolved.browserTarget, result }
    }
    try {
      if (args.action === 'status') {
        const inspected = await inspectParent()
        const batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        if (!batch) throw new Error('team_knowledge_batch_not_found')
        if (batch.targetFingerprint !== teamKnowledgeTargetFingerprint(inspected.target, inspected.result.parent, 'light_document')) throw new Error('team_knowledge_batch_target_mismatch')
        const result = { action: 'status', browserTarget: inspected.target, parent: inspected.result.parent, batch }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (args.action === 'inspect_parent') {
        const inspected = await inspectParent()
        const result = { action: 'inspect_parent', browserTarget: inspected.target, parent: inspected.result.parent, capabilities: inspected.result.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const contentFingerprint = teamKnowledgeBatchFingerprint(args.items)
      if (args.action === 'preview') {
        const inspected = await inspectParent(); const parent = inspected.result.parent
        if (args.parentFingerprint !== undefined && parent.fingerprint !== args.parentFingerprint) throw new Error('Team Knowledge parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(inspected.target, parent, 'light_document')
        const batch = await this.teamKnowledgeBatchStore.create({
          batchId: args.batchId, targetFingerprint, contentFingerprint,
          items: args.items.map((item, index) => ({ index, name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body), idempotencyIdentity: `team-batch:${hash(args.batchId).slice(0, 48)}:${String(index)}` })),
        })
        if (batch.status === 'completed') {
          const result = { action: 'preview', status: 'already_completed', browserTarget: inspected.target, parent, batch }
          this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
          return
        }
        for (const [key, grant] of this.teamKnowledgeBatchChallenges) if (grant.expiresAt < Date.now()) this.teamKnowledgeBatchChallenges.delete(key)
        if (this.teamKnowledgeBatchChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.teamKnowledgeBatchChallenges.delete(this.teamKnowledgeBatchChallenges.keys().next().value)
        const challenge = randomBytes(32).toString('base64url')
        this.teamKnowledgeBatchChallenges.set(challenge, { runId, generation: this.generation, target: inspected.target, parent, batchId: args.batchId, contentFingerprint, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', status: batch.status, browserTarget: inspected.target, parent, batch, challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const grant = this.teamKnowledgeBatchChallenges.get(args.challenge)
      this.teamKnowledgeBatchChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.target, target)
        || grant.batchId !== args.batchId || grant.contentFingerprint !== contentFingerprint) throw new Error('Team Knowledge batch approval challenge is missing, stale, changed, or already used.')
      const inspected = await inspectParent()
      if (!sameBrowserTarget(inspected.target, grant.target)) throw new Error('Team Knowledge Browser Target changed after confirmation.')
      if (inspected.result.parent.fingerprint !== grant.parent.fingerprint) throw new Error('Team Knowledge parent changed after confirmation.')
      const targetFingerprint = teamKnowledgeTargetFingerprint(grant.target, grant.parent, 'light_document')
      const result = await this.#withTeamKnowledgeBatchLock(JSON.stringify([args.batchId, targetFingerprint]), async () => {
        let batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        if (!batch || batch.targetFingerprint !== targetFingerprint || batch.contentFingerprint !== contentFingerprint) throw new Error('team_knowledge_batch_conflict')
        for (const item of batch.items.filter((candidate) => candidate.status !== 'created')) {
          const document = args.items[item.index]
          const existing = await this.teamDocStore.load(item.idempotencyIdentity)
          if (existing && (existing.targetFingerprint !== targetFingerprint || existing.contentHash !== item.contentHash || existing.kind !== 'light_document' || existing.name !== item.name)) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'failed', error: 'Team Knowledge batch item idempotency identity conflicts with the approved parent or content.' })
            continue
          }
          if (existing?.verified && validVerifiedTeamKnowledgeBatchItem(existing.result, document, true) && existing.result.item.catalogId === existing.catalogId) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'created', catalogId: existing.result.item.catalogId, stages: existing.result.stages, error: null })
            continue
          }
          const recovery = existing ? { catalogId: existing.catalogId ?? null, stages: existing.stages ?? [] } : undefined
          await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'creating', error: null })
          await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: recovery?.stages ?? [], catalogId: recovery?.catalogId ?? null, verified: false, ...(existing?.result ? { result: existing.result } : {}) })
          try {
            const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: 'light_document', name: document.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const itemResult = resolved.teamKnowledgeItem
            if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('Team Knowledge Browser Target changed during batch creation.')
            if (!validTeamKnowledgeItemResult(itemResult) || !['verified_write', 'partial_delivery'].includes(itemResult.status)) throw new Error('Extension peer returned an invalid Team Knowledge batch item result')
            if (itemResult.status === 'verified_write' && !validVerifiedTeamKnowledgeBatchItem(itemResult, document)) throw new Error('Extension peer verified the wrong Team Knowledge batch item')
            await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: itemResult.stages, catalogId: itemResult.item?.catalogId ?? null, verified: itemResult.status === 'verified_write', result: itemResult })
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: itemResult.status === 'verified_write' ? 'created' : 'failed', catalogId: itemResult.item?.catalogId ?? null, stages: itemResult.stages, error: itemResult.status === 'verified_write' ? null : itemResult.error })
          } catch (error) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'failed', error: error instanceof Error ? error.message : 'Team Knowledge batch item creation failed' })
          }
        }
        batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        return { action: 'create', status: batch.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: grant.target, parent: grant.parent, batch }
      })
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Knowledge batch operation failed') }
  }

  async #withPmdDeliveryLock(key, work) {
    const previous = this.pmdDeliveryLocks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => gate)
    this.pmdDeliveryLocks.set(key, queued)
    await previous.catch(() => undefined)
    try { return await work() } finally {
      release()
      if (this.pmdDeliveryLocks.get(key) === queued) this.pmdDeliveryLocks.delete(key)
    }
  }

  async #pmdPrdDelivery(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validPmdDeliveryArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, 'pmd_prd_delivery requires a valid fixed two-document action payload'))
      return
    }
    if (args.action === 'status') {
      try {
        const record = await this.pmdDeliveryStore.load(args.requirementId, args.deliveryRunId)
        if (!record) throw new Error('pmd_delivery_run_not_found')
        const result = { action: 'status', delivery: record }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'PMD delivery status failed') }
      return
    }
    const runId = this.currentRunId; const target = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    const inspectParent = async () => {
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'inspect_parent' }
      const resolved = await this.#requestExtension(request); const result = resolved.teamKnowledgeItem
      if (validTeamKnowledgeItemResult(result) && result.status === 'partial_delivery' && result.failedAt === 'inspect') throw new Error(teamDocInspectFailureText(result))
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid PMD delivery parent')
      if (result.capabilities?.light_document === false) throw new Error('team_knowledge_light_document_unsupported')
      return { target: resolved.browserTarget, result }
    }
    try {
      if (args.action === 'inspect_parent') {
        const inspected = await inspectParent()
        const result = { action: 'inspect_parent', browserTarget: inspected.target, parent: inspected.result.parent, capabilities: inspected.result.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const documents = normalizedPmdDocuments(args.documents)
      const contentFingerprint = pmdContentFingerprint(documents)
      if (args.action === 'preview') {
        const inspected = await inspectParent(); const parent = inspected.result.parent
        if (parent.fingerprint !== args.parentFingerprint) throw new Error('PMD delivery parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(inspected.target, parent, 'light_document')
        const record = await this.pmdDeliveryStore.create({
          requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, targetFingerprint, contentFingerprint,
          documents: documents.map((item) => ({ kind: item.kind, name: item.name, idempotencyIdentity: `pmd:${hash(`${args.requirementId}:${args.deliveryRunId}`).slice(0, 48)}:${item.kind}`, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) })),
        })
        if (record.status === 'completed') {
          const result = { action: 'preview', status: 'already_completed', browserTarget: inspected.target, parent, delivery: record }
          this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
          return
        }
        for (const [key, grant] of this.pmdDeliveryChallenges) if (grant.expiresAt < Date.now()) this.pmdDeliveryChallenges.delete(key)
        const challenge = randomBytes(32).toString('base64url')
        this.pmdDeliveryChallenges.set(challenge, { runId, generation: this.generation, target: inspected.target, parent, requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, contentFingerprint, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', status: record.status, browserTarget: inspected.target, parent, delivery: record, challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }

      const grant = this.pmdDeliveryChallenges.get(args.challenge)
      this.pmdDeliveryChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.target, target)
        || grant.requirementId !== args.requirementId || grant.deliveryRunId !== args.deliveryRunId || grant.contentFingerprint !== contentFingerprint) {
        throw new Error('PMD delivery approval challenge is missing, stale, changed, or already used.')
      }
      const inspected = await inspectParent()
      if (!sameBrowserTarget(inspected.target, grant.target)) throw new Error('PMD delivery Browser Target changed after confirmation.')
      if (inspected.result.parent.fingerprint !== grant.parent.fingerprint) throw new Error('PMD delivery parent changed after confirmation.')
      const targetFingerprint = teamKnowledgeTargetFingerprint(grant.target, grant.parent, 'light_document')
      const result = await this.#withPmdDeliveryLock(JSON.stringify([args.requirementId, args.deliveryRunId]), async () => {
        let record = await this.pmdDeliveryStore.load(args.requirementId, args.deliveryRunId)
        if (!record || record.targetFingerprint !== targetFingerprint || record.contentFingerprint !== contentFingerprint) throw new Error('pmd_delivery_run_conflict')
        let failedAt = null; let failure = null
        for (const item of record.documents.filter((candidate) => candidate.status !== 'created')) {
          const document = documents.find((candidate) => candidate.kind === item.kind)
          const existing = await this.teamDocStore.load(item.idempotencyIdentity)
          if (existing && (existing.targetFingerprint !== targetFingerprint || existing.contentHash !== item.contentHash || existing.kind !== 'light_document' || existing.name !== item.name)) {
            failedAt = item.kind; failure = 'PMD document idempotency identity conflicts with the approved parent or content.'
            await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'failed', error: failure })
            break
          }
          if (existing?.verified && validTeamKnowledgeItemResult(existing.result) && existing.result.status === 'verified_write') {
            await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'created', catalogId: existing.result.item.catalogId, stages: existing.result.stages, error: null })
            continue
          }
          const recovery = existing ? { catalogId: existing.catalogId ?? null, stages: existing.stages ?? [] } : undefined
          await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'creating', error: null })
          await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: recovery?.stages ?? [], catalogId: recovery?.catalogId ?? null, verified: false, ...(existing?.result ? { result: existing.result } : {}) })
          try {
            const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: 'light_document', name: item.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const itemResult = resolved.teamKnowledgeItem
            if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('PMD delivery Browser Target changed during creation.')
            if (!validTeamKnowledgeItemResult(itemResult) || !['verified_write', 'partial_delivery'].includes(itemResult.status)) throw new Error('Extension peer returned an invalid PMD document result')
            await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: itemResult.stages, catalogId: itemResult.item?.catalogId ?? null, verified: itemResult.status === 'verified_write', result: itemResult })
            if (itemResult.status !== 'verified_write') {
              failedAt = item.kind; failure = itemResult.error
              await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'failed', catalogId: itemResult.item?.catalogId ?? null, stages: itemResult.stages, error: itemResult.error })
              break
            }
            await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'created', catalogId: itemResult.item.catalogId, stages: itemResult.stages, error: null })
          } catch (error) {
            failedAt = item.kind; failure = error instanceof Error ? error.message : 'PMD document creation failed'
            await this.pmdDeliveryStore.updateItem({ requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, kind: item.kind, status: 'failed', error: failure })
            break
          }
        }
        record = await this.pmdDeliveryStore.load(args.requirementId, args.deliveryRunId)
        return { action: 'create', status: record.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: grant.target, parent: grant.parent, delivery: record, ...(failedAt ? { failedAt, error: failure } : {}) }
      })
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'PMD delivery failed') }
  }

  async #openBrowserTab(message, response) {
    if (!validBrowserOpenTabArguments(message.params.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'browser_open_tab requires one http(s) url argument'))
      return
    }
    const runId = this.currentRunId
    const boundTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }
    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation,
      tool: 'browser_open_tab', url: message.params.arguments.url,
    }
    try {
      const opened = await this.#requestExtension(correlation)
      const structuredContent = { runId, requestId: correlation.requestId, generation: correlation.generation, ...opened }
      if (!validBrowserOpenTabOutput(structuredContent)) throw new Error('Browser Connector produced an invalid browser_open_tab result')
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Browser tab could not be opened')
    }
  }

  #requestExtension(correlation, response, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      let cancelled = false
      const cancel = () => {
        if (cancelled || !this.pending.delete(correlation.requestId)) return
        cancelled = true
        clearTimeout(timeout)
        try { this.requestExtension({ type: 'connector_cancel', requestId: correlation.requestId, runId: correlation.runId, generation: correlation.generation }) } catch {}
        reject(new Error('Browser Connector request was cancelled'))
      }
      const timeout = setTimeout(() => {
        this.pending.delete(correlation.requestId)
        try { this.requestExtension({ type: 'connector_cancel', requestId: correlation.requestId, runId: correlation.runId, generation: correlation.generation }) } catch {}
        reject(new Error('Browser Connector timed out waiting for the Extension peer'))
      }, timeoutMs)
      const finish = (fn) => (value) => {
        if (response !== undefined) response.off('close', cancel)
        fn(value)
      }
      this.pending.set(correlation.requestId, { request: correlation, resolve: finish(resolve), reject: finish(reject), timeout })
      if (response !== undefined) response.once('close', cancel)
      try {
        this.requestExtension(correlation)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(correlation.requestId)
        reject(error)
      }
    })
  }

  #reply(response, body) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  #toolError(response, id, message) {
    this.#reply(response, {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: message }], isError: true },
    })
  }
}
