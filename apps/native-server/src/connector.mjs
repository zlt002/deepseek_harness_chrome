import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { TeamDocRecordStore } from './team-doc-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from './team-knowledge-batch-record-store.mjs'
import { OfficeDocumentWriteRecordStore } from './office-document-write-record-store.mjs'

const REQUEST_TIMEOUT_MS = 15_000
// A cold WebEdit read first sweeps iframes for up to 8s, then the in-frame
// runtime itself budgets another 8s. The previous 15s Native cap aborted
// before the Extension could answer, so the model only saw a peer timeout.
const OFFICE_REQUEST_TIMEOUT_MS = 30_000
// A Team Knowledge write includes navigation, editor-frame readiness, write
// readback, an optional per-document human confirmation (up to ten minutes),
// and restoration of the parent page. Batch and PMD delivery issue one
// Extension request per item, so this cap applies independently to each item.
const TEAM_KNOWLEDGE_WRITE_REQUEST_TIMEOUT_MS = 12 * 60_000
const KNOWLEDGE_REQUEST_TIMEOUT_MS = 30 * 60_000
const KNOWLEDGE_CATALOG_TIMEOUT_MS = 15_000
// Node fetch (undici) defaults headersTimeout/bodyTimeout to 300s. A
// knowledge tools/call must emit response headers and periodic body bytes
// before the Extension finishes, or the child MCP client dies as fetch failed.
const MCP_JSON_KEEPALIVE_INTERVAL_MS = 15_000
// Approval Grants cross a human-confirmation boundary. One minute is too short
// for a preview to be read and approved in the Harness Workspace, so keep the
// grant usable for a bounded ten-minute window. Resource fingerprints, Browser
// Target binding, payload hashes, and one-time consumption still prevent stale
// or changed writes.
const OFFICE_DOCUMENT_CHALLENGE_TTL_MS = 10 * 60_000
const OFFICE_DOCUMENT_MAX_RECORDS = 256
const TEAM_KNOWLEDGE_BATCH_MAX_GRANTS = 32
const MCP_PATH = '/mcp'
const MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES = 128 * 1024
// Operations without a stable public API and operation-specific readback are
// deliberately absent. Accepting them and failing after a mutation is unsafe.
const LIGHT_DOCUMENT_OPERATIONS = ['replace', 'delete', 'format', 'title', 'set_title', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format', 'blocks_insert', 'insert_drawing', 'selection_insert', 'selection_replace', 'selection_content_replace', 'selection_blocks_replace']
const MODEL_LIGHT_DOCUMENT_OPERATIONS = LIGHT_DOCUMENT_OPERATIONS.filter((operation) => !['selection_replace', 'selection_content_replace', 'selection_blocks_replace'].includes(operation))

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
    // to read_work_tab / light_document_read without guessing from the title.
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
  name: 'list_work_tabs',
  title: '列出工作标签',
  description: '列出这次会话绑定的工作标签（花名册），不是读正文。pages 里的每一页都是已勾选、可读的；isPrimary 只表示默认写目标，不是“只有这一页被选中”。返回每页的标题、网址、是轻文档还是表格、哪个已关闭。固定模式跟的是勾选的浏览器标签，同一标签换了文档会返回最新页。需要某一页正文时再调用 read_work_tab，tab 用本列表 pages 的序号。模型不能自己挑选未勾选的标签。documentIdentity 只表示探到的编辑器种类。null 只表示 WebEdit iframe 还没应答快探，不是“没有文档”。',
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

const readWorkTabTool = {
  name: 'read_work_tab',
  title: '读取工作标签内容',
  description: '按需读取 list_work_tabs 花名册里的某一页正文。tab 是该列表 pages 的序号，从 1 开始。pages 里每一页都可读，包括 isPrimary=false 的勾选页。轻文档读 WebEdit iframe 编辑器，表格读已用区域摘要，普通网页读可见文本。不能填写 tabId，也不能读未勾选的标签。本工具不改变主目标，不能写入。先调用 list_work_tabs 再读。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['tab'],
    properties: {
      tab: { type: 'integer', minimum: 1, maximum: 20, description: 'list_work_tabs 返回的 pages 序号，从 1 开始。' },
      offset: { type: 'integer', minimum: 0, maximum: 100000 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
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
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, payload: { type: 'object', additionalProperties: true } } },
}
const lightDocumentSelectionReadTool = {
  name: 'light_document_selection_read', title: 'Read selected light-document content',
  description: 'Read the current light-document selection and its stable fingerprint. Use immediately before preparing a replacement.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}
const lightDocumentSelectionReplacePreviewTool = {
  name: 'light_document_selection_replace_preview', title: 'Preview selected-content replacement',
  description: 'Preview a rich replacement for any stable non-collapsed selection, including partial text, multiple blocks, and nested lists. Supply only the desired blocks. This performs one read-only selection snapshot, binds its fingerprint, checks the Browser Target, and returns a one-time approval challenge. It never changes the document; commit revalidates the resource and selection immediately before mutation.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['blocks'], properties: { blocks: { type: 'array', minItems: 1, maxItems: 50, items: lightDocumentBlockSchema } } },
}
const lightDocumentSelectionReplaceCommitTool = {
  name: 'light_document_selection_replace_commit', title: 'Commit approved selected-content replacement',
  description: 'After user approval, commit exactly the structured replacement captured by preview. This tool intentionally accepts only the one-time challenge: the approved body and internal write identity are not model-controlled. On any failure, stop and report the exact error; do not retry through a different write tool or blocks_batch_edit. Success requires an atomic write and same-target structural readback.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['challenge'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 } } },
}

const lightDocumentSearchTool = {
  name: 'light_document_search', title: 'Search light document',
  description: 'Search the bound light document for a query. This is read-only and does not change the page.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
}
const lightDocumentWritePreviewTool = {
  name: 'light_document_write_preview', title: 'Preview light-document write',
  description: 'Preview a non-selection light-document change on the current write target and return a one-time challenge. It does not change the document. After the user confirms, call light_document_write_commit with only that challenge.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['operation', 'payload'], properties: { operation: { enum: MODEL_LIGHT_DOCUMENT_OPERATIONS }, payload: { type: 'object', additionalProperties: true } } },
}
const lightDocumentWriteCommitTool = {
  name: 'light_document_write_commit', title: 'Commit approved light-document write',
  description: 'After user approval, commit exactly the non-selection change captured by light_document_write_preview. Supply only the one-time challenge. On any failure, stop and report the exact error; do not retry through a different write tool.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['challenge'], properties: { challenge: { type: 'string', minLength: 1, maxLength: 256 } } },
}

const teamKnowledgeBatchItemSchema = { type: 'object', additionalProperties: false, required: ['name', 'body'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 100000 } } }

const teamKnowledgeBatchPreviewTool = {
  name: 'team_knowledge_batch_preview', title: 'Preview one to ten Team Knowledge light documents',
  description: 'The first step for one to ten light documents. Provide a stable batchId and the exact ordered names and bodies. This inspects the currently bound parent and returns a model-visible one-time creation challenge plus expiresAt. Copy that exact challenge into team_knowledge_batch_create after explicit user confirmation. If it expired, preview the unchanged batch again before create. No online document is created in this step.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'items'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, items: { type: 'array', minItems: 1, maxItems: 10, items: teamKnowledgeBatchItemSchema } } },
}

const teamKnowledgeBatchCreateTool = {
  name: 'team_knowledge_batch_create', title: 'Create the approved Team Knowledge light-document batch',
  description: 'After explicit approval, provide only the stable batchId and one-time challenge returned by preview. The Connector uses the exact in-memory preview snapshot, so names and bodies must not be sent again. Each item is written separately and the Browser Target shows a confirmation card; wait for the user to inspect and confirm that document before the tool leaves it or starts the next item. Success still requires business success, same-parent catalog rediscovery, persisted body readback, and every per-document confirmation. If the Native Host restarted or the Approval Grant expired, preview and confirm again. Reuse the same batchId to resume unfinished items; never fall back to opening a new tab or manual per-document writes.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['batchId', 'challenge'], properties: { batchId: { type: 'string', minLength: 1, maxLength: 128 }, challenge: { type: 'string', minLength: 1, maxLength: 256 } } },
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

function validReadWorkTabArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.includes('tab') && keys.every((key) => ['tab', 'offset', 'limit'].includes(key))
    && Number.isInteger(value.tab) && value.tab >= 1 && value.tab <= 20
    && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
}

function validReadWorkTabResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'ok') return false
  if (!Number.isInteger(value.tab) || value.tab < 1 || !validBrowserTarget(value.page)) return false
  if (!value.pageIdentity || typeof value.pageIdentity !== 'object' || typeof value.pageIdentity.title !== 'string' || value.pageIdentity.url !== value.page.url) return false
  if (!['webedit_light_document', 'webedit_spreadsheet', 'web_page'].includes(value.kind)) return false
  if (typeof value.content !== 'string' || value.content.length > 20000) return false
  if (typeof value.truncated !== 'boolean') return false
  return value.isPrimary === undefined || typeof value.isPrimary === 'boolean'
}

