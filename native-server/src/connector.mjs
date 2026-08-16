import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { TeamDocRecordStore } from './team-doc-record-store.mjs'
import { PmdDeliveryRecordStore } from './pmd-delivery-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from './team-knowledge-batch-record-store.mjs'
import { OfficeDocumentWriteRecordStore } from './office-document-write-record-store.mjs'

const REQUEST_TIMEOUT_MS = 15_000
const KNOWLEDGE_REQUEST_TIMEOUT_MS = 30 * 60_000
const KNOWLEDGE_CATALOG_TIMEOUT_MS = 15_000
const OFFICE_DOCUMENT_CHALLENGE_TTL_MS = 60_000
const OFFICE_DOCUMENT_MAX_RECORDS = 256
const MCP_PATH = '/mcp'
const MAX_SPREADSHEET_TOOL_RESPONSE_BYTES = 128 * 1024
const MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES = 128 * 1024
// Operations without a stable public API and operation-specific readback are
// deliberately absent. Accepting them and failing after a mutation is unsafe.
const LIGHT_DOCUMENT_OPERATIONS = ['replace', 'delete', 'format', 'title', 'set_title', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format']

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

function spreadsheetToolResponse(id, structuredContent) {
  const content = spreadsheetArtifactSummary(structuredContent)
  const body = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent } }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_SPREADSHEET_TOOL_RESPONSE_BYTES) return body
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Spreadsheet result exceeds the ${MAX_SPREADSHEET_TOOL_RESPONSE_BYTES}-byte response limit; no artifact payload was returned.` }], isError: true } }
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
    // This tracer bullet identifies only the verified page. The document
    // adapter has not discovered a stable service-issued identity yet.
    documentIdentity: { type: 'null' },
    primaryBrowserTarget: browserTargetSchema,
    pages: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['browserTarget', 'pageIdentity', 'documentIdentity', 'isPrimary'],
        properties: { browserTarget: browserTargetSchema, pageIdentity: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } } }, documentIdentity: { type: 'null' }, isPrimary: { type: 'boolean' } },
      },
    },
    unavailableBrowserTargets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['browserTarget', 'reason'], properties: { browserTarget: browserTargetSchema, reason: { const: 'closed_or_changed' } } } },
  },
}

const officeGetContextTool = {
  name: 'office_get_context',
  title: 'Get Office context',
  description: 'Read the trusted browser context bound to this Harness Run. In fixed-tab mode it returns every selected available page, marks the primary page, and reports selected pages that closed or changed. When multiple pages are returned, treat all of them as the current context and enumerate or use all of them unless the user explicitly asks only for the primary page. The model cannot select tabs.',
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
  description: 'Use this dispatch only for a bound WebEdit light document, never for spreadsheets. Reads are bounded. A mutation first obtains a one-time inspect_write challenge, then supplies that challenge and an idempotency identity; the extension rechecks the document fingerprint and reads back the result.',
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

const officeSpreadsheetTool = {
  name: 'office_spreadsheet', title: 'Read or edit spreadsheet',
  description: 'Use only for a bound WebEdit spreadsheet. Reads return bounded context, ranges, searches, or sheet lists. Any mutation first obtains a one-time inspect_write challenge; its operation, payload, Browser Target, and workbook fingerprint are revalidated and the same frame is read back.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['context', 'range', 'search', 'sheets', 'capabilities', 'inspect_write', 'write'] }, range: { type: 'string', minLength: 1, maxLength: 128 }, sheetName: { type: 'string', minLength: 1, maxLength: 120 }, query: { type: 'string', minLength: 1, maxLength: 500 }, matchCase: { type: 'boolean' }, matchEntireCell: { type: 'boolean' }, searchBy: { enum: ['value', 'text', 'formula'] }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    challenge: { type: 'string', minLength: 1 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 }, resource: officeResourceSchema,
    operation: { enum: ['set_values', 'set_formula', 'clear', 'format', 'merge', 'unmerge', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'row_height', 'column_width', 'sheet_add', 'sheet_rename', 'sheet_delete', 'sheet_select', 'sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'create_chart', 'create_pivot_table', 'insert_cell_image', 'export_pdf', 'export_range_image', 'export_worksheet_image'] }, payload: { type: 'object', additionalProperties: true },
  } },
}

const teamDocCreateTool = {
  name: 'team_doc_create', title: 'Create Team Knowledge light document',
  description: 'Browser-authenticated and self-contained: inspect the bound Chrome Team Knowledge parent, then create exactly one approved light document with readback verification. Do not call local midea-knowledge auth.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['phase'], properties: { phase: { enum: ['inspect', 'create'] }, challenge: { type: 'string' }, idempotencyIdentity: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' } } },
}

const teamKnowledgeItemTool = {
  name: 'team_knowledge_item', title: 'Create or verify a Team Knowledge child item',
  description: 'Use the bound Chrome Team Knowledge catalog only. Inspect the real parent first, preview one named light document or spreadsheet to obtain a one-time approval grant, then create exactly that item. Creation succeeds only after business success, parent rediscovery, and item readback.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { enum: ['inspect_parent', 'preview', 'create', 'readback'] },
      parentFingerprint: { type: 'string', minLength: 1, maxLength: 256 },
      kind: { enum: ['light_document', 'spreadsheet'] }, name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 100000 },
      challenge: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyIdentity: { type: 'string', minLength: 1, maxLength: 128 }, catalogId: { type: 'string', pattern: '^\\d+$' },
    },
  },
}

const teamKnowledgeBatchTool = {
  name: 'team_knowledge_batch', title: 'Create a batch of Team Knowledge light documents',
  description: 'Create one to ten ordered light documents in the bound Team Knowledge directory. Inspect the parent, preview the exact ordered names and body hashes, then create or resume only unfinished items. Each item requires catalog rediscovery and WebEdit body readback before it is verified.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['inspect_parent', 'preview', 'create', 'status'] }, batchId: { type: 'string', minLength: 1, maxLength: 128 }, parentFingerprint: { type: 'string', minLength: 1, maxLength: 256 }, challenge: { type: 'string', minLength: 1, maxLength: 256 },
    items: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 100000 } } } },
  } },
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

function validOfficeContext(value, browserTarget) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!(Object.keys(value).length === 3 || Object.keys(value).length === 6)) return false
  if (!(value.status === 'browser_target_verified'
    && value.documentIdentity === null
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
      && page.pageIdentity.url === page.browserTarget.url && page.documentIdentity === null && typeof page.isPrimary === 'boolean')
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
  if (value.action !== 'write' || keys.length !== 5) return false
  return typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
    && typeof value.idempotencyIdentity === 'string' && value.idempotencyIdentity.length > 0 && value.idempotencyIdentity.length <= 128
    && LIGHT_DOCUMENT_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    && JSON.stringify(value.payload).length <= 100000
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
function verifiedLightDocumentWriteMatches(result, request) {
  return validOfficeDocumentWriteResult(result) && result.requested?.operation === request.operation
    && canonicalJson(result.requested?.payload) === canonicalJson(request.payload)
    && result.observed?.verified === true && sameLightDocumentTarget(result.resource, request.resource)
}
const SPREADSHEET_OPERATIONS = ['set_values', 'set_formula', 'clear', 'format', 'merge', 'unmerge', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'row_height', 'column_width', 'sheet_add', 'sheet_rename', 'sheet_delete', 'sheet_select', 'sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'create_chart', 'create_pivot_table', 'insert_cell_image', 'export_pdf', 'export_range_image', 'export_worksheet_image']
function validOfficeSpreadsheetArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string') return false
  const keys = Object.keys(value)
  if (['context', 'sheets', 'inspect_write'].includes(value.action)) return keys.length === 1
  if (value.action === 'capabilities') return keys.every((key) => ['action', 'range', 'sheetName'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && (value.sheetName === undefined || typeof value.sheetName === 'string')
  if (value.action === 'range') return keys.every((key) => ['action', 'range', 'sheetName'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && (value.sheetName === undefined || typeof value.sheetName === 'string')
  if (value.action === 'search') return keys.every((key) => ['action', 'range', 'sheetName', 'query', 'matchCase', 'matchEntireCell', 'searchBy', 'offset', 'limit'].includes(key)) && typeof value.range === 'string' && value.range.length > 0 && value.range.length <= 128 && typeof value.query === 'string' && value.query.trim().length > 0 && value.query.length <= 500 && (value.searchBy === undefined || ['value', 'text', 'formula'].includes(value.searchBy)) && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000) && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
  return value.action === 'write' && keys.length === 6 && typeof value.challenge === 'string' && value.challenge.length > 0 && typeof value.idempotencyIdentity === 'string' && value.idempotencyIdentity.length > 0 && value.idempotencyIdentity.length <= 128 && validOfficeResource(value.resource) && SPREADSHEET_OPERATIONS.includes(value.operation) && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000
}
function validOfficeSpreadsheetReadResult(value) { return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'ok' && validOfficeResource(value.resource) }
function validOfficeSpreadsheetWriteResult(value) { return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'verified_write' && validOfficeResource(value.resource) && SPREADSHEET_OPERATIONS.includes(value.operation) && value.requested && typeof value.requested === 'object' && value.observed && typeof value.observed === 'object' }
function spreadsheetWriteHash(operation, payload) { return hash(JSON.stringify({ operation, payload })) }
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
function verifiedSpreadsheetWriteMatches(result, operation, payload) {
  if (!validOfficeSpreadsheetWriteResult(result) || result.operation !== operation) return false
  if (operation === 'set_values') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.values, payload.values) && jsonMatches(result.observed.values, payload.values)
  if (operation === 'set_formula') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.formulas, payload.formulas) && jsonMatches(result.observed.formulas, payload.formulas)
  if (operation === 'clear') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && result.observed.isBlank === true && Array.isArray(result.observed.values) && Array.isArray(result.observed.formulas)
  if (operation === 'format') return hasVerifiedSpreadsheetRange(result, payload) && requestedFormatMatches(result.requested, payload) && observedFormatMatches(result.observed.format, payload)
  if (operation === 'merge' || operation === 'unmerge') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.merged === (operation === 'merge') && result.observed.merged === (operation === 'merge')
  if (operation === 'row_height') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.RowHeight === payload.value && result.observed.RowHeight === payload.value
  if (operation === 'column_width') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.ColumnWidth === payload.value && result.observed.ColumnWidth === payload.value
  if (['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns'].includes(operation)) return false
  if (operation === 'sheet_add') return result.requested.name === payload.name && result.observed.name === payload.name && Number.isInteger(result.observed.beforeCount) && result.observed.afterCount === result.observed.beforeCount + 1 && result.observed.verified === true
  if (operation === 'sheet_rename') return result.requested.name === (payload.name ?? payload.sheetName) && result.requested.newName === payload.newName && result.observed.name === payload.newName && result.observed.afterCount === result.observed.beforeCount && result.observed.verified === true
  if (operation === 'sheet_delete') return result.requested.name === (payload.name ?? payload.sheetName) && result.requested.deleted === true && result.observed.name === (payload.name ?? payload.sheetName) && result.observed.deleted === true && result.observed.afterCount === result.observed.beforeCount - 1 && result.observed.verified === true
  if (operation === 'sheet_select') return result.requested.name === (payload.name ?? payload.sheetName) && result.observed.name === (payload.name ?? payload.sheetName) && result.observed.verified === true
  if (operation === 'sort') return hasVerifiedSpreadsheetRange(result, payload) && jsonMatches(result.requested.sorts, payload.sorts) && result.requested.hasHeader === (payload.hasHeader !== false) && Array.isArray(result.observed.values)
  if (operation === 'set_auto_filter') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.enabled === payload.enabled && result.observed.enabled === payload.enabled
  if (operation === 'clear_filters') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && result.observed.after?.operator === 'none'
  if (operation === 'set_data_validation') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.validationType === payload.validationType && result.requested.formula1 === payload.formula1 && result.requested.formula2 === payload.formula2 && Number.isInteger(result.observed.type) && result.observed.formula1 === (payload.formula1 ?? null) && result.observed.formula2 === (payload.formula2 ?? null)
  if (operation === 'clear_data_validation') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.clear === true && [null, 0].includes(result.observed.type)
  if (operation === 'add_hyperlink') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.url === (payload.url ?? null) && result.requested.subAddress === (payload.subAddress ?? null) && result.observed.url === (payload.url ?? null) && result.observed.subAddress === (payload.subAddress ?? null) && Number.isInteger(result.observed.count) && result.observed.count >= 1
  if (operation === 'delete_hyperlinks') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.delete === true && result.observed.count === 0
  if (operation === 'add_comment') return false
  if (operation === 'delete_comments') return false
  if (operation === 'create_chart') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.chartType === (payload.chartType ?? 'columnClustered') && result.requested.chartStyle === (Number.isInteger(payload.chartStyle) ? payload.chartStyle : 0) && Number.isInteger(result.observed.beforeCount) && result.observed.afterCount > result.observed.beforeCount && result.observed.chart && result.observed.chart.type === result.requested.chartType && (typeof result.observed.chart.id === 'string' || typeof result.observed.chart.id === 'number' || typeof result.observed.chart.name === 'string')
  if (operation === 'create_pivot_table') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.destination === payload.destination && result.requested.isNewSheet === false && Number.isInteger(result.observed.beforeCount) && result.observed.afterCount > result.observed.beforeCount && result.observed.destination === String(payload.destination).replace(/^.*!/, '').replace(/\$/g, '').toUpperCase() && result.observed.pivot && (typeof result.observed.pivot.id === 'string' || typeof result.observed.pivot.id === 'number')
  if (operation === 'insert_cell_image') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.url === payload.url && typeof result.observed.formula === 'string' && /^=DISPIMG\(/i.test(result.observed.formula)
  if (operation === 'export_pdf') return hasVerifiedSpreadsheetRange(result, payload) && result.requested.scope === (payload.scope ?? 'workbook') && result.observed.artifact?.kind === 'pdf' && result.observed.artifact?.mimeType === 'application/pdf' && typeof result.observed.artifact?.sourceOrigin === 'string'
  if (operation === 'export_range_image') return hasVerifiedSpreadsheetRange(result, payload) && result.observed.artifact?.kind === 'range_image' && /^image\//.test(result.observed.artifact?.mimeType ?? '') && Number.isInteger(result.observed.artifact?.byteLength)
  if (operation === 'export_worksheet_image') return hasVerifiedSpreadsheetRange(result, payload) && result.observed.artifact?.kind === 'worksheet_image' && /^image\//.test(result.observed.artifact?.mimeType ?? '') && Number.isInteger(result.observed.artifact?.byteLength)
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
  if (args.action === 'preview') return keys.length === 5 && typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0
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
  if (args.action === 'preview') return keys.length === 4 && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
    && typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0 && args.parentFingerprint.length <= 256 && validTeamKnowledgeBatchItems(args.items)
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
  return `${result.error}; stage=${diagnostic.stage}; httpStatus=${diagnostic.httpStatus}; errorCode=${diagnostic.errorCode ?? 'null'}`
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
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number, knowledgeRequestTimeoutMs?: number, knowledgeCatalogTimeoutMs?: number, onToolsListed?: () => void, fetch?: typeof fetch, teamDocStore?: TeamDocRecordStore, teamKnowledgeBatchStore?: TeamKnowledgeBatchRecordStore, pmdDeliveryStore?: PmdDeliveryRecordStore, officeDocumentWriteStore?: OfficeDocumentWriteRecordStore }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
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
      if ((isOfficeReadRangeRequest || isOfficeWriteRangeRequest || isOfficeDocumentRequest) && validOfficeReadFailure(response.error)) {
        pending.reject(new Error(JSON.stringify(response.error)))
      } else if (isKnowledgeRequest && typeof response.error === 'string') {
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
    if (isOfficeSpreadsheetRequest && ((pending.request.action === 'write' && !validOfficeSpreadsheetWriteResult(response.result)) || (pending.request.action !== 'write' && !validOfficeSpreadsheetReadResult(response.result)))) {
      pending.reject(new Error('Extension peer returned an invalid spreadsheet result')); return true
    }
    if (isKnowledgeRequest) {
      if (!validKnowledgeResult(response.result)) { pending.reject(new Error('Extension peer returned an invalid Knowledge Platform result')); return true }
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
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: [officeGetContextTool, officeReadRangeTool, officeWriteRangeTool, officeDocumentTool, officeSpreadsheetTool, teamDocCreateTool, teamKnowledgeItemTool, teamKnowledgeBatchTool, pmdPrdDeliveryTool, browserOpenTabTool, knowledgeSearchTool, codeSearchTool] } })
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
    if (message.params?.name === 'team_knowledge_batch') {
      await this.#teamKnowledgeBatch(message, response)
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
      const upstream = await this.fetch(target, {
        method: message.method,
        headers: knowledgeProxyHeaders(message.headers, message.cookie),
        redirect: 'follow',
        signal: controller.signal,
        ...(message.method === 'POST' ? { body: message.body ?? '' } : {}),
      })
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
      if (!response.destroyed) response.end(`Knowledge proxy failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.#toolError(response, message.id, 'Knowledge search is available only inside the continuable Knowledge subagent.')
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
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Knowledge Platform request failed')
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

  async #officeDocument(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validOfficeDocumentArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, 'office_document requires a bounded read/search/selection action, or a challenged verified write'))
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
    const args = message.params?.arguments ?? {}
    if (!validOfficeSpreadsheetArguments(args)) { this.#reply(response, errorResponse(message.id, -32602, 'office_spreadsheet requires a bounded read action, inspect_write, or challenged verified write')); return }
    const runId = this.currentRunId; const browserTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (args.action === 'write') {
      const grant = this.officeSpreadsheetChallenges.get(args.challenge); this.officeSpreadsheetChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) { this.#toolError(response, message.id, 'Spreadsheet approval challenge is missing, stale, or already used.'); return }
      if (!validOfficeResource(args.resource) || args.resource.fingerprint !== grant.resource.fingerprint || args.resource.sheetName !== grant.resource.sheetName) { this.#toolError(response, message.id, 'Spreadsheet resource differs from the approved inspection.'); return }
      const fingerprint = spreadsheetWriteHash(args.operation, args.payload)
      const existing = this.officeSpreadsheetWrites.get(args.idempotencyIdentity)
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.resourceFingerprint !== grant.resource.fingerprint) { this.#toolError(response, message.id, 'Spreadsheet idempotency identity conflicts with the approved operation or payload.'); return }
        this.#reply(response, spreadsheetToolResponse(message.id, existing.result)); return
      }
      const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_spreadsheet', action: 'write', resource: grant.resource, operation: args.operation, payload: args.payload }
      try {
        const resolved = await this.#requestExtension(correlation)
        if (!verifiedSpreadsheetWriteMatches(resolved.result, args.operation, args.payload)) throw new Error('Browser Connector produced an invalid verified spreadsheet write')
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        if (this.officeSpreadsheetWrites.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeSpreadsheetWrites.delete(this.officeSpreadsheetWrites.keys().next().value)
        this.officeSpreadsheetWrites.set(args.idempotencyIdentity, { fingerprint, resourceFingerprint: grant.resource.fingerprint, result })
        this.#reply(response, spreadsheetToolResponse(message.id, result))
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Spreadsheet write failed') }
      return
    }
    const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'office_spreadsheet', action: args.action, ...(args.range === undefined ? {} : { range: args.range }), ...(args.sheetName === undefined ? {} : { sheetName: args.sheetName }), ...(args.query === undefined ? {} : { query: args.query }), ...(args.matchCase === undefined ? {} : { matchCase: args.matchCase }), ...(args.matchEntireCell === undefined ? {} : { matchEntireCell: args.matchEntireCell }), ...(args.searchBy === undefined ? {} : { searchBy: args.searchBy }), ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }) }
    try {
      const resolved = await this.#requestExtension(correlation)
      if (!validOfficeSpreadsheetReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid bounded spreadsheet read')
      if (args.action === 'inspect_write') {
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.officeSpreadsheetChallenges) if (candidate.expiresAt < Date.now()) this.officeSpreadsheetChallenges.delete(key)
        if (this.officeSpreadsheetChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeSpreadsheetChallenges.delete(this.officeSpreadsheetChallenges.keys().next().value)
        this.officeSpreadsheetChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action: 'inspect_write', resource: resolved.result.resource, challenge }
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
        this.teamDocChallenges.set(challenge, { runId, generation: this.generation, target, parent })
        const result = { phase: 'inspect', browserTarget: target, parent, challenge }
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
    const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_doc_create', phase: 'create', parent: grant.parent, idempotencyIdentity: args.idempotencyIdentity, name: args.name, body: args.body, ...(recovery ? { recovery } : {}) }
    try {
      const resolved = await this.#requestExtension(request); const result = resolved.teamDoc
      if (!validTeamDocResult(result)) throw new Error('Extension peer returned an invalid canonical Team Doc result')
      await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, stages: result.stages, documentId: result.documentId, verified: result.status === 'verified_write', result })
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
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
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid Team Knowledge parent')
      return { request, result }
    }
    try {
      if (args.action === 'inspect_parent') {
        const resolved = await inspect()
        const result = { action: 'inspect_parent', browserTarget: target, parent: resolved.result.parent, capabilities: resolved.result.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (args.action === 'preview') {
        const resolved = await inspect(); const parent = resolved.result.parent
        if (parent.fingerprint !== args.parentFingerprint) { this.#toolError(response, message.id, 'Team Knowledge parent changed; inspect and confirm the directory again.'); return }
        const supported = resolved.result.capabilities?.[args.kind]
        if (supported === false) { this.#toolError(response, message.id, `team_knowledge_${args.kind}_unsupported`); return }
        for (const [key, grant] of this.teamKnowledgeItemChallenges) if (grant.expiresAt < Date.now()) this.teamKnowledgeItemChallenges.delete(key)
        const challenge = randomBytes(32).toString('base64url')
        const contentHash = teamKnowledgeContentHash(args.kind, args.name, args.body)
        this.teamKnowledgeItemChallenges.set(challenge, { runId, generation: this.generation, target, parent, kind: args.kind, name: args.name, contentHash, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', browserTarget: target, parent, kind: args.kind, name: args.name, contentHash, challenge }
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
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: args.kind, name: args.name, body: args.body, idempotencyIdentity: args.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
      const resolved = await this.#requestExtension(request); const result = resolved.teamKnowledgeItem
      if (!validTeamKnowledgeItemResult(result) || !['verified_write', 'partial_delivery'].includes(result.status)) throw new Error('Extension peer returned an invalid Team Knowledge item create result')
      await this.teamDocStore.save({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint, contentHash, kind: args.kind, name: args.name, stages: result.stages, catalogId: result.item?.catalogId ?? null, verified: result.status === 'verified_write', result })
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
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
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid Team Knowledge batch parent')
      if (result.capabilities?.light_document === false) throw new Error('team_knowledge_light_document_unsupported')
      return result
    }
    try {
      if (args.action === 'status') {
        const inspected = await inspectParent()
        const batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        if (!batch) throw new Error('team_knowledge_batch_not_found')
        if (batch.targetFingerprint !== teamKnowledgeTargetFingerprint(target, inspected.parent, 'light_document')) throw new Error('team_knowledge_batch_target_mismatch')
        const result = { action: 'status', browserTarget: target, parent: inspected.parent, batch }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (args.action === 'inspect_parent') {
        const inspected = await inspectParent()
        const result = { action: 'inspect_parent', browserTarget: target, parent: inspected.parent, capabilities: inspected.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const contentFingerprint = teamKnowledgeBatchFingerprint(args.items)
      if (args.action === 'preview') {
        const inspected = await inspectParent(); const parent = inspected.parent
        if (parent.fingerprint !== args.parentFingerprint) throw new Error('Team Knowledge parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(target, parent, 'light_document')
        const batch = await this.teamKnowledgeBatchStore.create({
          batchId: args.batchId, targetFingerprint, contentFingerprint,
          items: args.items.map((item, index) => ({ index, name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body), idempotencyIdentity: `team-batch:${hash(args.batchId).slice(0, 48)}:${String(index)}` })),
        })
        if (batch.status === 'completed') {
          const result = { action: 'preview', status: 'already_completed', browserTarget: target, parent, batch }
          this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
          return
        }
        for (const [key, grant] of this.teamKnowledgeBatchChallenges) if (grant.expiresAt < Date.now()) this.teamKnowledgeBatchChallenges.delete(key)
        if (this.teamKnowledgeBatchChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.teamKnowledgeBatchChallenges.delete(this.teamKnowledgeBatchChallenges.keys().next().value)
        const challenge = randomBytes(32).toString('base64url')
        this.teamKnowledgeBatchChallenges.set(challenge, { runId, generation: this.generation, target, parent, batchId: args.batchId, contentFingerprint, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', status: batch.status, browserTarget: target, parent, batch, challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const grant = this.teamKnowledgeBatchChallenges.get(args.challenge)
      this.teamKnowledgeBatchChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.target, target)
        || grant.batchId !== args.batchId || grant.contentFingerprint !== contentFingerprint) throw new Error('Team Knowledge batch approval challenge is missing, stale, changed, or already used.')
      const inspected = await inspectParent()
      if (inspected.parent.fingerprint !== grant.parent.fingerprint) throw new Error('Team Knowledge parent changed after confirmation.')
      const targetFingerprint = teamKnowledgeTargetFingerprint(target, grant.parent, 'light_document')
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
            const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: 'light_document', name: document.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request); const itemResult = resolved.teamKnowledgeItem
            if (!validTeamKnowledgeItemResult(itemResult) || !['verified_write', 'partial_delivery'].includes(itemResult.status)) throw new Error('Extension peer returned an invalid Team Knowledge batch item result')
            if (itemResult.status === 'verified_write' && !validVerifiedTeamKnowledgeBatchItem(itemResult, document)) throw new Error('Extension peer verified the wrong Team Knowledge batch item')
            await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: itemResult.stages, catalogId: itemResult.item?.catalogId ?? null, verified: itemResult.status === 'verified_write', result: itemResult })
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: itemResult.status === 'verified_write' ? 'created' : 'failed', catalogId: itemResult.item?.catalogId ?? null, stages: itemResult.stages, error: itemResult.status === 'verified_write' ? null : itemResult.error })
          } catch (error) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'failed', error: error instanceof Error ? error.message : 'Team Knowledge batch item creation failed' })
          }
        }
        batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        return { action: 'create', status: batch.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: target, parent: grant.parent, batch }
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
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid PMD delivery parent')
      if (result.capabilities?.light_document === false) throw new Error('team_knowledge_light_document_unsupported')
      return result
    }
    try {
      if (args.action === 'inspect_parent') {
        const inspected = await inspectParent()
        const result = { action: 'inspect_parent', browserTarget: target, parent: inspected.parent, capabilities: inspected.capabilities ?? {} }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      const documents = normalizedPmdDocuments(args.documents)
      const contentFingerprint = pmdContentFingerprint(documents)
      if (args.action === 'preview') {
        const inspected = await inspectParent(); const parent = inspected.parent
        if (parent.fingerprint !== args.parentFingerprint) throw new Error('PMD delivery parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(target, parent, 'light_document')
        const record = await this.pmdDeliveryStore.create({
          requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, targetFingerprint, contentFingerprint,
          documents: documents.map((item) => ({ kind: item.kind, name: item.name, idempotencyIdentity: `pmd:${hash(`${args.requirementId}:${args.deliveryRunId}`).slice(0, 48)}:${item.kind}`, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) })),
        })
        if (record.status === 'completed') {
          const result = { action: 'preview', status: 'already_completed', browserTarget: target, parent, delivery: record }
          this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
          return
        }
        for (const [key, grant] of this.pmdDeliveryChallenges) if (grant.expiresAt < Date.now()) this.pmdDeliveryChallenges.delete(key)
        const challenge = randomBytes(32).toString('base64url')
        this.pmdDeliveryChallenges.set(challenge, { runId, generation: this.generation, target, parent, requirementId: args.requirementId, deliveryRunId: args.deliveryRunId, contentFingerprint, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { action: 'preview', status: record.status, browserTarget: target, parent, delivery: record, challenge }
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
      if (inspected.parent.fingerprint !== grant.parent.fingerprint) throw new Error('PMD delivery parent changed after confirmation.')
      const targetFingerprint = teamKnowledgeTargetFingerprint(target, grant.parent, 'light_document')
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
            const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_item', action: 'create', parent: grant.parent, kind: 'light_document', name: item.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request); const itemResult = resolved.teamKnowledgeItem
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
        return { action: 'create', status: record.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: target, parent: grant.parent, delivery: record, ...(failedAt ? { failedAt, error: failure } : {}) }
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
