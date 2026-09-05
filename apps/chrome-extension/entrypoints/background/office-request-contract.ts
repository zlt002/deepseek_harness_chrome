import { validBrowserTarget, validUnavailableBrowserTarget } from '../../../native-server/src/transport/connector-protocol.mjs'
import type { BrowserTarget, ConnectorCorrelation, UnavailableBrowserTarget } from '../../../native-server/src/transport/connector-protocol.mjs'

export interface BrowserSessionCorrelation extends ConnectorCorrelation {
  /** Trusted Native-side owner of a send-time Browser Target capture. */
  harnessSessionId?: string
}

export interface ListWorkTabsRequest extends BrowserSessionCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  browserTargets?: BrowserTarget[]
  unavailableBrowserTargets?: UnavailableBrowserTarget[]
  tool: 'list_work_tabs'
}

export interface ReadWorkTabRequest extends BrowserSessionCorrelation {
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

export type OfficeSpreadsheetAction = 'context' | 'range' | 'search' | 'inspect_write' | 'write' | 'active_sheet' | 'selection' | 'used_range' | 'workbook_info' | 'sheets' | 'view' | 'worksheet_protection' | 'write_preflight' | 'filter_state' | 'filter_values' | 'range_features' | 'special_cells' | 'list_charts' | 'chart' | 'list_pivots' | 'pivot' | 'pivot_field_items' | 'defined_names' | 'print_settings' | 'outline' | 'dimensions' | 'capabilities' | 'debug_runtime' | 'probe_range_api'
export type OfficeSpreadsheetOperation = 'set_values' | 'set_formula' | 'clear' | 'format' | 'merge' | 'unmerge' | 'apply_table_style' | 'clear_formats' | 'row_height' | 'column_width' | 'insert_rows' | 'insert_columns' | 'delete_rows' | 'delete_columns' | 'insert_cells' | 'delete_cells' | 'fill_range' | 'auto_fill' | 'replace_range_text' | 'text_to_columns' | 'remove_duplicates' | 'copy_range' | 'move_range' | 'paste_special' | 'batch_write' | 'sort' | 'set_auto_filter' | 'clear_filters' | 'apply_filter' | 'set_data_validation' | 'clear_data_validation' | 'add_hyperlink' | 'delete_hyperlinks' | 'add_comment' | 'delete_comments' | 'add_conditional_format' | 'clear_conditional_formats' | 'insert_cell_image' | 'create_defined_name' | 'delete_defined_name' | 'activate_worksheet' | 'sheet_add' | 'sheet_rename' | 'copy_worksheet' | 'move_worksheet' | 'set_worksheet_visibility' | 'sheet_delete' | 'undo' | 'redo' | 'recalculate' | 'create_chart' | 'update_chart' | 'set_chart_data_source' | 'resize_chart' | 'delete_chart' | 'create_pivot_table' | 'refresh_pivot_tables' | 'add_pivot_field' | 'remove_pivot_field' | 'refresh_pivot_table' | 'delete_pivot_table' | 'sort_pivot_field' | 'set_pivot_subtotals' | 'set_pivot_value_function' | 'set_pivot_show_values_as' | 'export_pdf' | 'export_range_image' | 'export_worksheet_image' | 'set_zoom' | 'set_freeze_panes' | 'set_print_settings' | 'set_outline_group' | 'set_rows_hidden' | 'set_columns_hidden' | 'auto_fit'
const OFFICE_SPREADSHEET_OPERATIONS: readonly OfficeSpreadsheetOperation[] = ['set_values', 'set_formula', 'clear', 'format', 'merge', 'unmerge', 'apply_table_style', 'clear_formats', 'row_height', 'column_width', 'insert_rows', 'insert_columns', 'delete_rows', 'delete_columns', 'insert_cells', 'delete_cells', 'fill_range', 'auto_fill', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'copy_range', 'move_range', 'paste_special', 'batch_write', 'sort', 'set_auto_filter', 'clear_filters', 'apply_filter', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'add_conditional_format', 'clear_conditional_formats', 'insert_cell_image', 'create_defined_name', 'delete_defined_name', 'activate_worksheet', 'sheet_add', 'sheet_rename', 'copy_worksheet', 'move_worksheet', 'set_worksheet_visibility', 'sheet_delete', 'undo', 'redo', 'recalculate', 'create_chart', 'update_chart', 'set_chart_data_source', 'resize_chart', 'delete_chart', 'create_pivot_table', 'refresh_pivot_tables', 'add_pivot_field', 'remove_pivot_field', 'refresh_pivot_table', 'delete_pivot_table', 'sort_pivot_field', 'set_pivot_subtotals', 'set_pivot_value_function', 'set_pivot_show_values_as', 'export_pdf', 'export_range_image', 'export_worksheet_image', 'set_zoom', 'set_freeze_panes', 'set_print_settings', 'set_outline_group', 'set_rows_hidden', 'set_columns_hidden', 'auto_fit']

export type OfficePresentationAction = 'inspect_capabilities' | 'get_context' | 'selection' | 'get_text_boxes' | 'inspect_write' | 'write'
export type OfficePresentationOperation = 'manage_slides' | 'render_scene' | 'edit_selection' | 'manage_objects' | 'manage_tables' | 'manage_charts' | 'manage_notes' | 'manage_comments' | 'manage_metadata' | 'manage_structure' | 'replace_text_box' | 'save'
const OFFICE_PRESENTATION_OPERATIONS: readonly OfficePresentationOperation[] = ['manage_slides', 'render_scene', 'edit_selection', 'manage_objects', 'manage_tables', 'manage_charts', 'manage_notes', 'manage_comments', 'manage_metadata', 'manage_structure', 'replace_text_box', 'save']

export interface LightDocumentResourceIdentity {
  kind: 'webedit_light_document'
  origin: 'https://webedit.midea.com'
  documentName: string | null
  fingerprint: string
}

export interface OfficeDocumentRequest extends BrowserSessionCorrelation {
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

export interface SpreadsheetResourceIdentity {
  kind: 'webedit_spreadsheet'
  origin: 'https://webedit.midea.com'
  workbookName: string | null
  sheetName: string | null
  fingerprint: string
}

export interface OfficeSpreadsheetRequest extends BrowserSessionCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  tool: 'spreadsheet'
  action: OfficeSpreadsheetAction
  range?: string
  sheetName?: string
  query?: string
  matchCase?: boolean
  matchEntireCell?: boolean
  searchBy?: 'values' | 'text' | 'formula'
  offset?: number
  limit?: number
  index?: number
  fieldName?: string
  axis?: 'row' | 'column'
  cellType?: 'blanks' | 'constants' | 'formulas' | 'lastCell' | 'visible'
  operation?: OfficeSpreadsheetOperation
  payload?: Record<string, unknown>
  resource?: SpreadsheetResourceIdentity
  precondition?: Record<string, unknown>
}

export interface PresentationResourceIdentity {
  kind: 'webedit_presentation'
  origin: 'https://webedit.midea.com'
  presentationName?: string | null
  documentName?: string | null
  documentId?: string | number | null
  path?: string
  fingerprint: string
  slideCount?: number
}

export interface OfficePresentationRequest extends BrowserSessionCorrelation {
  type: 'connector_request'
  browserTarget: BrowserTarget
  tool: 'presentation'
  action: OfficePresentationAction
  slideIndex?: number
  operation?: OfficePresentationOperation
  payload?: Record<string, unknown>
  resource?: PresentationResourceIdentity
  precondition?: Record<string, unknown>
}

export interface OfficeReadFailure {
  code: 'unsupported' | 'preview' | 'readonly' | 'invalid_range' | 'invalid_request' | 'write_rejected' | 'write_incomplete' | 'navigation' | 'iframe_replaced' | 'timeout' | 'cancelled' | 'precondition_required' | 'fingerprint_mismatch' | 'selection_changed' | 'context_mismatch' | 'readback_mismatch' | 'runtime_error'
  message: string
  details?: Record<string, unknown>
}

type Candidate = Record<string, unknown>

function boundedFailureDetail(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true
  if (typeof value === 'string') return value.length <= 2_000
  // Runtime failures commonly contain observed.objects (four nested layers).
  // Preserve that diagnostic evidence without allowing arbitrary deep blobs.
  if (depth >= 5 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length <= 30 && value.every((item) => boundedFailureDetail(item, depth + 1))
  const entries = Object.entries(value)
  return entries.length <= 30 && entries.every(([key, child]) => key.length <= 128 && boundedFailureDetail(child, depth + 1))
}

/** Runtime error metadata crosses the Native boundary only when it is small,
 * structured, and free of executable/opaque values. */
export function isOfficeReadFailureDetails(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && boundedFailureDetail(value)
}

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

function boundedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 100000
}

export function isSpreadsheetResourceIdentity(value: unknown): value is SpreadsheetResourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Candidate
  return resource.kind === 'webedit_spreadsheet' && resource.origin === 'https://webedit.midea.com'
    && (typeof resource.workbookName === 'string' || resource.workbookName === null)
    && (typeof resource.sheetName === 'string' || resource.sheetName === null)
    && typeof resource.fingerprint === 'string' && resource.fingerprint.length > 0 && resource.fingerprint.length <= 512
}