function validLightDocumentResource(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4
    && value.kind === 'webedit_light_document' && value.origin === 'https://webedit.midea.com'
    && (typeof value.documentName === 'string' || value.documentName === null)
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0 && value.fingerprint.length <= 128
}

function lightDocumentArgumentsHint(args) {
  const action = args && typeof args === 'object' && !Array.isArray(args) ? args.action : undefined
  if (action === 'inspect_write') {
    if (typeof args.operation !== 'string' || !args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
      return 'light_document_write_preview requires the final operation and payload. For an empty document, first read the selection, then preview selection_insert with the selection fingerprint.'
    }
    if ((args.operation === 'selection_insert' || args.operation === 'selection_replace') && selectionInsertFragments(args.payload) === null) {
      return `light_document_write_preview ${args.operation} requires exactly one of text/markdown/html plus expectedSelectionFingerprint from a prior selection read.`
    }
    if (args.operation === 'insert_drawing' && lightDocumentInsertFragments('insert_drawing', args.payload) === null) {
      return 'light_document_write_preview insert_drawing requires Mermaid source and an optional insertion position.'
    }
    if (args.operation === 'blocks_insert' && lightDocumentInsertFragments('blocks_insert', args.payload) === null) {
      return 'light_document_write_preview blocks_insert requires supported blocks and an optional insertion position.'
    }
    return 'light_document_write_preview requires a supported operation and the exact final payload.'
  }
  if (action === 'write') return 'light_document_write_commit requires the one-time challenge returned by preview.'
  if (action === 'search') return 'light_document_search requires a non-empty query'
  return 'Invalid light-document operation.'
}

function validLightDocumentArguments(value) {
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
  if (name === 'light_document_read') return keys.every((key) => ['offset', 'limit', 'payload'].includes(key))
    && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
    && (value.payload === undefined || (value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)))
  if (name === 'light_document_search') return keys.every((key) => ['query', 'offset', 'limit'].includes(key))
    && typeof value.query === 'string' && value.query.trim().length > 0 && value.query.length <= 500
    && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
  if (name === 'light_document_selection_read') return keys.length === 0
  if (name === 'light_document_selection_replace_preview') return keys.length === 1 && selectionBlocksReplaceFragments({ blocks: value.blocks, expectedSelectionFingerprint: 'selection-v4-00000000000000000000000000000000' }) !== null
  if (name === 'light_document_write_preview') {
    return keys.length === 2 && typeof value.operation === 'string' && MODEL_LIGHT_DOCUMENT_OPERATIONS.includes(value.operation)
      && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
      && JSON.stringify(value.payload).length <= 100000 && validLightDocumentOperationPayload(value.operation, value.payload)
  }
  return (name === 'light_document_selection_replace_commit' || name === 'light_document_write_commit') && keys.length === 1
    && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
}

function validLightDocumentReadResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'ok'
    && validLightDocumentResource(value.resource) && value.document && typeof value.document === 'object' && !Array.isArray(value.document)
}

