import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TeamDocRecordStore } from './team-doc-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from './team-knowledge-batch-record-store.mjs'
import { OfficeDocumentWriteRecordStore } from './office-document-write-record-store.mjs'
import { BROWSER_TOOL_NAMES, CONNECTOR_TOOLS, LIGHT_DOCUMENT_OPERATIONS, MODEL_LIGHT_DOCUMENT_OPERATIONS, PRESENTATION_CHART_TYPES, PRESENTATION_EDIT_FIELDS, PRESENTATION_OBJECT_FIELDS, PRESENTATION_WRITE_ACTIONS, PRESENTATION_WRITE_OPERATIONS, PRESENTATION_WRITE_PAYLOAD_FIELDS, SPREADSHEET_INSPECT_ACTIONS, SPREADSHEET_WRITE_OPERATIONS } from './connector-tool-catalog.mjs'
import { KNOWLEDGE_PROXY_PATH, knowledgeErrorChain, knowledgeHttpsFetch, proxyKnowledgeRequest } from './knowledge-transport.mjs'
import {
  CONNECTOR_CANCEL,
  CONNECTOR_REQUEST,
  sameBrowserTarget,
  sameBrowserTargetList,
  sameUnavailableBrowserTargetList,
  validBrowserTarget,
  validBrowserTargetBinding,
  validConnectorResponseEnvelope,
  validUnavailableBrowserTarget,
} from './connector-protocol.mjs'
import { RunTargetRegistry } from './run-target-registry.mjs'
import { atomicWrite, fingerprint as htmlFingerprint, previewEdits, readWorkspace, validEdits } from './html-workbench.mjs'

export { isRetryableKnowledgeTransport, knowledgeErrorChain, knowledgeHttpsFetch } from './knowledge-transport.mjs'