export function isPresentationResourceIdentity(value: unknown): value is PresentationResourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Candidate
  const validName = typeof resource.presentationName === 'string' || resource.presentationName === null
    || typeof resource.documentName === 'string' || resource.documentName === null
  return resource.kind === 'webedit_presentation' && resource.origin === 'https://webedit.midea.com' && validName
    && typeof resource.fingerprint === 'string' && resource.fingerprint.length > 0 && resource.fingerprint.length <= 512
    && (resource.slideCount === undefined || (Number.isInteger(resource.slideCount) && (resource.slideCount as number) >= 0 && (resource.slideCount as number) <= 10000))
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


export function isOfficeSpreadsheetRequest(value: unknown): value is OfficeSpreadsheetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Candidate
  if (!(correlated(message) && message.tool === 'spreadsheet' && validBrowserTarget(message.browserTarget))) return false
  const action = message.action as OfficeSpreadsheetAction
  const inspectActions: readonly OfficeSpreadsheetAction[] = ['active_sheet', 'selection', 'used_range', 'workbook_info', 'sheets', 'view', 'worksheet_protection', 'write_preflight', 'filter_state', 'filter_values', 'range_features', 'special_cells', 'list_charts', 'chart', 'list_pivots', 'pivot', 'pivot_field_items', 'defined_names', 'print_settings', 'outline', 'dimensions', 'capabilities', 'debug_runtime', 'probe_range_api']
  if (!['context', 'range', 'search', 'inspect_write', 'write', ...inspectActions].includes(action)) return false
  const validSheetName = message.sheetName === undefined || (typeof message.sheetName === 'string' && message.sheetName.trim().length > 0 && message.sheetName.length <= 128)
  const validIndex = message.index === undefined || (Number.isInteger(message.index) && (message.index as number) >= 1 && (message.index as number) <= 10000)
  const validBoundedField = message.fieldName === undefined || (typeof message.fieldName === 'string' && message.fieldName.trim().length > 0 && message.fieldName.length <= 128)
  const validAxis = message.axis === undefined || message.axis === 'row' || message.axis === 'column'
  const validCellType = message.cellType === undefined || ['blanks', 'constants', 'formulas', 'lastCell', 'visible'].includes(String(message.cellType))
  if (!validSheetName || !validIndex || !validBoundedField || !validAxis || !validCellType) return false
  if (action === 'context') return message.range === undefined && message.query === undefined && message.operation === undefined
  if (action === 'range') return typeof message.range === 'string' && message.range.trim().length > 0 && message.range.length <= 128
  if (action === 'search') return typeof message.range === 'string' && message.range.trim().length > 0 && message.range.length <= 128
    && typeof message.query === 'string' && message.query.trim().length > 0 && message.query.length <= 500
    && (message.matchCase === undefined || typeof message.matchCase === 'boolean')
    && (message.matchEntireCell === undefined || typeof message.matchEntireCell === 'boolean')
    && (message.searchBy === undefined || ['values', 'text', 'formula'].includes(String(message.searchBy)))
    && (message.offset === undefined || (Number.isInteger(message.offset) && (message.offset as number) >= 0 && (message.offset as number) <= 100000))
    && (message.limit === undefined || (Number.isInteger(message.limit) && (message.limit as number) >= 1 && (message.limit as number) <= 200))
  if (inspectActions.includes(action)) {
    const rangeRequired: readonly OfficeSpreadsheetAction[] = ['filter_state', 'filter_values', 'range_features', 'special_cells', 'outline', 'dimensions', 'capabilities', 'probe_range_api']
    const indexRequired: readonly OfficeSpreadsheetAction[] = ['chart', 'pivot', 'pivot_field_items']
    return message.operation === undefined && message.payload === undefined && message.resource === undefined && message.precondition === undefined
      && (!rangeRequired.includes(action) || (typeof message.range === 'string' && message.range.trim().length > 0 && message.range.length <= 128))
      && (!indexRequired.includes(action) || validIndex && message.index !== undefined)
      && (!['outline', 'dimensions'].includes(action) || message.axis !== undefined)
      && (action !== 'special_cells' || message.cellType !== undefined)
      && (action !== 'pivot_field_items' || message.fieldName !== undefined)
  }
  if (!OFFICE_SPREADSHEET_OPERATIONS.includes(message.operation as OfficeSpreadsheetOperation) || !boundedRecord(message.payload)) return false
  if (action === 'inspect_write') return message.resource === undefined && message.precondition === undefined
  return isSpreadsheetResourceIdentity(message.resource) && boundedRecord(message.precondition)
}

export function isOfficePresentationRequest(value: unknown): value is OfficePresentationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Candidate
  if (!(correlated(message) && message.tool === 'presentation' && validBrowserTarget(message.browserTarget))) return false
  if (!['inspect_capabilities', 'get_context', 'selection', 'get_text_boxes', 'inspect_write', 'write'].includes(String(message.action))) return false
  if (message.slideIndex !== undefined && !(Number.isInteger(message.slideIndex) && (message.slideIndex as number) >= 0 && (message.slideIndex as number) <= 9999)) return false
  if (message.action === 'inspect_capabilities') {
    return message.slideIndex === undefined && message.operation === undefined && message.payload === undefined
      && message.resource === undefined && message.precondition === undefined
  }
  if (message.action === 'get_context' || message.action === 'selection' || message.action === 'get_text_boxes') {
    return message.operation === undefined && message.payload === undefined && message.resource === undefined && message.precondition === undefined
  }
  if (!OFFICE_PRESENTATION_OPERATIONS.includes(message.operation as OfficePresentationOperation) || !boundedRecord(message.payload)) return false
  if (message.action === 'inspect_write') return message.resource === undefined && message.precondition === undefined
  return isPresentationResourceIdentity(message.resource) && boundedRecord(message.precondition)
}