function validLightDocumentWriteResult(value) {
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
function lightDocumentSelectionMarkdown(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1) return null
  const rendered = blocks.map((item) => {
    const type = String(item?.type ?? item?.blockType ?? 'p').toLowerCase()
    if (typeof item?.markdown === 'string' && item.markdown.trim()) return item.markdown.trim()
    const text = typeof item?.text === 'string' ? item.text.trim() : typeof item?.html === 'string' ? item.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    if (/^h[1-6]$/.test(type)) return `${'#'.repeat(Number(type.slice(1)))} ${text}`
    if (type === 'blockquote') return text.split('\n').map((line) => `> ${line}`).join('\n')
    if (type === 'ul') return (item.items ?? []).map((line) => `- ${line}`).join('\n')
    if (type === 'ol') return (item.items ?? []).map((line, index) => `${index + 1}. ${line}`).join('\n')
    if (type === 'table') {
      const rows = item.rows ?? []
      if (!rows.length) return ''
      return [`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`)].join('\n')
    }
    if (type === 'codeblock') return `\`\`\`${item.language ?? 'plaintext'}\n${text}\n\`\`\``
    return text
  })
  const markdown = rendered.filter(Boolean).join('\n\n')
  return markdown.trim() && markdown.length <= 20_000 ? markdown : null
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
  if (!value.trim() || value.length > 20_000 || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(payload.expectedSelectionFingerprint) || (payload.insertBelow !== undefined && typeof payload.insertBelow !== 'boolean')) return null
  const fragments = distinctiveLightDocumentFragments(kind === 'html' ? value.replace(/<[^>]*>/g, ' ') : value)
  return fragments.length ? { kind, fragments } : null
}
function selectionBlocksReplaceFragments(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Object.keys(payload).every((key) => ['blocks', 'expectedSelectionFingerprint'].includes(key))
    || !Array.isArray(payload.blocks) || payload.blocks.length < 1 || payload.blocks.length > 50
    || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(payload.expectedSelectionFingerprint)
    || !payload.blocks.every(lightDocumentStructuredBlockValid)) return null
  const fragments = distinctiveLightDocumentFragments(payload.blocks.map(lightDocumentStructuredBlockText).join('\n'))
  return fragments.length ? { fragments } : null
}
function lightDocumentPayloadHasLiteralEscapedNewline(value, { code = false, markdown = false } = {}) {
  if (typeof value === 'string') {
    if (code) return false
    const visible = markdown ? markdownOutsideFences(value) : value.replace(/<pre\b[\s\S]*?<\/pre>/gi, '').replace(/<code\b[\s\S]*?<\/code>/gi, '')
    return /\\n/.test(visible)
  }
  if (Array.isArray(value)) return value.some((item) => lightDocumentPayloadHasLiteralEscapedNewline(item, { code, markdown }))
  if (!value || typeof value !== 'object') return false
  const blockType = String(value.type ?? value.blockType ?? '').toLowerCase()
  const childCode = code || blockType === 'codeblock' || blockType === 'pre'
  return Object.entries(value).some(([key, child]) => lightDocumentPayloadHasLiteralEscapedNewline(child, { code: childCode, markdown: key === 'markdown' }))
}
function validLightDocumentOperationPayload(operation, payload) {
  if (lightDocumentPayloadHasLiteralEscapedNewline(payload)) return false
  if (operation === 'selection_insert' || operation === 'selection_replace' || operation === 'selection_content_replace') return selectionInsertFragments(payload) !== null
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
  const matchesRequest = validLightDocumentWriteResult(result) && result.requested?.operation === request.operation
    && canonicalJson(result.requested?.payload) === canonicalJson(request.payload)
    && result.observed?.verified === true && sameLightDocumentTarget(result.resource, request.resource)
  if (!matchesRequest) return false
  if (request.operation === 'selection_insert' || request.operation === 'selection_replace' || request.operation === 'selection_content_replace') return verifiedFragmentEvidence(request, result, selectionInsertFragments(request.payload))
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
function validTeamParent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => ['parentId', 'bookId', 'parentName', 'parentType', 'fingerprint', 'canRead', 'canCreate'].includes(key))
    && ['parentId', 'bookId', 'parentName', 'fingerprint'].every((key) => typeof value[key] === 'string' && value[key].length > 0)
    && value.canRead === true && value.canCreate === true
}
function validTeamKnowledgeParent(value) {
  return validTeamParent(value) && typeof value.parentType === 'string' && value.parentType.length > 0
}
const TEAM_KNOWLEDGE_LIGHT_STAGES = ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified']
function validTeamKnowledgeItem(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.catalogId === 'string' && /^\d+$/.test(value.catalogId)
    && value.kind === 'light_document'
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.url === 'string' && value.url.startsWith('https://doc.midea.com/')
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0
}
function validTeamKnowledgeStages(value) {
  const expected = TEAM_KNOWLEDGE_LIGHT_STAGES
  if (!Array.isArray(value)) return false
  let previous = -1
  for (const stage of value) { const index = expected.indexOf(stage); if (index <= previous) return false; previous = index }
  return true
}
function validTeamKnowledgeItemResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['verified_write', 'partial_delivery', 'ok'].includes(value.status)) return false
  if (value.status === 'ok') return validTeamKnowledgeParent(value.parent) || (validTeamKnowledgeItem(value.item) && value.readback && typeof value.readback === 'object')
  if (value.status === 'verified_write') return validTeamKnowledgeItem(value.item)
    && validTeamKnowledgeStages(value.stages) && value.stages.length === TEAM_KNOWLEDGE_LIGHT_STAGES.length
    && value.readback && typeof value.readback === 'object'
  if ((value.item !== null && !validTeamKnowledgeItem(value.item)) || !Array.isArray(value.stages) || !['inspect', 'create', 'rediscover', 'write', 'readback', 'unsupported', 'confirmation'].includes(value.failedAt)
    || typeof value.error !== 'string' || value.error.length === 0) return false
  return value.diagnostic === undefined || (value.diagnostic && typeof value.diagnostic === 'object' && Number.isInteger(value.diagnostic.httpStatus) && (typeof value.diagnostic.errorCode === 'string' || value.diagnostic.errorCode === null))
}
function teamKnowledgeTargetFingerprint(target, parent, kind) {
  // Batch writes intentionally navigate this tab from the parent directory to
  // each created document. The stable fence is the tab plus verified parent
  // identity; including the transient URL makes a safe partial retry conflict.
  return hash(JSON.stringify({ browser: target.browser, windowId: target.windowId, tabId: target.tabId, parentFingerprint: parent.fingerprint, kind }))
}
function teamKnowledgeContentHash(kind, name, body) { return hash(JSON.stringify({ kind, name, body })) }
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
  if (args.action === 'preview') return (keys.length === 3 || keys.length === 4) && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
    && (args.parentFingerprint === undefined || typeof args.parentFingerprint === 'string' && args.parentFingerprint.length > 0 && args.parentFingerprint.length <= 256) && validTeamKnowledgeBatchItems(args.items)
  return args.action === 'create' && keys.length === 3 && typeof args.batchId === 'string' && args.batchId.trim().length > 0 && args.batchId.length <= 128
    && typeof args.challenge === 'string' && args.challenge.length > 0 && args.challenge.length <= 256
}
function teamKnowledgeBatchFingerprint(items) {
  return hash(JSON.stringify(items.map((item) => ({ name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) }))))
}
const PMD_ANALYSIS_MARKERS = [
  '# 需求分析与研发交付',
  '## 1. 需求最终理解',
  '## 2. 产品纠正',
  '## 3. 最终业务规则',
  '## 4. 代码修改位置',
  '## 5. 具体修改方式',
  '## 6. 验收清单',
  '### 正常情况',
  '### 异常情况',
  '### 边界情况',
  '### 权限情况',
  '### 兼容情况',
]
const PMD_PRD_MARKERS = [
  '# PRD:',
  '## 需求基本信息',
  '## 修订记录 [必填]',
  '# 一、术语与缩写 [建议填写]',
  '# 二、背景与目标',
  '# 三、整体流程',
  '# 四、功能性需求 [必填]',
  '# 五、角色权限 [必填]',
  '# 六、非功能性需求 [必填]',
  '# 七、配置与开关 【选填】',
  '# 八、测试关注点 [必填]',
  '# 九、参考文档 【选填】',
]
function markdownOutsideFences(body) {
  let fence = null
  return body.split('\n').flatMap((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0]
    if (marker) { fence = fence === null ? marker : fence === marker ? null : fence; return [] }
    return fence === null ? [line] : []
  }).join('\n')
}
function orderedMarkdownMarkersMissing(body, markers) {
  let offset = 0
  for (const marker of markers) {
    const index = body.indexOf(marker, offset)
    if (index < 0) return marker
    offset = index + marker.length
  }
  return null
}
function pmdBatchTemplateFailure(batchId, items) {
  if (!batchId.startsWith('pmd:')) return null
  if (items.length !== 2) return 'PMD delivery requires exactly two template documents'
  const [analysis, prd] = items
  if (!analysis.name.endsWith('_01_需求分析与研发交付') || !prd.name.endsWith('_02_PRD')) return 'PMD document names or order do not match the two-document contract'
  for (const document of items) if (/\\n/.test(markdownOutsideFences(document.body))) return `${document.name} contains a literal \\n outside a fenced code block`
  const missingAnalysis = orderedMarkdownMarkersMissing(analysis.body, PMD_ANALYSIS_MARKERS)
  if (missingAnalysis) return `analysis document is missing or reorders: ${missingAnalysis}`
  if (!analysis.body.includes('| 改什么 | 在哪里改 | 怎么改 | 改完效果 |')) return 'analysis document is missing the code-change table'
  const missingPrd = orderedMarkdownMarkersMissing(prd.body, PMD_PRD_MARKERS)
  if (missingPrd) return `PRD document is missing or reorders: ${missingPrd}`
  for (const header of ['| 业务需求名称 |', '| 版本 | 日期 |', '| 角色 | 功能/页面 |', '| 指标项 | 目标值 |']) if (!prd.body.includes(header)) return `PRD document is missing required table: ${header}`
  const internalTerm = /\b(?:Evidence|Impact|Task|AC)\b|测试\s*seam|证据分类|代码影响地图|纵向任务|验收合同/
  const analysisInternalTerm = markdownOutsideFences(analysis.body).match(internalTerm)
  if (analysisInternalTerm) return `analysis document exposes an internal delivery term: ${analysisInternalTerm[0]}`
  const visiblePrd = markdownOutsideFences(prd.body)
  const prdInternalTerm = visiblePrd.match(internalTerm)
  if (prdInternalTerm) return `PRD document exposes an internal delivery term: ${prdInternalTerm[0]}`
  if (/AccrUI\s*需求交接附录/.test(visiblePrd)) return 'PRD document appends a non-company-template handoff section'
  const codeLocator = visiblePrd.match(/(?:^|[\s`])(?:[\w.-]+\/)*[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs)\b/m)
  if (codeLocator) return `PRD document contains a code locator: ${codeLocator[0].trim()}`
  return null
}
function teamKnowledgeVisibleText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}
function teamKnowledgeLightDocumentReadbackMatches(body, observedBody) {
  if (typeof observedBody !== 'string' || observedBody.trim().length === 0) return false
  const fragments = body.replace(/<!--[\s\S]*?-->/g, '').split(/\n+/).flatMap((sourceLine) => {
    const line = sourceLine.trim()
    if (!line || /^(?:`{3,}|~{3,}|-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return []
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map(teamKnowledgeVisibleText)
      return cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? [] : [cells.join('\t')]
    }
    const heading = /^#{1,6}\s+/.test(line)
    const withoutBlockPrefix = line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '')
      .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    const fragment = teamKnowledgeVisibleText(heading
      ? withoutBlockPrefix.replace(/^\d+(?:\.\d+)*[.)、．]?\s+/, '')
      : withoutBlockPrefix)
    return fragment ? [fragment] : []
  }).filter(Boolean)
  return fragments.length > 0 && fragments.every((fragment) => observedBody.includes(fragment))
}
function teamKnowledgeBatchFailure(item) {
  if (item.status !== 'failed') return null
  const error = typeof item.error === 'string' ? item.error : ''
  const stage = /team_knowledge_user_confirmation_/i.test(error)
    ? '用户确认'
    : error === 'Extension peer verified the wrong Team Knowledge batch item'
    ? '回读校验'
    : item.stages.includes('body_written') ? '内容回读'
      : item.stages.includes('rediscovered') ? '内容写入'
        : item.stages.includes('created') ? '目录复查'
          : item.stages.includes('parent_inspected') ? '创建'
            : '创建前校验'
  if (error === 'Extension peer verified the wrong Team Knowledge batch item') return { stage, reason: '回读文本格式与原始 Markdown 不同，导致旧版校验误判。', retryable: true }
  if (/persisted_readback_(?:mismatch|failed|unavailable)/i.test(error)) {
    return { stage, reason: '文档已创建，但重新打开后未读到已持久化的正文。', retryable: true }
  }
  if (/team_doc_readback_mismatch/i.test(error) && item.catalogId && item.stages.includes('rediscovered')) {
    return { stage, reason: '文档目录已创建，但正文未通过编辑器回读校验；将复用同一文档继续写入。', retryable: true }
  }
  if (/team_knowledge_user_confirmation_(?:stopped|declined|timeout|page_unloaded|unavailable)/i.test(error)) {
    return { stage, reason: '该文档尚未获得用户页面确认，已停止后续文档处理。', retryable: true }
  }
  if (/idempotency identity conflicts|exact_name_conflict|item_type_(?:mismatch|unavailable)|directory_required|parent_fingerprint_mismatch|business_failed|readback_mismatch/i.test(error)) {
    return { stage, reason: '服务端返回的结果无法安全确认，请先检查父级、名称或内容后再发起新的预检。', retryable: false }
  }
  if (/webedit_.*(?:unavailable|runtime)|navigation_timeout|write_not_observed|request.*timeout/i.test(error)) {
    return { stage, reason: '浏览器或文档编辑器暂时未就绪。', retryable: true }
  }
  return { stage, reason: '未获得可验证的创建结果。', retryable: false }
}
function teamKnowledgeBatchView(batch) {
  return { ...batch, items: batch.items.map((item) => {
    const failure = teamKnowledgeBatchFailure(item)
    return failure ? { ...item, failure, retryable: failure.retryable } : { ...item, retryable: false }
  }) }
}
function teamKnowledgeBatchUserText(result) {
  if (result.action === 'inspect_parent') return `已确认可创建子文档的父级：${result.parent.parentName}`
  const items = Array.isArray(result.batch?.items) ? result.batch.items : []
  const completed = items.filter((item) => item.status === 'created').length
  const total = items.length
  if (result.action === 'preview') {
    if (result.status === 'already_completed') return `这批 ${total} 个子文档已经全部创建并完成内容回读，无需重复操作。`
    return `已确认父级和 ${total} 个子文档内容。确认后将逐份创建和写入；每份写入后都会停留在该页面等待用户确认，确认后才离页并处理下一份。已完成 ${completed} 个，剩余 ${total - completed} 个会续传。\n创建凭证：${result.challenge}`
  }
  if (result.action === 'create') {
    if (result.status === 'verified_write') return `已完成 ${total} 个子文档的创建、内容写入和回读验证。`
    const failures = items.filter((item) => item.status === 'failed' && item.failure)
    const details = failures.map((item) => `- ${item.name}：失败阶段：${item.failure.stage}；原因：${item.failure.reason}；可重试：${item.failure.retryable ? '是' : '否'}`)
    const retryable = failures.filter((item) => item.failure.retryable).length
    return `未完成：本次仅完成 ${completed}/${total} 个子文档。${details.length ? `\n失败明细：\n${details.join('\n')}\n` : ''}${retryable > 0 ? `其中 ${retryable} 项可使用同一批次重新预览并确认后续传；其余项请先处理原因，避免盲目重试。` : '请先处理失败原因，避免盲目重试。'}`
  }
  if (completed === total) return `这批 ${total} 个子文档已经全部完成。`
  const failures = items.filter((item) => item.status === 'failed' && item.failure)
  const details = failures.map((item) => `- ${item.name}：失败阶段：${item.failure.stage}；原因：${item.failure.reason}；可重试：${item.failure.retryable ? '是' : '否'}`)
  return details.length > 0
    ? `当前已完成 ${completed}/${total} 个子文档。\n失败明细：\n${details.join('\n')}`
    : `当前已完成 ${completed}/${total} 个子文档；仍在等待创建完成。`
}
function validVerifiedTeamKnowledgeBatchItem(result, approved, persisted = false) {
  if (!validTeamKnowledgeItemResult(result) || result.status !== 'verified_write' || result.item?.kind !== 'light_document' || result.item?.name !== approved.name) return false
  if (typeof result.item.catalogId !== 'string' || !/^\d+$/.test(result.item.catalogId) || !Array.isArray(result.stages)) return false
  if (!['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'].every((stage) => result.stages.includes(stage))) return false
  try {
    const url = new URL(result.item.url)
    if (url.origin !== 'https://doc.midea.com' || !url.pathname.includes(result.item.catalogId)) return false
  } catch { return false }
  return persisted || teamKnowledgeLightDocumentReadbackMatches(approved.body, result.readback?.body)
}

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function flatSelectionReplaceIdentity(challenge) {
  // Challenge values are server-generated one-time random values. Hashing keeps
  // them out of storage/logs while this namespace cannot collide with another write.
  return `flat-selection:${hash(challenge).slice(0, 48)}`
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

/** Node fetch uses undici's 300s bodyTimeout. Repo-search SSE stays quiet
 *  while Explore agents run, so we stream with https.request instead. */
export function knowledgeHttpsFetch(input, init = {}, timeouts = {}) {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input))
  const headers = new Headers(init.headers)
  const connectTimeout = timeouts.connectTimeout ?? 30_000
  const headersTimeout = timeouts.headersTimeout ?? 0
  const bodyTimeout = timeouts.bodyTimeout ?? 0
  const transport = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (error) => {
      request.destroy(error)
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers),
    }, (incoming) => {
      if (headerTimer !== undefined) clearTimeout(headerTimer)
      settled = true
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode ?? 502, statusText: incoming.statusMessage ?? '', headers: incoming.headers }))
    })
    if (bodyTimeout > 0) request.setTimeout(bodyTimeout, () => abort(Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' })))
    const headerTimer = headersTimeout > 0 ? setTimeout(() => abort(Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' })), headersTimeout) : undefined
    const connectTimer = setTimeout(() => abort(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), connectTimeout)
    request.once('socket', (socket) => socket.once('connect', () => clearTimeout(connectTimer)))
    request.once('error', (error) => {
      clearTimeout(connectTimer)
      if (headerTimer !== undefined) clearTimeout(headerTimer)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    if (init.signal !== undefined) {
      if (init.signal.aborted) {
        abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted'))
        return
      }
      init.signal.addEventListener('abort', () => abort(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted')), { once: true })
    }
    if (typeof init.body === 'string') request.end(init.body)
    else request.end()
  })
}

/**
 * Stateless, authenticated MCP endpoint managed by the Native Host. It is
 * deliberately the narrow Issue #2 tracer-bullet: list_work_tabs
 * crosses into Native Messaging.
 */
export class BrowserConnector {
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number, officeRequestTimeoutMs?: number, teamKnowledgeWriteRequestTimeoutMs?: number, knowledgeRequestTimeoutMs?: number, knowledgeCatalogTimeoutMs?: number, onToolsListed?: () => void, fetch?: typeof fetch, teamDocStore?: TeamDocRecordStore, teamKnowledgeBatchStore?: TeamKnowledgeBatchRecordStore, officeDocumentWriteStore?: OfficeDocumentWriteRecordStore }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.officeRequestTimeoutMs = options.officeRequestTimeoutMs ?? OFFICE_REQUEST_TIMEOUT_MS
    this.teamKnowledgeWriteRequestTimeoutMs = options.teamKnowledgeWriteRequestTimeoutMs ?? TEAM_KNOWLEDGE_WRITE_REQUEST_TIMEOUT_MS
    this.knowledgeRequestTimeoutMs = options.knowledgeRequestTimeoutMs ?? KNOWLEDGE_REQUEST_TIMEOUT_MS
    this.knowledgeCatalogTimeoutMs = options.knowledgeCatalogTimeoutMs ?? KNOWLEDGE_CATALOG_TIMEOUT_MS
    this.onToolsListed = options.onToolsListed
    // Undici's default bodyTimeout is 300s. A repo-search SSE often stays
    // quiet while the upstream Explore agents run, which looks like "fetch
    // failed" at ~5 minutes. AccrUI uses Chrome fetch and has no such cut.
    this.knowledgeFetchOptions = { connectTimeout: 30_000, headersTimeout: this.knowledgeRequestTimeoutMs, bodyTimeout: 0 }
    this.fetch = options.fetch ?? ((input, init = {}) => knowledgeHttpsFetch(input, init, this.knowledgeFetchOptions))
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    this.browserTargets = new Map()
    this.browserTargetSets = new Map()
    this.unavailableBrowserTargets = new Map()
    this.currentRunId = undefined
    this.pending = new Map()
    this.teamDocStore = options.teamDocStore ?? new TeamDocRecordStore()
    this.teamKnowledgeBatchStore = options.teamKnowledgeBatchStore ?? new TeamKnowledgeBatchRecordStore()
    this.teamKnowledgeBatchChallenges = new Map()
    this.teamKnowledgeBatchLocks = new Map()
    this.officeDocumentChallenges = new Map()
    this.officeDocumentWrites = new Map()
    this.uncertainSelectionWrite = undefined
    this.officeDocumentWriteStore = options.officeDocumentWriteStore ?? new OfficeDocumentWriteRecordStore()
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
    this.uncertainSelectionWrite = undefined
    this.teamKnowledgeBatchChallenges.clear()
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
    const previousTarget = this.browserTargets.get(runId)
    if (this.currentRunId !== undefined && this.currentRunId !== runId) {
      this.officeDocumentChallenges.clear()
      this.officeDocumentWrites.clear()
      this.teamKnowledgeBatchChallenges.clear()
      this.uncertainSelectionWrite = undefined
    }
    if (validBrowserTarget(previousTarget) && validBrowserTarget(browserTarget) && !sameBrowserTarget(previousTarget, browserTarget)) this.uncertainSelectionWrite = undefined
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
    const isOfficeContextRequest = pending.request.tool === 'list_work_tabs'
    const isReadWorkTabRequest = pending.request.tool === 'read_work_tab'
    const isOfficeDocumentRequest = pending.request.tool === 'light_document'
    const isTeamKnowledgeBatchRequest = pending.request.tool === 'team_knowledge_batch'
    const isKnowledgeRequest = pending.request.tool === 'knowledge_search' || pending.request.tool === 'code_search'
    const isSelectedSourceScopeRequest = pending.request.tool === 'selected_source_scope'
    const isBrowserBoundRequest = isOfficeContextRequest || isReadWorkTabRequest || isOfficeDocumentRequest || isTeamKnowledgeBatchRequest
    const sameOpenIdentity = response.runId === pending.request.runId && response.generation === pending.request.generation
    const currentTarget = this.browserTargets.get(pending.request.runId)
    const currentTargets = this.browserTargetSets.get(pending.request.runId) ?? (currentTarget === undefined ? undefined : [currentTarget])
    const currentUnavailable = this.unavailableBrowserTargets.get(pending.request.runId) ?? []
    const responseTargets = response.browserTargets ?? (response.browserTarget === undefined ? undefined : [response.browserTarget])
    const responseUnavailable = response.unavailableBrowserTargets ?? []
    const sameOfficeIdentity = sameOpenIdentity && sameBrowserTarget(response.browserTarget, currentTarget)
      && sameBrowserTargetList(responseTargets, currentTargets)
      && sameUnavailableBrowserTargetList(responseUnavailable, currentUnavailable)
    if ((isBrowserBoundRequest && !sameOfficeIdentity) || (!isBrowserBoundRequest && !sameOpenIdentity)) return false
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (!Object.hasOwn(response, 'result')) {
      if ((isReadWorkTabRequest || isOfficeDocumentRequest) && validOfficeReadFailure(response.error)) {
        pending.reject(new Error(JSON.stringify(response.error)))
      } else if (typeof response.error === 'string' && response.error.length > 0) {
        pending.reject(new Error(response.error))
      } else {
        pending.reject(new Error('Extension peer returned no Connector result'))
      }
      return true
    }
    if (isTeamKnowledgeBatchRequest) {
      if (!validTeamKnowledgeItemResult(response.result)) { pending.reject(new Error('Extension peer returned an invalid Team Knowledge item result')); return true }
      pending.resolve({ browserTarget: response.browserTarget, teamKnowledgeItem: response.result }); return true
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
    if (isReadWorkTabRequest && !validReadWorkTabResult(response.result)) {
      pending.reject(new Error('Extension peer returned an invalid work-tab read'))
      return true
    }
    if (isOfficeDocumentRequest && ((pending.request.action === 'write' && !verifiedLightDocumentWriteMatches(response.result, pending.request))
      || (pending.request.action !== 'write' && !validLightDocumentReadResult(response.result)))) {
      pending.reject(new Error('Extension peer returned an invalid light-document result'))
      return true
    }
    pending.resolve(isReadWorkTabRequest ? {
      browserTarget: response.browserTarget,
      result: response.result,
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
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: [officeGetContextTool, readWorkTabTool, lightDocumentReadTool, lightDocumentSelectionReadTool, lightDocumentSelectionReplacePreviewTool, lightDocumentSelectionReplaceCommitTool, lightDocumentSearchTool, lightDocumentWritePreviewTool, lightDocumentWriteCommitTool, teamKnowledgeBatchPreviewTool, teamKnowledgeBatchCreateTool, knowledgeSearchTool, codeSearchTool, selectedSourceScopeTool] } })
      return
    }
    if (message.method !== 'tools/call') {
      this.#reply(response, errorResponse(message.id, -32601, 'method not found'))
      return
    }
    if (['light_document_read', 'light_document_selection_read', 'light_document_selection_replace_preview', 'light_document_selection_replace_commit', 'light_document_search', 'light_document_write_preview', 'light_document_write_commit'].includes(message.params?.name)) {
      await this.#flatLightDocument(message, response)
      return
    }
    const batchAction = ({ team_knowledge_batch_preview: 'preview', team_knowledge_batch_create: 'create' })[message.params?.name]
    if (batchAction !== undefined) {
      await this.#teamKnowledgeBatch({ ...message, params: { ...message.params, arguments: { ...(message.params?.arguments ?? {}), action: batchAction } } }, response)
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
    if (message.params?.name === 'read_work_tab') {
      await this.#readWorkTab(message, response)
      return
    }
    if (message.params?.name !== 'list_work_tabs') {
      this.#reply(response, errorResponse(message.id, -32601, `Unknown Connector tool: ${String(message.params?.name ?? '')}`))
      return
    }
    if (!validOfficeGetContextArguments(message.params.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'list_work_tabs accepts no model-controlled target arguments'))
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
      tool: 'list_work_tabs',
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
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
    const keepAlive = this.#keepJsonAlive(response)
    try {
      const result = await this.#requestExtension(correlation, response, this.knowledgeRequestTimeoutMs)
      keepAlive.stop()
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) {
      keepAlive.stop()
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

  async #readWorkTab(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validReadWorkTabArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, 'read_work_tab requires tab from list_work_tabs pages, starting at 1. Do not pass a tabId.'))
      return
    }
    const runId = this.currentRunId
    const boundTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }
    const browserTargets = this.browserTargetSets.get(runId) ?? [boundTarget]
    const unavailableBrowserTargets = this.unavailableBrowserTargets.get(runId) ?? []
    if (args.tab > browserTargets.length) {
      this.#toolError(response, message.id, `list_work_tabs currently has ${browserTargets.length} available page(s). Call list_work_tabs again, then pass a tab from 1 to ${browserTargets.length}.`)
      return
    }
    const isMultiTarget = browserTargets.length > 1 || unavailableBrowserTargets.length > 0
    const correlation = {
      type: 'connector_request',
      requestId: randomUUID(),
      runId,
      generation: this.generation,
      browserTarget: boundTarget,
      ...(isMultiTarget ? { browserTargets, unavailableBrowserTargets } : {}),
      tool: 'read_work_tab',
      tab: args.tab,
      ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      if (!validReadWorkTabResult(resolved.result)) throw new Error('Browser Connector produced an invalid work-tab read')
      const structuredContent = {
        runId,
        requestId: correlation.requestId,
        generation: this.generation,
        browserTarget: resolved.browserTarget,
        ...resolved.result,
      }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Work-tab read failed')
    }
  }

  async #flatLightDocument(message, response) {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'light_document_write_preview' && lightDocumentPayloadHasLiteralEscapedNewline(args.payload)) {
      this.#reply(response, errorResponse(message.id, -32602, 'Light-document payload contains a literal \\n outside a code block. Use real paragraph/list blocks or actual newline characters before requesting a write.'))
      return
    }
    if (!validFlatLightDocumentArguments(name, args)) {
      this.#reply(response, errorResponse(message.id, -32602, `${name} received invalid arguments; use its flat schema exactly.`))
      return
    }
    // All light-document tools reuse one internal routing path. The extension owns frame discovery and the model
    // cannot supply a Browser Target or resource identity.
    if (name === 'light_document_read' || name === 'light_document_selection_read' || name === 'light_document_search') {
      const mapped = name === 'light_document_read' ? { action: 'read', ...args }
        : name === 'light_document_search' ? { action: 'search', ...args }
          : { action: 'selection' }
      await this.#lightDocument({ ...message, params: { ...message.params, arguments: mapped } }, response)
      return
    }
    const runId = this.currentRunId
    const browserTarget = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (this.uncertainSelectionWrite?.runId === runId && this.uncertainSelectionWrite.generation === this.generation
      && sameBrowserTarget(this.uncertainSelectionWrite.browserTarget, browserTarget)) {
      this.#toolError(response, message.id, 'Selected-content write is uncertain after failed readback. Stop automatic recovery, report the exact error, and wait for a new Browser Target or Run before another write.')
      return
    }
    if (name === 'light_document_write_preview') {
      await this.#lightDocument({ ...message, params: { ...message.params, arguments: { action: 'inspect_write', operation: args.operation, payload: args.payload } } }, response)
      return
    }
    if (name === 'light_document_write_commit') {
      const grant = this.officeDocumentChallenges.get(args.challenge)
      if (!grant || grant.flatSelectionReplace === true || typeof grant.operation !== 'string' || !grant.payload) {
        this.#toolError(response, message.id, 'Light-document write challenge is missing, stale, or not issued by light_document_write_preview.')
        return
      }
      await this.#lightDocument({ ...message, params: { ...message.params, arguments: { action: 'write', challenge: args.challenge, idempotencyIdentity: grant.idempotencyIdentity, operation: grant.operation, payload: grant.payload } } }, response)
      return
    }
    if (name === 'light_document_selection_replace_commit') {
      const grant = this.officeDocumentChallenges.get(args.challenge)
      if (!grant || grant.flatSelectionReplace !== true || !grant.payload || typeof grant.operation !== 'string' || typeof grant.idempotencyIdentity !== 'string') { this.#toolError(response, message.id, 'Selected-content approval challenge is missing, stale, or not issued by preview.'); return }
      // Do not permit any raw action, operation, target, or body to enter this
      // endpoint.  Commit reconstitutes exactly what preview approved.
      await this.#lightDocument({ ...message, params: { ...message.params, arguments: { action: 'write', challenge: args.challenge, idempotencyIdentity: grant.idempotencyIdentity, operation: grant.operation, payload: grant.payload } } }, response)
      return
    }
    const selectionCorrelation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: 'selection' }
    try {
      const selected = await this.#requestExtension(selectionCorrelation, undefined, this.officeRequestTimeoutMs)
      if (!validLightDocumentReadResult(selected.result)) throw new Error('Browser Connector produced an invalid light-document selection')
      const selection = selected.result.document?.selection
      const selectionFingerprint = selection?.selectionFingerprint
      if (!selection?.supported || selection?.truncated || selection?.hasSelection !== true || selection?.isCollapsed || selection?.stable !== true || typeof selectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(selectionFingerprint)) {
        throw new Error('The current light-document selection is not a stable non-collapsed selection. Select the exact content to replace, then read the selection again before preview.')
      }
      let operation; let payload; let previewAction
      if (selection.wholeBlockReplaceable === true) {
        operation = 'selection_blocks_replace'; payload = { blocks: args.blocks, expectedSelectionFingerprint: selectionFingerprint }; previewAction = 'selection_blocks_replace_preview'
      } else {
        const markdown = lightDocumentSelectionMarkdown(args.blocks)
        if (!markdown || !['public_replace_content', 'public_insert_content'].includes(selection.replaceStrategy)) throw new Error('The current WebEdit selection does not expose a public replacement strategy.')
        operation = 'selection_content_replace'
        payload = { markdown, expectedSelectionFingerprint: selectionFingerprint }; previewAction = 'selection_content_replace_preview'
      }
      if (!validLightDocumentOperationPayload(operation, payload)) throw new Error('The requested replacement blocks are invalid.')
      const challenge = randomBytes(32).toString('base64url')
      for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
      if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
      // Commit enters the normal write path, whose runtime re-reads both the
      // resource and selection fingerprint immediately before mutation.
      this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: selected.result.resource, operation, payload, payloadHash: lightDocumentWriteHash(operation, payload), idempotencyIdentity: flatSelectionReplaceIdentity(challenge), flatSelectionReplace: true, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
      const result = { runId, requestId: selectionCorrelation.requestId, generation: this.generation, browserTarget: selected.browserTarget, action: previewAction, resource: selected.result.resource, selection, blocks: args.blocks, challenge }
      this.#reply(response, lightDocumentToolResponse(message.id, result))
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document selection preview failed')
    }
  }

  async #lightDocument(message, response) {
    const args = message.params?.arguments ?? {}
    if (['inspect_write', 'write'].includes(args.action) && lightDocumentPayloadHasLiteralEscapedNewline(args.payload)) {
      this.#reply(response, errorResponse(message.id, -32602, 'Light-document payload contains a literal \\n outside a code block. Use real paragraph/list blocks or actual newline characters before requesting a write.'))
      return
    }
    if (!validLightDocumentArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, lightDocumentArgumentsHint(args)))
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
      const correlation = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: 'write', operation: args.operation, payload: args.payload, resource: grant.resource }
      try {
        const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        if (!verifiedLightDocumentWriteMatches(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid verified light-document write')
        await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'verified')
        if (this.officeDocumentWrites.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentWrites.delete(this.officeDocumentWrites.keys().next().value)
        this.officeDocumentWrites.set(args.idempotencyIdentity, { fingerprint: requestFingerprint, result })
        this.#reply(response, lightDocumentToolResponse(message.id, result))
      } catch (error) {
        try { await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}
        if (grant.flatSelectionReplace === true) this.uncertainSelectionWrite = { runId, generation: this.generation, browserTarget }
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document write failed')
      }
      return
    }

    const correlation = {
      type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: args.action,
      ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.query === undefined ? {} : { query: args.query.trim() }), ...(args.payload === undefined ? {} : { payload: args.payload }), ...(args.operation === undefined ? {} : { operation: args.operation }),
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      if (!validLightDocumentReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid bounded light-document read')
      if (args.action === 'inspect_write') {
        const blockCount = Number.isInteger(resolved.result.document?.blockCount) ? resolved.result.document.blockCount : undefined
        if (['replace', 'delete', 'format', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format'].includes(args.operation) && blockCount === 0) {
          this.#toolError(response, message.id, 'This light document has no public replaceable block (blockCount 0). Call selection then selection_insert, or inspect_write with blocks_insert / insert_drawing to add body content.')
          return
        }
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
        if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
        this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payload: args.payload, payloadHash: lightDocumentWriteHash(args.operation, args.payload), idempotencyIdentity: `light-write:${lightDocumentWriteHash(args.operation, args.payload).slice(0, 48)}`, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
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
      this.#reply(response, errorResponse(message.id, -32602, `${String(message.params?.name ?? 'team_knowledge_batch')} received invalid arguments`))
      return
    }
    const runId = this.currentRunId; const target = runId === undefined ? undefined : this.browserTargets.get(runId)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    const inspectParent = async () => {
      const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_batch', action: 'inspect_parent' }
      const resolved = await this.#requestExtension(request); const result = resolved.teamKnowledgeItem
      if (validTeamKnowledgeItemResult(result) && result.status === 'partial_delivery' && result.failedAt === 'inspect') throw new Error(teamDocInspectFailureText(result))
      if (!validTeamKnowledgeItemResult(result) || result.status !== 'ok' || !validTeamKnowledgeParent(result.parent)) throw new Error('Extension peer returned an invalid Team Knowledge batch parent')
      if (result.capabilities?.light_document === false) throw new Error('team_knowledge_light_document_unsupported')
      return { target: resolved.browserTarget, result }
    }
    try {
      if (args.action === 'preview') {
        const templateFailure = pmdBatchTemplateFailure(args.batchId, args.items)
        if (templateFailure) throw new Error(`pmd_prd_template_invalid: ${templateFailure}`)
        const contentFingerprint = teamKnowledgeBatchFingerprint(args.items)
        const inspected = await inspectParent(); const parent = inspected.result.parent
        if (args.parentFingerprint !== undefined && parent.fingerprint !== args.parentFingerprint) throw new Error('Team Knowledge parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(inspected.target, parent, 'light_document')
        const batch = await this.teamKnowledgeBatchStore.create({
          batchId: args.batchId, targetFingerprint, contentFingerprint,
          items: args.items.map((item, index) => ({ index, name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body), idempotencyIdentity: `team-batch:${hash(args.batchId).slice(0, 48)}:${String(index)}` })),
        })
        if (batch.status === 'completed') {
          const result = { action: 'preview', status: 'already_completed', browserTarget: inspected.target, parent, batch: teamKnowledgeBatchView(batch) }
          this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: teamKnowledgeBatchUserText(result) }], structuredContent: result } })
          return
        }
        for (const [key, grant] of this.teamKnowledgeBatchChallenges) if (grant.expiresAt < Date.now()) this.teamKnowledgeBatchChallenges.delete(key)
        if (this.teamKnowledgeBatchChallenges.size >= TEAM_KNOWLEDGE_BATCH_MAX_GRANTS) this.teamKnowledgeBatchChallenges.delete(this.teamKnowledgeBatchChallenges.keys().next().value)
        const challenge = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS
        const items = Object.freeze(args.items.map((item) => Object.freeze({ name: item.name, body: item.body })))
        this.teamKnowledgeBatchChallenges.set(challenge, { runId, generation: this.generation, target: inspected.target, parent, batchId: args.batchId, contentFingerprint, items, expiresAt })
        const result = { action: 'preview', status: batch.status, browserTarget: inspected.target, parent, batch: teamKnowledgeBatchView(batch), challenge, expiresAt }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: teamKnowledgeBatchUserText(result) }], structuredContent: result } })
        return
      }
      const grant = this.teamKnowledgeBatchChallenges.get(args.challenge)
      this.teamKnowledgeBatchChallenges.delete(args.challenge)
      if (!grant) throw new Error('team_knowledge_batch_approval_missing_or_already_used')
      if (grant.expiresAt < Date.now()) throw new Error('team_knowledge_batch_approval_expired')
      if (grant.runId !== runId || grant.generation !== this.generation) throw new Error('team_knowledge_batch_approval_run_changed')
      if (!sameBrowserTarget(grant.target, target)) throw new Error('team_knowledge_batch_approval_browser_target_changed')
      if (grant.batchId !== args.batchId) throw new Error('team_knowledge_batch_approval_batch_changed')
      const contentFingerprint = grant.contentFingerprint
      const documents = grant.items
      const inspected = await inspectParent()
      if (!sameBrowserTarget(inspected.target, grant.target)) throw new Error('Team Knowledge Browser Target changed after confirmation.')
      if (inspected.result.parent.fingerprint !== grant.parent.fingerprint) throw new Error('Team Knowledge parent changed after confirmation.')
      const targetFingerprint = teamKnowledgeTargetFingerprint(grant.target, grant.parent, 'light_document')
      const result = await this.#withTeamKnowledgeBatchLock(JSON.stringify([args.batchId, targetFingerprint]), async () => {
        let batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        if (!batch || batch.targetFingerprint !== targetFingerprint || batch.contentFingerprint !== contentFingerprint) throw new Error('team_knowledge_batch_conflict')
        for (const item of batch.items.filter((candidate) => candidate.status !== 'created' && (candidate.status !== 'failed' || teamKnowledgeBatchFailure(candidate)?.retryable === true))) {
          const document = documents[item.index]
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
            const request = { type: 'connector_request', requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_knowledge_batch', action: 'create', parent: grant.parent, kind: 'light_document', name: document.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, userConfirmation: { itemIndex: item.index + 1, totalItems: batch.items.length }, ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const itemResult = resolved.teamKnowledgeItem
            if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('Team Knowledge Browser Target changed during batch creation.')
            if (!validTeamKnowledgeItemResult(itemResult) || !['verified_write', 'partial_delivery'].includes(itemResult.status)) throw new Error('Extension peer returned an invalid Team Knowledge batch item result')
            if (itemResult.status === 'verified_write' && !validVerifiedTeamKnowledgeBatchItem(itemResult, document)) throw new Error('Extension peer verified the wrong Team Knowledge batch item')
            await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: itemResult.stages, catalogId: itemResult.item?.catalogId ?? null, verified: itemResult.status === 'verified_write', result: itemResult })
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: itemResult.status === 'verified_write' ? 'created' : 'failed', catalogId: itemResult.item?.catalogId ?? null, stages: itemResult.stages, error: itemResult.status === 'verified_write' ? null : itemResult.error })
            if (itemResult.status === 'partial_delivery' && itemResult.failedAt === 'confirmation') break
          } catch (error) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'failed', error: error instanceof Error ? error.message : 'Team Knowledge batch item creation failed' })
          }
        }
        batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        return { action: 'create', status: batch.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: grant.target, parent: grant.parent, batch: teamKnowledgeBatchView(batch) }
      })
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: teamKnowledgeBatchUserText(result) }], structuredContent: result, ...(result.status === 'partial_delivery' ? { isError: true } : {}) } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Knowledge batch operation failed') }
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

  #openJson(response) {
    if (response.headersSent || response.writableEnded || response.destroyed) return
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
  }

  #keepJsonAlive(response, intervalMs = MCP_JSON_KEEPALIVE_INTERVAL_MS) {
    this.#openJson(response)
    if (!response.writableEnded && !response.destroyed) response.write('\n')
    const timer = setInterval(() => {
      if (response.writableEnded || response.destroyed) return
      response.write('\n')
    }, intervalMs)
    timer.unref?.()
    return { stop() { clearInterval(timer) } }
  }

  #reply(response, body) {
    if (response.writableEnded || response.destroyed) return
    this.#openJson(response)
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
