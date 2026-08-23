import { validBrowserTarget, validUnavailableBrowserTarget } from '../../../native-server/src/connector-protocol.mjs'
import type { BrowserTarget, ConnectorCorrelation, UnavailableBrowserTarget } from '../../../native-server/src/connector-protocol.mjs'

export interface ListWorkTabsRequest extends ConnectorCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  browserTargets?: BrowserTarget[]
  unavailableBrowserTargets?: UnavailableBrowserTarget[]
  tool: 'list_work_tabs'
}

export interface ReadWorkTabRequest extends ConnectorCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  browserTargets?: BrowserTarget[]
  unavailableBrowserTargets?: UnavailableBrowserTarget[]
  tool: 'read_work_tab'
  tab: number
  offset?: number
  limit?: number
}

export type OfficeDocumentAction = 'read' | 'search' | 'selection' | 'inspect_write' | 'write'
export type OfficeDocumentOperation = 'replace' | 'delete' | 'format' | 'title' | 'set_title' | 'blocks_replace' | 'blocks_batch_replace' | 'blocks_batch_edit' | 'blocks_delete' | 'blocks_format' | 'blocks_insert' | 'insert_drawing' | 'selection_insert' | 'selection_replace' | 'selection_content_replace' | 'selection_blocks_replace' | 'selection_delete'
const OFFICE_DOCUMENT_OPERATIONS: readonly OfficeDocumentOperation[] = ['replace', 'delete', 'format', 'title', 'set_title', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit', 'blocks_delete', 'blocks_format', 'blocks_insert', 'insert_drawing', 'selection_insert', 'selection_replace', 'selection_content_replace', 'selection_blocks_replace', 'selection_delete']

export interface LightDocumentResourceIdentity {
  kind: 'webedit_light_document'
  origin: 'https://webedit.midea.com'
  documentName: string | null
  fingerprint: string
}

export interface OfficeDocumentRequest extends ConnectorCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  tool: 'light_document'
  action: OfficeDocumentAction
  offset?: number
  limit?: number
  query?: string
  operation?: OfficeDocumentOperation
  payload?: Record<string, unknown>
  resource?: LightDocumentResourceIdentity
}

export interface OfficeReadFailure {
  code: 'unsupported' | 'preview' | 'readonly' | 'invalid_range' | 'navigation' | 'iframe_replaced' | 'timeout' | 'cancelled' | 'fingerprint_mismatch' | 'readback_mismatch' | 'runtime_error'
  message: string
}

type Candidate = Record<string, unknown>

function correlated(value: Candidate): boolean {
  return value.type === 'connector_request' && typeof value.requestId === 'string'
    && typeof value.runId === 'string' && typeof value.generation === 'string'
}

export function isListWorkTabsRequest(value: unknown): value is ListWorkTabsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Candidate
  return correlated(message) && message.tool === 'list_work_tabs' && validBrowserTarget(message.browserTarget)
    && (message.browserTargets === undefined || (Array.isArray(message.browserTargets) && message.browserTargets.every(validBrowserTarget)))
    && (message.unavailableBrowserTargets === undefined || (Array.isArray(message.unavailableBrowserTargets) && message.unavailableBrowserTargets.every(validUnavailableBrowserTarget)))
}

export function isReadWorkTabRequest(value: unknown): value is ReadWorkTabRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Candidate
  return correlated(message) && message.tool === 'read_work_tab' && validBrowserTarget(message.browserTarget)
    && Number.isInteger(message.tab) && (message.tab as number) >= 1 && (message.tab as number) <= 20
    && (message.offset === undefined || (Number.isInteger(message.offset) && (message.offset as number) >= 0 && (message.offset as number) <= 100000))
    && (message.limit === undefined || (Number.isInteger(message.limit) && (message.limit as number) >= 1 && (message.limit as number) <= 200))
    && (message.browserTargets === undefined || (Array.isArray(message.browserTargets) && message.browserTargets.every(validBrowserTarget)))
    && (message.unavailableBrowserTargets === undefined || (Array.isArray(message.unavailableBrowserTargets) && message.unavailableBrowserTargets.every(validUnavailableBrowserTarget)))
}

export function isLightDocumentResourceIdentity(value: unknown): value is LightDocumentResourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Candidate
  return resource.kind === 'webedit_light_document' && resource.origin === 'https://webedit.midea.com'
    && (typeof resource.documentName === 'string' || resource.documentName === null)
    && typeof resource.fingerprint === 'string' && resource.fingerprint.length > 0
}

export function isOfficeDocumentRequest(value: unknown): value is OfficeDocumentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Candidate
  if (!(correlated(message) && message.tool === 'light_document' && validBrowserTarget(message.browserTarget))) return false
  if (!['read', 'search', 'selection', 'inspect_write', 'write'].includes(String(message.action))) return false
  const action = message.action as OfficeDocumentAction
  const validPayload = message.payload === undefined || (message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload) && JSON.stringify(message.payload).length <= 100000)
  if (action === 'read') return (message.offset === undefined || (Number.isInteger(message.offset) && (message.offset as number) >= 0 && (message.offset as number) <= 100000))
    && (message.limit === undefined || (Number.isInteger(message.limit) && (message.limit as number) >= 1 && (message.limit as number) <= 200)) && validPayload
  if (action === 'search') return typeof message.query === 'string' && message.query.trim().length > 0 && message.query.length <= 500
    && (message.offset === undefined || (Number.isInteger(message.offset) && (message.offset as number) >= 0 && (message.offset as number) <= 100000))
    && (message.limit === undefined || (Number.isInteger(message.limit) && (message.limit as number) >= 1 && (message.limit as number) <= 200))
  if (action === 'selection') return message.offset === undefined && message.limit === undefined && message.query === undefined && validPayload
  if (action === 'inspect_write') return message.offset === undefined && message.limit === undefined && message.query === undefined
    && OFFICE_DOCUMENT_OPERATIONS.includes(message.operation as OfficeDocumentOperation)
    && message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload) && JSON.stringify(message.payload).length <= 100000
  return OFFICE_DOCUMENT_OPERATIONS.includes(message.operation as OfficeDocumentOperation)
    && message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload)
    && JSON.stringify(message.payload).length <= 100000 && isLightDocumentResourceIdentity(message.resource)
}