const REQUEST_TIMEOUT_MS = 15_000
// A cold WebEdit read first sweeps iframes for up to 8s, then the in-frame
// runtime itself budgets another 8s. The previous 15s Native cap aborted
// before the Extension could answer, so the model only saw a peer timeout.
// A write preview can spend up to 8s locating the WebEdit frame and another
// 22s inside the frame. Keep transport headroom so the Native Host never
// cancels at the exact moment the Extension is returning the inspection.
const OFFICE_REQUEST_TIMEOUT_MS = 45_000
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
function lightDocumentToolResponse(id, structuredContent) {
  const body = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES) return body
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Light-document result exceeds the ${MAX_LIGHT_DOCUMENT_TOOL_RESPONSE_BYTES}-byte response limit; no payload was returned.` }], isError: true } }
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

function browserTargetOwner(message) {
  const identity = harnessIdentity(message)
  return identity?.parentSessionId ?? identity?.sessionId
}

function sameBrowserTab(left, right) {
  return validBrowserTarget(left) && validBrowserTarget(right)
    && left.browser === right.browser && left.windowId === right.windowId && left.tabId === right.tabId
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

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets) {
  return validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets)
}

function validHtmlWorkbenchPreviewArguments(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && validEdits(value.edits) }
function validHtmlWorkbenchCommitArguments(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256 }
function validHtmlWorkbenchDomFingerprint(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) }
function validHtmlWorkbenchStylesheetFingerprints(value) {
  return Array.isArray(value) && value.length <= 20 && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && typeof item.url === 'string' && item.url.startsWith('file:') && /^[a-f0-9]{64}$/i.test(item.fingerprint))
}
function cssPropertyName(name) { return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase()) }
function cssDeclarationMultiset(content) {
  const declarations = new Map()
  for (const block of content.matchAll(/\{([^}]*)\}/g)) {
    for (const declaration of block[1].matchAll(/(?:^|;)\s*([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;{}]+?)\s*(?=;|$)/g)) {
      const property = cssPropertyName(declaration[1])
      const values = declarations.get(property) ?? []
      values.push(declaration[2].replace(/\s+/g, ' ').trim())
      declarations.set(property, values)
    }
  }
  for (const values of declarations.values()) values.sort()
  return declarations
}
function editedComputedProperties(edits, anchorStates) {
  const available = new Set(Array.isArray(anchorStates) ? anchorStates.flatMap(item => item?.computedStyle && typeof item.computedStyle === 'object' ? Object.keys(item.computedStyle) : []) : [])
  const properties = new Set()
  for (const edit of edits) {
    if (!edit.path.toLowerCase().endsWith('.css')) continue
    const before = cssDeclarationMultiset(edit.before)
    const after = cssDeclarationMultiset(edit.content)
    for (const property of new Set([...before.keys(), ...after.keys()])) {
      if (available.has(property) && JSON.stringify(before.get(property) ?? []) !== JSON.stringify(after.get(property) ?? [])) properties.add(property)
    }
  }
  return [...properties].sort()
}
function sameHtmlWorkbenchStylesheetFingerprints(actual, expected) {
  return validHtmlWorkbenchStylesheetFingerprints(actual) && actual.length === expected.length
    && actual.every((item, index) => item.url === expected[index].url && item.fingerprint === expected[index].fingerprint)
}
function validHtmlWorkbenchAnchorStates(value, expectedSelectors, expectedProperties = []) {
  return Array.isArray(value) && value.length === expectedSelectors.length && value.every((item, index) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && item.selector === expectedSelectors[index]
    && item.computedStyle && typeof item.computedStyle === 'object' && !Array.isArray(item.computedStyle)
    && Object.keys(item.computedStyle).length > 0 && Object.values(item.computedStyle).every(field => typeof field === 'string')
    && expectedProperties.every(field => typeof item.computedStyle[field] === 'string'))
}
function sameHtmlWorkbenchAnchorStates(actual, expected, properties) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((item, index) => item.selector === expected[index].selector
    && properties.every(field => item.computedStyle[field] === expected[index].computedStyle[field]))
}
function validOfficeDocumentIdentity(value) {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const boundedName = (candidate) => typeof candidate === 'string' && candidate.length <= 512 || candidate === null
  if (value.kind === 'webedit_spreadsheet' || value.kind === 'webedit_light_document') {
    return Object.keys(value).length === 5 && boundedName(value.workbookName) && boundedName(value.sheetName)
      && (typeof value.hasContent === 'boolean' || value.hasContent === null)
      && Number.isInteger(value.webeditFrames) && value.webeditFrames >= 1 && value.webeditFrames <= 50
  }
  return value.kind === 'webedit_presentation' && Object.keys(value).length === 5
    && boundedName(value.presentationName)
    // A ready `/weboffice/office/p/` target can be a valid blank presentation
    // before its first slide exists. This is roster-only identity; presentation
    // read/write validators still require a usable slide before dispatch.
    && (Number.isInteger(value.slideCount) && value.slideCount >= 0 && value.slideCount <= 10000 || value.slideCount === null)
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
  if (!['webedit_light_document', 'webedit_spreadsheet', 'webedit_presentation', 'web_page'].includes(value.kind)) return false
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

function validSpreadsheetResource(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 5
    && value.kind === 'webedit_spreadsheet' && value.origin === 'https://webedit.midea.com'
    && (typeof value.workbookName === 'string' || value.workbookName === null)
    && (typeof value.sheetName === 'string' || value.sheetName === null)
    && typeof value.fingerprint === 'string' && value.fingerprint.length > 0 && value.fingerprint.length <= 512
}

function sameSpreadsheetResource(left, right) {
  return validSpreadsheetResource(left) && validSpreadsheetResource(right)
    && left.kind === right.kind && left.origin === right.origin
    && left.workbookName === right.workbookName && left.sheetName === right.sheetName
    && left.fingerprint === right.fingerprint
}

// A spreadsheet Resource Identity has two deliberately distinct parts.  The
// workbook anchor keeps a Browser Target pinned to the same document/frame;
// the active worksheet and fingerprint are mutable context.  A write still
// enters the frame only with the exact inspected resource/precondition, but a
// successful sheet-transition must be allowed to return its new context.
function sameSpreadsheetWorkbook(left, right) {
  return validSpreadsheetResource(left) && validSpreadsheetResource(right)
    && left.kind === right.kind && left.origin === right.origin
    && left.workbookName === right.workbookName
}

function spreadsheetOperationMayTransitionSheet(operation) {
  return ['activate_worksheet', 'sheet_add', 'sheet_delete', 'copy_worksheet', 'move_worksheet'].includes(operation)
}

function validSpreadsheetReadResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'ok'
    && validSpreadsheetResource(value.resource)
}

function validSpreadsheetInspectResult(value) {
  return validSpreadsheetReadResult(value) && value.precondition && typeof value.precondition === 'object'
    && !Array.isArray(value.precondition) && JSON.stringify(value.precondition).length <= 100000
}

function validSpreadsheetWriteResult(value, request) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'verified_write'
    && value.operation === request.operation
    // Normal writes retain the full active-sheet identity.  Only operations
    // which explicitly change workbook context may return a different active
    // sheet/fingerprint, and even then must remain in the inspected workbook.
    && (sameSpreadsheetResource(value.resource, request.resource)
      || (spreadsheetOperationMayTransitionSheet(request.operation) && sameSpreadsheetWorkbook(value.resource, request.resource)))
    && value.requested && typeof value.requested === 'object' && !Array.isArray(value.requested)
    && value.observed && typeof value.observed === 'object' && !Array.isArray(value.observed)
    && value.observed.verified === true
}

function validPresentationResource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ['kind', 'origin', 'presentationName', 'documentName', 'documentId', 'path', 'fingerprint', 'slideCount'].includes(key))) return false
  const boundedText = (candidate, max = 512) => typeof candidate === 'string' && candidate.length <= max
  const optionalText = (candidate, max) => candidate === undefined || candidate === null || boundedText(candidate, max)
  const optionalDocumentId = value.documentId === undefined || value.documentId === null || boundedText(value.documentId) || Number.isFinite(value.documentId)
  const hasName = Object.hasOwn(value, 'presentationName') || Object.hasOwn(value, 'documentName')
  return value.kind === 'webedit_presentation' && value.origin === 'https://webedit.midea.com' && hasName
    && optionalText(value.presentationName, 512) && optionalText(value.documentName, 512)
    && optionalDocumentId && optionalText(value.path, 2048)
    && boundedText(value.fingerprint) && value.fingerprint.length > 0
    && (value.slideCount === undefined || Number.isInteger(value.slideCount) && value.slideCount >= 0 && value.slideCount <= 10000)
}
function presentationName(value) { return value.presentationName ?? value.documentName ?? null }
function optionalResourceField(value, field) { return value[field] ?? null }
function samePresentationDocument(left, right) {
  return validPresentationResource(left) && validPresentationResource(right)
    && left.kind === right.kind && left.origin === right.origin
    && presentationName(left) === presentationName(right)
    && optionalResourceField(left, 'documentId') === optionalResourceField(right, 'documentId')
    && optionalResourceField(left, 'path') === optionalResourceField(right, 'path')
}
function samePresentationTarget(left, right) {
  return samePresentationDocument(left, right)
    && left.fingerprint === right.fingerprint
}
function validPresentationReadResult(value) { return value && typeof value === 'object' && !Array.isArray(value) && validPresentationResource(value.resource) }
function validPresentationContextResult(value) {
  return validPresentationReadResult(value) && Number.isInteger(value.slideCount) && value.slideCount >= 1 && value.slideCount <= 10000
    && (value.resource.slideCount === undefined || value.resource.slideCount === value.slideCount)
}
const REQUIRED_PRESENTATION_CAPABILITY_NAMES = ['slides', 'context', 'objects', 'selection', 'text', 'save', 'export', 'tables', 'charts', 'notes', 'comments', 'metadata', 'structure']
const PRESENTATION_CAPABILITY_NAMES = [...REQUIRED_PRESENTATION_CAPABILITY_NAMES, 'render_scene', 'render_slide_visual']
function validPresentationCapabilitiesResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) return false
  if (!['ready', 'capabilities', 'methods', 'operations', 'resource'].every((key) => Object.hasOwn(value, key))) return false
  if (value.ready !== true || !validPresentationResource(value.resource)
    || !Number.isInteger(value.resource.slideCount) || value.resource.slideCount < 0 || value.resource.slideCount > 10000) return false
  if (!value.capabilities || typeof value.capabilities !== 'object' || Array.isArray(value.capabilities)) return false
  const capabilityNames = Object.keys(value.capabilities)
  if (capabilityNames.length < REQUIRED_PRESENTATION_CAPABILITY_NAMES.length || capabilityNames.length > PRESENTATION_CAPABILITY_NAMES.length
    || !capabilityNames.every((name) => PRESENTATION_CAPABILITY_NAMES.includes(name) && typeof value.capabilities[name] === 'boolean')
    || !REQUIRED_PRESENTATION_CAPABILITY_NAMES.every((name) => typeof value.capabilities[name] === 'boolean')) return false
  if (!Array.isArray(value.methods) || value.methods.length > 256
    || !value.methods.every((method) => typeof method === 'string' && method.length > 0 && method.length <= 128)) return false
  if (!value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations)) return false
  const operationNames = Object.keys(value.operations)
  if (operationNames.length !== PRESENTATION_WRITE_OPERATIONS.length
    || !PRESENTATION_WRITE_OPERATIONS.every((operation) => {
      const capability = value.operations[operation]
      const allowedActions = PRESENTATION_WRITE_ACTIONS[operation]
      return capability && typeof capability === 'object' && !Array.isArray(capability)
        && Object.keys(capability).length === 1 && Array.isArray(capability.actions) && capability.actions.length <= 16
        && capability.actions.every((action, index) => typeof action === 'string' && action.length > 0 && action.length <= 64
          && allowedActions.includes(action) && capability.actions.indexOf(action) === index)
    })) return false
  return JSON.stringify(value).length <= 50000
}
function validBoundedPreviewValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return true
  if (typeof value === 'string') return value.length <= 2000
  if (depth >= 4 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => validBoundedPreviewValue(item, depth + 1))
  const keys = Object.keys(value)
  return keys.length <= 32 && keys.every((key) => key.length <= 128 && key !== 'precondition' && validBoundedPreviewValue(value[key], depth + 1))
}
function validPresentationRuntimeSummary(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3
    && Array.isArray(value.payloadKeys) && value.payloadKeys.length <= 32
    && value.payloadKeys.every((key) => typeof key === 'string' && key.length <= 128 && key !== 'precondition')
    && validBoundedPreviewValue(value.target) && validBoundedPreviewValue(value.effect)
}
function payloadPreviewShape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `text(${value.length})`
  if (value && typeof value === 'object') return `object(${Object.keys(value).length})`
  return typeof value
}
function previewTarget(payload) {
  const source = payload.target && typeof payload.target === 'object' && !Array.isArray(payload.target) ? payload.target : payload
  const result = {}
  for (const key of ['sheetName', 'range', 'destination', 'sourceName', 'name', 'slideIndex', 'objectIndex', 'textBoxIndex']) {
    const value = source[key] ?? (source === payload ? undefined : payload[key])
    if (typeof value === 'string' && value.length <= 512 || Number.isInteger(value)) result[key] = value
  }
  return Object.keys(result).length > 0 ? result : null
}
function previewSummary(operation, payload, runtimeSummary = undefined) {
  const keys = Object.keys(payload).filter((key) => key !== 'precondition').slice(0, 32)
  return {
    operation,
    target: previewTarget(payload),
    requested: { keys, fieldCount: Object.keys(payload).length, shapes: Object.fromEntries(keys.map((key) => [key, payloadPreviewShape(payload[key])])) },
    ...(runtimeSummary === undefined ? {} : { runtime: runtimeSummary }),
  }
}
function boundedMatrixPreview(value, maxRows = 8, maxColumns = 8) {
  if (!Array.isArray(value)) return undefined
  const rows = value.length
  const columns = value.reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 1), 0)
  const cells = value.slice(0, maxRows).map((row) => (Array.isArray(row) ? row : [row]).slice(0, maxColumns).map((cell) => {
    if (typeof cell === 'string') return cell.slice(0, 240)
    if (cell === null || typeof cell === 'boolean' || Number.isFinite(cell)) return cell
    return String(cell).slice(0, 240)
  }))
  return { rows, columns, cellCount: rows * columns, cells, truncated: rows > maxRows || columns > maxColumns }
}
function spreadsheetConfirmation(operation, payload, runtimeSummary = undefined) {
  // This is intentionally a payload projection rather than a generic list of
  // keys/shapes.  The value shown to a person at approval time must identify
  // the exact worksheet object/range that the frozen grant will mutate.
  const confirmation = { target: previewTarget(payload) }
  if (['set_print_settings', 'refresh_pivot_tables', 'undo', 'redo', 'recalculate'].includes(operation)) {
    confirmation.target = { scope: 'active_workbook' }
  }
  const copy = (keys, into = 'target') => {
    const value = {}
    for (const key of keys) if (payload[key] !== undefined) value[key] = boundedSpreadsheetPreview(payload[key])
    if (Object.keys(value).length > 0) confirmation[into] = { ...(confirmation[into] ?? {}), ...value }
  }
  copy(['sheetName', 'range', 'sourceRange', 'destination', 'destinationRange', 'headerRange'])
  copy(['name', 'newName', 'sourceName', 'targetName'], 'names')
  copy(['chartId', 'chartIndex', 'chartName', 'chartType', 'type', 'title', 'source', 'sourceRange', 'left', 'top', 'width', 'height'], 'chart')
  copy(['pivotTableId', 'pivotIndex', 'pivotName', 'fieldName', 'axis', 'orientation', 'function', 'summaryFunction', 'calculation', 'baseField', 'baseItem', 'source', 'destination'], 'pivot')
  copy(['field', 'criteria', 'values', 'filterOn', 'operator'], 'filter')
  copy(['zoom', 'freeze', 'target'], 'view')
  copy(['count', 'shift', 'position', 'index', 'beforeIndex', 'afterIndex'], 'structure')
  copy(['header', 'border', 'numberFormat', 'formatCode', 'fillColor', 'fontColor', 'fontSize', 'bold', 'italic', 'horizontalAlignment', 'verticalAlignment'], 'format')
  copy(['scope', 'fileName'], 'export')
  const values = boundedMatrixPreview(payload.values)
  const formulas = boundedMatrixPreview(payload.formulas)
  if (values !== undefined) confirmation.values = values
  if (formulas !== undefined) confirmation.formulas = formulas
  if (operation === 'batch_write' && Array.isArray(payload.cells)) {
    const cells = payload.cells.slice(0, 24).map((cell) => {
      const item = cell && typeof cell === 'object' && !Array.isArray(cell) ? cell : {}
      const address = typeof item.range === 'string' ? item.range : typeof item.address === 'string' ? item.address : null
      return {
        address,
        ...(boundedMatrixPreview(item.values) === undefined ? {} : { values: boundedMatrixPreview(item.values) }),
        ...(boundedMatrixPreview(item.formulas) === undefined ? {} : { formulas: boundedMatrixPreview(item.formulas) }),
        ...(typeof item.value === 'string' || Number.isFinite(item.value) || typeof item.value === 'boolean' || item.value === null ? { value: boundedSpreadsheetPreview(item.value) } : {}),
      }
    })
    confirmation.batch = { cellCount: payload.cells.length, cells, truncated: payload.cells.length > cells.length }
    confirmation.target = { batchWrite: true, cellCount: payload.cells.length }
  }
  const textFields = ['what', 'replacement', 'delimiter', 'text', 'url', 'refersTo', 'sourceRange', 'destination', 'newName', 'sourceName', 'targetName', 'name', 'chartType', 'fileName']
  const text = {}
  for (const key of textFields) {
    if (typeof payload[key] === 'string') text[key] = payload[key].slice(0, 240)
  }
  if (Object.keys(text).length > 0) confirmation.details = text
  const booleans = {}
  for (const key of ['enabled', 'visible', 'hidden', 'freeze', 'grouped', 'hasHeader', 'isNewSheet']) if (typeof payload[key] === 'boolean') booleans[key] = payload[key]
  if (Object.keys(booleans).length > 0) confirmation.flags = booleans
  const numbers = {}
  for (const key of ['index', 'position', 'value', 'width', 'height', 'left', 'top', 'count']) if (Number.isFinite(payload[key])) numbers[key] = payload[key]
  if (Object.keys(numbers).length > 0) confirmation.quantities = numbers
  for (const key of ['columns', 'criteria', 'fields', 'items']) {
    if (Array.isArray(payload[key])) confirmation[key] = { count: payload[key].length, preview: payload[key].slice(0, 12) }
  }
  if (runtimeSummary !== undefined) confirmation.runtime = boundedSpreadsheetPreview(runtimeSummary, 2000)
  return confirmation
}
function boundedSpreadsheetPreview(value, maxText = 240, depth = 0) {
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return value
  if (typeof value === 'string') return value.slice(0, maxText)
  if (depth >= 3 || !value || typeof value !== 'object') return String(value).slice(0, maxText)
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => boundedSpreadsheetPreview(item, maxText, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key.slice(0, 128), boundedSpreadsheetPreview(item, maxText, depth + 1)]))
}
const SPREADSHEET_TARGET_REQUIREMENTS = Object.freeze({
  set_values: [['range'], ['values']], set_formula: [['range'], ['formulas']], batch_write: [['cells']],
  copy_range: [['sourceRange'], ['destinationRange']], paste_special: [['sourceRange'], ['destinationRange']],
  auto_fill: [['range'], ['destination']], move_range: [['range'], ['destination']],
  sheet_add: [['name']], sheet_rename: [['sheetName'], ['newName']], sheet_delete: [['sheetName']],
  copy_worksheet: [['sourceName', 'name']], move_worksheet: [['sheetName', 'sourceName'], ['index']],
  set_worksheet_visibility: [['sheetName'], ['visible']], activate_worksheet: [['sheetName']],
  create_defined_name: [['name'], ['refersTo']], delete_defined_name: [['name']],
  create_chart: [['range'], ['chartType']], update_chart: [['chartId', 'chartIndex', 'chartName', 'name']],
  set_chart_data_source: [['chartId', 'chartIndex', 'chartName', 'name'], ['sourceRange']],
  resize_chart: [['chartId', 'chartIndex', 'chartName', 'name'], ['width'], ['height']], delete_chart: [['chartId', 'chartIndex', 'chartName', 'name']],
  create_pivot_table: [['range'], ['destination']], refresh_pivot_table: [['pivotTableId', 'pivotIndex', 'pivotName', 'name']],
  delete_pivot_table: [['pivotTableId', 'pivotIndex', 'pivotName', 'name']],
  add_pivot_field: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName'], ['orientation', 'axis']],
  remove_pivot_field: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName']],
  sort_pivot_field: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName']],
  set_pivot_subtotals: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName']],
  set_pivot_value_function: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName'], ['summaryFunction', 'function']],
  set_pivot_show_values_as: [['pivotTableId', 'pivotIndex', 'pivotName', 'name'], ['fieldName'], ['calculation']],
  apply_filter: [['range'], ['field'], ['criteria', 'values']], set_auto_filter: [['range']], clear_filters: [['range']],
  set_zoom: [['zoom']], set_freeze_panes: [['freeze']], set_outline_group: [['range'], ['axis'], ['grouped']],
  export_pdf: [['scope']], export_range_image: [['range']], export_worksheet_image: [['sheetName']],
  // These operations deliberately target the current workbook/view rather
  // than a range.  An empty requirement list means the preview remains valid
  // and the confirmation explicitly describes that workbook-wide target.
  set_print_settings: [], refresh_pivot_tables: [], undo: [], redo: [], recalculate: [],
})
function spreadsheetPreviewComplete(operation, payload) {
  const groups = SPREADSHEET_TARGET_REQUIREMENTS[operation] ?? [['range']]
  return groups.every((group) => group.some((key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== ''))
}
function spreadsheetPreviewSummary(operation, payload, runtimeSummary = undefined) {
  return { ...previewSummary(operation, payload, runtimeSummary), confirmation: spreadsheetConfirmation(operation, payload, runtimeSummary) }
}
function previewPosition(value) {
  const position = {}
  for (const key of ['left', 'top', 'width', 'height']) if (Number.isFinite(value[key])) position[key] = value[key]
  return position
}
function boundedTextPreview(value, maxLength = 240) {
  if (typeof value !== 'string') return {}
  return { text: value.slice(0, maxLength), textLength: value.length, textTruncated: value.length > maxLength }
}
function boundedValuePreview(value) {
  if (value === undefined) return { omitted: true }
  if (typeof value === 'string') return boundedTextPreview(value)
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return { value }
  try {
    const serialized = JSON.stringify(value)
    return serialized.length <= 240 ? { value } : { json: serialized.slice(0, 240), jsonLength: serialized.length, jsonTruncated: true }
  } catch { return { value: String(value).slice(0, 240), valueTruncated: true } }
}
function presentationChartTypePreview(value) {
  if (Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (/^[+-]?\d+$/.test(normalized)) {
    const number = Number(normalized)
    return Number.isSafeInteger(number) ? number : undefined
  }
  return normalized === '' ? undefined : normalized.slice(0, 128)
}
function presentationSlideTarget(payload, fields = []) {
  const target = {}
  for (const field of ['slideIndex', ...fields]) if (Number.isInteger(payload[field])) target[field] = payload[field]
  return target
}
function presentationObjectPreview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = previewPosition(value)
  if (Number.isFinite(value.rotation)) result.rotation = value.rotation
  return Object.keys(result).length === 0 ? undefined : result
}
function presentationObservedTarget(precondition) {
  if (!precondition || typeof precondition !== 'object' || Array.isArray(precondition)) return undefined
  const observed = {}
  if (Number.isInteger(precondition.currentSlide)) observed.currentSlide = precondition.currentSlide
  if (validBoundedPreviewValue(precondition.slide)) observed.slide = precondition.slide
  if (validBoundedPreviewValue(precondition.target)) observed.object = precondition.target
  if (validBoundedPreviewValue(precondition.selection?.selectedShape)) observed.selectedObject = precondition.selection.selectedShape
  return Object.keys(observed).length === 0 ? undefined : observed
}
function withPresentationRuntime(confirmation, runtimeSummary, observed = undefined) {
  return { ...confirmation, ...(runtimeSummary === undefined ? {} : { runtime: runtimeSummary }), ...(observed === undefined ? {} : { observed }) }
}
function presentationConfirmation(operation, payload, runtimeSummary = undefined, observed = undefined) {
  const action = typeof payload.action === 'string' ? payload.action.slice(0, 64) : null
  if (operation === 'manage_slides' && action === 'add') {
    return { action, insertion: Number.isFinite(payload.index) ? { index: payload.index } : { append: true } }
  }
  if (operation === 'manage_slides') return withPresentationRuntime({ action, target: presentationSlideTarget(payload) }, runtimeSummary, observed)
  if (operation === 'edit_selection') {
    const edit = payload.edit && typeof payload.edit === 'object' && !Array.isArray(payload.edit) ? payload.edit : payload
    const change = presentationObjectPreview(edit) ?? {}
    if (typeof edit.replaceText === 'string') change.replaceText = boundedTextPreview(edit.replaceText)
    return withPresentationRuntime({ action, target: presentationSlideTarget(payload), edit: change }, runtimeSummary, observed)
  }
  if (operation === 'manage_objects') {
    return withPresentationRuntime({ action, target: presentationSlideTarget(payload, ['objectIndex']), ...(presentationObjectPreview(payload.object) === undefined ? {} : { object: presentationObjectPreview(payload.object) }) }, runtimeSummary, observed)
  }
  if (operation === 'manage_tables') {
    return {
      action,
      table: {
        slideIndex: Number.isInteger(payload.slideIndex) ? payload.slideIndex : null,
        rows: Number.isInteger(payload.rows) ? payload.rows : null,
        columns: Number.isInteger(payload.columns) ? payload.columns : null,
        position: previewPosition(payload),
      },
    }
  }
  if (operation === 'manage_charts') {
    return {
      action,
      chart: {
        slideIndex: Number.isInteger(payload.slideIndex) ? payload.slideIndex : null,
        ...(presentationChartTypePreview(payload.chartType) === undefined ? {} : { chartType: presentationChartTypePreview(payload.chartType) }),
        position: previewPosition(payload),
        ...(Number.isFinite(payload.chartStyle) ? { chartStyle: payload.chartStyle } : {}),
      },
    }
  }
  if (operation === 'manage_notes') return withPresentationRuntime({ action, target: presentationSlideTarget(payload), text: boundedTextPreview(payload.text) }, runtimeSummary, observed)
  if (operation === 'manage_comments') {
    return withPresentationRuntime({ action, target: { ...presentationSlideTarget(payload), ...(typeof payload.slideId === 'string' || Number.isFinite(payload.slideId) ? { slideId: payload.slideId } : {}) }, text: boundedTextPreview(payload.text), ...((typeof payload.replyer === 'string' || Number.isSafeInteger(payload.replyer)) ? { replyer: typeof payload.replyer === 'string' ? payload.replyer.slice(0, 240) : payload.replyer } : {}) }, runtimeSummary, observed)
  }
  if (operation === 'manage_metadata') return { action, metadata: { ...(typeof payload.name === 'string' ? { name: payload.name.slice(0, 240) } : {}), value: boundedValuePreview(payload.value) } }
  if (operation === 'manage_structure') {
    const move = action === 'move_slide'
      ? { fromIndex: Number.isInteger(payload.slideIndex) ? payload.slideIndex : null, toIndex: Number.isInteger(payload.toIndex) ? payload.toIndex : null }
      : { sectionIndex: Number.isInteger(payload.sectionIndex) ? payload.sectionIndex : null, toPos: Number.isInteger(payload.toPos) ? payload.toPos : null }
    return withPresentationRuntime({ action, move }, runtimeSummary, observed)
  }
  if (operation === 'replace_text_box') return withPresentationRuntime({ action, target: presentationSlideTarget(payload, ['textBoxIndex']), text: boundedTextPreview(payload.text) }, runtimeSummary, observed)
  if (operation === 'save') return { action }
  if (operation === 'render_slide_visual') return withPresentationRuntime({ action, target: presentationSlideTarget(payload), visual: runtimeSummary?.effect?.visual ?? null }, runtimeSummary, observed)
  if (operation === 'render_scene') {
    const source = Array.isArray(payload.elements) ? payload.elements : []
    return {
      action,
      target: presentationSlideTarget(payload),
      elementCount: source.length,
      elements: source.slice(0, 50).map((candidate, index) => {
        const element = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
        const type = typeof element.type === 'string' ? element.type.slice(0, 32) : 'unknown'
        const fileName = typeof element.fileName === 'string' ? element.fileName.split(/[\\/]/).at(-1).slice(0, 128) : undefined
        return {
          index, type, position: previewPosition(element),
          ...boundedTextPreview(element.text),
          ...(Number.isInteger(element.rows) ? { rows: element.rows } : {}),
          ...(Number.isInteger(element.columns) ? { columns: element.columns } : {}),
          ...(presentationChartTypePreview(element.chartType) === undefined ? {} : { chartType: presentationChartTypePreview(element.chartType) }),
          ...(fileName === undefined ? {} : { fileName }),
        }
      }),
    }
  }
  return { action }
}
function presentationPreviewSummary(operation, payload, runtimeSummary, precondition = undefined) {
  const summary = previewSummary(operation, payload, runtimeSummary)
  return { ...summary, confirmation: presentationConfirmation(operation, payload, runtimeSummary, presentationObservedTarget(precondition)) }
}
function validPresentationInspectResult(value, request) {
  return validPresentationReadResult(value) && Number.isInteger(value.resource.slideCount) && value.resource.slideCount >= 0 && value.resource.slideCount <= 10000
    && value.operation === request.operation && validPresentationRuntimeSummary(value.summary)
    && value.precondition && typeof value.precondition === 'object' && !Array.isArray(value.precondition)
    && JSON.stringify(value.precondition).length <= 100000
}
function validPresentationWriteResult(value, request) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.status === 'verified_write'
    // A verified mutation may legitimately change the version fingerprint. It
    // must still read back from the same immutable presentation identity.
    && value.operation === request.operation && samePresentationDocument(value.resource, request.resource)
    && value.observed && typeof value.observed === 'object' && !Array.isArray(value.observed)
    && value.observed.verified === true && validPresentationContextResult(value.observed)
    && samePresentationTarget(value.observed.resource, value.resource)
}
function nonNegativePresentationIndex(value) { return Number.isInteger(value) && value >= 0 && value <= 9999 }
function validPresentationRect(value) { return value && typeof value === 'object' && !Array.isArray(value) && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(value[key])) }
function validPresentationChartType(value) {
  const values = new Set(Object.values(PRESENTATION_CHART_TYPES))
  if (Number.isFinite(value)) return values.has(value)
  if (typeof value !== 'string' || value.length > 128) return false
  const normalized = value.trim()
  if (Object.hasOwn(PRESENTATION_CHART_TYPES, normalized)) return true
  return /^[+-]?\d+$/.test(normalized) && values.has(Number(normalized))
}
function validPresentationSceneElement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validPresentationRect(value)) return false
  const exactKeys = (keys) => Object.keys(value).every((key) => keys.includes(key))
  const rect = ['type', 'left', 'top', 'width', 'height']
  if (value.type === 'text') return exactKeys([...rect, 'text']) && typeof value.text === 'string'
  if (value.type === 'image') return exactKeys([...rect, 'fileName']) && typeof value.fileName === 'string' && value.fileName.length > 0 && value.fileName.length <= 2048
  if (value.type === 'table') return exactKeys([...rect, 'rows', 'columns']) && Number.isInteger(value.rows) && value.rows > 0 && Number.isInteger(value.columns) && value.columns > 0
  return value.type === 'chart' && exactKeys([...rect, 'chartType']) && validPresentationChartType(value.chartType)
}
function validPresentationSlideVisual(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['action', 'slideIndex', 'svg', 'left', 'top', 'width', 'height'].includes(key))
    && value.action === 'replace_visual' && nonNegativePresentationIndex(value.slideIndex)
    && typeof value.svg === 'string' && value.svg.length > 0 && value.svg.length <= 100000
    && validPresentationRect(value)
}
function validPresentationPreviewPayload(operation, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !PRESENTATION_WRITE_OPERATIONS.includes(operation)) return false
  const action = payload.action
  if (!PRESENTATION_WRITE_ACTIONS[operation].includes(action)) return false
  const allowed = PRESENTATION_WRITE_PAYLOAD_FIELDS[`${operation}:${action}`]
  if (!allowed || !Object.keys(payload).every((key) => allowed.includes(key))) return false
  const exactNestedFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key)) && Object.keys(value).some((key) => value[key] !== undefined)
  if (operation === 'manage_slides') return action === 'add'
    ? (payload.index === undefined || Number.isFinite(payload.index))
    : nonNegativePresentationIndex(payload.slideIndex)
  if (operation === 'render_scene') return action === 'replace_scene' && nonNegativePresentationIndex(payload.slideIndex)
    && Array.isArray(payload.elements) && payload.elements.length >= 1 && payload.elements.length <= 50 && payload.elements.every(validPresentationSceneElement)
  if (operation === 'render_slide_visual') return validPresentationSlideVisual(payload)
  if (operation === 'edit_selection') return action === 'update' && nonNegativePresentationIndex(payload.slideIndex)
    && exactNestedFields(payload.edit, PRESENTATION_EDIT_FIELDS)
  if (operation === 'manage_objects') return nonNegativePresentationIndex(payload.slideIndex) && nonNegativePresentationIndex(payload.objectIndex)
    && (action === 'delete' || (action === 'update' && payload.object && typeof payload.object === 'object' && !Array.isArray(payload.object)
      && exactNestedFields(payload.object, PRESENTATION_OBJECT_FIELDS)))
  if (operation === 'manage_tables') return action === 'insert' && nonNegativePresentationIndex(payload.slideIndex)
    && Number.isInteger(payload.rows) && payload.rows > 0 && Number.isInteger(payload.columns) && payload.columns > 0 && validPresentationRect(payload) && payload.useScale === undefined
  if (operation === 'manage_charts') return action === 'insert' && nonNegativePresentationIndex(payload.slideIndex)
    && validPresentationChartType(payload.chartType) && validPresentationRect(payload) && payload.chartStyle === undefined
  if (operation === 'manage_notes') return action === 'replace' && nonNegativePresentationIndex(payload.slideIndex) && typeof payload.text === 'string'
  if (operation === 'manage_comments') return action === 'add' && nonNegativePresentationIndex(payload.slideIndex) && typeof payload.text === 'string'
    && (payload.replyer === undefined || typeof payload.replyer === 'string' && payload.replyer.length > 0 && payload.replyer.length <= 256 || Number.isSafeInteger(payload.replyer) && payload.replyer >= 0)
  if (operation === 'manage_metadata') return action === 'set_builtin' && typeof payload.name === 'string' && payload.name.length > 0 && payload.value !== undefined
  if (operation === 'manage_structure') return action === 'move_slide'
    ? nonNegativePresentationIndex(payload.slideIndex) && nonNegativePresentationIndex(payload.toIndex)
    : nonNegativePresentationIndex(payload.sectionIndex) && nonNegativePresentationIndex(payload.toPos)
  if (operation === 'replace_text_box') return action === 'replace' && nonNegativePresentationIndex(payload.slideIndex)
    && nonNegativePresentationIndex(payload.textBoxIndex) && typeof payload.text === 'string'
  return operation === 'save' && action === 'save'
}
function validFlatPresentationArguments(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (name === 'presentation_get_capabilities' || name === 'presentation_get_context' || name === 'presentation_get_selection') return keys.length === 0
  if (name === 'presentation_get_text_boxes') return keys.every((key) => key === 'slideIndex') && (value.slideIndex === undefined || Number.isInteger(value.slideIndex) && value.slideIndex >= 0 && value.slideIndex <= 9999)
  if (name === 'presentation_write_preview') return keys.length === 2 && PRESENTATION_WRITE_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000
    && validPresentationPreviewPayload(value.operation, value.payload)
  return name === 'presentation_write_commit' && keys.length === 1 && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
}

function validFlatSpreadsheetArguments(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  const boundedSheetName = value.sheetName === undefined || typeof value.sheetName === 'string' && value.sheetName.trim().length > 0 && value.sheetName.length <= 128
  const boundedRange = typeof value.range === 'string' && value.range.trim().length > 0 && value.range.length <= 128
  if (name === 'spreadsheet_get_context') return keys.length === 0
  if (name === 'spreadsheet_read_range') return keys.every((key) => ['range', 'sheetName'].includes(key)) && boundedRange && boundedSheetName
  if (name === 'spreadsheet_search') return keys.every((key) => ['query', 'range', 'sheetName', 'matchCase', 'matchEntireCell', 'searchBy', 'offset', 'limit'].includes(key))
    && typeof value.query === 'string' && value.query.trim().length > 0 && value.query.length <= 500 && boundedRange && boundedSheetName
    && (value.matchCase === undefined || typeof value.matchCase === 'boolean')
    && (value.matchEntireCell === undefined || typeof value.matchEntireCell === 'boolean')
    && (value.searchBy === undefined || ['values', 'text', 'formula'].includes(value.searchBy))
    && (value.offset === undefined || Number.isInteger(value.offset) && value.offset >= 0 && value.offset <= 100000)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
  if (name === 'spreadsheet_inspect') return validSpreadsheetInspectArguments(value)
  if (name === 'spreadsheet_write_preview') return keys.length === 2 && typeof value.operation === 'string' && SPREADSHEET_WRITE_OPERATIONS.includes(value.operation)
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) && JSON.stringify(value.payload).length <= 100000
    && spreadsheetPreviewComplete(value.operation, value.payload)
  return name === 'spreadsheet_write_commit' && keys.length === 1
    && typeof value.challenge === 'string' && value.challenge.length > 0 && value.challenge.length <= 256
}

const SPREADSHEET_INSPECT_RUNTIME_ACTIONS = Object.freeze({
  active_sheet: 'active_sheet', selection: 'selection', used_range: 'used_range',
  workbook: 'workbook_info', sheets: 'sheets', view: 'view', protection: 'worksheet_protection',
  preflight: 'write_preflight', filter: 'filter_state', filter_values: 'filter_values',
  range_features: 'range_features', special_cells: 'special_cells', charts: 'list_charts',
  chart: 'chart', pivots: 'list_pivots', pivot: 'pivot', pivot_field_items: 'pivot_field_items',
  defined_names: 'defined_names', print_settings: 'print_settings', outline: 'outline',
  dimensions: 'dimensions', capabilities: 'capabilities', debug_runtime: 'debug_runtime', probe_range_api: 'probe_range_api',
})
function boundedOptionalText(value, maxLength = 128) {
  return value === undefined || typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}
function validSpreadsheetInspectArguments(value) {
  const keys = Object.keys(value)
  if (!SPREADSHEET_INSPECT_ACTIONS.includes(value.action)
    || !keys.every((key) => ['action', 'range', 'sheetName', 'index', 'fieldName', 'axis', 'cellType', 'offset', 'limit'].includes(key))
    || !boundedOptionalText(value.range) || !boundedOptionalText(value.sheetName) || !boundedOptionalText(value.fieldName)
    || (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 1 || value.index > 10000))
    || (value.axis !== undefined && !['row', 'column'].includes(value.axis))
    || (value.cellType !== undefined && !['blanks', 'constants', 'formulas', 'lastCell', 'visible'].includes(value.cellType))
    || (value.offset !== undefined && (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > 100000))
    || (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200))) return false
  const rangeRequired = new Set(['filter', 'filter_values', 'range_features', 'special_cells', 'outline', 'dimensions', 'capabilities', 'probe_range_api'])
  const indexRequired = new Set(['chart', 'pivot', 'pivot_field_items'])
  if (rangeRequired.has(value.action) && value.range === undefined) return false
  if (indexRequired.has(value.action) && value.index === undefined) return false
  if (['outline', 'dimensions'].includes(value.action) && value.axis === undefined) return false
  if (value.action === 'special_cells' && value.cellType === undefined) return false
  if (value.action === 'pivot_field_items' && value.fieldName === undefined) return false
  return true
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
      if (lightDocumentMermaidIsUnsupported(args.payload?.mermaid)) return `light_document_write_preview insert_drawing does not support ${lightDocumentMermaidDirective(args.payload.mermaid)} in this WebEdit target. Use flowchart or pie instead.`
      return 'light_document_write_preview insert_drawing requires Mermaid source. To insert after the current selected content, first call light_document_selection_read, then use payload { mermaid: "flowchart TD\\n开始 --> 结束", position: "after_selection", expectedSelectionFingerprint }. For document-block insertion, use start/end/before/after; before/after require id or index. SVG, text, image, and unknown payload fields are not accepted.'
    }
    if (args.operation === 'blocks_insert' && lightDocumentInsertFragments('blocks_insert', args.payload) === null) {
      const count = Array.isArray(args.payload.blocks) ? args.payload.blocks.length : undefined
      if (count !== undefined && count > 50) return `light_document_write_preview blocks_insert accepts at most 50 blocks per preview; received ${count}. Split the body into ordered batches of at most 50, and complete preview → user confirmation → commit → same Browser Target readback for each batch before starting the next.`
      return 'light_document_write_preview blocks_insert requires supported blocks and an optional insertion position.'
    }
    if (args.operation === 'blocks_delete' && lightDocumentBatchItems('blocks_delete', args.payload) === null) {
      return 'light_document_write_preview blocks_delete accepts only payload { blocks: [{ id }] } with one to fifty distinct stable ids. It does not accept index, including { blocks: [{ index: 7 }] }; call light_document_read, then use its current ids.'
    }
    if (lightDocumentOperationNeedsStableBlockLocator(args.operation) && !lightDocumentReplacementTargets(args.operation, args.payload)) {
      return `light_document_write_preview ${args.operation} requires a stable id or index from the current light_document_read result for every replacement target. Do not use replace on a blank document; use blocks_insert for structured body content or selection_insert at a verified caret.`
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
  if (name === 'light_document_selection_replace_preview') return keys.length === 1 && selectionPreviewBlocksValid(value.blocks)
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
function sameLightDocumentWriteTarget(result, request) {
  if (sameLightDocumentTarget(result.resource, request.resource)) return true
  const title = result.observed?.title
  // Initializing an empty document title legitimately changes documentName.
  // Keep that narrow exception tied to the blocks_insert response which has
  // already attested the requested body fragments below.
  return request.operation === 'blocks_insert' && title?.initialized === true
    && typeof title.text === 'string' && title.text.trim().length > 0 && title.text.length <= 500
    && validLightDocumentResource(result.resource) && validLightDocumentResource(request.resource)
    && result.resource.kind === request.resource.kind && result.resource.origin === request.resource.origin
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
  if (!['start', 'end', 'before', 'after', 'after_selection'].includes(position)) return null
  if ((position === 'before' || position === 'after') && !(typeof payload.id === 'string' && payload.id) && !Number.isInteger(payload.index)) return null
  if (position === 'after_selection' && (typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(payload.expectedSelectionFingerprint) || payload.id !== undefined || payload.index !== undefined)) return null
  if (position !== 'after_selection' && payload.expectedSelectionFingerprint !== undefined) return null
  const allowed = operation === 'insert_drawing' ? ['mermaid', 'position', 'id', 'index', 'expectedSelectionFingerprint'] : ['blocks', 'position', 'id', 'index']
  if (!Object.keys(payload).every((key) => allowed.includes(key))) return null
  if (operation === 'insert_drawing') {
    if (typeof payload.mermaid !== 'string' || !payload.mermaid.trim() || payload.mermaid.length > 20_000) return null
    if (lightDocumentMermaidIsUnsupported(payload.mermaid)) return null
    const fragments = distinctiveLightDocumentFragments(payload.mermaid)
    return fragments.length ? { kind: 'mermaid', fragments, position } : null
  }
  if (!Array.isArray(payload.blocks) || payload.blocks.length < 1 || payload.blocks.length > 50 || !payload.blocks.every(lightDocumentStructuredBlockValid)) return null
  const fragments = distinctiveLightDocumentFragments(payload.blocks.map(lightDocumentStructuredBlockText).join('\n'))
  return fragments.length ? { kind: 'blocks', fragments, position } : null
}
function lightDocumentMermaidDirective(source) {
  if (typeof source !== 'string') return 'this Mermaid diagram'
  return source.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('%%'))?.split(/\s+/)[0] ?? 'this Mermaid diagram'
}
function lightDocumentMermaidIsUnsupported(source) { return lightDocumentMermaidDirective(source).toLowerCase() === 'xychart-beta' }
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
function selectionDeleteFragments(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Object.keys(payload).every((key) => key === 'expectedSelectionFingerprint')
    || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(payload.expectedSelectionFingerprint)) return null
  return { expectedSelectionFingerprint: payload.expectedSelectionFingerprint }
}
function selectionPreviewBlocksValid(blocks) {
  return Array.isArray(blocks) && blocks.length <= 50 && blocks.every(lightDocumentStructuredBlockValid)
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
function lightDocumentStableBlockLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
  const index = Number.isInteger(value.index) && value.index >= 0 && value.index <= 100000
  return id || index
}
function lightDocumentOperationNeedsStableBlockLocator(operation) {
  return ['replace', 'delete', 'format', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit'].includes(operation)
}
function lightDocumentReplacementTargets(operation, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (['replace', 'delete', 'format', 'blocks_replace'].includes(operation)) return lightDocumentStableBlockLocator(payload)
  if (operation === 'blocks_batch_replace') {
    return Array.isArray(payload.replacements) && payload.replacements.length >= 1 && payload.replacements.length <= 50
      && payload.replacements.every(lightDocumentStableBlockLocator)
  }
  if (operation === 'blocks_batch_edit') {
    const edits = Array.isArray(payload.edits) ? payload.edits : Array.isArray(payload.replacements) ? payload.replacements : []
    const deletions = Array.isArray(payload.deletions) ? payload.deletions : []
    const targets = [...edits, ...deletions]
    return targets.length >= 1 && targets.length <= 50 && targets.every(lightDocumentStableBlockLocator)
  }
  return true
}
function lightDocumentIsSemanticEmpty(document) {
  if (document?.emptyBody?.semantic === true) return true
  if (document?.emptyBody?.semantic === false) return false
  if (document?.blockCount !== 1 || document?.hasMore !== false || !Array.isArray(document?.blocks) || document.blocks.length !== 1) return false
  const block = document.blocks[0]
  const type = String(block?.type ?? block?.blockType ?? '').trim().toLowerCase()
  if (type !== 'p' && type !== 'paragraph') return false
  if (block?.truncated === true) return false
  if (typeof block?.text === 'string') return block.text.trim() === ''
  return block?.textLength === 0
}
function validLightDocumentOperationPayload(operation, payload) {
  if (lightDocumentPayloadHasLiteralEscapedNewline(payload)) return false
  if (operation === 'selection_insert' || operation === 'selection_replace' || operation === 'selection_content_replace') return selectionInsertFragments(payload) !== null
  if (operation === 'selection_blocks_replace') return selectionBlocksReplaceFragments(payload) !== null
  if (operation === 'selection_delete') return selectionDeleteFragments(payload) !== null
  if (operation === 'insert_drawing' || operation === 'blocks_insert') return lightDocumentInsertFragments(operation, payload) !== null
  if (lightDocumentOperationNeedsStableBlockLocator(operation)) return lightDocumentReplacementTargets(operation, payload)
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
    && result.observed?.verified === true && sameLightDocumentWriteTarget(result, request)
  if (!matchesRequest) return false
  if (request.operation === 'selection_insert' || request.operation === 'selection_replace' || request.operation === 'selection_content_replace') return verifiedFragmentEvidence(request, result, selectionInsertFragments(request.payload))
  if (request.operation === 'selection_blocks_replace') {
    const requested = selectionBlocksReplaceFragments(request.payload)
    return verifiedFragmentEvidence(request, result, requested)
      && Array.isArray(result.observed?.replacedTagIds) && result.observed.replacedTagIds.length >= 1
      && Array.isArray(result.observed?.observedBlocks) && result.observed.observedBlocks.length >= 1
  }
  if (request.operation === 'selection_delete') {
    const partial = typeof result.observed?.deletedSelectionText === 'string' && result.observed.deletedSelectionText.length > 0
      && typeof result.observed?.verifiedTextAfter === 'string'
      && result.observed?.deletedTagIds === undefined && result.observed?.outsideSelectionBlocks === undefined
    const wholeBlocks = Array.isArray(result.observed?.deletedTagIds) && result.observed.deletedTagIds.length > 0
      && result.observed.deletedTagIds.every((id) => typeof id === 'string' && id.length > 0)
      && Array.isArray(result.observed?.outsideSelectionBlocks)
      && result.observed.outsideSelectionBlocks.every((block) => block && typeof block === 'object'
        && typeof block.type === 'string' && typeof block.text === 'string'
        && (block.language === undefined || block.language === null || typeof block.language === 'string'))
      && result.observed?.deletedSelectionText === undefined && result.observed?.verifiedTextAfter === undefined
    return partial !== wholeBlocks
  }
  if (request.operation === 'insert_drawing' || request.operation === 'blocks_insert') {
    const requested = lightDocumentInsertFragments(request.operation, request.payload)
    if (!verifiedFragmentEvidence(request, result, requested)) return false
    if (request.operation !== 'insert_drawing' || requested.position !== 'after_selection') return true
    const insertion = result.observed?.insertion
    return insertion?.position === 'after_selection' && Array.isArray(insertion.selectedTagIds) && insertion.selectedTagIds.length > 0
      && insertion.selectedTagIds.every((id) => typeof id === 'string' && id.length > 0)
      && insertion.insertedBlock?.type === 'codeblock' && insertion.insertedBlock?.language === 'mermaid'
  }
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
const MAX_PMD_PRD_REVIEW_ADOPTIONS = 32
function validPmdPrdReviewAdoption(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && ['runId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'contentHash'].every(key => typeof value[key] === 'string')
    && /^[A-Za-z0-9._:-]{1,160}$/.test(value.runId) && /^[A-Za-z0-9._:-]{1,160}$/.test(value.harnessSessionId)
    && /^[A-Za-z0-9._:-]{1,160}$/.test(value.reviewId) && /^[A-Za-z0-9._:-]{1,160}$/.test(value.resourceId)
    && typeof value.displayPath === 'string' && value.displayPath.length > 0 && value.displayPath.length <= 2048
    && /^[A-Za-z0-9._:-]{1,160}$/.test(value.revision) && /^[a-f0-9]{64}$/i.test(value.fingerprint) && /^[a-f0-9]{64}$/i.test(value.contentHash)
}
function teamKnowledgeBatchFingerprint(items) {
  return hash(JSON.stringify(items.map((item) => ({ name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body) }))))
}
const PMD_PRD_MARKERS = [
  '# PRD:',
  '## 需求基本信息',
  '## 修订记录',
  '# 二、背景与目标',
  '# 四、功能性需求',
  '## （一）正常业务场景',
  '## （二）异常业务场景',
  '# 五、角色权限',
  '# 八、测试关注点',
  '## （三）验收清单',
  '### 正常情况',
  '### 异常情况',
  '### 边界情况',
  '### 权限情况',
  '### 兼容情况',
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
function pmdEstimatedPersonDays(lines) {
  const row = lines.map(line => line.trim().startsWith('|') && line.trim().endsWith('|') ? line.trim().slice(1, -1).split('|').map(cell => cell.trim()) : null).find(cells => cells?.[0] === '预估人天')
  const match = row?.[1]?.match(/^(\d+(?:\.\d+)?)\s*人天$/)
  return match ? Number(match[1]) : null
}
function pmdBasicInformationFailure(visiblePrd) {
  const rows = visiblePrd.split('\n').map(pmdTableRow)
  const required = [['业务需求名称', 0, 1], ['所属系统', 2, 3], ['需求编号及链接', 0, 1], ['产品经理', 2, 3], ['预估人天', 0, 1]]
  for (const [label, labelIndex, valueIndex] of required) {
    const row = rows.find(cells => cells?.includes(label))
    if (!row || row[labelIndex] !== label || !row[valueIndex]?.trim()) return `PRD basic information is missing: ${label}`
  }
  const revision = rows.find(cells => cells?.[0] === 'V1.0')
  if (!revision || revision.length !== 6 || revision.some(cell => !cell.trim())) return 'PRD revision record must be complete'
  const requirement = rows.find(cells => cells?.[0] === '需求编号及链接')?.[1] ?? ''
  if (requirement && !/https?:\/\/\S+/.test(requirement)) return 'PRD basic information must include a confirmed requirement link'
  const estimate = rows.find(cells => cells?.[0] === '预估人天')?.[1] ?? ''
  if (estimate && !/^\d+(?:\.\d+)?\s*人天$/.test(estimate)) return 'PRD 预估人天 must be a confirmed numeric person-day value'
  return null
}
function pmdTableRow(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1).split('|').map(cell => cell.trim()) : null
}
function pmdTableRows(lines, header) {
  const headerIndex = lines.findIndex(line => {
    const row = pmdTableRow(line)
    return row?.length === header.length && row.every((cell, index) => cell === header[index])
  })
  const separator = pmdTableRow(lines[headerIndex + 1] ?? '')
  if (headerIndex < 0 || !separator || separator.length !== header.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return []
  const rows = []
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const row = pmdTableRow(lines[index])
    if (!row) break
    rows.push(row)
  }
  return rows
}
function pmdTargetChangeFailure(target) {
  const text = target.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return '目标修改点不能为空'
  if (/^\[待确认\](?:（[^）]*）)?[。；]?$/.test(text) && !text.includes('影响')) return '目标修改点不能只有[待确认]，必须说明缺失信息对实施或测试的影响'
  const plain = text.replace(/\[待确认\]（[^）]*）/g, '').replace(/[\s\d①②③④⑤⑥⑦⑧⑨⑩.,，。；:：、]/g, '')
  if (plain.length < 8) return '目标修改点信息不足，需说明具体改动或完成效果'
  if (/^(?:(?:优化|调整|修复)[\u4e00-\u9fff]{0,10}|(?:保持一致|正确展示)[\u4e00-\u9fff]{0,6})$/.test(plain)) return '目标修改点不能只是“优化、调整、修复、保持一致、正确展示”等空泛短句'
  if (/(?:^|[^A-Za-z0-9_.\\/-])\/(?:[\w.-]+\/)+[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|java|kts?|go|py|rb|php|cs|sql|xml|ya?ml)\b/i.test(text) || /(?:^|[^A-Za-z0-9_.\\/-])[A-Za-z]:[\\/](?:[\w.-]+[\\/])*[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|java|kts?|go|py|rb|php|cs|sql|xml|ya?ml)\b/i.test(text)) return '目标修改点不得使用开发者本机绝对路径，需使用代码库完整相对路径'
  const codeFile = /(?:^|[^A-Za-z0-9_.\\/-])((?:[\w.-]+\/)*)([\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|java|kts?|go|py|rb|php|cs|sql|xml|ya?ml))\b/g
  for (const match of text.matchAll(codeFile)) if (!match[1]) return `目标修改点中的代码文件必须使用带目录的代码库相对路径，不能只写文件名：${match[2]}`
  if (!/(?:[\w.-]+\/)+[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|java|kts?|go|py|rb|php|cs|sql|xml|ya?ml)\b/.test(text)) return '目标修改点必须包含完整相对路径'
  return null
}
function pmdTextOutsideTargetChangeCells(lines) {
  const result = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = pmdTableRow(lines[index])
    if (!header || header.length !== 4 || !header.every((cell, cellIndex) => cell === ['需求点', '类型', '原有实现', '目标修改点'][cellIndex]) || !pmdTableRow(lines[index + 1])) { result.push(lines[index]); continue }
    result.push(lines[index], lines[index + 1]); index += 2
    for (; index < lines.length; index += 1) {
      const row = pmdTableRow(lines[index])
      if (!row) { index -= 1; break }
      result.push(`| ${row.slice(0, 3).join(' | ')} | [目标修改点] |`)
    }
  }
  return result.join('\n')
}
function pmdDetailedFunctionalFailure(visiblePrd) {
  const lines = visiblePrd.split('\n'); const normalStart = lines.findIndex(line => line.trim() === '## （一）正常业务场景')
  const boundaryStart = lines.findIndex((line, index) => index > normalStart && line.trim() === '## 边界场景')
  const abnormalStart = lines.findIndex((line, index) => index > normalStart && line.trim() === '## （二）异常业务场景')
  if (normalStart < 0 || abnormalStart < 0 || (boundaryStart >= 0 && boundaryStart > abnormalStart)) return 'PRD functional requirements must keep 正常业务场景 → optional 边界场景 → 异常业务场景'
  const normalEnd = boundaryStart >= 0 ? boundaryStart : abnormalStart
  const normal = lines.slice(normalStart + 1, normalEnd)
  if (normal.some(line => /^(?:##|###)\s+(?:改动总览与影响|页面与代码定位总览)$/.test(line.trim()))) return 'PRD must not add a change overview or locator overview'
  const changes = normal.flatMap((line, index) => /^###\s+4\.(\d+)\s+改动点：\S/.test(line.trim()) ? [{ index, number: line.trim().match(/^###\s+4\.(\d+)/)?.[1] }] : [])
  if (!changes.length) return 'PRD normal business scenarios must contain at least one ### 4.x 改动点： heading'
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]; const start = change.index; const end = changes[index + 1]?.index ?? normal.length
    const children = normal.flatMap((line, childIndex) => childIndex > start && childIndex < end && /^####\s+4\.(\d+)\.\d+\s+\S+：\S/.test(line.trim()) ? [childIndex] : [])
    if (!children.length) return `${normal[start].trim()} must contain at least one specific child item`
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = normal.slice(children[childIndex], children[childIndex + 1] ?? end).join('\n'); const heading = normal[children[childIndex]].trim()
      if (heading.match(/^####\s+4\.(\d+)\./)?.[1] !== change.number) return `${heading} must be numbered under ${normal[start].trim()}`
      if (child.split('\n').slice(1).some(line => /^#{5,}\s+/.test(line.trim()))) return `${heading} must not contain Markdown headings below the specific-item level`
      if (child.split('\n').slice(1).some(line => { const row = pmdTableRow(line); return row?.length === 2 && row[0] === '定位项' && row[1] === '位置' })) return `${heading} must not contain legacy locator table`
      const changeRows = pmdTableRows(child.split('\n'), ['需求点', '类型', '原有实现', '目标修改点'])
      if (!changeRows.length) return `${heading} is missing required development change table: 需求点 / 类型 / 原有实现 / 目标修改点`
      for (const row of changeRows) {
        const [requirement, type, original, target] = row
        if (row.length !== 4 || !requirement || !type || !original || !target) return `${heading} development change table must contain complete 需求点、类型、原有实现、目标修改点`
        if (!['新增', '修改', '删除', '修复'].includes(type)) return `${heading} 类型 must be one of: 新增、修改、删除、修复`
        if (type === '新增' && original !== '不适用（新增）') return `${heading} 新增 item 原有实现 must be 不适用（新增）`
        if (type !== '新增' && (original === '不适用（新增）' || (original.includes('[待确认]') && !/（[^）]+）/.test(original)))) return `${heading} ${type} item 原有实现 must be confirmed or explain [待确认] impact`
        const targetChangeFailure = pmdTargetChangeFailure(target)
        if (targetChangeFailure) return `${heading} ${targetChangeFailure}`
      }
    }
  }
  const estimatedDays = pmdEstimatedPersonDays(lines)
  if (boundaryStart < 0) return estimatedDays !== null && estimatedDays > 10 ? 'PRD boundary scenarios are required when estimated person-days exceed 10' : null
  const boundary = lines.slice(boundaryStart + 1, abnormalStart).join('\n')
  for (const systemBoundary of ['超时', '并发', '数据量极值']) {
    const match = boundary.match(new RegExp(`^\\|\\s*${systemBoundary}\\s*\\|\\s*(.*?)\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))
    if (!match || !match[1] || !match[2] || match[1].includes('[待确认]') || match[2].includes('[待确认]')) return `PRD boundary scenarios must define system behaviour for: ${systemBoundary}`
  }
  return null
}
function pmdBatchTemplateFailure(batchId, items) {
  if (!batchId.startsWith('pmd:')) return null
  if (items.length !== 1) return 'PMD delivery requires exactly one PRD document'
  const [prd] = items
  if (!prd.name.endsWith('_PRD')) return 'PMD document name must end with _PRD'
  if (/\\n/.test(markdownOutsideFences(prd.body))) return `${prd.name} contains a literal \\n outside a fenced code block`
  const missingPrd = orderedMarkdownMarkersMissing(prd.body, PMD_PRD_MARKERS)
  if (missingPrd) return `PRD document is missing or reorders: ${missingPrd}`
  for (const header of ['| 业务需求名称 |', '| 版本 | 日期 |', '| 角色 | 功能/页面 |']) if (!prd.body.includes(header)) return `PRD document is missing required table: ${header}`
  const internalTerm = /\b(?:Evidence|Impact|Task|AC)\b|测试\s*seam|证据分类|代码影响地图|纵向任务|验收合同/
  const visiblePrd = markdownOutsideFences(prd.body)
  if (visiblePrd.includes('[待确认]')) return 'PRD document contains [待确认]; confirm required facts before freezing'
  const basicInformationFailure = pmdBasicInformationFailure(visiblePrd)
  if (basicInformationFailure) return basicInformationFailure
  const functionalFailure = pmdDetailedFunctionalFailure(visiblePrd)
  if (functionalFailure) return functionalFailure
  const prdInternalTerm = visiblePrd.match(internalTerm)
  if (prdInternalTerm) return `PRD document exposes an internal delivery term: ${prdInternalTerm[0]}`
  const fieldLabel = visiblePrd.match(/\[(?:必填|选填|建议填写|涉及多系统交互时必填)\]|【选填】/)
  if (fieldLabel) return `PRD document exposes a field label: ${fieldLabel[0]}`
  if (/AccrUI\s*需求交接附录/.test(visiblePrd)) return 'PRD document appends a non-company-template handoff section'
  const visibleLines = visiblePrd.split('\n'); const outsideTargetChangeCells = pmdTextOutsideTargetChangeCells(visibleLines)
  const codeLocator = outsideTargetChangeCells.match(/(?:^|[\s`])(?:[\w.-]+\/)*[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|java|kts?|go|py|rb|php|cs|sql|xml|ya?ml)\b/im)
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
function teamKnowledgeCatalogIdFromBrowserTarget(browserTarget) {
  if (!validBrowserTarget(browserTarget)) return null
  try {
    const url = new URL(browserTarget.url)
    const match = /^\/teamKnowledge\/detail\/docOnline\/(\d+)\/?$/.exec(url.pathname)
    if (url.origin !== 'https://doc.midea.com' || !match) return null
    const queryCatalogId = url.searchParams.get('id')
    return queryCatalogId === null || queryCatalogId === match[1] ? match[1] : null
  } catch { return null }
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
  if (error === 'team_doc_batch_replace_invalid_range') {
    return { stage, reason: '新建空白文档没有可替换的标题区块；将复用同一文档按原批次恢复写入。', retryable: true }
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

function validOfficeFailureDetails(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return true
  if (typeof value === 'string') return value.length <= 2_000
  // Keep this exactly aligned with the Extension contract.  A PPT
  // readback_mismatch contains details.observed.objects at five levels.
  if (depth >= 5 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length <= 30 && value.every((item) => validOfficeFailureDetails(item, depth + 1))
  const entries = Object.entries(value)
  return entries.length <= 30 && entries.every(([key, child]) => key.length <= 128 && validOfficeFailureDetails(child, depth + 1))
}

function validOfficeReadFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.every((key) => ['code', 'message', 'details'].includes(key)) && keys.includes('code') && keys.includes('message')
    && ['unsupported', 'preview', 'readonly', 'invalid_range', 'invalid_request', 'write_rejected', 'write_incomplete', 'navigation', 'iframe_replaced', 'timeout', 'cancelled', 'precondition_required', 'fingerprint_mismatch', 'selection_changed', 'context_mismatch', 'readback_mismatch', 'runtime_error'].includes(value.code)
    && typeof value.message === 'string' && value.message.length > 0
    && (value.details === undefined || value.details && typeof value.details === 'object' && !Array.isArray(value.details) && validOfficeFailureDetails(value.details))
}

function isPeerPreMutationFingerprintMismatch(error) {
  try {
    const value = JSON.parse(error instanceof Error ? error.message : String(error))
    return value?.code === 'fingerprint_mismatch'
  } catch { return false }
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
 * deliberately the narrow Issue #2 tracer-bullet: list_work_tabs
 * crosses into Native Messaging.
 */
export class BrowserConnector {
  /** @param {{ requestExtension: (request: object) => void, requestTimeoutMs?: number, officeRequestTimeoutMs?: number, teamKnowledgeWriteRequestTimeoutMs?: number, knowledgeRequestTimeoutMs?: number, knowledgeCatalogTimeoutMs?: number, onToolsListed?: () => void, fetch?: typeof fetch, reportPrdEvent?: (event: object) => Promise<unknown> | unknown, teamDocStore?: TeamDocRecordStore, teamKnowledgeBatchStore?: TeamKnowledgeBatchRecordStore, officeDocumentWriteStore?: OfficeDocumentWriteRecordStore }} options */
  constructor(options) {
    this.requestExtension = options.requestExtension
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.officeRequestTimeoutMs = options.officeRequestTimeoutMs ?? OFFICE_REQUEST_TIMEOUT_MS
    this.teamKnowledgeWriteRequestTimeoutMs = options.teamKnowledgeWriteRequestTimeoutMs ?? TEAM_KNOWLEDGE_WRITE_REQUEST_TIMEOUT_MS
    this.knowledgeRequestTimeoutMs = options.knowledgeRequestTimeoutMs ?? KNOWLEDGE_REQUEST_TIMEOUT_MS
    this.knowledgeCatalogTimeoutMs = options.knowledgeCatalogTimeoutMs ?? KNOWLEDGE_CATALOG_TIMEOUT_MS
    this.onToolsListed = options.onToolsListed
    this.reportPrdEvent = options.reportPrdEvent ?? (() => undefined)
    // Undici's default bodyTimeout is 300s. A repo-search SSE often stays
    // quiet while the upstream Explore agents run, which looks like "fetch
    // failed" at ~5 minutes. AccrUI uses Chrome fetch and has no such cut.
    this.knowledgeFetchOptions = { connectTimeout: 30_000, headersTimeout: this.knowledgeRequestTimeoutMs, bodyTimeout: 0 }
    this.fetch = options.fetch ?? ((input, init = {}) => knowledgeHttpsFetch(input, init, this.knowledgeFetchOptions))
    this.server = undefined
    this.url = undefined
    this.token = undefined
    this.generation = undefined
    this.runTargets = new RunTargetRegistry()
    this.capturedBrowserTargets = new Map()
    this.browserCallBindings = new AsyncLocalStorage()
    this.pending = new Map()
    this.updateQuiescent = false
    this.teamDocStore = options.teamDocStore ?? new TeamDocRecordStore()
    this.teamKnowledgeBatchStore = options.teamKnowledgeBatchStore ?? new TeamKnowledgeBatchRecordStore()
    this.teamKnowledgeBatchChallenges = new Map()
    this.pmdPrdReviewAdoptions = new Map()
    this.teamKnowledgeBatchLocks = new Map()
    this.officeDocumentChallenges = new Map()
    this.spreadsheetChallenges = new Map()
    this.spreadsheetWriteLocks = new Map()
    this.presentationChallenges = new Map()
    this.presentationWriteLocks = new Map()
    this.officeDocumentWrites = new Map()
    this.htmlWorkbenchChallenges = new Map()
    this.htmlWorkbenchWriteLocks = new Map()
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

  /** True while a Browser operation is still awaiting its Extension response. */
  isBusy() {
    return this.pending.size > 0
  }

  /** Atomically reject new browser work after observing this Connector idle. */
  beginUpdateQuiescence() {
    if (this.updateQuiescent || this.pending.size > 0) return false
    this.updateQuiescent = true
    return true
  }

  endUpdateQuiescence() {
    this.updateQuiescent = false
  }

  /** @returns {Promise<void>} */
  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Browser Connector stopped'))
    }
    this.pending.clear()
    this.officeDocumentChallenges.clear()
    this.spreadsheetChallenges.clear()
    this.spreadsheetWriteLocks.clear()
    this.presentationChallenges.clear()
    this.presentationWriteLocks.clear()
    this.officeDocumentWrites.clear()
    this.htmlWorkbenchChallenges.clear()
    this.htmlWorkbenchWriteLocks.clear()
    this.uncertainSelectionWrite = undefined
    this.teamKnowledgeBatchChallenges.clear()
    this.pmdPrdReviewAdoptions.clear()
    this.runTargets.clear()
    this.capturedBrowserTargets.clear()
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
    const registered = this.runTargets.register(runId, browserTarget, browserTargets, unavailableBrowserTargets)
    if (!registered.ok) return false
    if (registered.runChanged) {
      this.officeDocumentChallenges.clear()
      this.spreadsheetChallenges.clear()
      this.spreadsheetWriteLocks.clear()
      this.presentationChallenges.clear()
      this.presentationWriteLocks.clear()
      this.officeDocumentWrites.clear()
      this.htmlWorkbenchChallenges.clear()
      this.htmlWorkbenchWriteLocks.clear()
      this.teamKnowledgeBatchChallenges.clear()
      this.capturedBrowserTargets.clear()
      this.uncertainSelectionWrite = undefined
    }
    if (registered.targetChanged) this.uncertainSelectionWrite = undefined
    return true
  }

  /** Store one Browser Target that the trusted Extension confirmed for a Run. */
  bindBrowserTarget(runId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (!validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets)) return false
    return this.registerRun(runId, browserTarget, browserTargets, unavailableBrowserTargets)
  }

  /** Keep a send-time target per Harness session without changing the active Connector Run. */
  captureBrowserTarget(runId, sessionId, submissionId, browserTarget, browserTargets, unavailableBrowserTargets) {
    if (this.runTargets.currentRunId !== runId || !validHarnessSessionIdentity(sessionId) || !validHarnessSessionIdentity(submissionId)
      || !validBrowserTargetSet(browserTarget, browserTargets, unavailableBrowserTargets)) return false
    const key = `${runId}\u0000${sessionId}`
    this.capturedBrowserTargets.set(key, Object.freeze({ submissionId, browserTarget, browserTargets: browserTargets ?? [browserTarget], unavailableBrowserTargets: unavailableBrowserTargets ?? [] }))
    return true
  }

  releaseCapturedBrowserTarget(sessionId, submissionId) {
    if (!validHarnessSessionIdentity(sessionId) || !validHarnessSessionIdentity(submissionId) || this.runTargets.currentRunId === undefined) return false
    const key = `${this.runTargets.currentRunId}\u0000${sessionId}`
    const captured = this.capturedBrowserTargets.get(key)
    if (!captured || captured.submissionId !== submissionId) return false
    this.capturedBrowserTargets.delete(key)
    return true
  }

  #browserBinding(message) {
    const fallback = this.runTargets.current()
    const runId = fallback?.runId
    if (runId === undefined) throw new Error('No active Harness Run is available for Browser Target use.')
    const owner = browserTargetOwner(message)
    const capturesExist = [...this.capturedBrowserTargets.keys()].some(key => key.startsWith(`${runId}\u0000`))
    if (owner === undefined) {
      if (capturesExist) throw new Error('Browser Connector request lacks a Harness session identity, so its captured Browser Target cannot be selected.')
      if (!validBrowserTarget(fallback?.browserTarget)) throw new Error('No Browser Target is bound to this Run by the Extension.')
      return { ...fallback, harnessSessionId: undefined }
    }
    const captured = this.capturedBrowserTargets.get(`${runId}\u0000${owner}`)
    if (captured === undefined) throw new Error('No Browser Target was captured for this Harness session; refusing to use another session’s page.')
    return { runId, browserTarget: captured.browserTarget, browserTargets: captured.browserTargets, unavailableBrowserTargets: captured.unavailableBrowserTargets, harnessSessionId: owner }
  }

  #activateCapturedBrowserTarget(message) {
    return this.#browserBinding(message)
  }

  #currentBrowserBinding() {
    return this.browserCallBindings.getStore() ?? this.runTargets.current()
  }

  /** Store the exact saved PRD accepted in the visual Markdown Review. */
  recordPmdPrdReviewAdoption(adoption) {
    if (!validPmdPrdReviewAdoption(adoption) || this.runTargets.currentRunId !== adoption.runId) return false
    const key = adoption.harnessSessionId
    if (!this.pmdPrdReviewAdoptions.has(key) && this.pmdPrdReviewAdoptions.size >= MAX_PMD_PRD_REVIEW_ADOPTIONS) {
      this.pmdPrdReviewAdoptions.delete(this.pmdPrdReviewAdoptions.keys().next().value)
    }
    this.pmdPrdReviewAdoptions.set(key, Object.freeze({ ...adoption, batchId: undefined }))
    return true
  }

  #authorizePmdPrdPreview(batchId, runId, identity, items, reserve = true) {
    const key = identity?.parentSessionId ?? identity?.sessionId
    if (!key) throw new Error('pmd_prd_review_adoption_session_required')
    const adoption = this.pmdPrdReviewAdoptions.get(key)
    if (!adoption) throw new Error('pmd_prd_review_adoption_required')
    if (items.length !== 1 || hash(items[0].body) !== adoption.contentHash) throw new Error('pmd_prd_review_adoption_content_changed')
    if (adoption.batchId !== undefined && adoption.batchId !== batchId) throw new Error('pmd_prd_review_adoption_batch_changed')
    if (reserve && adoption.batchId === undefined) this.pmdPrdReviewAdoptions.set(key, Object.freeze({ ...adoption, batchId }))
    return adoption
  }

  #preflightPmdPrdPreview(batchId, runId, identity, items) {
    const templateFailure = pmdBatchTemplateFailure(batchId, items)
    if (templateFailure) throw new Error(`pmd_prd_template_invalid: ${templateFailure}`)
    if (batchId.startsWith('pmd:')) this.#authorizePmdPrdPreview(batchId, runId, identity, items, false)
  }

  #reportAiLightDocumentWrite(message, runId, browserTarget, result, idempotencyIdentity) {
    try {
      const identity = harnessIdentity(message)
      const sessionId = identity?.parentSessionId ?? identity?.sessionId
      const catalogId = teamKnowledgeCatalogIdFromBrowserTarget(browserTarget)
      if (!catalogId) return
      const adoption = sessionId === undefined ? undefined : this.pmdPrdReviewAdoptions.get(sessionId)
      const adoptedName = adoption && adoption.batchId === undefined ? adoption.displayPath.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '') : undefined
      const generationEventId = adoption && adoption.batchId === undefined ? `review:${adoption.reviewId}:generated` : undefined
      const resourceName = typeof result?.resource?.documentName === 'string' ? result.resource.documentName : undefined
      const documentName = (adoptedName || resourceName || `在线文档 ${catalogId}`).trim().slice(0, 256)
      if (!documentName) return
      if (sessionId !== undefined && adoption && adoption.batchId === undefined) this.pmdPrdReviewAdoptions.delete(sessionId)
      void Promise.resolve(this.reportPrdEvent({
        eventId: `document:ai-write:${hash(canonicalJson([runId, idempotencyIdentity, catalogId])).slice(0, 48)}`,
        eventType: 'document_published', outcome: 'succeeded', occurredAt: new Date().toISOString(),
        ...(sessionId === undefined ? {} : { sessionId }), runId,
        ...(generationEventId === undefined ? {} : { generationEventId }),
        documentName, documentCatalogId: catalogId, documentUrl: browserTarget.url,
      })).catch(() => {})
    } catch {
      // Telemetry must never downgrade a successful Verified Write.
    }
  }

  /** Accept one correlated response received from the Extension peer. */
  acceptExtensionResponse(response) {
    if (!validConnectorResponseEnvelope(response)) return false
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    const isOfficeContextRequest = pending.request.tool === 'list_work_tabs'
    const isReadWorkTabRequest = pending.request.tool === 'read_work_tab'
    const isOfficeDocumentRequest = pending.request.tool === 'light_document'
    const isSpreadsheetRequest = pending.request.tool === 'spreadsheet'
    const isPresentationRequest = pending.request.tool === 'presentation'
    const isHtmlWorkbenchRequest = pending.request.tool === 'html_workbench'
    const isTeamKnowledgeBatchRequest = pending.request.tool === 'team_knowledge_batch'
    const isKnowledgeRequest = pending.request.tool === 'knowledge_search' || pending.request.tool === 'code_search'
    const isSelectedSourceScopeRequest = pending.request.tool === 'selected_source_scope'
    const isBrowserBoundRequest = isOfficeContextRequest || isReadWorkTabRequest || isOfficeDocumentRequest || isSpreadsheetRequest || isPresentationRequest || isHtmlWorkbenchRequest || isTeamKnowledgeBatchRequest
    const sameOpenIdentity = response.runId === pending.request.runId && response.generation === pending.request.generation
    // A second session may begin a later browser request before this Extension
    // response returns.  Validate against the request's immutable correlation,
    // never against the Connector's subsequently selected session target.
    const currentTarget = pending.request.browserTarget
    const currentTargets = pending.request.browserTargets ?? (currentTarget === undefined ? [] : [currentTarget])
    const currentUnavailable = pending.request.unavailableBrowserTargets ?? []
    const responseTargets = response.browserTargets ?? (response.browserTarget === undefined ? undefined : [response.browserTarget])
    const responseUnavailable = response.unavailableBrowserTargets ?? []
    const confirmedBinding = this.runTargets.current()
    const legalTeamKnowledgeLeaseMigration = sameOpenIdentity
      && isTeamKnowledgeBatchRequest
      && pending.request.action === 'inspect_parent'
      && pending.request.lease === 'reuse'
      && sameBrowserTab(response.browserTarget, currentTarget)
      && Array.isArray(responseTargets) && responseTargets.length === 1
      && sameBrowserTarget(responseTargets[0], response.browserTarget)
      && sameUnavailableBrowserTargetList(responseUnavailable, currentUnavailable)
    // The Extension may resolve a stale direct Office request by asking the
    // Native Host to transfer this same Run before it reads the editor.  Do
    // not weaken the normal response check: accept the new target only when
    // the Native Host has already registered that exact binding for this Run.
    const legalResolvedOfficeTargetMigration = sameOpenIdentity
      && (isOfficeDocumentRequest || isSpreadsheetRequest || isPresentationRequest)
      && confirmedBinding?.runId === pending.request.runId
      && sameBrowserTarget(response.browserTarget, confirmedBinding.browserTarget)
      && sameBrowserTargetList(responseTargets, confirmedBinding.browserTargets ?? [confirmedBinding.browserTarget])
      && sameUnavailableBrowserTargetList(responseUnavailable, confirmedBinding.unavailableBrowserTargets ?? [])
    const sameOfficeIdentity = sameOpenIdentity && (legalTeamKnowledgeLeaseMigration || legalResolvedOfficeTargetMigration || (sameBrowserTarget(response.browserTarget, currentTarget)
      && sameBrowserTargetList(responseTargets, currentTargets)
      && sameUnavailableBrowserTargetList(responseUnavailable, currentUnavailable)))
    if (isBrowserBoundRequest && sameOpenIdentity && !sameOfficeIdentity) {
      clearTimeout(pending.timeout)
      this.pending.delete(response.requestId)
      pending.reject(new Error('Browser Target changed or no longer matches this tool request; no page operation was accepted.'))
      return true
    }
    if ((isBrowserBoundRequest && !sameOfficeIdentity) || (!isBrowserBoundRequest && !sameOpenIdentity)) return false
    if ((legalTeamKnowledgeLeaseMigration || legalResolvedOfficeTargetMigration) && pending.request.harnessSessionId !== undefined) {
      const key = `${pending.request.runId}\u0000${pending.request.harnessSessionId}`
      const captured = this.capturedBrowserTargets.get(key)
      if (captured) this.capturedBrowserTargets.set(key, Object.freeze({
        ...captured,
        browserTarget: response.browserTarget,
        browserTargets: responseTargets ?? [response.browserTarget],
        unavailableBrowserTargets: responseUnavailable,
      }))
    }
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (!Object.hasOwn(response, 'result')) {
      if ((isReadWorkTabRequest || isOfficeDocumentRequest || isSpreadsheetRequest || isPresentationRequest) && validOfficeReadFailure(response.error)) {
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
    if (isSpreadsheetRequest && ((pending.request.action === 'write' && !validSpreadsheetWriteResult(response.result, pending.request))
      || (pending.request.action === 'inspect_write' && !validSpreadsheetInspectResult(response.result))
      || (!['write', 'inspect_write'].includes(pending.request.action) && !validSpreadsheetReadResult(response.result)))) {
      pending.reject(new Error('Extension peer returned an invalid spreadsheet result'))
      return true
    }
    if (isPresentationRequest && ((pending.request.action === 'write' && !validPresentationWriteResult(response.result, pending.request))
      || (pending.request.action === 'inspect_write' && !validPresentationInspectResult(response.result, pending.request))
      || (pending.request.action === 'inspect_capabilities' && !validPresentationCapabilitiesResult(response.result))
      || (!['write', 'inspect_write', 'inspect_capabilities'].includes(pending.request.action) && !validPresentationReadResult(response.result)))) {
      pending.reject(new Error('Extension peer returned an invalid presentation result'))
      return true
    }
    if (isHtmlWorkbenchRequest && (!response.result || typeof response.result !== 'object' || Array.isArray(response.result))) {
      pending.reject(new Error('Extension peer returned an invalid HTML Workbench result'))
      return true
    }
    pending.resolve(isReadWorkTabRequest ? {
      browserTarget: response.browserTarget,
      result: response.result,
    } : isOfficeDocumentRequest || isSpreadsheetRequest || isPresentationRequest || isHtmlWorkbenchRequest ? {
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
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { tools: CONNECTOR_TOOLS } })
      return
    }
    if (message.method !== 'tools/call') {
      this.#reply(response, errorResponse(message.id, -32601, 'method not found'))
      return
    }
    if (BROWSER_TOOL_NAMES.has(message.params?.name)) {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      // These checks are local only: no Browser Target capture is required and
      // no tab can be read or changed when they reject the call.
      if (['light_document_read', 'light_document_selection_read', 'light_document_selection_replace_preview', 'light_document_selection_replace_commit', 'light_document_search', 'light_document_write_preview', 'light_document_write_commit'].includes(name)) {
        if (name === 'light_document_write_preview' && lightDocumentPayloadHasLiteralEscapedNewline(args.payload)) {
          this.#reply(response, errorResponse(message.id, -32602, 'Light-document payload contains a literal \\n outside a code block. Use real paragraph/list blocks or actual newline characters before requesting a write.'))
          return
        }
        if (!validFlatLightDocumentArguments(name, args)) {
          const hint = name === 'light_document_write_preview'
            ? lightDocumentArgumentsHint({ action: 'inspect_write', ...args })
            : `${name} received invalid arguments; use its flat schema exactly.`
          this.#reply(response, errorResponse(message.id, -32602, hint))
          return
        }
      }
      const batchAction = ({ team_knowledge_batch_preview: 'preview', team_knowledge_batch_create: 'create' })[name]
      if (batchAction !== undefined) {
        const batchArgs = { ...args, action: batchAction }
        if (!validTeamKnowledgeBatchArguments(batchArgs)) {
          this.#reply(response, errorResponse(message.id, -32602, `${name} received invalid arguments`))
          return
        }
        if (batchAction === 'preview') {
          try {
            this.#preflightPmdPrdPreview(args.batchId, this.runTargets.currentRunId, harnessIdentity(message), args.items)
          } catch (error) {
            this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Knowledge batch preview failed')
            return
          }
        }
      }
      let binding
      try { binding = this.#browserBinding(message) } catch (error) {
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Browser Target capture is unavailable.')
        return
      }
      return this.browserCallBindings.run(Object.freeze(binding), () => this.#dispatchBrowserToolCall(message, response))
    }
    if (message.params?.name === 'knowledge_search' || message.params?.name === 'code_search') {
      await this.#knowledgeSearch(message, response)
      return
    }
    if (message.params?.name === 'selected_source_scope') {
      await this.#selectedSourceScope(message, response)
      return
    }
    this.#reply(response, errorResponse(message.id, -32601, `Unknown Connector tool: ${String(message.params?.name ?? '')}`))
  }

  async #dispatchBrowserToolCall(message, response) {
    const name = message.params?.name
    if (['light_document_read', 'light_document_selection_read', 'light_document_selection_replace_preview', 'light_document_selection_replace_commit', 'light_document_search', 'light_document_write_preview', 'light_document_write_commit'].includes(name)) {
      return this.#flatLightDocument(message, response)
    }
    if (['spreadsheet_get_context', 'spreadsheet_read_range', 'spreadsheet_search', 'spreadsheet_inspect', 'spreadsheet_write_preview', 'spreadsheet_write_commit'].includes(name)) {
      return this.#flatSpreadsheet(message, response)
    }
    if (['presentation_get_capabilities', 'presentation_get_context', 'presentation_get_selection', 'presentation_get_text_boxes', 'presentation_write_preview', 'presentation_write_commit'].includes(name)) {
      return this.#flatPresentation(message, response)
    }
    if (['html_workbench_read', 'html_workbench_preview', 'html_workbench_commit'].includes(name)) {
      return this.#htmlWorkbench(message, response)
    }
    const batchAction = ({ team_knowledge_batch_preview: 'preview', team_knowledge_batch_create: 'create' })[name]
    if (batchAction !== undefined) {
      return this.#teamKnowledgeBatch({ ...message, params: { ...message.params, arguments: { ...(message.params?.arguments ?? {}), action: batchAction } } }, response)
    }
    if (name === 'read_work_tab') return this.#readWorkTab(message, response)
    if (name !== 'list_work_tabs') {
      this.#reply(response, errorResponse(message.id, -32601, `Unknown Connector tool: ${String(name ?? '')}`))
      return
    }
    if (!validOfficeGetContextArguments(message.params.arguments ?? {})) {
      this.#reply(response, errorResponse(message.id, -32602, 'list_work_tabs accepts no model-controlled target arguments'))
      return
    }
    const currentBinding = this.#currentBrowserBinding()
    const runId = currentBinding?.runId
    const boundTarget = currentBinding?.browserTarget
    if (!validBrowserTarget(boundTarget)) {
      this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.')
      return
    }
    const requestId = randomUUID()
    const browserTargets = currentBinding.browserTargets ?? [boundTarget]
    const unavailableBrowserTargets = currentBinding.unavailableBrowserTargets
    const isMultiTarget = browserTargets.length > 1 || unavailableBrowserTargets.length > 0
    const correlation = {
      type: CONNECTOR_REQUEST, requestId, runId, generation: this.generation, browserTarget: boundTarget,
      ...(currentBinding.harnessSessionId === undefined ? {} : { harnessSessionId: currentBinding.harnessSessionId }),
      ...(isMultiTarget ? { browserTargets, unavailableBrowserTargets } : {}), tool: 'list_work_tabs',
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      const structuredContent = {
        runId: correlation.runId, requestId: correlation.requestId, generation: correlation.generation,
        browserTarget: resolved.browserTarget, officeContext: resolved.officeContext,
        ...(isMultiTarget ? { primaryBrowserTarget: resolved.browserTarget, browserTargets: resolved.browserTargets, unavailableBrowserTargets: resolved.unavailableBrowserTargets } : {}),
      }
      if (!validOfficeGetContextOutput(structuredContent)) throw new Error('Browser Connector produced an invalid canonical Office context schema')
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } })
    } catch (error) {
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Browser Connector request failed' }], isError: true } })
    }
  }

  async #proxyKnowledge(request, response) {
    await proxyKnowledgeRequest({
      request,
      response,
      fetchImpl: this.fetch,
      catalogTimeoutMs: this.knowledgeCatalogTimeoutMs,
      requestTimeoutMs: this.knowledgeRequestTimeoutMs,
    })
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
    const runId = this.runTargets.currentRunId
    if (runId === undefined) {
      this.#toolError(response, message.id, 'No active Harness Run is available for Knowledge search.')
      return
    }
    const correlation = {
      type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, tool: kind,
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
    const runId = this.runTargets.currentRunId
    if (runId === undefined) {
      this.#toolError(response, message.id, 'No active Harness Run is available for selected-source scope.')
      return
    }
    const correlation = {
      type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, tool: 'selected_source_scope',
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
    let currentBinding
    try { currentBinding = this.#browserBinding(message) } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'No Browser Target is available for this Harness session.')
      return
    }
    const runId = currentBinding.runId
    const boundTarget = currentBinding.browserTarget
    const browserTargets = currentBinding.browserTargets ?? [boundTarget]
    const unavailableBrowserTargets = currentBinding.unavailableBrowserTargets
    if (args.tab > browserTargets.length) {
      this.#toolError(response, message.id, `list_work_tabs currently has ${browserTargets.length} available page(s). Call list_work_tabs again, then pass a tab from 1 to ${browserTargets.length}.`)
      return
    }
    const isMultiTarget = browserTargets.length > 1 || unavailableBrowserTargets.length > 0
    const correlation = {
      type: CONNECTOR_REQUEST,
      requestId: randomUUID(),
      runId,
      generation: this.generation,
      browserTarget: boundTarget,
      ...(currentBinding.harnessSessionId === undefined ? {} : { harnessSessionId: currentBinding.harnessSessionId }),
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

  async #flatSpreadsheet(message, response) {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (!validFlatSpreadsheetArguments(name, args)) {
      this.#reply(response, errorResponse(message.id, -32602, `${name} received invalid arguments; use its flat schema exactly.`))
      return
    }
    if (name === 'spreadsheet_get_context') {
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: 'context' } } }, response)
      return
    }
    if (name === 'spreadsheet_read_range') {
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: 'range', ...args } } }, response)
      return
    }
    if (name === 'spreadsheet_search') {
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: 'search', ...args } } }, response)
      return
    }
    if (name === 'spreadsheet_inspect') {
      const { action, ...inspect } = args
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: SPREADSHEET_INSPECT_RUNTIME_ACTIONS[action], ...inspect } } }, response)
      return
    }
    if (name === 'spreadsheet_write_preview') {
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: 'inspect_write', operation: args.operation, payload: args.payload } } }, response)
      return
    }
    const grant = this.spreadsheetChallenges.get(args.challenge)
    if (!grant || typeof grant.operation !== 'string' || !grant.payload || !grant.precondition) {
      this.#toolError(response, message.id, 'Spreadsheet write challenge is missing, stale, or not issued by spreadsheet_write_preview.')
      return
    }
    // Commit deliberately reconstructs its request from the approval grant.
    // No operation, payload, target, resource, or precondition is model-controlled.
    const fenceKey = canonicalJson([grant.browserTarget, grant.resource.fingerprint])
    await this.#withSpreadsheetWriteFence(fenceKey, async () => {
      await this.#spreadsheet({ ...message, params: { ...message.params, arguments: { action: 'write', challenge: args.challenge, idempotencyIdentity: grant.idempotencyIdentity, operation: grant.operation, payload: grant.payload, resource: grant.resource, precondition: grant.precondition } } }, response)
    })
  }

  async #withSpreadsheetWriteFence(key, work) {
    const previous = this.spreadsheetWriteLocks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => gate)
    this.spreadsheetWriteLocks.set(key, queued)
    await previous.catch(() => undefined)
    try { return await work() } finally {
      release()
      if (this.spreadsheetWriteLocks.get(key) === queued) this.spreadsheetWriteLocks.delete(key)
    }
  }

  async #spreadsheet(message, response) {
    const args = message.params?.arguments ?? {}
    let currentBinding
    try { currentBinding = this.#browserBinding(message) } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'No Browser Target is available for this Harness session.')
      return
    }
    const runId = currentBinding.runId
    const browserTarget = currentBinding.browserTarget
    if (args.action === 'write') {
      const grant = this.spreadsheetChallenges.get(args.challenge)
      this.spreadsheetChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) {
        this.#toolError(response, message.id, 'Spreadsheet approval challenge is missing, stale, or already used.')
        return
      }
      if (grant.operation !== args.operation || grant.payloadHash !== lightDocumentWriteHash(args.operation, args.payload)
        || !sameSpreadsheetResource(grant.resource, args.resource) || canonicalJson(grant.precondition) !== canonicalJson(args.precondition)) {
        this.#toolError(response, message.id, 'Spreadsheet approval does not match the inspected operation, payload, resource, or precondition.')
        return
      }
      let checkpoint
      try {
        checkpoint = await this.officeDocumentWriteStore.create({
          idempotencyIdentity: args.idempotencyIdentity, targetFingerprint: hash(canonicalJson(browserTarget)), resourceFingerprint: grant.resource.fingerprint,
          operation: args.operation, payloadHash: grant.payloadHash,
        })
      } catch (error) {
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Could not persist the spreadsheet write fence.')
        return
      }
      if (!checkpoint.createdNew) {
        this.#toolError(response, message.id, checkpoint.record.state === 'verified'
          ? 'This spreadsheet write was already verified; reread the spreadsheet before continuing.'
          : 'This spreadsheet write is uncertain after an interrupted write; automatic retry is forbidden. Reread and resolve manually.')
        return
      }
      const correlation = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'spreadsheet', action: 'write', operation: args.operation, payload: args.payload, resource: grant.resource, precondition: grant.precondition }
      try {
        const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
        if (!validSpreadsheetWriteResult(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid verified spreadsheet write')
        await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'verified')
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) {
        if (isPeerPreMutationFingerprintMismatch(error)) {
          try { await this.officeDocumentWriteStore.discardPending(args.idempotencyIdentity) } catch {}
          this.#toolError(response, message.id, 'fingerprint_mismatch: The spreadsheet changed before any write was sent. Reread it, prepare a new preview, and request approval again.')
          return
        }
        try { await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Spreadsheet write failed')
      }
      return
    }

    const action = args.action
    const validReadAction = ['context', 'range', 'search', ...Object.values(SPREADSHEET_INSPECT_RUNTIME_ACTIONS)].includes(action)
    if (!(validReadAction || action === 'inspect_write')) {
      this.#toolError(response, message.id, 'Invalid spreadsheet operation.')
      return
    }
    const correlation = {
      type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'spreadsheet', action,
      ...(args.range === undefined ? {} : { range: args.range }), ...(args.sheetName === undefined ? {} : { sheetName: args.sheetName }),
      ...(args.query === undefined ? {} : { query: args.query.trim() }), ...(args.matchCase === undefined ? {} : { matchCase: args.matchCase }),
      ...(args.matchEntireCell === undefined ? {} : { matchEntireCell: args.matchEntireCell }), ...(args.searchBy === undefined ? {} : { searchBy: args.searchBy }),
      ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.index === undefined ? {} : { index: args.index }), ...(args.fieldName === undefined ? {} : { fieldName: args.fieldName }),
      ...(args.axis === undefined ? {} : { axis: args.axis }), ...(args.cellType === undefined ? {} : { cellType: args.cellType }),
      ...(args.operation === undefined ? {} : { operation: args.operation }), ...(args.payload === undefined ? {} : { payload: args.payload }),
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      if (action === 'inspect_write') {
        if (!validSpreadsheetInspectResult(resolved.result)) throw new Error('Browser Connector produced an invalid spreadsheet write inspection')
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.spreadsheetChallenges) if (candidate.expiresAt < Date.now()) this.spreadsheetChallenges.delete(key)
        if (this.spreadsheetChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.spreadsheetChallenges.delete(this.spreadsheetChallenges.keys().next().value)
        const payloadHash = lightDocumentWriteHash(args.operation, args.payload)
        // The runtime's operation precondition guards range/workbook state.
        // Add the immutable Resource Identity fingerprint here so the
        // Extension can prove it selected that exact WebEdit iframe before
        // any challenge-only write is dispatched.
        const precondition = { ...resolved.result.precondition, resourceFingerprint: resolved.result.resource.fingerprint }
        this.spreadsheetChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payload: args.payload, payloadHash, precondition, idempotencyIdentity: `spreadsheet-write:${hash(challenge).slice(0, 48)}`, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action, resource: resolved.result.resource, operation: args.operation, summary: spreadsheetPreviewSummary(args.operation, args.payload, resolved.result.summary), challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
        return
      }
      if (!validSpreadsheetReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid spreadsheet read')
      const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Spreadsheet operation failed')
    }
  }

  async #flatPresentation(message, response) {
    const name = message.params?.name; const args = message.params?.arguments ?? {}
    if (!validFlatPresentationArguments(name, args)) {
      this.#reply(response, errorResponse(message.id, -32602, `${name} received invalid arguments; use its flat schema exactly.`)); return
    }
    if (name === 'presentation_get_capabilities') return this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'inspect_capabilities' } } }, response)
    if (name === 'presentation_get_context') return this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'get_context' } } }, response)
    if (name === 'presentation_get_selection') return this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'selection' } } }, response)
    if (name === 'presentation_get_text_boxes') return this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'get_text_boxes', ...args } } }, response)
    if (name === 'presentation_write_preview') return this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'inspect_write', operation: args.operation, payload: args.payload } } }, response)
    const grant = this.presentationChallenges.get(args.challenge)
    if (!grant) { this.#toolError(response, message.id, 'Presentation write challenge is missing, stale, or not issued by presentation_write_preview.'); return }
    const fenceKey = canonicalJson([grant.browserTarget, grant.resource.fingerprint])
    await this.#withPresentationWriteFence(fenceKey, async () => this.#presentation({ ...message, params: { ...message.params, arguments: { action: 'write', challenge: args.challenge, idempotencyIdentity: grant.idempotencyIdentity, operation: grant.operation, payload: grant.payload, resource: grant.resource, precondition: grant.precondition } } }, response))
  }

  async #withPresentationWriteFence(key, work) {
    const previous = this.presentationWriteLocks.get(key) ?? Promise.resolve(); let release
    const gate = new Promise((resolve) => { release = resolve }); const queued = previous.catch(() => undefined).then(() => gate)
    this.presentationWriteLocks.set(key, queued); await previous.catch(() => undefined)
    try { return await work() } finally { release(); if (this.presentationWriteLocks.get(key) === queued) this.presentationWriteLocks.delete(key) }
  }

  async #presentation(message, response) {
    const args = message.params?.arguments ?? {}; const currentBinding = this.#currentBrowserBinding()
    const runId = currentBinding?.runId; const browserTarget = currentBinding?.browserTarget
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    if (args.action === 'write') {
      const grant = this.presentationChallenges.get(args.challenge); this.presentationChallenges.delete(args.challenge)
      if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) { this.#toolError(response, message.id, 'Presentation approval challenge is missing, stale, or already used.'); return }
      if (grant.operation !== args.operation || grant.payloadHash !== lightDocumentWriteHash(args.operation, args.payload) || !samePresentationTarget(grant.resource, args.resource) || canonicalJson(grant.precondition) !== canonicalJson(args.precondition)) { this.#toolError(response, message.id, 'Presentation approval does not match the inspected operation, payload, resource, or precondition.'); return }
      let checkpoint
      try { checkpoint = await this.officeDocumentWriteStore.create({ idempotencyIdentity: args.idempotencyIdentity, targetFingerprint: hash(canonicalJson(browserTarget)), resourceFingerprint: grant.resource.fingerprint, operation: args.operation, payloadHash: grant.payloadHash }) } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Could not persist the presentation write fence.'); return }
      if (!checkpoint.createdNew) { this.#toolError(response, message.id, checkpoint.record.state === 'verified' ? 'This presentation write was already verified; reread the presentation before continuing.' : 'This presentation write is uncertain after an interrupted write; automatic retry is forbidden. Reread and resolve manually.'); return }
      const correlation = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'presentation', action: 'write', operation: args.operation, payload: args.payload, resource: grant.resource, precondition: grant.precondition }
      try {
        const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
        if (!validPresentationWriteResult(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid verified presentation write')
        await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'verified')
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) {
        if (isPeerPreMutationFingerprintMismatch(error)) { try { await this.officeDocumentWriteStore.discardPending(args.idempotencyIdentity) } catch {}; this.#toolError(response, message.id, 'fingerprint_mismatch: The presentation changed before any write was sent. Reread it, prepare a new preview, and request approval again.'); return }
        try { await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Presentation write failed')
      }
      return
    }
    const action = args.action
    if (!['inspect_capabilities', 'get_context', 'selection', 'get_text_boxes', 'inspect_write'].includes(action)) { this.#toolError(response, message.id, 'Invalid presentation operation.'); return }
    const correlation = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'presentation', action, ...(args.slideIndex === undefined ? {} : { slideIndex: args.slideIndex }), ...(args.operation === undefined ? {} : { operation: args.operation }), ...(args.payload === undefined ? {} : { payload: args.payload }) }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      if (action === 'inspect_write' && !validPresentationInspectResult(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid presentation write inspection')
      if (action === 'inspect_capabilities' && !validPresentationCapabilitiesResult(resolved.result)) throw new Error('Browser Connector produced an invalid presentation capabilities result')
      if (!['inspect_write', 'inspect_capabilities'].includes(action) && !validPresentationReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid presentation read')
      if (['get_context', 'get_text_boxes'].includes(action) && !validPresentationContextResult(resolved.result)) {
        throw new Error('Browser Connector produced a presentation result without a bounded context readback')
      }
      if (action === 'inspect_write') {
        const challenge = randomBytes(32).toString('base64url'); const payloadHash = lightDocumentWriteHash(args.operation, args.payload)
        for (const [key, candidate] of this.presentationChallenges) if (candidate.expiresAt < Date.now()) this.presentationChallenges.delete(key)
        if (this.presentationChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.presentationChallenges.delete(this.presentationChallenges.keys().next().value)
        this.presentationChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payload: args.payload, payloadHash, precondition: resolved.result.precondition, idempotencyIdentity: `presentation-write:${hash(challenge).slice(0, 48)}`, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action: 'inspect_write', resource: resolved.result.resource, operation: args.operation, summary: presentationPreviewSummary(args.operation, args.payload, resolved.result.summary, resolved.result.precondition), challenge }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } }); return
      }
      const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Presentation operation failed') }
  }

  async #flatLightDocument(message, response) {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'light_document_write_preview' && lightDocumentPayloadHasLiteralEscapedNewline(args.payload)) {
      this.#reply(response, errorResponse(message.id, -32602, 'Light-document payload contains a literal \\n outside a code block. Use real paragraph/list blocks or actual newline characters before requesting a write.'))
      return
    }
    if (!validFlatLightDocumentArguments(name, args)) {
      const hint = name === 'light_document_write_preview'
        ? lightDocumentArgumentsHint({ action: 'inspect_write', ...args })
        : `${name} received invalid arguments; use its flat schema exactly.`
      this.#reply(response, errorResponse(message.id, -32602, hint))
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
    const currentBinding = this.#currentBrowserBinding()
    const runId = currentBinding?.runId
    const browserTarget = currentBinding?.browserTarget
    if (!validBrowserTarget(browserTarget)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    let batchWriteFence
    try { batchWriteFence = await this.#incompleteTeamKnowledgeBatchWriteFence(browserTarget) } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Could not read the Team Knowledge batch recovery fence.')
      return
    }
    if (batchWriteFence) { this.#toolError(response, message.id, batchWriteFence); return }
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
    const selectionCorrelation = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: 'selection' }
    try {
      const selected = await this.#requestExtension(selectionCorrelation, undefined, this.officeRequestTimeoutMs)
      if (!validLightDocumentReadResult(selected.result)) throw new Error('Browser Connector produced an invalid light-document selection')
      const selection = selected.result.document?.selection
      const selectionFingerprint = selection?.selectionFingerprint
      if (!selection?.supported || selection?.truncated || selection?.hasSelection !== true || selection?.isCollapsed || selection?.stable !== true || typeof selectionFingerprint !== 'string' || !/^selection-v4-[0-9a-f]{32}$/.test(selectionFingerprint)) {
        throw new Error('The current light-document selection is not a stable non-collapsed selection. Select the exact content to replace, then read the selection again before preview.')
      }
      let operation; let payload; let previewAction
      if (args.blocks.length === 0) {
        if (selection.replaceStrategy === 'full_canvas_patch_selected_table') throw new Error('Selected table cells cannot be deleted as a partial selection. Select the whole stable table block, or delete it by stable block id.')
        if (selection.wholeBlockReplaceable !== true && selection.replaceStrategy !== 'public_replace_content') throw new Error('The current light-document selection does not expose a safe deletion strategy. Select the exact content again before preview.')
        operation = 'selection_delete'; payload = { expectedSelectionFingerprint: selectionFingerprint }; previewAction = 'selection_delete_preview'
      } else if (selection.wholeBlockReplaceable === true) {
        operation = 'selection_blocks_replace'; payload = { blocks: args.blocks, expectedSelectionFingerprint: selectionFingerprint }; previewAction = 'selection_blocks_replace_preview'
      } else {
        const markdown = lightDocumentSelectionMarkdown(args.blocks)
        const containingTableReplacement = selection.replaceStrategy === 'full_canvas_patch_selected_table'
          && args.blocks.length === 1 && String(args.blocks[0]?.type).toLowerCase() === 'table'
          && selection.containingTable && typeof selection.containingTable.id === 'string'
        if (!markdown || (!containingTableReplacement && !['public_replace_content', 'public_insert_content'].includes(selection.replaceStrategy))) throw new Error('The current WebEdit selection does not expose a safe replacement strategy for these blocks.')
        operation = 'selection_content_replace'
        payload = { markdown, expectedSelectionFingerprint: selectionFingerprint }; previewAction = containingTableReplacement ? 'selection_table_replace_preview' : 'selection_content_replace_preview'
      }
      if (!validLightDocumentOperationPayload(operation, payload)) throw new Error('The requested replacement blocks are invalid.')
      const challenge = randomBytes(32).toString('base64url')
      for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
      if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
      // Commit enters the normal write path, whose runtime re-reads both the
      // resource and selection fingerprint immediately before mutation.
      this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: selected.result.resource, operation, payload, payloadHash: lightDocumentWriteHash(operation, payload), idempotencyIdentity: flatSelectionReplaceIdentity(challenge), flatSelectionReplace: true, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
      const replacementScope = previewAction === 'selection_table_replace_preview' ? { kind: 'containing_table', ...selection.containingTable } : { kind: 'selection' }
      const result = { runId, requestId: selectionCorrelation.requestId, generation: this.generation, browserTarget: selected.browserTarget, action: previewAction, replacementScope, resource: selected.result.resource, selection, blocks: args.blocks, challenge }
      this.#reply(response, lightDocumentToolResponse(message.id, result))
    } catch (error) {
      this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document selection preview failed')
    }
  }

  async #htmlWorkbench(message, response) {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if ((name === 'html_workbench_preview' && !validHtmlWorkbenchPreviewArguments(args)) || (name === 'html_workbench_commit' && !validHtmlWorkbenchCommitArguments(args)) || (name === 'html_workbench_read' && (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0))) {
      this.#reply(response, errorResponse(message.id, -32602, `${String(name)} received invalid arguments.`)); return
    }
    const binding = this.#currentBrowserBinding(); const runId = binding?.runId; const browserTarget = binding?.browserTarget
    if (!validBrowserTarget(browserTarget) || !browserTarget.url.startsWith('file:')) { this.#toolError(response, message.id, 'HTML Workbench requires a bound local file:// HTML Browser Target.'); return }
    const send = async (action, extra = {}) => this.#requestExtension({ type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'html_workbench', action, ...extra }, undefined, this.officeRequestTimeoutMs)
    if (name === 'html_workbench_read') {
      try {
        const inspected = await send('read'); const snapshot = await readWorkspace(browserTarget.url, inspected.result.selections)
        const result = { runId, browserTarget: inspected.browserTarget, resource: { kind: 'local_html', url: snapshot.url, fingerprint: snapshot.fingerprint }, selections: snapshot.selections, html: snapshot.html.slice(0, 100000), stylesheets: snapshot.stylesheets.map(item => ({ ...item, content: item.content.slice(0, 100000) })) }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'HTML Workbench read failed') }
      return
    }
    if (name === 'html_workbench_preview') {
      try {
        const inspected = await send('read'); if (!validHtmlWorkbenchDomFingerprint(inspected.result.domFingerprint)) throw new Error('Extension peer did not return a valid local HTML DOM state fingerprint.')
        const preview = await previewEdits(browserTarget.url, args.edits, inspected.result.selections)
        const cssEdit = preview.edits.some(edit => edit.path.toLowerCase().endsWith('.css'))
        const anchorSelectors = Array.isArray(inspected.result.selections) ? inspected.result.selections.map(anchor => anchor?.selector).filter(selector => typeof selector === 'string' && selector.length > 0 && selector.length <= 2_000) : []
        if (cssEdit && (!validHtmlWorkbenchAnchorStates(inspected.result.anchorStates, anchorSelectors) || anchorSelectors.length === 0)) throw new Error('HTML Workbench CSS edits require at least one selected DOM anchor with computed-style preflight evidence.')
        const computedProperties = cssEdit ? editedComputedProperties(preview.edits, inspected.result.anchorStates) : []
        const challenge = randomBytes(32).toString('base64url')
        this.htmlWorkbenchChallenges.set(challenge, { runId, generation: this.generation, browserTarget, domFingerprint: inspected.result.domFingerprint, url: preview.snapshot.url, edits: preview.edits, editFingerprint: preview.editFingerprint, anchorStates: cssEdit ? inspected.result.anchorStates : [], computedProperties, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, browserTarget, resource: { kind: 'local_html', url: preview.snapshot.url, fingerprint: preview.snapshot.fingerprint }, diff: preview.diff, challenge, expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS }
        this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
      } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'HTML Workbench preview failed') }
      return
    }
    const grant = this.htmlWorkbenchChallenges.get(args.challenge); this.htmlWorkbenchChallenges.delete(args.challenge)
    if (!grant || grant.expiresAt < Date.now() || grant.runId !== runId || grant.generation !== this.generation || !sameBrowserTarget(grant.browserTarget, browserTarget)) { this.#toolError(response, message.id, 'HTML Workbench Approval Grant is missing, stale, already used, or belongs to another Browser Target.'); return }
    const key = `${browserTarget.windowId}:${browserTarget.tabId}:${grant.url}`; const prior = this.htmlWorkbenchWriteLocks.get(key) ?? Promise.resolve(); let release
    const queued = prior.catch(() => undefined).then(() => new Promise(resolve => { release = resolve })); this.htmlWorkbenchWriteLocks.set(key, queued); await prior.catch(() => undefined)
    try {
      const preflight = await send('preflight')
      if (!validHtmlWorkbenchDomFingerprint(preflight.result.domFingerprint) || preflight.result.domFingerprint !== grant.domFingerprint) throw new Error('fingerprint_mismatch: The Browser Target page changed before the approved write; no file was written.')
      const cssEdit = grant.edits.some(edit => edit.path.toLowerCase().endsWith('.css'))
      const expectedAnchorSelectors = grant.anchorStates.map(item => item.selector)
      if (cssEdit && (!validHtmlWorkbenchAnchorStates(preflight.result.anchorStates, expectedAnchorSelectors, grant.computedProperties) || expectedAnchorSelectors.length === 0 || !sameHtmlWorkbenchAnchorStates(preflight.result.anchorStates, grant.anchorStates, grant.computedProperties))) throw new Error('fingerprint_mismatch: Selected DOM anchor computed styles changed before the approved CSS write; no file was written.')
      for (const edit of grant.edits) {
        const current = await readWorkspace(grant.url); const file = edit.absolute === current.htmlPath ? current.html : current.stylesheets.find(item => edit.absolute.endsWith(item.path))?.content
        if (file === undefined || htmlFingerprint(file) !== edit.beforeFingerprint) throw new Error('fingerprint_mismatch: A local HTML/CSS file changed before the approved write; no file was written.')
      }
      await atomicWrite(grant.edits)
      const disk = await readWorkspace(grant.url)
      const persisted = await Promise.all(grant.edits.map(async edit => ({ edit, content: await readFile(edit.absolute, 'utf8') })))
      if (persisted.some(item => item.content !== item.edit.content)) throw new Error('readback_mismatch: A persisted local HTML/CSS file does not exactly match the approved content.')
      const expectedSourceFingerprint = htmlFingerprint(disk.html)
      const expectedStylesheets = disk.stylesheets.map(item => ({ url: pathToFileURL(resolve(disk.root, item.path)).href, fingerprint: htmlFingerprint(item.content) }))
      const readback = await send('refresh_readback', { expectedSourceFingerprint, expectedStylesheets, expectedAnchorSelectors })
      if (readback.result.verified !== true || readback.result.url !== disk.url || readback.result.sourceFingerprint !== expectedSourceFingerprint
        || !sameHtmlWorkbenchStylesheetFingerprints(readback.result.stylesheetFingerprints, expectedStylesheets)
        || !validHtmlWorkbenchAnchorStates(readback.result.anchorStates, expectedAnchorSelectors, grant.computedProperties)) throw new Error(`readback_mismatch: ${String(readback.result.error ?? 'same-target page did not load the exact committed HTML/CSS source and selected DOM state')}`)
      const result = { status: 'verified_write', runId, browserTarget: readback.browserTarget, resource: { kind: 'local_html', url: disk.url, fingerprint: disk.fingerprint }, files: persisted.map(item => ({ path: item.edit.path, fingerprint: htmlFingerprint(item.content) })), pageReadback: readback.result }
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } catch (error) { this.#toolError(response, message.id, `uncertain: ${error instanceof Error ? error.message : String(error)}`) } finally { release?.(); if (this.htmlWorkbenchWriteLocks.get(key) === queued) this.htmlWorkbenchWriteLocks.delete(key) }
  }

  async #incompleteTeamKnowledgeBatchWriteFence(browserTarget) {
    const catalogId = teamKnowledgeCatalogIdFromBrowserTarget(browserTarget)
    if (!catalogId) return null
    const matches = await this.teamKnowledgeBatchStore.findIncompleteItemsByCatalogId(catalogId)
    if (matches.length === 0) return null
    const batchIds = [...new Set(matches.map((match) => match.batchId))]
    return `team_knowledge_batch_incomplete_write_fence: This docOnline/${catalogId} document belongs to unfinished batch ${batchIds.join(', ')}. Do not use generic light_document mutation tools; reads remain available. Resume the same batch with team_knowledge_batch_preview and team_knowledge_batch_create using batchId ${batchIds.join(', ')}.`
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
    const currentBinding = this.#currentBrowserBinding()
    const runId = currentBinding?.runId
    const browserTarget = currentBinding?.browserTarget
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
          ? 'This idempotency identity was already verified; call light_document_read on the same Browser Target before continuing.'
          : 'This idempotency identity is uncertain after an interrupted write. Do not preview or commit the same payload again. First call light_document_read on the same Browser Target to determine whether it took effect, then resolve manually.')
        return
      }
      const correlation = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: 'write', operation: args.operation, payload: args.payload, resource: grant.resource }
      try {
        const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, ...resolved.result }
        if (!verifiedLightDocumentWriteMatches(resolved.result, correlation)) throw new Error('Browser Connector produced an invalid verified light-document write')
        if (grant.titleInitializationRequired === true && (resolved.result.observed?.title?.initialized !== true || typeof resolved.result.observed.title.text !== 'string' || !resolved.result.observed.title.text.trim())) {
          throw new Error('Empty light-document title initialization was required, but the Browser Target did not return verified title readback. Reread this same document before continuing.')
        }
        await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'verified')
        if (this.officeDocumentWrites.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentWrites.delete(this.officeDocumentWrites.keys().next().value)
        this.officeDocumentWrites.set(args.idempotencyIdentity, { fingerprint: requestFingerprint, result })
        this.#reportAiLightDocumentWrite(message, runId, resolved.browserTarget, resolved.result, args.idempotencyIdentity)
        this.#reply(response, lightDocumentToolResponse(message.id, result))
      } catch (error) {
        if (isPeerPreMutationFingerprintMismatch(error)) {
          try { await this.officeDocumentWriteStore.discardPending(args.idempotencyIdentity) } catch {}
          this.#toolError(response, message.id, 'fingerprint_mismatch: The light document changed before any write was sent. Reread it, prepare a new preview, and request approval again.')
          return
        }
        try { await this.officeDocumentWriteStore.setState(args.idempotencyIdentity, 'uncertain') } catch {}
        if (grant.flatSelectionReplace === true) this.uncertainSelectionWrite = { runId, generation: this.generation, browserTarget }
        this.#toolError(response, message.id, error instanceof Error ? error.message : 'Light-document write failed')
      }
      return
    }

    const correlation = {
      type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'light_document', action: args.action,
      ...(args.offset === undefined ? {} : { offset: args.offset }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.query === undefined ? {} : { query: args.query.trim() }), ...(args.payload === undefined ? {} : { payload: args.payload }), ...(args.operation === undefined ? {} : { operation: args.operation }),
    }
    try {
      const resolved = await this.#requestExtension(correlation, undefined, this.officeRequestTimeoutMs)
      if (!validLightDocumentReadResult(resolved.result)) throw new Error('Browser Connector produced an invalid bounded light-document read')
      if (args.action === 'inspect_write') {
        const blockCount = Number.isInteger(resolved.result.document?.blockCount) ? resolved.result.document.blockCount : undefined
        const isSemanticEmpty = lightDocumentIsSemanticEmpty(resolved.result.document)
        if (['replace', 'delete', 'format', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format'].includes(args.operation) && (blockCount === 0 || isSemanticEmpty)) {
          this.#toolError(response, message.id, isSemanticEmpty
            ? 'This light document is semantically blank (only an empty paragraph), so replace would create a challenge that cannot commit. Use inspect_write with blocks_insert for structured body content, or read the caret selection then use selection_insert.'
            : 'This light document has no public replaceable block (blockCount 0). Call selection then selection_insert, or inspect_write with blocks_insert / insert_drawing to add body content.')
          return
        }
        const selection = resolved.result.document?.selection
        const firstH1 = args.operation === 'blocks_insert' && Array.isArray(args.payload?.blocks)
          ? args.payload.blocks.find((block) => String(block?.type ?? block?.blockType ?? '').toLowerCase() === 'h1')
          : null
        const emptyBody = resolved.result.document?.emptyBody
        const semanticEmpty = lightDocumentIsSemanticEmpty(resolved.result.document)
        const titleInitializationRequired = semanticEmpty && firstH1 !== null && firstH1 !== undefined
          && (() => {
            const title = resolved.result.document?.title
            if (title?.supported !== true || typeof title.text !== 'string' || title.truncated === true) return null
            return title.text.trim() === ''
          })()
        if (firstH1 !== null && firstH1 !== undefined && (!emptyBody || typeof emptyBody.semantic !== 'boolean' || (semanticEmpty && titleInitializationRequired === null))) {
          this.#toolError(response, message.id, 'Cannot safely determine whether this light document is semantically empty and has a readable title state. Reload the document page, reopen the side panel, then reread before previewing the body write.')
          return
        }
        if (args.operation === 'insert_drawing' && args.payload?.position === 'after_selection'
          && (selection?.selectionFingerprint !== args.payload.expectedSelectionFingerprint || selection?.stable !== true || selection?.hasSelection !== true || selection?.isCollapsed || !Array.isArray(selection?.selectedTagIds) || selection.selectedTagIds.length < 1 || selection.selectionIdsValid !== true)) {
          this.#toolError(response, message.id, 'The current light-document selection is not a stable block selection matching expectedSelectionFingerprint. Select the target content, call light_document_selection_read again, then preview the drawing.')
          return
        }
        const challenge = randomBytes(32).toString('base64url')
        for (const [key, candidate] of this.officeDocumentChallenges) if (candidate.expiresAt < Date.now()) this.officeDocumentChallenges.delete(key)
        if (this.officeDocumentChallenges.size >= OFFICE_DOCUMENT_MAX_RECORDS) this.officeDocumentChallenges.delete(this.officeDocumentChallenges.keys().next().value)
        const payloadHash = lightDocumentWriteHash(args.operation, args.payload)
        const previewIdentity = hash(canonicalJson([resolved.result.resource.fingerprint, args.operation, args.payload]))
        this.officeDocumentChallenges.set(challenge, { runId, generation: this.generation, browserTarget, resource: resolved.result.resource, operation: args.operation, payload: args.payload, payloadHash, idempotencyIdentity: `light-write:${previewIdentity.slice(0, 48)}`, ...(titleInitializationRequired === true ? { titleInitializationRequired: true } : {}), expiresAt: Date.now() + OFFICE_DOCUMENT_CHALLENGE_TTL_MS })
        const result = { runId, requestId: correlation.requestId, generation: correlation.generation, browserTarget: resolved.browserTarget, action: 'inspect_write', resource: resolved.result.resource, operation: args.operation, ...(args.operation === 'insert_drawing' && args.payload?.position === 'after_selection' ? { insertion: { position: 'after_selection', selectedTagIds: selection.selectedTagIds } } : {}), challenge }
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

  async #releaseTeamKnowledgeBatchLease(runId, browserTarget, parent, batchId) {
    const request = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget, tool: 'team_knowledge_batch', action: 'release', batchId, lease: 'release', parent }
    const resolved = await this.#requestExtension(request)
    if (!validTeamKnowledgeItemResult(resolved.teamKnowledgeItem) || resolved.teamKnowledgeItem.status !== 'ok') throw new Error('team_knowledge_batch_lease_release_failed')
  }

  async #bestEffortReleaseTeamKnowledgeBatchLease(runId, browserTarget, parent, batchId) {
    try { await this.#releaseTeamKnowledgeBatchLease(runId, browserTarget, parent, batchId) } catch {}
  }

  async #teamKnowledgeBatch(message, response) {
    const args = message.params?.arguments ?? {}
    if (!validTeamKnowledgeBatchArguments(args)) {
      this.#reply(response, errorResponse(message.id, -32602, `${String(message.params?.name ?? 'team_knowledge_batch')} received invalid arguments`))
      return
    }
    const currentBinding = this.#currentBrowserBinding(); const runId = currentBinding?.runId; const target = currentBinding?.browserTarget
    const identity = harnessIdentity(message)
    if (!validBrowserTarget(target)) { this.#toolError(response, message.id, 'No Browser Target is bound to this Run by the Extension.'); return }
    const existingBatch = await this.teamKnowledgeBatchStore.load(args.batchId)
    const lease = existingBatch && existingBatch.status !== 'completed' ? 'reuse' : 'acquire'
    let pmdReviewAdoption
    const inspectParent = async () => {
      const request = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget: target, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: args.batchId, lease, ...(pmdReviewAdoption === undefined ? {} : { pmdReviewAdoption }) }
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
        if (args.batchId.startsWith('pmd:')) {
          const adoption = this.#authorizePmdPrdPreview(args.batchId, runId, identity, args.items)
          pmdReviewAdoption = { harnessSessionId: adoption.harnessSessionId, reviewId: adoption.reviewId, resourceId: adoption.resourceId, displayPath: adoption.displayPath, revision: adoption.revision, fingerprint: adoption.fingerprint, contentHash: adoption.contentHash }
        }
        const contentFingerprint = teamKnowledgeBatchFingerprint(args.items)
        const inspected = await inspectParent(); const parent = inspected.result.parent
        if (args.parentFingerprint !== undefined && parent.fingerprint !== args.parentFingerprint) throw new Error('Team Knowledge parent changed; inspect and confirm the directory again.')
        const targetFingerprint = teamKnowledgeTargetFingerprint(inspected.target, parent, 'light_document')
        const batch = await this.teamKnowledgeBatchStore.create({
          batchId: args.batchId, targetFingerprint, contentFingerprint,
          items: args.items.map((item, index) => ({ index, name: item.name, contentHash: teamKnowledgeContentHash('light_document', item.name, item.body), idempotencyIdentity: `team-batch:${hash(args.batchId).slice(0, 48)}:${String(index)}` })),
        })
        if (batch.status === 'completed') {
          await this.#bestEffortReleaseTeamKnowledgeBatchLease(runId, inspected.target, parent, args.batchId)
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
            const request = { type: CONNECTOR_REQUEST, requestId: randomUUID(), runId, generation: this.generation, browserTarget: grant.target, tool: 'team_knowledge_batch', action: 'create', batchId: args.batchId, lease: 'reuse', parent: grant.parent, kind: 'light_document', name: document.name, body: document.body, idempotencyIdentity: item.idempotencyIdentity, ...(args.batchId.startsWith('pmd:') ? {} : { userConfirmation: { itemIndex: item.index + 1, totalItems: batch.items.length } }), ...(recovery ? { recovery } : {}) }
            const resolved = await this.#requestExtension(request, undefined, this.teamKnowledgeWriteRequestTimeoutMs); const itemResult = resolved.teamKnowledgeItem
            if (!sameBrowserTarget(resolved.browserTarget, grant.target)) throw new Error('Team Knowledge Browser Target changed during batch creation.')
            if (!validTeamKnowledgeItemResult(itemResult) || !['verified_write', 'partial_delivery'].includes(itemResult.status)) throw new Error('Extension peer returned an invalid Team Knowledge batch item result')
            if (itemResult.status === 'verified_write' && !validVerifiedTeamKnowledgeBatchItem(itemResult, document)) throw new Error('Extension peer verified the wrong Team Knowledge batch item')
            await this.teamDocStore.save({ idempotencyIdentity: item.idempotencyIdentity, targetFingerprint, contentHash: item.contentHash, kind: 'light_document', name: item.name, stages: itemResult.stages, catalogId: itemResult.item?.catalogId ?? null, verified: itemResult.status === 'verified_write', result: itemResult })
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: itemResult.status === 'verified_write' ? 'created' : 'failed', catalogId: itemResult.item?.catalogId ?? null, stages: itemResult.stages, error: itemResult.status === 'verified_write' ? null : itemResult.error })
            if (itemResult.status === 'verified_write') {
              const adoptionKey = identity?.parentSessionId ?? identity?.sessionId
              const adoption = adoptionKey === undefined ? undefined : this.pmdPrdReviewAdoptions.get(adoptionKey)
              const generationEventId = adoption?.batchId === args.batchId ? `review:${adoption.reviewId}:generated` : undefined
              void Promise.resolve(this.reportPrdEvent({
                eventId: `document:${hash(args.batchId).slice(0, 48)}:${String(item.index)}:${itemResult.item.catalogId}`,
                eventType: 'document_published', outcome: 'succeeded', occurredAt: new Date().toISOString(),
                ...(identity === undefined ? {} : { sessionId: identity.parentSessionId ?? identity.sessionId }),
                runId, batchId: args.batchId, itemIndex: item.index,
                ...(generationEventId === undefined ? {} : { generationEventId }),
                documentName: itemResult.item.name, documentCatalogId: itemResult.item.catalogId, documentUrl: itemResult.item.url,
              })).catch(() => {})
            }
            if (itemResult.status === 'partial_delivery' && itemResult.failedAt === 'confirmation') break
          } catch (error) {
            await this.teamKnowledgeBatchStore.updateItem({ batchId: args.batchId, index: item.index, status: 'failed', error: error instanceof Error ? error.message : 'Team Knowledge batch item creation failed' })
          }
        }
        batch = await this.teamKnowledgeBatchStore.load(args.batchId)
        return { action: 'create', status: batch.status === 'completed' ? 'verified_write' : 'partial_delivery', browserTarget: grant.target, parent: grant.parent, batch: teamKnowledgeBatchView(batch) }
      })
      if (result.status === 'verified_write') await this.#bestEffortReleaseTeamKnowledgeBatchLease(runId, grant.target, grant.parent, args.batchId)
      this.#reply(response, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: teamKnowledgeBatchUserText(result) }], structuredContent: result, ...(result.status === 'partial_delivery' ? { isError: true } : {}) } })
    } catch (error) { this.#toolError(response, message.id, error instanceof Error ? error.message : 'Team Knowledge batch operation failed') }
  }

  #requestExtension(correlation, response, timeoutMs = this.requestTimeoutMs) {
    if (this.updateQuiescent) return Promise.reject(new Error('在线更新正在准备；暂不接受新的浏览器任务'))
    const browserBound = ['list_work_tabs', 'read_work_tab', 'light_document', 'spreadsheet', 'presentation', 'html_workbench', 'team_knowledge_batch'].includes(correlation.tool)
    const owner = this.browserCallBindings.getStore()?.harnessSessionId
    const dispatched = browserBound && owner !== undefined && correlation.harnessSessionId === undefined
      ? { ...correlation, harnessSessionId: owner }
      : correlation
    return new Promise((resolve, reject) => {
      let cancelled = false
      const cancel = () => {
        if (cancelled || !this.pending.delete(dispatched.requestId)) return
        cancelled = true
        clearTimeout(timeout)
        try { this.requestExtension({ type: CONNECTOR_CANCEL, requestId: dispatched.requestId, runId: dispatched.runId, generation: dispatched.generation }) } catch {}
        reject(new Error('Browser Connector request was cancelled'))
      }
      const timeout = setTimeout(() => {
        this.pending.delete(dispatched.requestId)
        try { this.requestExtension({ type: CONNECTOR_CANCEL, requestId: dispatched.requestId, runId: dispatched.runId, generation: dispatched.generation }) } catch {}
        reject(new Error('Browser Connector timed out waiting for the Extension peer'))
      }, timeoutMs)
      const finish = (fn) => (value) => {
        if (response !== undefined) response.off('close', cancel)
        fn(value)
      }
      this.pending.set(dispatched.requestId, { request: dispatched, resolve: finish(resolve), reject: finish(reject), timeout })
      if (response !== undefined) response.once('close', cancel)
      try {
        this.requestExtension(dispatched)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(dispatched.requestId)
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
