import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { TeamDocRecordStore } from './team-doc-record-store.mjs'

const REQUEST_TIMEOUT_MS = 15_000
const KNOWLEDGE_REQUEST_TIMEOUT_MS = 30 * 60_000
const MCP_PATH = '/mcp'

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

const teamDocCreateTool = {
  name: 'team_doc_create', title: 'Create Team Knowledge light document',
  description: 'Browser-authenticated and self-contained: inspect the bound Chrome Team Knowledge parent, then create exactly one approved light document with readback verification. Do not call local midea-knowledge auth.',
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['phase'], properties: { phase: { enum: ['inspect', 'create'] }, challenge: { type: 'string' }, idempotencyIdentity: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' } } },
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

function validTeamParent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 6
    && ['parentId', 'bookId', 'parentName', 'fingerprint'].every((key) => typeof value[key] === 'string' && value[key].length > 0)
    && value.canRead === true && value.canCreate === true
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

/**
 * Stateless, authenticated MCP endpoint managed by the Native Host. It is
 * deliberately the narrow Issue #2 tracer-bullet: only office_get_context
 * crosses into Native Messaging.
 */
export class BrowserConnector {
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number, knowledgeRequestTimeoutMs?: number, onToolsListed?: () => void }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.knowledgeRequestTimeoutMs = options.knowledgeRequestTimeoutMs ?? KNOWLEDGE_REQUEST_TIMEOUT_MS
    this.onToolsListed = options.onToolsListed
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
    const isTeamDocRequest = pending.request.tool === 'team_doc_create'
    const isKnowledgeRequest = pending.request.tool === 'knowledge_search' || pending.request.tool === 'code_search'
    const isOfficeRequest = isOfficeContextRequest || isOfficeReadRangeRequest || isOfficeWriteRangeRequest || isTeamDocRequest
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
      if ((isOfficeReadRangeRequest || isOfficeWriteRangeRequest) && validOfficeReadFailure(response.error)) {
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
    if (!isOfficeRequest) {
      if (!validBrowserTarget(response.browserTarget) || !validPageIdentity(response.result.pageIdentity, response.browserTarget)) {
        pending.reject(new Error('Extension peer returned an invalid browser_open_tab result'))
        return true
      }
      pending.resolve({ browserTarget: response.browserTarget, pageIdentity: response.result.pageIdentity })
      return true
    }
    pending.resolve(isOfficeWriteRangeRequest ? {
      browserTarget: response.browserTarget, resource: response.result.resource, requested: response.result.requested, observed: response.result.observed,
    } : isOfficeReadRangeRequest ? {
      browserTarget: response.browserTarget,
      range: response.result.range,
      resource: response.result.resource,
    } : {
      browserTarget: response.browserTarget,
      browserTargets: responseTargets,
      unavailableBrowserTargets: response.result.unavailableBrowserTargets ?? responseUnavailable,
      officeContext: response.result,
    })
    return true
  }

  async #handle(request, response) {
    if (request.url !== MCP_PATH) {
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
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: [officeGetContextTool, officeReadRangeTool, officeWriteRangeTool, teamDocCreateTool, browserOpenTabTool, knowledgeSearchTool, codeSearchTool] } })
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
    if (message.params?.name === 'team_doc_create') {
      await this.#teamDoc(message, response)
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
