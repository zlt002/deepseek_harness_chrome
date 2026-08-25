(() => {
  'use strict'
  const fail = (code, message) => ({ ok: false, error: { code, message } })
  const resolve = async (value) => value && typeof value.then === 'function' ? await value : value
  const call = async (target, name, args = []) => target && typeof target[name] === 'function' ? resolve(target[name](...args)) : undefined
  const property = async (target, name) => { try { return await resolve(target?.[name]) } catch { return undefined } }
  const set = async (target, name, value) => { try { target[name] = value; return true } catch { return false } }
  const valueOf = (source, row, column) => Array.isArray(source) ? (Array.isArray(source[row]) ? source[row][column] : source[row]) : source
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const matrix = (source) => Array.isArray(source) ? source : [[source ?? null]]
  const resourceFingerprint = (workbookName, sheetName) => `webedit:${location.origin}${location.pathname}|${workbookName ?? ''}|${sheetName ?? ''}`
  const ADVANCED_OPERATIONS = new Set(['sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_conditional_format', 'clear_conditional_formats', 'add_comment', 'delete_comments', 'insert_cell_image', 'export_pdf', 'export_range_image', 'export_worksheet_image', 'clear_formats', 'apply_table_style', 'apply_filter'])
  // Analytics writes have object, rather than cell, targets.  They deliberately
  // do not fall through the range-write path: an object collection is the write
  // fence and a source range (when present) is separately fingerprinted.
  const ANALYTICS_OPERATIONS = new Set(['create_chart', 'update_chart', 'set_chart_data_source', 'resize_chart', 'delete_chart', 'create_pivot_table', 'refresh_pivot_tables', 'refresh_all_pivot_tables', 'add_pivot_field', 'remove_pivot_field', 'refresh_pivot_table', 'delete_pivot_table', 'sort_pivot_field', 'set_pivot_subtotals', 'set_pivot_value_function', 'set_pivot_show_values_as'])
  const MAX_IMAGE_ARTIFACT_BYTES = 256 * 1024
  const MAX_INLINE_IMAGE_ARTIFACT_BYTES = 8 * 1024
  const VALIDATION_TYPES = { wholeNumber: 1, decimal: 2, list: 3, date: 4, time: 5, textLength: 6, custom: 7 }
  const ALERT_STYLES = { stop: 1, warning: 2, information: 3 }
  const VALIDATION_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }
  const CONDITIONAL_FORMAT_TYPES = { cellValue: 1, expression: 2 }
  const CONDITIONAL_FORMAT_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }
  const VALIDATION_PROPERTY_NAMES = ['AlertStyle', 'Operator', 'Formula1', 'Formula2', 'IgnoreBlank', 'ShowError', 'ErrorTitle', 'ErrorMessage']
  // Range.Cut is permitted only when every formatting property is explicitly
  // readable and one of WebEdit's known unstyled defaults. null means the API
  // did not prove the value, never a default.
  const MOVE_DEFAULT_FORMATS = {
    bold: [false, 0], italic: [false, 0], underline: [false, 0, 'none'], size: [10, 11, 12],
    name: ['Arial', 'Calibri', '宋体', '等线'], color: ['#000000', '#FF000000', 0, -16777216, 'rgb(0,0,0)'],
    fill: ['#FFFFFF', '#FFFFFFFF', 16777215, -1, 'rgb(255,255,255)'], numberFormat: ['General', '通用格式', '常规'],
    alignment: ['general', 'General', 0, -4105], wrap: [false, 0],
  }
  const WORKBOOK_OPERATIONS = new Set(['create_defined_name', 'delete_defined_name', 'activate_worksheet', 'move_worksheet', 'set_worksheet_visibility'])
  const SHEET_LIFECYCLE_OPERATIONS = new Set(['sheet_add', 'sheet_rename', 'sheet_delete', 'copy_worksheet'])
  const VIEW_OPERATIONS = new Set(['set_zoom', 'set_freeze_panes'])
  const PRINT_OPERATIONS = new Set(['set_print_settings'])
  const OUTLINE_OPERATIONS = new Set(['set_outline_group'])
  const DIMENSION_OPERATIONS = new Set(['set_rows_hidden', 'set_columns_hidden', 'auto_fit'])
  const PRINT_KEYS = ['printArea', 'printTitleRows', 'printTitleColumns', 'orientation', 'zoom', 'fitToPagesWide', 'fitToPagesTall', 'centerHorizontally', 'centerVertically', 'leftMargin', 'rightMargin', 'topMargin', 'bottomMargin', 'headerMargin', 'footerMargin']
  const PRINT_PROPERTY = { printArea: 'PrintArea', printTitleRows: 'PrintTitleRows', printTitleColumns: 'PrintTitleColumns', orientation: 'Orientation', zoom: 'Zoom', fitToPagesWide: 'FitToPagesWide', fitToPagesTall: 'FitToPagesTall', centerHorizontally: 'CenterHorizontally', centerVertically: 'CenterVertically', leftMargin: 'LeftMargin', rightMargin: 'RightMargin', topMargin: 'TopMargin', bottomMargin: 'BottomMargin', headerMargin: 'HeaderMargin', footerMargin: 'FooterMargin' }
  const SPECIAL_CELL_TYPES = { blanks: 4, constants: 2, formulas: -4123, lastCell: 11, visible: 12 }

  // Instant readiness check for the background frame probe: no polling, no waiting.
  // Light-document frames also expose globalThis.APP (openApi.editor.canvas).
  // Claiming "spreadsheet ready" from APP alone makes list_work_tabs
  // misroute a Team Knowledge light document to office_spreadsheet.
  function readyNow() {
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    if (!app) return false
    const path = String(location.pathname || '').toLowerCase()
    if (path.includes('/weboffice/office/o/')) return false
    const canvas = app.openApi?.editor?.canvas
    if (canvas && typeof canvas.getDocXml === 'function') return false
    return true
  }

  async function appAndSheet(requestedSheet) {
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    if (!app) return { error: fail('unsupported', 'WebEdit spreadsheet runtime is unavailable') }
    const workbook = await property(app, 'ActiveWorkbook') ?? await call(app, 'getActiveWorkbook')
    let sheet = await call(app, 'getActiveSheet') ?? await property(app, 'ActiveSheet')
    if (requestedSheet) {
      if (!workbook || typeof requestedSheet !== 'string' || !requestedSheet.trim()) return { error: fail('invalid_range', 'WebEdit requires a nonempty exact worksheet name') }
      const candidate = await call(workbook, 'getWorksheet', [requestedSheet]) ?? await call(workbook, 'getItem', [requestedSheet])
      const candidateName = await call(candidate, 'getName') ?? await property(candidate, 'Name')
      if (!candidate || candidateName !== requestedSheet) return { error: fail('invalid_range', 'The requested worksheet was not found by exact name') }
      sheet = candidate
    }
    if (!sheet) return { error: fail('preview', 'WebEdit does not expose an active spreadsheet sheet') }
    const workbookName = await call(workbook, 'getName') ?? await property(workbook, 'Name') ?? null
    const sheetName = await call(sheet, 'getName') ?? await property(sheet, 'Name') ?? requestedSheet ?? null
    return { app, workbook, sheet, resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: typeof workbookName === 'string' ? workbookName : null, sheetName: typeof sheetName === 'string' ? sheetName : null, fingerprint: resourceFingerprint(workbookName, sheetName) } }
  }
  async function rangeFor(sheet, address) {
    const bare = splitSheetPrefix(address).range
    // accr-ui parity: the Midea APP runtime exposes sheet.getRange(address), but it
    // ignores its argument and returns the entire worksheet. When the Midea-specific
    // constructors are available, build an exact internal range from numeric bounds.
    if (sheet && typeof sheet.createRANGE === 'function' && typeof sheet.createRange === 'function') {
      const parsed = parseAddress(bare)
      if (parsed) {
        // AccrUI / live Midea APP createRANGE is 0-based. Sending 1-based A1
        // coordinates shifts every exact range by one cell.
        const core = await call(sheet, 'createRANGE', [parsed.rowFrom - 1, parsed.rowTo - 1, parsed.colFrom - 1, parsed.colTo - 1])
        const exact = core ? await call(sheet, 'createRange', [core]) : null
        if (exact) return exact
      }
    }
    return await call(sheet, 'getRange', [bare]) ?? await call(sheet, 'Range', [address])
  }
  async function viewSnapshot(resolved) {
    const activeWindow = await property(resolved.app, 'ActiveWindow') ?? await call(resolved.app, 'getActiveWindow'); const activeCell = await property(resolved.app, 'ActiveCell') ?? await call(resolved.app, 'getActiveCell') ?? await property(resolved.sheet, 'ActiveCell'); const activeSheet = await property(resolved.app, 'ActiveSheet')
    const sheetName = await call(activeSheet, 'getName') ?? await property(activeSheet, 'Name'); const row = Number(await property(activeCell, 'Row')); const column = Number(await property(activeCell, 'Column')); const freezePanes = await property(activeWindow, 'FreezePanes'); const splitRow = Number(await property(activeWindow, 'SplitRow')); const splitColumn = Number(await property(activeWindow, 'SplitColumn')); const zoom = Number(await property(activeWindow, 'Zoom')); const scrollRow = Number(await property(activeWindow, 'ScrollRow')); const scrollColumn = Number(await property(activeWindow, 'ScrollColumn') )
    const cellReadable = Number.isInteger(row) && row >= 1 && row <= 1048576 && Number.isInteger(column) && column >= 1 && column <= 16384
    const partial = cellReadable ? { activeCell: `${columnName(column)}${row}` } : null
    if (!activeWindow || !cellReadable || typeof sheetName !== 'string' || sheetName.length === 0 || sheetName !== resolved.resource.sheetName || typeof freezePanes !== 'boolean' || !Number.isInteger(splitRow) || splitRow < 0 || splitRow > 1048575 || !Number.isInteger(splitColumn) || splitColumn < 0 || splitColumn > 16383 || !Number.isInteger(zoom) || zoom < 10 || zoom > 400 || !Number.isInteger(scrollRow) || scrollRow < 1 || scrollRow > 1048576 || !Number.isInteger(scrollColumn) || scrollColumn < 1 || scrollColumn > 16384) return { supported: false, activeWindow: null, view: partial }
    return { supported: true, activeWindow, view: { sheetName, activeCell: `${columnName(column)}${row}`, freezePanes, splitRow, splitColumn, zoom, scrollRow, scrollColumn } }
  }
  const MAX_SELECTION_CELLS = 2000
  async function selectionObject(app) {
    return await call(app, 'getSelectionRange') ?? await property(app, 'Selection') ?? await call(app, 'getSelection') ?? null
  }
  async function activeCellObject(resolved) {
    return await property(resolved.app, 'ActiveCell') ?? await call(resolved.app, 'getActiveCell') ?? await property(resolved.sheet, 'ActiveCell') ?? null
  }
  function addressFromBounds(bounds) {
    const start = `${columnName(bounds.colFrom)}${bounds.rowFrom}`
    return bounds.rowsCount === 1 && bounds.columnsCount === 1 ? start : `${start}:${columnName(bounds.colTo)}${bounds.rowTo}`
  }
  function boundsFromCore(core) {
    if (!core || typeof core !== 'object') return null
    const rowFrom = Number(core.rowFrom) + 1
    const rowTo = Number(core.rowTo) + 1
    const colFrom = Number(core.colFrom) + 1
    const colTo = Number(core.colTo) + 1
    if (![rowFrom, rowTo, colFrom, colTo].every((value) => Number.isInteger(value)) || rowFrom < 1 || colFrom < 1 || rowTo < rowFrom || colTo < colFrom || rowTo > 1048576 || colTo > 16384) return null
    return { rowFrom, rowTo, colFrom, colTo, rowsCount: rowTo - rowFrom + 1, columnsCount: colTo - colFrom + 1 }
  }
  async function boundsFromExcelRange(range) {
    const row = Number(await call(range, 'getRow') ?? await property(range, 'Row'))
    const column = Number(await call(range, 'getColumn') ?? await property(range, 'Column'))
    const rows = await call(range, 'getRows') ?? await property(range, 'Rows')
    const columns = await call(range, 'getColumns') ?? await property(range, 'Columns')
    const rowsCount = Number(await call(rows, 'getCount') ?? await property(rows, 'Count'))
    const columnsCount = Number(await call(columns, 'getCount') ?? await property(columns, 'Count'))
    if (!Number.isInteger(row) || !Number.isInteger(column) || row < 1 || column < 1 || row > 1048576 || column > 16384) return null
    if (!Number.isInteger(rowsCount) || !Number.isInteger(columnsCount) || rowsCount < 1 || columnsCount < 1 || row + rowsCount - 1 > 1048576 || column + columnsCount - 1 > 16384) return { rowFrom: row, rowTo: row, colFrom: column, colTo: column, rowsCount: 1, columnsCount: 1 }
    return { rowFrom: row, rowTo: row + rowsCount - 1, colFrom: column, colTo: column + columnsCount - 1, rowsCount, columnsCount }
  }
  function addressFromExplicit(value) {
    if (typeof value !== 'string' || value.includes('function')) return null
    const bare = splitSheetPrefix(value.replace(/\$/g, '')).range
    return parseAddress(bare) ? bare.toUpperCase() : null
  }
  async function rangeBounds(range) {
    if (!range) return null
    const fromCore = boundsFromCore(await call(range, 'getRANGE'))
    if (fromCore) return { ...fromCore, address: addressFromBounds(fromCore) }
    const explicit = addressFromExplicit(await call(range, 'getAddress') ?? await call(range, 'getAddressLocal') ?? await property(range, 'Address'))
    if (explicit) {
      const parsed = parseAddress(explicit)
      const bounds = { rowFrom: parsed.rowFrom, rowTo: parsed.rowTo, colFrom: parsed.colFrom, colTo: parsed.colTo, rowsCount: parsed.rowTo - parsed.rowFrom + 1, columnsCount: parsed.colTo - parsed.colFrom + 1 }
      return { ...bounds, address: addressFromBounds(bounds) }
    }
    const fromExcel = await boundsFromExcelRange(range)
    return fromExcel ? { ...fromExcel, address: addressFromBounds(fromExcel) } : null
  }
  async function summarizeLocatedRange(resolved, range, source) {
    const bounds = await rangeBounds(range)
    if (!bounds) return { supported: false }
    const cellCount = bounds.rowsCount * bounds.columnsCount
    const summary = { supported: true, source, sheetName: resolved.resource.sheetName, address: bounds.address, row: bounds.rowFrom, column: bounds.colFrom, rowsCount: bounds.rowsCount, columnsCount: bounds.columnsCount, cellCount, singleCell: cellCount === 1, truncated: cellCount > MAX_SELECTION_CELLS, values: null, value2: null, text: null, formulas: null }
    if (cellCount > MAX_SELECTION_CELLS) return summary
    const read = await rangeSnapshot(resolved.sheet, bounds.address, { tolerateMissingFormulas: true })
    if (!read.error) {
      summary.values = read.snapshot.values
      summary.value2 = read.snapshot.values
      summary.text = read.snapshot.text
      summary.formulas = read.snapshot.formulas
      return summary
    }
    const value2 = await call(range, 'getActiveCellValue') ?? await call(range, 'getValue2') ?? await property(range, 'Value2')
    if (value2 === undefined) return summary
    summary.values = matrix(value2)
    summary.value2 = summary.values
    summary.text = matrix(await call(range, 'getText') ?? await property(range, 'Text') ?? value2)
    return summary
  }
  function activeCellSummary(summary) {
    if (!summary?.supported) return null
    return { address: summary.address, row: summary.row, column: summary.column, value: summary.singleCell ? summary.values?.[0]?.[0] ?? null : null, text: summary.singleCell ? summary.text?.[0]?.[0] ?? '' : '' }
  }
  async function selectionSnapshot(resolved) {
    const selection = await selectionObject(resolved.app)
    const active = await activeCellObject(resolved)
    const selected = await summarizeLocatedRange(resolved, selection, 'getSelectionRange')
    const activeSummary = await summarizeLocatedRange(resolved, active, 'ActiveCell')
    if (selected.supported) return { ...selected, activeCell: activeCellSummary(activeSummary) ?? (selected.singleCell ? activeCellSummary(selected) : { address: selected.address, row: selected.row, column: selected.column, value: null, text: '' }) }
    if (activeSummary.supported) return { ...activeSummary, source: 'ActiveCell', activeCell: activeCellSummary(activeSummary) }
    return { supported: false, reason: 'selection_api_not_detected', address: null, activeCell: null }
  }
  function requestedViewOperation(operation, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (operation === 'set_zoom') return Object.keys(payload).every((key) => ['sheetName', 'zoom'].includes(key)) && Number.isInteger(payload.zoom) && payload.zoom >= 10 && payload.zoom <= 400 ? { zoom: payload.zoom } : null
    if (operation === 'set_freeze_panes') { if (!Object.keys(payload).every((key) => ['sheetName', 'freeze', 'target'].includes(key)) || typeof payload.freeze !== 'boolean' || (payload.freeze ? typeof payload.target !== 'string' : payload.target !== undefined)) return null; const target = payload.freeze ? parseAddress(payload.target) : null; return payload.freeze ? target && target.rowFrom === target.rowTo && target.colFrom === target.colTo ? { freeze: true, target: payload.target } : null : { freeze: false } }
    return null
  }
  function canonicalOrientation(value) { return value === 1 || value === '1' || value === 'portrait' ? 'portrait' : value === 2 || value === '2' || value === 'landscape' ? 'landscape' : null }
  function canonicalPrintArea(value) { if (typeof value !== 'string') return null; const area = value.trim().replace(/^.*!/, '').replace(/\$/g, '').toUpperCase(); return area === '' || parseAddress(area) ? area : null }
  function parseOutlineRange(address, axis) {
    if (typeof address !== 'string' || address.length === 0 || address.length > 128 || (axis !== 'row' && axis !== 'column')) return null
    const rows = /^\$?([1-9]\d{0,6}):\$?([1-9]\d{0,6})$/.exec(address.trim())
    const columns = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(address.trim())
    if (axis === 'row' && rows) { const from = Number(rows[1]); const to = Number(rows[2]); return from <= to && to <= 1048576 && to - from < 1000 ? { range: `${from}:${to}`, from, to } : null }
    if (axis === 'column' && columns) { const index = (name) => name.toUpperCase().split('').reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0); const from = index(columns[1]); const to = index(columns[2]); return from <= to && to <= 16384 && to - from < 1000 ? { range: `${columns[1].toUpperCase()}:${columns[2].toUpperCase()}`, from, to } : null }
    return null
  }
  function requestedOutlineOperation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['sheetName', 'range', 'axis', 'grouped'].includes(key)) || typeof payload.axis !== 'string' || typeof payload.grouped !== 'boolean') return null
    const target = parseOutlineRange(payload.range, payload.axis); return target ? { ...target, axis: payload.axis, grouped: payload.grouped } : null
  }
  function specialCellCandidateExists(snapshot, kind) {
    if (!snapshot || kind === 'lastCell' || kind === 'visible') return true
    for (let row = 0; row < snapshot.values.length; row += 1) for (let column = 0; column < snapshot.values[row].length; column += 1) {
      const value = snapshot.values[row][column]; const formula = snapshot.formulas[row][column]; const hasFormula = typeof formula === 'string' && formula.startsWith('=')
      if (kind === 'blanks' && (value === null || value === undefined || value === '')) return true
      if (kind === 'constants' && value !== null && value !== undefined && value !== '' && !hasFormula) return true
      if (kind === 'formulas' && hasFormula) return true
    }
    return false
  }
  function specialCellsRequest(request) {
    if (!request || typeof request.range !== 'string' || !Object.hasOwn(SPECIAL_CELL_TYPES, request.kind)) return null
    const target = parseAddress(request.range); const cells = target && (target.rowTo - target.rowFrom + 1) * (target.colTo - target.colFrom + 1)
    if (!target || cells > 100000 || !Number.isInteger(request.offset ?? 0) || request.offset < 0 || request.offset > 100000 || !Number.isInteger(request.limit ?? 200) || request.limit < 1 || request.limit > 200) return null
    return { target, kind: request.kind, type: SPECIAL_CELL_TYPES[request.kind], offset: request.offset ?? 0, limit: request.limit ?? 200 }
  }
  function insideAddress(area, target) { return area.rowFrom >= target.rowFrom && area.rowTo <= target.rowTo && area.colFrom >= target.colFrom && area.colTo <= target.colTo }
  async function specialCells(resolved, request) {
    const requested = specialCellsRequest(request); if (!requested) return fail('invalid_range', 'special_cells requires a simple bounded range, supported kind, offset, and limit')
    const input = await rangeSnapshot(resolved.sheet, request.range, { tolerateMissingFormulas: true }); if (input.error) return input.error
    if (!specialCellCandidateExists(input.snapshot, requested.kind)) return { ok: true, result: { status: 'ok', resource: resolved.resource, specialCells: { range: request.range, sheetName: resolved.resource.sheetName, kind: requested.kind, count: 0, areaCount: 0, offset: requested.offset, limit: requested.limit, returned: 0, hasMore: false, nextOffset: null, truncated: false, areas: [] } } }
    if (typeof input.range.SpecialCells !== 'function') return fail('unsupported', 'WebEdit does not expose Range.SpecialCells')
    let specialRange; try { specialRange = await resolve(input.range.SpecialCells(requested.type)) } catch { return fail('unsupported', 'WebEdit SpecialCells did not return a readable collection') }
    const collection = await property(specialRange, 'Areas'); const count = Number(await property(specialRange, 'Count')); const areaCount = Number(await property(collection, 'Count'))
    if (!specialRange || !collection || !Number.isInteger(count) || count < 0 || count > 100000 || !Number.isInteger(areaCount) || areaCount < 0 || areaCount > 100000 || areaCount > count) return fail('unsupported', 'WebEdit returned an incomplete or inconsistent SpecialCells collection')
    const start = Math.min(requested.offset, areaCount); const end = Math.min(areaCount, requested.offset + requested.limit); const areas = []; const areaRanges = []; let returnedCells = 0
    for (let index = start; index < end; index += 1) {
      const area = await call(collection, 'Item', [index + 1]); const row = Number(await property(area, 'Row')); const column = Number(await property(area, 'Column')); const rows = await property(area, 'Rows'); const columns = await property(area, 'Columns'); const rowsCount = Number(await property(rows, 'Count')); const columnsCount = Number(await property(columns, 'Count')); const areaCountValue = Number(await property(area, 'Count'))
      const parsed = Number.isInteger(row) && Number.isInteger(column) && Number.isInteger(rowsCount) && Number.isInteger(columnsCount) && row >= 1 && column >= 1 && rowsCount >= 1 && columnsCount >= 1 && row + rowsCount - 1 <= 1048576 && column + columnsCount - 1 <= 16384 ? { rowFrom: row, rowTo: row + rowsCount - 1, colFrom: column, colTo: column + columnsCount - 1 } : null
      const cells = parsed ? rowsCount * columnsCount : 0
      if (!area || !parsed || !insideAddress(parsed, requested.target) || areaRanges.some((candidate) => overlap(candidate, parsed)) || !Number.isInteger(areaCountValue) || areaCountValue !== cells || returnedCells + cells > count) return fail('unsupported', 'WebEdit returned an invalid or overlapping SpecialCells Area; no partial page was accepted')
      returnedCells += cells; areaRanges.push(parsed); areas.push({ index: index + 1, address: addressFor(parsed), row, column, rowsCount, columnsCount, count: cells })
    }
    if (areas.length !== end - start) return fail('unsupported', 'WebEdit omitted a requested SpecialCells Area; no partial page was accepted')
    if (start === 0 && end === areaCount && returnedCells !== count) return fail('unsupported', 'WebEdit SpecialCells Count differs from the fully enumerated Areas')
    const hasMore = end < areaCount
    return { ok: true, result: { status: 'ok', resource: resolved.resource, specialCells: { range: request.range, sheetName: resolved.resource.sheetName, kind: requested.kind, count, areaCount, offset: requested.offset, limit: requested.limit, returned: areas.length, hasMore, nextOffset: hasMore ? end : null, truncated: hasMore, areas } } }
  }
  function requestedDimensionOperation(operation, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const expectedAxis = operation === 'set_rows_hidden' ? 'row' : operation === 'set_columns_hidden' ? 'column' : payload.axis
    if ((expectedAxis !== 'row' && expectedAxis !== 'column') || !Object.keys(payload).every((key) => ['sheetName', 'range', 'hidden', 'axis'].includes(key))) return null
    if ((operation === 'set_rows_hidden' || operation === 'set_columns_hidden') && (Object.hasOwn(payload, 'axis') || typeof payload.hidden !== 'boolean')) return null
    if (operation === 'auto_fit' && (payload.hidden !== undefined || !Object.hasOwn(payload, 'axis'))) return null
    const target = parseOutlineRange(payload.range, expectedAxis)
    return target ? { ...target, axis: expectedAxis, ...(operation === 'auto_fit' ? {} : { hidden: payload.hidden }) } : null
  }
  async function dimensionSnapshot(resolved, target) {
    const items = []
    for (let index = target.from; index <= target.to; index += 1) {
      const address = target.axis === 'row' ? `${index}:${index}` : `${columnName(index)}:${columnName(index)}`
      const range = await rangeFor(resolved.sheet, address)
      const member = await property(range, target.axis === 'row' ? 'EntireRow' : 'EntireColumn') ?? range
      const hidden = await property(member, 'Hidden'); const size = await property(member, target.axis === 'row' ? 'RowHeight' : 'ColumnWidth')
      if (typeof hidden !== 'boolean' || typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > 10000) return { supported: false }
      items.push({ index, hidden, size })
    }
    return { supported: true, dimensions: { sheetName: resolved.resource.sheetName, range: target.range, axis: target.axis, items } }
  }
  function validPrintTitle(value, axis) {
    if (value === '') return true
    const match = axis === 'row' ? /^\$?([1-9]\d{0,6}):\$?([1-9]\d{0,6})$/.exec(value) : /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/i.exec(value)
    if (!match) return false
    const index = axis === 'row' ? (item) => Number(item) : (item) => item.toUpperCase().split('').reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0)
    const from = index(match[1]); const to = index(match[2]); const maximum = axis === 'row' ? 1048576 : 16384
    return from <= to && to <= maximum
  }
  function validPrintValue(key, value) {
    if (key === 'printArea') return typeof value === 'string' && value.length <= 128 && (value === '' || !!parseAddress(value))
    if (key === 'printTitleRows') return typeof value === 'string' && value.length <= 64 && validPrintTitle(value, 'row')
    if (key === 'printTitleColumns') return typeof value === 'string' && value.length <= 32 && validPrintTitle(value, 'column')
    if (key === 'orientation') return value === 'portrait' || value === 'landscape'
    if (key === 'zoom') return Number.isInteger(value) && value >= 10 && value <= 400
    if (key === 'fitToPagesWide' || key === 'fitToPagesTall') return Number.isInteger(value) && value >= 1 && value <= 100
    if (key === 'centerHorizontally' || key === 'centerVertically') return typeof value === 'boolean'
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 720
  }
  function requestedPrintOperation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => key === 'sheetName' || PRINT_KEYS.includes(key))) return null
    const requested = Object.fromEntries(PRINT_KEYS.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]])); const keys = Object.keys(requested)
    if (keys.length === 0 || keys.some((key) => !validPrintValue(key, requested[key])) || (Object.hasOwn(requested, 'zoom') && (Object.hasOwn(requested, 'fitToPagesWide') || Object.hasOwn(requested, 'fitToPagesTall')))) return null
    return requested
  }
  async function printSettingsSnapshot(resolved) {
    const pageSetup = await property(resolved.sheet, 'PageSetup') ?? await call(resolved.sheet, 'getPageSetup'); if (!pageSetup) return { supported: false }
    const values = {}; for (const key of PRINT_KEYS) values[key] = await property(pageSetup, PRINT_PROPERTY[key])
    const orientation = canonicalOrientation(values.orientation); const printArea = canonicalPrintArea(values.printArea); const zoom = values.zoom === false ? false : Number(values.zoom)
    if (printArea === null || typeof values.printTitleRows !== 'string' || values.printTitleRows.length > 64 || !validPrintTitle(values.printTitleRows, 'row') || typeof values.printTitleColumns !== 'string' || values.printTitleColumns.length > 32 || !validPrintTitle(values.printTitleColumns, 'column') || !orientation || !(zoom === false || Number.isInteger(zoom) && zoom >= 10 && zoom <= 400) || !Number.isInteger(values.fitToPagesWide) || values.fitToPagesWide < 1 || values.fitToPagesWide > 100 || !Number.isInteger(values.fitToPagesTall) || values.fitToPagesTall < 1 || values.fitToPagesTall > 100 || typeof values.centerHorizontally !== 'boolean' || typeof values.centerVertically !== 'boolean' || !['leftMargin', 'rightMargin', 'topMargin', 'bottomMargin', 'headerMargin', 'footerMargin'].every((key) => typeof values[key] === 'number' && Number.isFinite(values[key]) && values[key] >= 0 && values[key] <= 720)) return { supported: false }
    return { supported: true, pageSetup, settings: { sheetName: resolved.resource.sheetName, printArea, printTitleRows: values.printTitleRows, printTitleColumns: values.printTitleColumns, orientation, zoom, fitToPagesWide: values.fitToPagesWide, fitToPagesTall: values.fitToPagesTall, centerHorizontally: values.centerHorizontally, centerVertically: values.centerVertically, leftMargin: values.leftMargin, rightMargin: values.rightMargin, topMargin: values.topMargin, bottomMargin: values.bottomMargin, headerMargin: values.headerMargin, footerMargin: values.footerMargin } }
  }
  async function outlineSnapshot(resolved, target) {
    const method = target.axis === 'row' ? 'getRowOutlineLevel' : 'getColOutlineLevel'; if (typeof resolved.sheet?.[method] !== 'function') return { supported: false }
    const levels = []; for (let index = target.from; index <= target.to; index += 1) { const level = await call(resolved.sheet, method, [index]); if (!Number.isInteger(level) || level < 0 || level > 8) return { supported: false }; levels.push(level) }
    return { supported: true, outline: { sheetName: resolved.resource.sheetName, range: target.range, axis: target.axis, levels } }
  }
  async function rangeSnapshot(sheet, address, options = {}) {
    const bare = splitSheetPrefix(address).range
    const range = await rangeFor(sheet, bare)
    if (!range) return { error: fail('invalid_range', 'WebEdit could not resolve the requested range') }
    let values = await call(range, 'getValue2') ?? await call(range, 'getValue') ?? await property(range, 'Value2') ?? await property(range, 'Value')
    if (values === undefined || values === null) {
      // accr-ui parity: Midea runtimes expose bulk reads through getRangeContents()
      // when the Excel-style value APIs return nothing for the exact range.
      const contents = await call(range, 'getRangeContents')
      const candidate = contents && typeof contents === 'object'
        ? (contents.result && Array.isArray(contents.result.Values) ? contents.result.Values : Array.isArray(contents.Values) ? contents.Values : undefined)
        : undefined
      if (candidate !== undefined) values = candidate
    }
    const formulasSource = await call(range, 'getFormula') ?? await property(range, 'Formula')
    const valuesMatrix = matrix(values)
    const formulasMatrix = formulasSource === undefined || formulasSource === null ? undefined : matrix(formulasSource)
    const text = matrix(await call(range, 'getText') ?? await property(range, 'Text'))
    const parsed = parseAddress(bare)
    const expected = parsed ? `${parsed.rowTo - parsed.rowFrom + 1}x${parsed.colTo - parsed.colFrom + 1}` : 'unbounded'
    const shapeOf = (source) => Array.isArray(source) ? `${source.length}x${source[0] instanceof Array ? source[0].length : '?'}` : `non-matrix (${source === undefined ? 'undefined' : typeof source})`
    if (!matrixMatchesAddress(valuesMatrix, bare)) return { error: fail('readback_mismatch', `WebEdit returned a wrong-sized values matrix for ${bare}: expected ${expected}, observed ${shapeOf(valuesMatrix)}`) }
    let formulas = formulasMatrix
    if (!matrixMatchesAddress(formulas, bare)) {
      if (options.tolerateMissingFormulas !== true) return { error: fail('readback_mismatch', `WebEdit returned a wrong-sized formulas matrix for ${bare}: expected ${expected}, observed ${shapeOf(formulas)}`) }
      formulas = valuesMatrix.map((row) => row.map(() => null))
    }
    const rows = valuesMatrix.map((row, rowIndex) => row.map((cell, columnIndex) => ({ value: cell ?? null, text: valueOf(text, rowIndex, columnIndex) == null ? (cell == null ? '' : String(cell)) : String(valueOf(text, rowIndex, columnIndex)), formula: typeof valueOf(formulas, rowIndex, columnIndex) === 'string' ? valueOf(formulas, rowIndex, columnIndex) : null })))
    return { range, snapshot: { address: bare, values: valuesMatrix, formulas, text, rows } }
  }
  function hasProperty(target, name) { try { return !!target && name in Object(target) } catch { return false } }
  async function validationSnapshot(range) {
    const validation = await property(range, 'Validation')
    if (!validation) return { supported: false, validation: null }
    const type = await property(validation, 'Type')
    if (!Number.isInteger(type) || type < 0 || type > 7) return { supported: false, validation: null }
    if (type === 0) return { supported: true, validation: null }
    const [alertStyle, operator, formula1, formula2, ignoreBlank, showError, errorTitle, errorMessage] = await Promise.all(VALIDATION_PROPERTY_NAMES.map((name) => property(validation, name)))
    if (!Number.isInteger(alertStyle) || !Number.isInteger(operator) || typeof formula1 !== 'string' || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || typeof ignoreBlank !== 'boolean' || typeof showError !== 'boolean' || typeof errorTitle !== 'string' || errorTitle.length > 255 || typeof errorMessage !== 'string' || errorMessage.length > 1024) return { supported: false, validation: null }
    return { supported: true, validation: { type, alertStyle, operator, formula1, formula2, ignoreBlank, showError, errorTitle, errorMessage } }
  }
  function requestedValidation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'validationType', 'alertStyle', 'operator', 'formula1', 'formula2', 'ignoreBlank', 'showError', 'errorTitle', 'errorMessage'].includes(key))) return null
    const type = VALIDATION_TYPES[payload.validationType]; const alertStyle = ALERT_STYLES[payload.alertStyle ?? 'stop']; const operator = VALIDATION_OPERATORS[payload.operator ?? 'between']
    const formula1 = payload.formula1; const formula2 = payload.formula2 ?? ''
    if (!type || !alertStyle || !operator || typeof formula1 !== 'string' || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || ((operator === 1 || operator === 2) && payload.formula2 === undefined) || (payload.ignoreBlank !== undefined && typeof payload.ignoreBlank !== 'boolean') || (payload.showError !== undefined && typeof payload.showError !== 'boolean') || (payload.errorTitle !== undefined && (typeof payload.errorTitle !== 'string' || payload.errorTitle.length > 255)) || (payload.errorMessage !== undefined && (typeof payload.errorMessage !== 'string' || payload.errorMessage.length > 1024))) return null
    return { type, alertStyle, operator, formula1, formula2, ignoreBlank: payload.ignoreBlank ?? true, showError: payload.showError ?? true, errorTitle: payload.errorTitle ?? '', errorMessage: payload.errorMessage ?? '' }
  }
  // A write approval is bound to the smallest readable state that can be
  // affected by the supported operation.  Keep it bounded because this
  // object crosses the page -> extension -> native-host boundary twice.
  async function writePrecondition(range, address, includeValidation = false, includeHyperlinks = false, requireHyperlinkScreenTip = false, includeConditionalFormats = false) {
    const snapshot = await rangeSnapshotFromRange(range, address)
    if (!snapshot) return null
    const font = await property(range, 'Font') ?? {}
    const interior = await property(range, 'Interior') ?? {}
    const validation = includeValidation ? await validationSnapshot(range) : null
    if (includeValidation && !validation.supported) return null
    const hyperlinks = includeHyperlinks ? await hyperlinksSnapshot(range, requireHyperlinkScreenTip) : null
    if (includeHyperlinks && !hyperlinks.supported) return null
    const conditionalFormats = includeConditionalFormats ? await conditionalFormatsSnapshot(range) : null
    if (includeConditionalFormats && !conditionalFormats.supported) return null
    const state = {
      values: snapshot.values,
      formulas: snapshot.formulas,
      merged: await property(range, 'MergeCells') ?? null,
      filter: await filterCondition(range),
      rowHeight: await property(await property(range, 'EntireRow') ?? range, 'RowHeight') ?? null,
      columnWidth: await property(await property(range, 'EntireColumn') ?? range, 'ColumnWidth') ?? null,
      format: {
        bold: await property(font, 'bold') ?? await property(font, 'Bold') ?? null,
        italic: await property(font, 'italic') ?? await property(font, 'Italic') ?? null,
        underline: await property(font, 'underline') ?? await property(font, 'Underline') ?? null,
        size: await property(font, 'size') ?? await property(font, 'Size') ?? null,
        name: await property(font, 'name') ?? await property(font, 'Name') ?? null,
        color: await property(font, 'color') ?? await property(font, 'Color') ?? null,
        fill: await property(interior, 'color') ?? await property(interior, 'Color') ?? null,
        numberFormat: await property(range, 'numberFormat') ?? await property(range, 'NumberFormat') ?? null,
        alignment: await property(range, 'alignment') ?? await property(range, 'HorizontalAlignment') ?? null,
        wrap: await property(range, 'wrap') ?? await property(range, 'WrapText') ?? null,
      },
      ...(includeValidation ? { validation: validation.validation } : {}),
      ...(includeHyperlinks ? { hyperlinks: hyperlinks.items } : {}),
      ...(includeConditionalFormats ? { conditionalFormats: conditionalFormats.items } : {}),
    }
    const precondition = { version: 1, range: address, state }
    return JSON.stringify(precondition).length <= 96_000 ? precondition : null
  }
  function completeDataValidationState(state) {
    const format = state?.format
    return !!state && typeof state === 'object' && typeof state.merged === 'boolean' && !!state.filter && typeof state.filter.operator === 'string' && typeof state.rowHeight === 'number' && Number.isFinite(state.rowHeight) && typeof state.columnWidth === 'number' && Number.isFinite(state.columnWidth)
      && !!format && typeof format === 'object' && ['bold', 'italic', 'underline', 'size', 'name', 'color', 'fill', 'numberFormat', 'alignment', 'wrap'].every((key) => Object.hasOwn(format, key) && format[key] !== null)
  }
  async function borderSnapshot(range, sides) {
    if (!Array.isArray(sides) || sides.length === 0 || sides.length > 8) return null
    const borders = await property(range, 'Borders'); if (!borders) return null
    const snapshot = {}
    for (const side of sides) {
      if (typeof side !== 'string' || !side || side.length > 32) return null
      const border = await property(borders, side) ?? borders[side]
      const color = await property(border, 'Color') ?? await property(border, 'color')
      if (!border || color === undefined || color === null) return null
      snapshot[side] = { color }
    }
    return snapshot
  }
  async function rangeSnapshotFromRange(range, address) {
    if (!range) return null
    const values = matrix(await call(range, 'getValue2') ?? await call(range, 'getValue') ?? await property(range, 'Value2') ?? await property(range, 'Value'))
    const formulas = matrix(await call(range, 'getFormula') ?? await property(range, 'Formula'))
    return matrixMatchesAddress(values, address) && matrixMatchesAddress(formulas, address) ? { address, values, formulas } : null
  }
  function blankMatrix(matrix) { return Array.isArray(matrix) && matrix.every((row) => Array.isArray(row) && row.every(blankCell)) }
  function columnNumber(name) { return name.toUpperCase().split('').reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) }
  function columnName(value) { let output = ''; for (let current = value; current > 0; current = Math.floor((current - 1) / 26)) output = String.fromCharCode(65 + ((current - 1) % 26)) + output; return output }
  function parseAddress(address) {
    const match = typeof address === 'string' && address.match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/i)
    if (!match) return null
    const rowFrom = Number(match[2]); const colFrom = columnNumber(match[1]); const rowTo = Number(match[4] ?? match[2]); const colTo = columnNumber(match[3] ?? match[1])
    return rowFrom > 0 && rowTo >= rowFrom && rowTo <= 1048576 && colFrom > 0 && colTo >= colFrom && colTo <= 16384 ? { rowFrom, rowTo, colFrom, colTo } : null
  }
  function splitSheetPrefix(address) {
    if (typeof address !== 'string') return { sheetName: null, range: address }
    const match = /^\s*(?:'((?:[^']|'')+)'|([^'!:\s]+))!\s*(.+?)\s*$/.exec(address)
    if (!match) return { sheetName: null, range: address.trim() }
    return { sheetName: (match[1] ?? match[2]).replace(/''/g, "'"), range: match[3] }
  }
  function requestedBatchWrite(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['sheetName', 'cells'].includes(key)) || !Array.isArray(payload.cells) || payload.cells.length < 1 || payload.cells.length > 500) return null
    const entries = []; const seen = new Set()
    for (const item of payload.cells) { const parsed = parseAddress(item?.cell); if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).every((key) => ['cell', 'value'].includes(key)) || !parsed || parsed.rowFrom !== parsed.rowTo || parsed.colFrom !== parsed.colTo || seen.has(String(item.cell).toUpperCase()) || !(typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean' || item.value === null)) return null; seen.add(String(item.cell).toUpperCase()); entries.push({ cell: String(item.cell).toUpperCase(), value: item.value, ...parsed }) }
    const rowFrom = Math.min(...entries.map((entry) => entry.rowFrom)); const rowTo = Math.max(...entries.map((entry) => entry.rowTo)); const colFrom = Math.min(...entries.map((entry) => entry.colFrom)); const colTo = Math.max(...entries.map((entry) => entry.colTo)); const count = (rowTo - rowFrom + 1) * (colTo - colFrom + 1)
    if (count !== entries.length || count > 500) return null
    const values = Array.from({ length: rowTo - rowFrom + 1 }, () => Array(colTo - colFrom + 1).fill(null)); for (const entry of entries) values[entry.rowFrom - rowFrom][entry.colFrom - colFrom] = entry.value
    return { range: addressFor({ rowFrom, rowTo, colFrom, colTo }), cells: entries.map(({ cell, value }) => ({ cell, value })), values }
  }
  function directionalFillExpected(values, direction) {
    if (!Array.isArray(values) || values.length === 0 || !values.every((row) => Array.isArray(row) && row.length === values[0].length) || !['down', 'up', 'left', 'right'].includes(direction)) return null
    const expected = values.map((row) => row.slice()); const height = expected.length; const width = expected[0].length
    if ((direction === 'down' || direction === 'up') && height < 2) return null
    if ((direction === 'left' || direction === 'right') && width < 2) return null
    if (direction === 'down') for (let row = 1; row < height; row += 1) expected[row] = expected[0].slice()
    if (direction === 'up') for (let row = 0; row < height - 1; row += 1) expected[row] = expected[height - 1].slice()
    if (direction === 'right') for (const row of expected) for (let column = 1; column < width; column += 1) row[column] = row[0]
    if (direction === 'left') for (const row of expected) for (let column = 0; column < width - 1; column += 1) row[column] = row[width - 1]
    return same(expected, values) ? null : expected
  }
  function matrixMatchesAddress(value, address) {
    const parsed = parseAddress(address)
    const rows = parsed ? parsed.rowTo - parsed.rowFrom + 1 : 0; const columns = parsed ? parsed.colTo - parsed.colFrom + 1 : 0
    return rows > 0 && columns > 0 && Array.isArray(value) && value.length === rows && value.every((row) => Array.isArray(row) && row.length === columns)
  }
  function defaultMoveFormat(format) { return !!format && typeof format === 'object' && Object.entries(MOVE_DEFAULT_FORMATS).every(([key, allowed]) => Object.hasOwn(format, key) && allowed.some((value) => same(value, format[key]))) }
  function defaultMoveState(state) { return state?.merged === false && defaultMoveFormat(state.format) }
  function addressFor(parsed) { return `${columnName(parsed.colFrom)}${parsed.rowFrom}:${columnName(parsed.colTo)}${parsed.rowTo}` }
  function overlap(left, right) { return left.rowFrom <= right.rowTo && left.rowTo >= right.rowFrom && left.colFrom <= right.colTo && left.colTo >= right.colFrom }
  const STRUCTURAL_OPERATIONS = new Set(['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'insert_cells', 'delete_cells'])
  function structuralRequest(operation, payload) {
    if (!STRUCTURAL_OPERATIONS.has(operation) || !payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['sheetName', 'range', 'count', 'shift', 'position'].includes(key))) return null
    const count = payload.count === undefined ? 1 : payload.count
    if (!Number.isInteger(count) || count < 1 || count > 100) return null
    const rowMatch = typeof payload.range === 'string' && /^([1-9]\d{0,6}):([1-9]\d{0,6})$/.exec(payload.range)
    const columnMatch = typeof payload.range === 'string' && /^([A-Z]{1,3}):([A-Z]{1,3})$/i.exec(payload.range)
    const cell = parseAddress(payload.range)
    const rows = operation.includes('_rows'); const columns = operation.includes('_columns'); const inserting = operation.startsWith('insert_')
    if (rows && (!rowMatch || Number(rowMatch[1]) > Number(rowMatch[2]) || Number(rowMatch[2]) > 1048576 || payload.shift !== undefined)) return null
    if (columns && (!columnMatch || columnNumber(columnMatch[1]) > columnNumber(columnMatch[2]) || columnNumber(columnMatch[2]) > 16384 || payload.shift !== undefined)) return null
    if ((rows || columns) && (!inserting && payload.position !== undefined || inserting && payload.position !== undefined && payload.position !== 'before' && payload.position !== 'after')) return null
    if (!rows && !columns && (!cell || (operation === 'insert_cells' && payload.shift !== 'down' && payload.shift !== 'right') || (operation === 'delete_cells' && payload.shift !== 'up' && payload.shift !== 'left') || payload.position !== undefined)) return null
    const target = rows ? { rowFrom: Number(rowMatch[1]), rowTo: Number(rowMatch[2]), colFrom: 1, colTo: 1 } : columns ? { rowFrom: 1, rowTo: 1, colFrom: columnNumber(columnMatch[1]), colTo: columnNumber(columnMatch[2]) } : cell
    const axis = rows || (!columns && payload.shift === 'down') ? 'vertical' : columns || payload.shift === 'right' ? 'horizontal' : (!columns && payload.shift === 'up') ? 'vertical' : 'horizontal'
    const direction = operation === 'insert_cells' ? payload.shift : operation === 'delete_cells' ? payload.shift : rows ? (inserting ? 'down' : 'up') : (inserting ? 'right' : 'left')
    const anchor = { ...target }
    if (inserting && payload.position === 'after') {
      if (axis === 'vertical') anchor.rowFrom = anchor.rowTo + 1
      else anchor.colFrom = anchor.colTo + 1
    }
    const span = (axis === 'vertical' ? target.rowTo - target.rowFrom + 1 : target.colTo - target.colFrom + 1) * count
    if ((axis === 'vertical' && anchor.rowFrom + span - 1 > 1048576) || (axis === 'horizontal' && anchor.colFrom + span - 1 > 16384)) return null
    return { operation, count, target, anchor, axis, direction, inserting, rows, columns, span }
  }
  async function structuralFootprint(resolved, spec, fixedBounds = null) {
    const usedRange = await call(resolved.sheet, 'getUsedRange') ?? await property(resolved.sheet, 'UsedRange') ?? await call(resolved.sheet, 'UsedRange')
    const used = await rangeBounds(usedRange)
    if (!used) return null
    // The moved band plus two cells on either side is enough to prove the
    // requested displacement, including blank inserts before existing data.
    // Keep that evidence bounded before it crosses the extension boundary.
    let bounds = fixedBounds
    if (!bounds) {
      let rowFrom; let rowTo; let colFrom; let colTo
      if (spec.axis === 'vertical') {
        rowFrom = Math.max(1, spec.anchor.rowFrom - 2); rowTo = spec.direction === 'up' ? used.rowTo : Math.min(1048576, spec.anchor.rowTo + spec.span + 2)
        colFrom = spec.rows ? used.colFrom : Math.max(1, spec.target.colFrom - 2); colTo = spec.rows ? used.colTo : Math.min(16384, spec.target.colTo + 2)
      } else {
        rowFrom = spec.columns ? used.rowFrom : Math.max(1, spec.target.rowFrom - 2); rowTo = spec.columns ? used.rowTo : Math.min(1048576, spec.target.rowTo + 2)
        colFrom = Math.max(1, spec.anchor.colFrom - 2); colTo = spec.direction === 'left' ? used.colTo : Math.min(16384, spec.anchor.colTo + spec.span + 2)
      }
      bounds = { rowFrom, rowTo, colFrom, colTo }
    }
    const { rowFrom, rowTo, colFrom, colTo } = bounds
    if (![rowFrom, rowTo, colFrom, colTo].every(Number.isInteger) || rowTo < rowFrom || colTo < colFrom || (rowTo - rowFrom + 1) * (colTo - colFrom + 1) > 20_000) return null
    const address = addressFor(bounds); const snapshot = await rangeSnapshot(resolved.sheet, address)
    if (snapshot.error) return null
    return { address, bounds, usedAddress: used.address, values: snapshot.snapshot.values, formulas: snapshot.snapshot.formulas }
  }
  function structuralExpected(footprint, spec) {
    const values = footprint.values.map((row) => row.slice()); const formulas = footprint.formulas.map((row) => row.slice())
    const r0 = spec.anchor.rowFrom - footprint.bounds.rowFrom; const c0 = spec.anchor.colFrom - footprint.bounds.colFrom
    const targetRows = spec.columns ? values.length : spec.target.rowTo - spec.target.rowFrom + 1
    const targetColumns = spec.rows ? values[0].length : spec.target.colTo - spec.target.colFrom + 1
    const blank = spec.axis === 'vertical' ? (r, c) => { values[r][c] = null; formulas[r][c] = '' } : (r, c) => { values[r][c] = null; formulas[r][c] = '' }
    if (spec.direction === 'down' || spec.direction === 'up') {
      const start = Math.max(0, r0); const end = Math.min(values.length, r0 + spec.span); const columns = Array.from({ length: targetColumns }, (_, index) => spec.rows ? index : c0 + index).filter((index) => index >= 0 && index < values[0].length)
      for (const c of columns) {
        if (spec.direction === 'down') for (let r = values.length - 1; r >= start; r -= 1) { const source = r - spec.span; if (source >= start) { values[r][c] = footprint.values[source][c]; formulas[r][c] = footprint.formulas[source][c] } else blank(r, c) }
        else for (let r = start; r < values.length; r += 1) { const source = r + spec.span; if (source < values.length) { values[r][c] = footprint.values[source][c]; formulas[r][c] = footprint.formulas[source][c] } else blank(r, c) }
      }
      if (end <= start) return null
    } else {
      const start = Math.max(0, c0); const end = Math.min(values[0].length, c0 + spec.span); const rows = Array.from({ length: targetRows }, (_, index) => spec.columns ? index : r0 + index).filter((index) => index >= 0 && index < values.length)
      for (const r of rows) {
        if (spec.direction === 'right') for (let c = values[0].length - 1; c >= start; c -= 1) { const source = c - spec.span; if (source >= start) { values[r][c] = footprint.values[r][source]; formulas[r][c] = footprint.formulas[r][source] } else blank(r, c) }
        else for (let c = start; c < values[0].length; c += 1) { const source = c + spec.span; if (source < values[0].length) { values[r][c] = footprint.values[r][source]; formulas[r][c] = footprint.formulas[r][source] } else blank(r, c) }
      }
      if (end <= start) return null
    }
    return { values, formulas }
  }
  function splitDelimited(value, delimiter, consecutive) {
    if (typeof value !== 'string') return [value]
    const output = []; let current = ''; let quoted = false
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]
      if (character === '"') { if (quoted && value[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted; continue }
      if (!quoted && character === delimiter) { output.push(current); current = ''; if (consecutive) while (value[index + 1] === delimiter) index += 1; continue }
      current += character
    }
    output.push(current); return output
  }
  function hasUnclosedQuote(value) { let quoted = false; for (let index = 0; index < String(value).length; index += 1) { if (value[index] !== '"') continue; if (quoted && value[index + 1] === '"') { index += 1; continue } quoted = !quoted } return quoted }
  function textTokenIsTypeAmbiguous(value) { return typeof value === 'string' && /^(?:[+-]?\d+(?:\.\d+)?|\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4})$/.test(value.trim()) }
  function replacementValue(value, what, replacement, whole, matchCase) {
    if (typeof value !== 'string') return { value, count: 0 }
    if (whole) { const match = matchCase ? value === what : value.toLocaleLowerCase() === what.toLocaleLowerCase(); return { value: match ? replacement : value, count: match ? 1 : 0 } }
    const expression = new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi'); let count = 0
    return { value: value.replace(expression, () => { count += 1; return replacement }), count }
  }
  function duplicateValue(value) { return blankCell(value) ? 'blank:' : typeof value === 'string' ? `string:${value.toLocaleLowerCase()}` : `${typeof value}:${String(value)}` }
  function blankCell(value) { return value === null || value === undefined || value === '' }
  function blankSnapshot(snapshot) {
    return snapshot.values.every((row) => row.every(blankCell)) && snapshot.formulas.every((row) => row.every(blankCell))
  }
  async function collectionCount(collection) {
    const count = Number(await property(collection, 'Count'))
    return Number.isInteger(count) && count >= 0 && count <= 100000 ? count : null
  }
  async function collectionItem(collection, index) { return await call(collection, 'Item', [index]) ?? await call(collection, 'getItemAt', [index - 1]) }
  async function hyperlinkItemSnapshot(item, requireScreenTip = false) {
    const address = await property(item, 'Address') ?? await property(item, 'address'); const subAddress = await property(item, 'SubAddress') ?? await property(item, 'subAddress'); const textToDisplay = await property(item, 'TextToDisplay') ?? await property(item, 'textToDisplay'); const name = await property(item, 'Name') ?? await property(item, 'name'); const type = await property(item, 'Type') ?? await property(item, 'type'); const screenTip = requireScreenTip ? (await property(item, 'ScreenTip') ?? await property(item, 'screenTip')) : undefined
    if (typeof address !== 'string' || typeof subAddress !== 'string' || typeof textToDisplay !== 'string' || typeof name !== 'string' || !(typeof type === 'string' || typeof type === 'number') || (requireScreenTip && typeof screenTip !== 'string')) return null
    return { address, subAddress, textToDisplay, name, type, ...(requireScreenTip ? { screenTip } : {}) }
  }
  async function hyperlinksSnapshot(range, requireScreenTip = false) {
    const collection = await property(range, 'Hyperlinks'); const count = Number(await property(collection, 'Count'))
    if (!collection || !Number.isInteger(count) || count < 0 || count > 200) return { supported: false, items: [], collection: null }
    const items = []
    for (let index = 1; index <= count; index += 1) {
      const item = await collectionItem(collection, index); const snapshot = await hyperlinkItemSnapshot(item, requireScreenTip)
      if (!snapshot) return { supported: false, items: [], collection: null }
      items.push(snapshot)
    }
    return { supported: true, items, collection }
  }
  function canonicalColor(value) {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase()
    if (Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) return `#${value.toString(16).padStart(6, '0').toUpperCase()}`
    return null
  }
  function requestedColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null }
  async function conditionalFormatItemSnapshot(item) {
    const interior = await property(item, 'Interior'); const font = await property(item, 'Font')
    const type = await property(item, 'Type'); const operator = await property(item, 'Operator'); const formula1 = await property(item, 'Formula1'); const formula2 = await property(item, 'Formula2'); const priority = await property(item, 'Priority')
    const fillColor = canonicalColor(await property(interior, 'Color') ?? await property(interior, 'color')); const fontColor = canonicalColor(await property(font, 'Color') ?? await property(font, 'color'))
    const bold = await property(font, 'Bold') ?? await property(font, 'bold'); const italic = await property(font, 'Italic') ?? await property(font, 'italic')
    if (!Number.isInteger(type) || !Number.isInteger(operator) || !Object.values(CONDITIONAL_FORMAT_TYPES).includes(type) || !Object.values(CONDITIONAL_FORMAT_OPERATORS).includes(operator) || typeof formula1 !== 'string' || formula1.length === 0 || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || ((operator === 1 || operator === 2) && formula2.length === 0) || !Number.isInteger(priority) || priority < 1 || priority > 200 || !fillColor || !fontColor || typeof bold !== 'boolean' || typeof italic !== 'boolean') return null
    return { type, operator, formula1, formula2, priority, fillColor, fontColor, bold, italic }
  }
  async function conditionalFormatsSnapshot(range) {
    const collection = await property(range, 'FormatConditions'); const count = Number(await property(collection, 'Count'))
    if (!collection || typeof collection.Item !== 'function' || !Number.isInteger(count) || count < 0 || count > 200) return { supported: false, items: [], collection: null }
    const items = []
    for (let index = 1; index <= count; index += 1) {
      const snapshot = await conditionalFormatItemSnapshot(await collectionItem(collection, index))
      if (!snapshot) return { supported: false, items: [], collection: null }
      items.push(snapshot)
    }
    return { supported: true, items, collection }
  }
  function requestedConditionalFormat(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'conditionType', 'operator', 'formula1', 'formula2', 'fillColor', 'fontColor', 'bold', 'italic'].includes(key))) return null
    const type = CONDITIONAL_FORMAT_TYPES[payload.conditionType]; const operator = CONDITIONAL_FORMAT_OPERATORS[payload.operator ?? 'equal']; const formula1 = payload.formula1; const formula2 = payload.formula2 ?? ''
    if (!type || !operator || typeof formula1 !== 'string' || formula1.length === 0 || formula1.length > 1024 || typeof formula2 !== 'string' || formula2.length > 1024 || ((operator === 1 || operator === 2) && (payload.formula2 === undefined || formula2.length === 0)) || (payload.fillColor !== undefined && !requestedColor(payload.fillColor)) || (payload.fontColor !== undefined && !requestedColor(payload.fontColor)) || (payload.bold !== undefined && typeof payload.bold !== 'boolean') || (payload.italic !== undefined && typeof payload.italic !== 'boolean')) return null
    return { type, operator, formula1, formula2, ...(payload.fillColor === undefined ? {} : { fillColor: requestedColor(payload.fillColor) }), ...(payload.fontColor === undefined ? {} : { fontColor: requestedColor(payload.fontColor) }), ...(payload.bold === undefined ? {} : { bold: payload.bold }), ...(payload.italic === undefined ? {} : { italic: payload.italic }) }
  }
  function isSafeInternalHyperlinkReference(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f\[\]]/.test(value)) return false
    const a1 = "\\$?[A-Z]{1,3}\\$?[1-9][0-9]{0,6}(?::\\$?[A-Z]{1,3}\\$?[1-9][0-9]{0,6})?"
    const sheet = "(?:[A-Za-z_][A-Za-z0-9_.]{0,30}|'(?:[^'\\[\\]\\u0000-\\u001f\\u007f]|''){1,62}')!"
    return new RegExp(`^(?:${sheet})?${a1}$`).test(value) || /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(value)
  }
  function requestedHyperlink(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).every((key) => ['range', 'sheetName', 'url', 'subAddress', 'screenTip', 'textToDisplay'].includes(key))) return null
    const url = payload.url ?? ''; const subAddress = payload.subAddress ?? ''; const screenTip = payload.screenTip; const textToDisplay = payload.textToDisplay
    if (typeof url !== 'string' || url.length > 2048 || typeof subAddress !== 'string' || subAddress.length > 256 || typeof textToDisplay !== 'string' || textToDisplay.length > 500 || (screenTip !== undefined && (typeof screenTip !== 'string' || screenTip.length > 500)) || /[\u0000-\u001f\u007f]/.test(url) || /[\u0000-\u001f\u007f]/.test(subAddress)) return null
    if (subAddress && !isSafeInternalHyperlinkReference(subAddress)) return null
    if (url) {
      try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.href !== url) return null } catch { return null }
    } else if (!isSafeInternalHyperlinkReference(subAddress)) return null
    return { url, subAddress, textToDisplay, ...(screenTip === undefined ? {} : { screenTip }) }
  }
  async function worksheetSnapshot(workbook) {
    const collection = workbook?.Worksheets ?? workbook?.Sheets
    const count = await collectionCount(collection)
    if (!collection || count === null || count > 200) return null
    const names = []; const active = await call(workbook, 'getActiveSheet') ?? await property(workbook, 'ActiveSheet'); const activeName = await call(active, 'getName') ?? await property(active, 'Name')
    for (let index = 1; index <= count; index += 1) {
      const sheet = await collectionItem(collection, index)
      const name = await call(sheet, 'getName') ?? await property(sheet, 'Name')
      if (typeof name !== 'string' || !name) return null
      const visible = await property(sheet, 'Visible') ?? await property(sheet, 'visible')
      names.push({ index, name, visible: typeof visible === 'boolean' ? visible : null, active: typeof activeName === 'string' ? name === activeName : sheet === active ? true : null })
    }
    return { collection, count, sheets: names, names: names.map((sheet) => sheet.name) }
  }
  async function undoRedoSnapshot(resolved) {
    const undo = await call(resolved.app, 'getUndoCount') ?? await property(resolved.app, 'UndoCount')
    const redo = await call(resolved.app, 'getRedoCount') ?? await property(resolved.app, 'RedoCount')
    const history = Number.isInteger(undo) && undo >= 0 && Number.isInteger(redo) && redo >= 0 ? { undo, redo } : null
    const selection = await selectionSnapshot(resolved)
    const usedRange = await call(resolved.sheet, 'getUsedRange') ?? await property(resolved.sheet, 'UsedRange')
    const used = await summarizeLocatedRange(resolved, usedRange, 'UsedRange')
    // Only retain bounded, fully readable observations. They make no claim
    // about which historic edit was applied; history counters are required for
    // a verified undo/redo result.
    return { history, selection: selection.supported ? { address: selection.address, activeCell: selection.activeCell } : null, usedRange: used.supported && used.count <= 2000 ? { address: used.address, values: used.values ?? null, formulas: used.formulas ?? null } : null }
  }
  async function definedNamesSnapshot(workbook) {
    const collection = await property(workbook, 'Names') ?? await call(workbook, 'getNames')
    const count = await collectionCount(collection); if (!collection || count === null || count > 200) return null
    const names = []
    for (let index = 1; index <= count; index += 1) {
      const item = await collectionItem(collection, index); const name = await property(item, 'Name') ?? await property(item, 'name'); const refersTo = await property(item, 'RefersTo') ?? await property(item, 'Value') ?? await property(item, 'value'); const visible = await property(item, 'Visible') ?? await property(item, 'visible'); const scope = await property(item, 'Scope') ?? await property(item, 'scope')
      if (typeof name !== 'string' || !name || typeof refersTo !== 'string') return null
      names.push({ name, refersTo, visible: typeof visible === 'boolean' ? visible : null, scope: typeof scope === 'string' || typeof scope === 'number' ? scope : null })
    }
    return { collection, names }
  }
  async function filterCondition(range) {
    if (!range || typeof range.queryAutoFilterListItems !== 'function') return null
    const callback = await callbackResult((done) => range.queryAutoFilterListItems('auto', null, done))
    if (!callback.callbackInvoked || callback.callbackError) return null
    const condition = callback.args?.[0]?.result?.fieldData?.condition
    if (!condition || typeof condition !== 'object' || typeof condition.operator !== 'string') return null
    return { operator: condition.operator.toLowerCase() }
  }
  function callbackFailure(args) {
    for (const value of args) {
      if (value instanceof Error) return value.message || 'WebEdit callback returned an error'
      if (!value || typeof value !== 'object') continue
      if (value.error instanceof Error) return value.error.message || 'WebEdit callback returned an error'
      if (typeof value.error === 'string' && value.error.length > 0) return value.error
      if (typeof value.err === 'string' && value.err.length > 0) return value.err
      if (typeof value.errorCode === 'string' && value.errorCode.length > 0 && value.errorCode !== '0') return value.errorCode
      if (typeof value.errorCode === 'number' && value.errorCode !== 0) return String(value.errorCode)
      if (value.isOk === false || value.ok === false || value.success === false || value.rejected === true) return typeof value.message === 'string' ? value.message : 'WebEdit callback reported failure'
    }
    const failureText = args.find((value) => typeof value === 'string' && /^(?:error|failed|failure|rejected)\b/i.test(value))
    return typeof failureText === 'string' ? failureText : null
  }
  async function callbackResult(invoke, timeoutMs = 5000) {
    return new Promise((resolveResult) => {
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(value) } }
      const timer = setTimeout(() => finish({ callbackInvoked: false }), timeoutMs)
      try {
        const returned = invoke((...args) => finish({ callbackInvoked: true, args, callbackError: callbackFailure(args) }))
        // A resolved promise can mean only that WebEdit accepted the request.
        // Completion remains callback-only; a rejected promise is fail-closed.
        if (returned && typeof returned.then === 'function') returned.then(undefined, () => finish({ callbackInvoked: false, rejected: true }))
      } catch { finish({ callbackInvoked: false, rejected: true }) }
    })
  }
  async function pivotCollection(sheet) { return await call(sheet, 'getPivotTables') ?? await property(sheet, 'PivotTables') }
  // Shapes can contain pictures, text boxes, and arbitrary drawing objects.  A
  // chart write must never use that mixed collection as its identity fence.
  async function chartCollection(sheet) { return await call(sheet, 'getChartObjects') ?? await property(sheet, 'ChartObjects') ?? await call(sheet, 'getCharts') ?? await property(sheet, 'Charts') }
  async function objectIdentity(value) {
    const id = await call(value, 'getId') ?? await property(value, 'Id') ?? await property(value, 'id')
    const name = await call(value, 'getName') ?? await property(value, 'Name') ?? await property(value, 'name')
    const type = await call(value, 'getType') ?? await property(value, 'Type') ?? await property(value, 'type')
    return { id: id ?? null, name: name ?? null, type: type ?? null }
  }
  async function readableAddress(value) {
    const candidate = await call(value, 'getAddress') ?? await call(value, 'getRangeAddress') ?? await property(value, 'Address') ?? await property(value, 'address') ?? value
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 256) return null
    const normalized = candidate.trim().replace(/^.*!/, '')
    return /^[A-Z]{1,3}\$?\d+(?::[A-Z]{1,3}\$?\d+)?$/i.test(normalized) ? normalized.replace(/\$/g, '').toUpperCase() : null
  }
  async function commentEntries(collection) {
    const count = await collectionCount(collection)
    if (!collection || count === null || count > 1000) return null
    const entries = []
    for (let index = 1; index <= count; index += 1) {
      const item = await collectionItem(collection, index)
      if (!item) return null
      const text = await call(item, 'getText') ?? await call(item, 'getContent') ?? await property(item, 'Text') ?? await property(item, 'Content') ?? await property(item, 'Comment')
      const sourceAddress = await call(item, 'getAddress') ?? await property(item, 'Address') ?? await call(item, 'getRange') ?? await property(item, 'Range')
      const author = await call(item, 'getAuthor') ?? await property(item, 'Author')
      entries.push({ text: typeof text === 'string' ? text : null, address: await readableAddress(sourceAddress), author: typeof author === 'string' ? author : null })
    }
    return entries
  }
  async function pivotDestination(pivot) {
    const destination = await call(pivot, 'getDestination') ?? await call(pivot, 'getDestinationRange') ?? await property(pivot, 'Destination') ?? await property(pivot, 'DestinationRange')
    return readableAddress(destination)
  }
  function hasReadableIdentity(identity) { return identity.id !== null || identity.name !== null }
  function identityMatches(callbackIdentity, collectionIdentity) {
    const comparable = ['id', 'name'].filter((key) => callbackIdentity[key] !== null && collectionIdentity[key] !== null)
    return comparable.length > 0 && comparable.every((key) => callbackIdentity[key] === collectionIdentity[key])
  }
  const PIVOT_ORIENTATION = { row: 'etRowField', column: 'etColumnField', value: 'etDataField', filter: 'etPageField' }
  const PIVOT_SUBTOTAL = { auto: 'SubtotalAuto', none: 'SubtotalNone', sum: 'SubtotalSum', count: 'SubtotalCount', average: 'SubtotalAverage', max: 'SubtotalMax', min: 'SubtotalMin', product: 'SubtotalProduct', countNumbers: 'SubtotalCountN', stdev: 'SubtotalStdev', stdevp: 'SubtotalStdevP', variance: 'SubtotalVar', variancep: 'SubtotalVarP' }
  const PIVOT_FUNCTION = { sum: 'etSum', average: 'etAverage', count: 'etCount', countNumbers: 'etCountNums', max: 'etMax', min: 'etMin', product: 'etProduct', stdev: 'etStDev', stdevp: 'etStDevP', variance: 'etVar', variancep: 'etVarP', distinctCount: 'etDistinctCount' }
  const PIVOT_CALCULATION = { none: 'xlNoAdditionalCalculation', differenceFrom: 'xlDifferenceFrom', percentDifferenceFrom: 'xlPercentDifferenceFrom', percentOf: 'xlPercentOf', percentOfColumn: 'xlPercentOfColumn', percentOfRow: 'xlPercentOfRow', percentOfTotal: 'xlPercentOfTotal', runningTotal: 'xlRunningTotal', percentRunningTotal: 'xlPercentRunningTotal', percentOfParentRow: 'xlPercentOfParentRow', percentOfParentColumn: 'xlPercentOfParentColumn', percentOfParent: 'xlPercentOfParent', rankAscending: 'xlRankAscending', rankDescending: 'xlRankDecending', index: 'xlIndex' }
  async function analyticsCollectionSnapshot(collection, label, max = 500) {
    const count = await collectionCount(collection)
    if (!collection || count === null || count > max) return null
    const items = []
    for (let index = 1; index <= count; index += 1) {
      const item = await collectionItem(collection, index); const identity = await objectIdentity(item)
      if (!item || !hasReadableIdentity(identity)) return null
      items.push({ index, ...identity })
    }
    return { label, count, items }
  }
  function analyticsTarget(payload, kind) {
    const index = payload?.[kind === 'chart' ? 'chartIndex' : 'pivotIndex'] ?? payload?.index
    const id = payload?.[kind === 'chart' ? 'chartId' : 'pivotTableId'] ?? payload?.id
    const name = payload?.[kind === 'chart' ? 'chartName' : 'pivotName'] ?? payload?.name
    const entries = [Number.isInteger(index) && index > 0, id !== undefined && id !== null && String(id).length > 0, typeof name === 'string' && name.trim().length > 0].filter(Boolean).length
    return entries === 1 ? { index: Number.isInteger(index) && index > 0 ? index : null, id: id !== undefined && id !== null ? id : null, name: typeof name === 'string' && name.trim() ? name.trim() : null } : null
  }
  async function analyticsFind(collection, target) {
    const count = await collectionCount(collection)
    if (!target || count === null || count > 500) return null
    if (target.index !== null) return target.index <= count ? await collectionItem(collection, target.index) : null
    for (let index = 1; index <= count; index += 1) {
      const item = await collectionItem(collection, index); const identity = await objectIdentity(item)
      if ((target.id !== null && identity.id !== null && String(target.id) === String(identity.id)) || (target.name !== null && target.name === identity.name)) return item
    }
    return null
  }
  async function chartDetail(chart, required = []) {
    const identity = await objectIdentity(chart)
    if (!chart || !hasReadableIdentity(identity)) return null
    const detail = { ...identity }
    const get = async (keys) => { for (const key of keys) { const value = await call(chart, key) ?? await property(chart, key); if (value !== undefined && value !== null) return value } return undefined }
    if (required.includes('type')) { const value = await get(['getChartType', 'Type', 'ChartType', 'type']); if (value === undefined) return null; detail.type = value }
    if (required.includes('title')) { const value = await get(['getTitle', 'Title', 'title']); if (typeof value !== 'string') return null; detail.title = value }
    if (required.includes('source')) { const value = await get(['getSourceData', 'getDataSource', 'SourceData', 'SourceRange', 'sourceRange']); const source = await readableAddress(value); if (!source) return null; detail.sourceRange = source }
    for (const key of ['width', 'height', 'left', 'top']) if (required.includes(key)) { const cap = key[0].toUpperCase() + key.slice(1); const value = Number(await get([`get${cap}`, cap, key])); if (!Number.isFinite(value) || value < 0) return null; detail[key] = value }
    return detail
  }
  async function pivotFieldCollection(pivot) { return await call(pivot, 'getPivotFields') ?? await call(pivot, 'PivotFields') ?? await property(pivot, 'PivotFields') ?? await call(pivot, 'getFields') ?? await property(pivot, 'Fields') }
  async function pivotFieldDetail(field) {
    const identity = await objectIdentity(field); const name = identity.name
    if (!field || typeof name !== 'string' || !name) return null
    const get = async (keys) => { for (const key of keys) { const value = await call(field, key) ?? await property(field, key); if (value !== undefined && value !== null) return value } return undefined }
    const orientation = await get(['getOrientation', 'Orientation', 'orientation']); const position = await get(['getPosition', 'Position', 'position']); const summaryFunction = await get(['getSummaryFunction', 'SummaryFunction', 'Function', 'summaryFunction']); const calculation = await get(['getCalculation', 'Calculation', 'ShowValuesAs', 'calculation']); const baseField = await get(['getBaseField', 'BaseField', 'baseField']); const baseItem = await get(['getBaseItem', 'BaseItem', 'baseItem']); const autoSortOrder = await get(['getAutoSortOrder', 'AutoSortOrder', 'autoSortOrder']); const subtotals = await get(['getSubtotals', 'Subtotals', 'subtotals'])
    return { ...identity, orientation: orientation ?? null, position: Number.isFinite(Number(position)) ? Number(position) : null, summaryFunction: summaryFunction ?? null, calculation: calculation ?? null, baseField: baseField ?? null, baseItem: baseItem ?? null, autoSortOrder: autoSortOrder ?? null, subtotals: Array.isArray(subtotals) ? subtotals : null }
  }
  async function pivotDetail(pivot, includeFields = false, refresh = false) {
    const identity = await objectIdentity(pivot); if (!pivot || !hasReadableIdentity(identity)) return null
    const detail = { ...identity, destination: await pivotDestination(pivot) }
    if (!detail.destination && includeFields === false) detail.destination = null
    if (refresh) { const updateTime = await call(pivot, 'getUpdateTime') ?? await property(pivot, 'UpdateTime') ?? await property(pivot, 'updateTime'); if (updateTime === undefined || updateTime === null) return null; detail.updateTime = updateTime }
    if (includeFields) {
      const fields = await pivotFieldCollection(pivot); const count = await collectionCount(fields)
      if (!fields || count === null || count > 500) return null
      detail.fields = []
      for (let index = 1; index <= count; index += 1) { const field = await pivotFieldDetail(await collectionItem(fields, index)); if (!field) return null; detail.fields.push({ index, ...field }) }
    }
    return detail
  }
  async function analyticsState(resolved, includeFields = false, refresh = false) {
    const charts = await chartCollection(resolved.sheet); const pivots = await pivotCollection(resolved.sheet)
    const chartSnapshot = await analyticsCollectionSnapshot(charts, 'charts'); const pivotSnapshot = await analyticsCollectionSnapshot(pivots, 'pivots')
    if (!chartSnapshot || !pivotSnapshot) return null
    // ChartObjects/Charts must yield actual chart objects with a stable runtime
    // id and a readable chart type.  A drawing-shape collection cannot satisfy
    // this fence even when it happens to expose a Name.
    chartSnapshot.items = []
    for (let index = 1; index <= chartSnapshot.count; index += 1) { const detail = await chartDetail(await collectionItem(charts, index), ['type']); if (!detail || detail.id === null) return null; chartSnapshot.items.push({ index, ...detail }) }
    if (includeFields || refresh) {
      pivotSnapshot.items = []
      for (let index = 1; index <= pivotSnapshot.count; index += 1) { const detail = await pivotDetail(await collectionItem(pivots, index), includeFields, refresh); if (!detail) return null; pivotSnapshot.items.push({ index, ...detail }) }
    }
    return { charts: chartSnapshot, pivots: pivotSnapshot }
  }
  async function pivotCommand(app, pivot) {
    const factory = await call(app, 'getCoreFactory'); const core = await call(pivot, 'getCorePivotTable')
    return factory && core && typeof factory.createPivotTableCmd === 'function' ? await resolve(factory.createPivotTableCmd(app, core)) : null
  }
  async function callbackMutation(invoke) {
    const result = await callbackResult(invoke)
    return result.callbackInvoked && !result.callbackError ? result : null
  }
  function chartRequired(operation, payload) {
    if (operation === 'set_chart_data_source') return ['source']
    if (operation === 'resize_chart') return ['width', 'height']
    if (operation === 'update_chart') return [...(Object.hasOwn(payload, 'chartType') ? ['type'] : []), ...(Object.hasOwn(payload, 'title') ? ['title'] : []), ...(Object.hasOwn(payload, 'sourceRange') ? ['source'] : []), ...(Object.hasOwn(payload, 'width') ? ['width'] : []), ...(Object.hasOwn(payload, 'height') ? ['height'] : []), ...(Object.hasOwn(payload, 'left') ? ['left'] : []), ...(Object.hasOwn(payload, 'top') ? ['top'] : [])]
    return []
  }
  function pivotFieldExists(detail, payload, orientation) { return Array.isArray(detail?.fields) && detail.fields.some((field) => field.name === payload.fieldName && (orientation === undefined || field.orientation === orientation || String(field.orientation) === String(orientation))) }
  async function analyticsPrecondition(resolved, operation, payload) {
    const chartOperation = ['create_chart', 'update_chart', 'set_chart_data_source', 'resize_chart', 'delete_chart'].includes(operation)
    const pivotOperation = !chartOperation
    const includeFields = ['add_pivot_field', 'remove_pivot_field', 'sort_pivot_field', 'set_pivot_subtotals', 'set_pivot_value_function', 'set_pivot_show_values_as'].includes(operation)
    const refresh = ['refresh_pivot_table', 'refresh_pivot_tables', 'refresh_all_pivot_tables'].includes(operation)
    const state = await analyticsState(resolved, includeFields, refresh); if (!state) return null
    const sourceRange = operation === 'create_chart' || operation === 'create_pivot_table' ? payload.range : (operation === 'set_chart_data_source' || Object.hasOwn(payload, 'sourceRange') ? payload.sourceRange : null)
    let source = null
    if (sourceRange !== null) { if (typeof sourceRange !== 'string' || !parseAddress(sourceRange)) return null; const range = await rangeFor(resolved.sheet, sourceRange); const precondition = await writePrecondition(range, sourceRange); if (!precondition) return null; source = { range: sourceRange, state: precondition.state } }
    let target = null
    if ((chartOperation && operation !== 'create_chart') || (pivotOperation && !['create_pivot_table', 'refresh_pivot_tables', 'refresh_all_pivot_tables'].includes(operation))) {
      target = analyticsTarget(payload, chartOperation ? 'chart' : 'pivot'); if (!target) return null
      const collection = chartOperation ? await chartCollection(resolved.sheet) : await pivotCollection(resolved.sheet); const item = await analyticsFind(collection, target); if (!item) return null
      const detail = chartOperation ? await chartDetail(item, chartRequired(operation, payload)) : await pivotDetail(item, includeFields, refresh)
      if (!detail) return null
      target = { ...target, identity: await objectIdentity(item), detail }
    }
    return { version: 8, analytics: { operation, state, source, target } }
  }
  async function artifactUrl(value) {
    const url = await property(value, 'url')
    if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return null
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return null
      const rawFilename = parsed.pathname.split('/').pop() || ''
      let filename = rawFilename
      try { filename = decodeURIComponent(rawFilename) } catch {}
      return { origin: parsed.origin, filename, expiresAt: Number(parsed.searchParams.get('Expires')) || null, queryRedacted: parsed.search.length > 0 }
    } catch { return null }
  }
  function dataUrlMetadata(dataUrl, maxBytes = MAX_IMAGE_ARTIFACT_BYTES) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i)
    if (!match) return null
    const byteLength = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
    if (byteLength > maxBytes) return { mimeType: match[1], byteLength, tooLarge: true }
    return byteLength <= MAX_INLINE_IMAGE_ARTIFACT_BYTES ? { dataUrl, mimeType: match[1], byteLength, delivery: 'inline' } : { mimeType: match[1], byteLength, delivery: 'metadata_only' }
  }
  async function capabilities(resolved, address) {
    const range = typeof address === 'string' ? await rangeFor(resolved.sheet, address) : null
    if (typeof address === 'string' && !range) return fail('invalid_range', 'WebEdit could not resolve the requested capability range')
    const validation = await property(range, 'Validation')
    const validationState = range ? await validationSnapshot(range) : { supported: false }
    const hyperlinks = await property(range, 'Hyperlinks'); const hyperlinkState = range ? await hyperlinksSnapshot(range) : { supported: false }
    const comments = await property(resolved.sheet, 'Comments')
    const charts = await chartCollection(resolved.sheet)
    const pivots = await pivotCollection(resolved.sheet)
    const chartCount = await collectionCount(charts); const pivotCount = await collectionCount(pivots)
    const chartReadable = !!charts && chartCount !== null && chartCount <= 500
    const pivotReadable = !!pivots && pivotCount !== null && pivotCount <= 500
    const filterState = await property(range, 'AutoFilter') ?? await property(resolved.sheet, 'AutoFilter')
    const workbookSheets = await worksheetSnapshot(resolved.workbook); const workbookNames = await definedNamesSnapshot(resolved.workbook)
    const detected = {
      sort: !!(range && (typeof range.sort === 'function' || typeof range.Sort === 'function')),
      autoFilter: !!(range && (typeof range.setAutoFilter === 'function' || typeof range.SetAutoFilter === 'function') && filterState !== undefined),
      dataValidation: !!(range && validationState.supported && validation && typeof validation.Delete === 'function' && typeof validation.Add === 'function' && VALIDATION_PROPERTY_NAMES.every((name) => hasProperty(validation, name))),
      hyperlinks: !!(range && hyperlinkState.supported && hyperlinks && typeof hyperlinks.Add === 'function' && typeof hyperlinks.Delete === 'function' && typeof hyperlinks.Item === 'function'),
      comments: false,
      charts: chartReadable, pivots: pivotReadable, cellImages: false,
      exportPdf: false,
      exportRangeImage: false,
      exportWorksheetImage: false,
    }
    const detectedButUnsupported = []
    if (range && (typeof range.AddComment === 'function' || typeof range.ClearComments === 'function') && comments && await collectionCount(comments) !== null) detectedButUnsupported.push('comments')
    const unavailable = 'unavailable: no stable public mutation callback plus same-object readback contract'
    // AccrUI exposes these tool names, but they are not evidence that the
    // current WebEdit frame can perform an auditable Harness Verified Write.
    const accruiMigrationMatrix = {
      cellInsertDeleteHidden: { supported: !!(range && (typeof range.Insert === 'function' || typeof range.Delete === 'function')), rowColumnHidden: true, operations: ['insert_cells', 'delete_cells', 'set_rows_hidden', 'set_columns_hidden'], requiresInspectableTarget: true, reason: 'requires bounded target/anchor snapshot and exact post-write footprint readback' },
      fillReplaceTextToColumnsRemoveDuplicates: { supported: false, directionalFill: true, fillStrategy: 'atomic_set_values_formula_free', autoFill: !!(range && typeof range.AutoFill === 'function'), batchWrite: true, replaceRangeText: typeof range?.Replace === 'function', textToColumns: !!(range && typeof range.TextToColumns === 'function' && parseAddress(address)?.colFrom === parseAddress(address)?.colTo), removeDuplicates: typeof range?.RemoveDuplicates === 'function', requiresInspectableTarget: true, reason: 'AutoFill requires source-contained one-axis destinations with blank extension and source-preservation readback' },
      autoFit: { supported: true, operation: 'auto_fit', requiresInspectableTarget: true, reason: 'whole-row/column AutoFit requires per-item size and hidden-state readback' },
      conditionalFormatting: { supported: false, reason: unavailable },
      copyPasteMove: { supported: false, moveRange: typeof range?.Cut === 'function', requiresInspectableTarget: true, reason: 'copy and paste remain unavailable; move_range requires inspected source and destination state' },
      viewFreeze: { supported: false, reason: unavailable },
      definedNames: { supported: !!workbookNames, create: !!(workbookNames && typeof workbookNames.collection.Add === 'function'), delete: !!workbookNames, requiresInspectableTarget: true, reason: 'defined-name writes require a complete bounded name snapshot and exact readback' },
      printSettings: { supported: !!(await printSettingsSnapshot(resolved)).supported, requiresInspectableTarget: true, reason: 'print writes require a complete PageSetup snapshot and exact whole-state readback' },
      worksheetCopyMoveHide: { supported: false, copy: !!(workbookSheets && typeof workbookSheets.collection.copy === 'function'), move: !!(workbookSheets && typeof workbookSheets.collection.move === 'function'), visibility: !!workbookSheets, requiresInspectableTarget: true, reason: 'worksheet writes require a complete bounded sheet-order snapshot and exact readback' },
      undoRedo: { supported: false, reason: unavailable },
      chartManagement: { create: !!(chartReadable && range && typeof resolved.sheet?.addChart === 'function'), list: chartReadable, update: chartReadable, resize: chartReadable, delete: chartReadable, requiresInspectableTarget: true, reason: chartReadable ? 'per-operation inspect additionally requires a chart type, stable id, callback, and exact readback' : unavailable },
      pivotManagement: { create: !!(pivotReadable && range && typeof range.createPivotTable === 'function'), list: pivotReadable, refresh: pivotReadable && !!resolved.workbook && typeof (resolved.workbook.refreshAllPivotTables ?? resolved.workbook.RefreshAllPivotTables) === 'function', fields: pivotReadable, delete: pivotReadable, requiresInspectableTarget: true, reason: pivotReadable ? 'per-operation inspect additionally requires a stable id, callback, and operation-specific readback' : unavailable },
    }
    return { ok: true, result: { status: 'ok', resource: resolved.resource, capabilities: { ...detected, detectedButUnsupported, accruiMigrationMatrix } } }
  }
  async function context() {
    const resolved = await appAndSheet()
    if (resolved.error) return resolved.error
    const { workbook, sheet, resource } = resolved
    const sheetCount = Number(await property(workbook?.Worksheets, 'Count') ?? await property(workbook?.Sheets, 'Count'))
    const selection = await selectionSnapshot(resolved)
    const compact = selection.supported
      ? { supported: true, address: selection.address, rowsCount: selection.rowsCount, columnsCount: selection.columnsCount, singleCell: selection.singleCell, activeCell: selection.activeCell }
      : { supported: false, address: null, activeCell: null }
    return { ok: true, result: { status: 'ok', resource, context: { workbookName: resource.workbookName, activeSheet: resource.sheetName, sheetCount: Number.isInteger(sheetCount) ? sheetCount : null, readOnly: await property(resolved.app, 'ReadOnly') === true || await property(resolved.app, 'readonly') === true, selection: compact } } }
  }
  async function listSheets() {
    const resolved = await appAndSheet(); if (resolved.error) return resolved.error
    const snapshot = await worksheetSnapshot(resolved.workbook); if (!snapshot) return fail('unsupported', 'WebEdit does not expose bounded worksheet enumeration')
    return { ok: true, result: { status: 'ok', resource: resolved.resource, sheets: snapshot.sheets } }
  }
  async function read(request) {
    // Strip an optional 'Sheet name!' prefix so every downstream A1 parser and the
    // exact-range constructor see bare addresses; an explicit sheetName wins.
    const prefix = splitSheetPrefix(request.range)
    if (prefix.sheetName && request.sheetName === undefined) request = { ...request, sheetName: prefix.sheetName }
    if (request.range !== prefix.range) request = { ...request, range: prefix.range }
    if (request.action === 'context') return context()
    if (request.action === 'sheets') return listSheets()
    // Compatibility aliases for the legacy WebEdit spreadsheet profile.  Keep
    // these as structured reads so callers do not need to know the compact
    // Connector action names.
    if (request.action === 'active_sheet') {
      const resolved = await appAndSheet(); if (resolved.error) return resolved.error
      return { ok: true, result: { status: 'ok', resource: resolved.resource, activeSheet: resolved.resource.sheetName } }
    }
    if (request.action === 'workbook_info') {
      const resolved = await appAndSheet(); if (resolved.error) return resolved.error
      const snapshot = await worksheetSnapshot(resolved.workbook)
      if (!snapshot) return fail('unsupported', 'WebEdit does not expose bounded workbook information')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, workbook: { name: resolved.resource.workbookName, sheetCount: snapshot.count, sheets: snapshot.sheets, readOnly: await property(resolved.app, 'ReadOnly') === true || await property(resolved.app, 'readonly') === true } } }
    }
    if (request.action === 'recalculate') {
      return fail('unsupported', 'recalculate is a write-only operation; use inspect_write followed by approved write')
    }
    const resolved = await appAndSheet(request.sheetName); if (resolved.error) return resolved.error
    if (request.action === 'defined_names') {
      const names = await definedNamesSnapshot(resolved.workbook); if (!names) return fail('unsupported', 'WebEdit does not expose bounded defined-name enumeration')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, definedNames: names.names } }
    }
    if (request.action === 'filter_state') {
      const filter = await filterCondition(resolved.sheet)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, filter: filter ? { supported: true, ...filter } : { supported: false } } }
    }
    if (request.action === 'filter_values') {
      if (typeof request.range !== 'string') return fail('invalid_range', 'filter_values requires a bounded range')
      const snapshot = await rangeSnapshot(resolved.sheet, request.range, { tolerateMissingFormulas: true }); if (snapshot.error) return snapshot.error
      const values = []; const seen = new Set(); for (const row of snapshot.snapshot.values) for (const value of row) { const key = JSON.stringify(value); if (!seen.has(key)) { seen.add(key); values.push(value) } }
      const offset = Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0; const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 1000) : 200
      return { ok: true, result: { status: 'ok', resource: resolved.resource, filterValues: { values: values.slice(offset, offset + limit), offset, limit, total: values.length, hasMore: offset + limit < values.length, nextOffset: offset + limit < values.length ? offset + limit : null } } }
    }
    if (request.action === 'debug_runtime' || request.action === 'probe_range_api') {
      const target = request.action === 'probe_range_api' && typeof request.range === 'string' ? await rangeFor(resolved.sheet, request.range) : resolved.sheet
      if (!target) return fail('invalid_range', 'WebEdit could not resolve the probe target')
      const max = Number.isInteger(request.maxMethods) ? Math.min(Math.max(request.maxMethods, 1), 1000) : 200
      const names = Object.keys(target).filter((name) => typeof target[name] === 'function').sort()
      return { ok: true, result: { status: 'ok', resource: resolved.resource, probe: { target: request.action === 'probe_range_api' ? 'range' : 'worksheet', methods: names.slice(0, max), methodCount: names.length, truncated: names.length > max } } }
    }
    if (request.action === 'worksheet_protection' || request.action === 'write_preflight') {
      const target = typeof request.range === 'string' ? await rangeFor(resolved.sheet, request.range) : null
      const readBool = async (object, names) => { for (const name of names) { const value = await property(object, name); if (typeof value === 'boolean') return { value, source: name } } return { value: null, source: null } }
      const state = { readOnly: await readBool(resolved.app, ['ReadOnly', 'readonly']), sheetProtected: await readBool(resolved.sheet, ['ProtectContents', 'ProtectionMode', 'protected']), rangeLocked: await readBool(target, ['Locked', 'locked']), saving: await readBool(resolved.app, ['IsSaving', 'isSaving']), syncing: await readBool(resolved.app, ['isSyncing', 'IsSyncing']), conflict: await readBool(resolved.app, ['hasConflict', 'IsConflict']) }
      const verdict = Object.values(state).some((item) => item.value === true) ? 'blocked' : Object.values(state).some((item) => item.value === false) ? 'allowed' : 'unknown'
      return { ok: true, result: { status: 'ok', resource: resolved.resource, protection: { ...state, verdict } } }
    }
    if (request.action === 'list_charts' || request.action === 'list_pivots') {
      const collection = request.action === 'list_charts' ? await chartCollection(resolved.sheet) : await pivotCollection(resolved.sheet); const count = await collectionCount(collection)
      if (!collection || count === null || count > 10000) return fail('unsupported', `${request.action} collection count is unavailable or unsafe`)
      const offset = Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0; const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 500) : 100; const items = []
      for (let index = offset + 1; index <= Math.min(count, offset + limit); index += 1) items.push({ index, ...(await objectIdentity(await collectionItem(collection, index))) })
      return { ok: true, result: { status: 'ok', resource: resolved.resource, [request.action === 'list_charts' ? 'charts' : 'pivots']: { offset, limit, total: count, items, hasMore: offset + items.length < count, nextOffset: offset + items.length < count ? offset + items.length : null } } }
    }
    if (request.action === 'chart' || request.action === 'inspect_chart' || request.action === 'pivot' || request.action === 'inspect_pivot') {
      const isChart = request.action === 'chart' || request.action === 'inspect_chart'; const collection = isChart ? await chartCollection(resolved.sheet) : await pivotCollection(resolved.sheet); const count = await collectionCount(collection)
      if (!collection || count === null || count > 10000) return fail('unsupported', 'analytics collection count is unavailable or unsafe')
      const item = Number.isInteger(request.index) ? await collectionItem(collection, request.index) : null; if (!item) return fail('invalid_range', 'analytics object index was not found')
      const detail = isChart ? await chartDetail(item, ['type']) : await pivotDetail(item, true, false); if (!detail) return fail('unsupported', 'analytics object detail is unreadable')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, [isChart ? 'chart' : 'pivot']: { ...detail, index: request.index, dataReady: true } } }
    }
    if (request.action === 'list_pivot_fields' || request.action === 'pivot_field_items') {
      const pivots = await pivotCollection(resolved.sheet); const pivot = await analyticsFind(pivots, analyticsTarget(request, 'pivot') ?? (Number.isInteger(request.index) ? { index: request.index, id: null, name: null } : null))
      if (!pivot) return fail('invalid_range', 'pivot field reads require an exact pivot identity')
      const fields = await pivotFieldCollection(pivot); const count = await collectionCount(fields)
      if (!fields || count === null || count > 500) return fail('unsupported', 'pivot field collection count is unavailable or unsafe')
      const offset = Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0; const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 500) : 100; const items = []
      for (let index = offset + 1; index <= Math.min(count, offset + limit); index += 1) { const detail = await pivotFieldDetail(await collectionItem(fields, index)); if (!detail) return fail('unsupported', 'pivot field identity is unreadable'); items.push({ index, ...detail }) }
      if (request.action === 'pivot_field_items') {
        const fieldName = typeof request.fieldName === 'string' ? request.fieldName : null; let field = null; let raw = null
        if (fieldName) for (let index = 1; index <= count; index += 1) { const candidate = await collectionItem(fields, index); const detail = await pivotFieldDetail(candidate); if (!detail) return fail('unsupported', 'pivot field identity is unreadable'); if (detail.name === fieldName) { field = { index, ...detail }; raw = candidate; break } }
        if (!field || !raw) return fail('invalid_range', 'pivot_field_items requires an exact fieldName')
        const itemCollection = await call(raw, 'getItems') ?? await property(raw, 'Items'); const itemCount = await collectionCount(itemCollection)
        if (!itemCollection || itemCount === null || itemCount > 500) return fail('unsupported', 'pivot field-item collection is unavailable or unsafe')
        const fieldOffset = Number.isInteger(request.itemOffset) && request.itemOffset >= 0 ? request.itemOffset : 0; const fieldLimit = Number.isInteger(request.itemLimit) ? Math.min(Math.max(request.itemLimit, 1), 500) : 100; const fieldItems = []
        for (let index = fieldOffset + 1; index <= Math.min(itemCount, fieldOffset + fieldLimit); index += 1) { const item = await collectionItem(itemCollection, index); const name = await call(item, 'getName') ?? await property(item, 'Name') ?? await property(item, 'name'); if (typeof name !== 'string') return fail('unsupported', 'pivot field item is unreadable'); fieldItems.push({ index, name }) }
        return { ok: true, result: { status: 'ok', resource: resolved.resource, pivotFieldItems: { pivot: await objectIdentity(pivot), fieldName, offset: fieldOffset, limit: fieldLimit, total: itemCount, items: fieldItems, hasMore: fieldOffset + fieldItems.length < itemCount, nextOffset: fieldOffset + fieldItems.length < itemCount ? fieldOffset + fieldItems.length : null } } }
      }
      return { ok: true, result: { status: 'ok', resource: resolved.resource, pivotFields: { pivot: await objectIdentity(pivot), offset, limit, total: count, items, hasMore: offset + items.length < count, nextOffset: offset + items.length < count ? offset + items.length : null } } }
    }
    if (request.action === 'capabilities') return capabilities(resolved, request.range)
    if (request.action === 'view') {
      const snapshot = await viewSnapshot(resolved)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, view: snapshot.supported ? { supported: true, ...snapshot.view } : { supported: false, ...(snapshot.view ? { activeCell: snapshot.view.activeCell } : {}) } } }
    }
    if (request.action === 'selection') {
      return { ok: true, result: { status: 'ok', resource: resolved.resource, selection: await selectionSnapshot(resolved) } }
    }
    if (request.action === 'used_range') {
      const used = await call(resolved.sheet, 'getUsedRange') ?? await property(resolved.sheet, 'UsedRange') ?? await call(resolved.sheet, 'UsedRange')
      const summary = await summarizeLocatedRange(resolved, used, 'UsedRange')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, usedRange: summary.supported ? summary : { supported: false, reason: 'used_range_api_not_detected', address: null } } }
    }
    if (request.action === 'print_settings') {
      const snapshot = await printSettingsSnapshot(resolved)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, printSettings: snapshot.supported ? { supported: true, ...snapshot.settings } : { supported: false } } }
    }
    if (request.action === 'outline') {
      const target = parseOutlineRange(request.range, request.axis)
      if (!target) return fail('invalid_range', 'outline requires a bounded whole-row or whole-column range with matching axis')
      const snapshot = await outlineSnapshot(resolved, { ...target, axis: request.axis })
      return { ok: true, result: { status: 'ok', resource: resolved.resource, outline: snapshot.supported ? { supported: true, ...snapshot.outline } : { supported: false } } }
    }
    if (request.action === 'special_cells') return specialCells(resolved, request)
    if (request.action === 'dimensions') {
      const target = parseOutlineRange(request.range, request.axis)
      if (!target) return fail('invalid_range', 'dimensions requires a bounded whole-row or whole-column range with matching axis')
      const snapshot = await dimensionSnapshot(resolved, { ...target, axis: request.axis })
      return { ok: true, result: { status: 'ok', resource: resolved.resource, dimensions: snapshot.supported ? { supported: true, ...snapshot.dimensions } : { supported: false } } }
    }
    if (request.action === 'range_features') {
      if (typeof request.range !== 'string' || request.range.length === 0 || request.range.length > 128) return fail('invalid_range', 'range is required and bounded')
      const range = await rangeFor(resolved.sheet, request.range); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
      const validation = await validationSnapshot(range); const hyperlinks = await hyperlinksSnapshot(range); const conditionalFormats = await conditionalFormatsSnapshot(range)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, rangeFeatures: { range: request.range, supported: validation.supported && hyperlinks.supported, validation: validation.validation, hyperlinks: hyperlinks.supported ? hyperlinks.items : null, hyperlinksSupported: hyperlinks.supported, conditionalFormats: conditionalFormats.supported ? conditionalFormats.items : null, conditionalFormatsSupported: conditionalFormats.supported } } }
    }
    if (request.action === 'range') {
      if (typeof request.range !== 'string' || request.range.length > 128) return fail('invalid_range', 'range is required and bounded')
      const read = await rangeSnapshot(resolved.sheet, request.range, { tolerateMissingFormulas: true }); if (read.error) return read.error
      return { ok: true, result: { status: 'ok', resource: resolved.resource, range: read.snapshot } }
    }
    if (request.action === 'search') {
      if (typeof request.query !== 'string' || !request.query.trim() || typeof request.range !== 'string') return fail('invalid_range', 'query and bounded range are required')
      const read = await rangeSnapshot(resolved.sheet, request.range, { tolerateMissingFormulas: true }); if (read.error) return read.error
      const query = request.matchCase ? request.query : request.query.toLowerCase(); const field = request.searchBy === 'formula' ? 'formulas' : request.searchBy === 'text' ? 'text' : 'values'
      const matches = []
      read.snapshot[field].forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        const candidate = cell == null ? '' : String(cell); const comparable = request.matchCase ? candidate : candidate.toLowerCase()
        if (request.matchEntireCell ? comparable === query : comparable.includes(query)) {
          const bounds = parseAddress(request.range)
          const row = bounds.rowFrom + rowIndex; const column = bounds.colFrom + columnIndex
          matches.push({ row, column, address: `${columnName(column)}${row}`, value: candidate })
        }
      }))
      const offset = Number.isInteger(request.offset) && request.offset >= 0 ? request.offset : 0; const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 200) : 100
      return { ok: true, result: { status: 'ok', resource: resolved.resource, search: { range: request.range, query: request.query, total: matches.length, matches: matches.slice(offset, offset + limit), offset, limit, hasMore: offset + limit < matches.length } } }
    }
    return fail('unsupported', 'unsupported spreadsheet read action')
  }
  async function writable(resolved, request) {
    if (await property(resolved.app, 'ReadOnly') === true || await property(resolved.app, 'readonly') === true) return fail('readonly', 'WebEdit reports this spreadsheet as read-only')
    if (!request.resource || request.resource.fingerprint !== resolved.resource.fingerprint || request.resource.sheetName !== resolved.resource.sheetName) return fail('fingerprint_mismatch', 'The WebEdit workbook or sheet changed since inspection')
    return null
  }
  async function inspectWrite(request) {
    const payload = request.payload ?? {}; const operation = request.operation
    if (ANALYTICS_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const precondition = await analyticsPrecondition(resolved, operation, payload)
      if (!precondition) return fail('unsupported', 'WebEdit cannot create the complete bounded analytics identity, source, and operation-state precondition required for this write')
      if (JSON.stringify(precondition).length > 96_000) return fail('unsupported', 'WebEdit analytics precondition exceeds its safe bound')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } }
    }
    if (['export_pdf', 'export_worksheet_image'].includes(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets) return fail('unsupported', 'export requires a bounded workbook snapshot')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 3, sheets: sheets.sheets } } }
    }
    if (operation === 'undo' || operation === 'redo') {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets) return fail('unsupported', `${operation} requires a bounded workbook snapshot`)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 10, sheets: sheets.sheets, undoRedo: await undoRedoSnapshot(resolved) } } }
    }
    if (operation === 'recalculate') {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sheets = await worksheetSnapshot(resolved.workbook); const method = resolved.workbook && (typeof resolved.workbook.Recalculate === 'function' ? 'Recalculate' : typeof resolved.workbook.recalculate === 'function' ? 'recalculate' : null)
      const before = await property(resolved.workbook, 'recalculateTime') ?? await property(resolved.workbook, 'RecalculateTime')
      if (!sheets || !method) return fail('unsupported', 'WebEdit does not expose Workbook.Recalculate with a bounded workbook precondition')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 11, sheets: sheets.sheets, recalculateTime: before ?? null } } }
    }
    if (['copy_range', 'paste_special'].includes(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sourceAddress = payload.sourceRange; const destinationAddress = payload.destinationRange
      const source = typeof sourceAddress === 'string' && await rangeFor(resolved.sheet, sourceAddress); const destination = typeof destinationAddress === 'string' && await rangeFor(resolved.sheet, destinationAddress)
      const sourceState = source && await writePrecondition(source, sourceAddress); const destinationState = destination && await writePrecondition(destination, destinationAddress)
      if (!sourceState || !destinationState) return fail('unsupported', `${operation} requires readable source and destination ranges`)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 2, targets: [{ range: sourceAddress, state: sourceState.state }, { range: destinationAddress, state: destinationState.state }] } } }
    }
    if (SHEET_LIFECYCLE_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const before = await worksheetSnapshot(resolved.workbook)
      if (!before) return fail('unsupported', 'WebEdit cannot create a bounded worksheet precondition')
      if (operation === 'sheet_add' && typeof before.collection.Add !== 'function' && typeof before.collection.add !== 'function') return fail('unsupported', 'WebEdit does not expose worksheet creation')
      if (operation === 'copy_worksheet' && typeof before.collection.copy !== 'function') return fail('unsupported', 'WebEdit does not expose worksheet copy')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 3, sheets: before.sheets } } }
    }
    if (operation === 'auto_fill') {
      const sourceAddress = typeof payload.range === 'string' ? payload.range : ''
      const destinationAddress = typeof payload.destination === 'string' ? payload.destination : ''
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const source = await rangeFor(resolved.sheet, sourceAddress); const destination = await rangeFor(resolved.sheet, destinationAddress)
      const sourceState = source && await writePrecondition(source, sourceAddress); const destinationState = destination && await writePrecondition(destination, destinationAddress)
      if (!sourceState || !destinationState || !parseAddress(sourceAddress) || !parseAddress(destinationAddress)) return fail('unsupported', 'auto_fill requires readable source and destination ranges')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 2, targets: [{ range: sourceAddress, state: sourceState.state }, { range: destinationAddress, state: destinationState.state }] } } }
    }
    if (PRINT_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const requested = requestedPrintOperation(payload); const before = await printSettingsSnapshot(resolved)
      if (!requested) return fail('invalid_range', 'print settings require a nonempty whitelisted payload without zoom/fit conflict')
      if (!before.supported) return fail('unsupported', 'WebEdit does not expose a complete readable PageSetup')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 5, printSettings: before.settings } } }
    }
    if (OUTLINE_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const target = requestedOutlineOperation(payload); if (!target) return fail('invalid_range', 'outline requires a bounded whole-row or whole-column range, axis, and grouped flag')
      const snapshot = await outlineSnapshot(resolved, target); const range = await rangeFor(resolved.sheet, target.range); const member = range && (await property(range, target.axis === 'row' ? 'Rows' : 'Columns'))
      if (!snapshot.supported || !member || typeof member[target.grouped ? 'Group' : 'Ungroup'] !== 'function') return fail('unsupported', 'WebEdit cannot fully inspect and mutate this outline target')
      if (snapshot.outline.levels.some((level) => target.grouped ? level >= 8 : level <= 0)) return fail('invalid_range', 'outline target is already at its bounded group or ungroup limit')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 6, outline: snapshot.outline } } }
    }
    if (DIMENSION_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const target = requestedDimensionOperation(operation, payload)
      if (!target) return fail('invalid_range', 'dimension write requires a bounded whole-row or whole-column range and matching operation axis')
      const snapshot = await dimensionSnapshot(resolved, target)
      const range = await rangeFor(resolved.sheet, target.range); const member = range && await property(range, target.axis === 'row' ? 'Rows' : 'Columns')
      if (!snapshot.supported || !member) return fail('unsupported', 'WebEdit cannot read every target dimension before mutation')
      if (operation === 'auto_fit' ? typeof member.AutoFit !== 'function' : !('Hidden' in Object(member))) return fail('unsupported', 'WebEdit does not expose a complete readable dimension mutation API')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 7, dimensions: snapshot.dimensions } } }
    }
    if (VIEW_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const requested = requestedViewOperation(operation, payload); const before = await viewSnapshot(resolved)
      if (!requested) return fail('invalid_range', 'view write requires a bounded zoom or freeze target')
      if (!before.supported) return fail('unsupported', 'WebEdit does not expose a complete readable worksheet view')
      if (operation === 'set_freeze_panes' && requested.freeze) { const target = await rangeFor(resolved.sheet, requested.target); if (!target || typeof target.Select !== 'function') return fail('unsupported', 'WebEdit does not expose a selectable freeze target') }
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition: { version: 4, view: before.view } } }
    }
    if (WORKBOOK_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets) return fail('unsupported', 'WebEdit cannot create a bounded worksheet precondition')
      const names = ['create_defined_name', 'delete_defined_name'].includes(operation) ? await definedNamesSnapshot(resolved.workbook) : null
      if (['create_defined_name', 'delete_defined_name'].includes(operation) && !names) return fail('unsupported', 'WebEdit cannot create a bounded defined-name precondition')
      const precondition = { version: 3, sheets: sheets.sheets, ...(names ? { definedNames: names.names } : {}) }
      return JSON.stringify(precondition).length <= 96_000 ? { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } } : fail('unsupported', 'WebEdit workbook precondition exceeds its safe bound')
    }
    if (operation === 'batch_write') {
      const batch = requestedBatchWrite(payload); const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      if (!batch) return fail('invalid_range', 'batch_write requires a non-overlapping complete rectangle of 1 to 500 scalar cells')
      const range = await rangeFor(resolved.sheet, batch.range); const precondition = await writePrecondition(range, batch.range)
      if (!precondition || precondition.state.formulas.some((row) => row.some((formula) => !blankCell(formula)))) return fail('unsupported', 'batch_write requires a complete formula-free target snapshot for atomic exact readback')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } }
    }
    if (STRUCTURAL_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const spec = structuralRequest(operation, payload); if (!spec) return fail('invalid_range', 'structural write requires a bounded matching range, count, position, and shift')
      const targetAddress = spec.rows ? `${spec.target.rowFrom}:${spec.target.rowTo}` : spec.columns ? `${columnName(spec.target.colFrom)}:${columnName(spec.target.colTo)}` : payload.range
      const targetRange = await rangeFor(resolved.sheet, targetAddress); const member = spec.rows ? await property(targetRange, 'EntireRow') : spec.columns ? await property(targetRange, 'EntireColumn') : targetRange
      const method = spec.inserting ? (typeof member?.Insert === 'function' ? 'Insert' : typeof member?.insert === 'function' ? 'insert' : null) : (typeof member?.Delete === 'function' ? 'Delete' : typeof member?.delete === 'function' ? 'delete' : null)
      const footprint = await structuralFootprint(resolved, spec)
      if (!member || !method || !footprint || !structuralExpected(footprint, spec)) return fail('unsupported', 'WebEdit cannot create the bounded anchor footprint required for this structural write')
      const precondition = { version: 9, structure: { operation, spec: { count: spec.count, axis: spec.axis, direction: spec.direction, rows: spec.rows, columns: spec.columns, span: spec.span, target: spec.target, anchor: spec.anchor }, footprint } }
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } }
    }
    const address = payload.range
    if (typeof address !== 'string' || !address || address.length > 128) return fail('invalid_range', 'payload.range is required and bounded')
    const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    if (operation === 'set_data_validation' && !requestedValidation(payload)) return fail('invalid_range', 'set_data_validation requires a complete bounded validation schema')
    if (operation === 'clear_data_validation' && !Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))) return fail('invalid_range', 'clear_data_validation accepts only a bounded range')
    if (operation === 'add_hyperlink' && !requestedHyperlink(payload)) return fail('invalid_range', 'add_hyperlink requires a safe bounded URL or internal reference and exact display text')
    if (operation === 'delete_hyperlinks' && !Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))) return fail('invalid_range', 'delete_hyperlinks accepts only a bounded range')
    if (operation === 'add_conditional_format' && !requestedConditionalFormat(payload)) return fail('invalid_range', 'add_conditional_format requires a complete bounded condition and readable style')
    if (operation === 'clear_conditional_formats' && !Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))) return fail('invalid_range', 'clear_conditional_formats accepts only a bounded range')
    if (!['replace_range_text', 'text_to_columns', 'remove_duplicates', 'move_range'].includes(operation)) {
      const requestedBorderSides = operation === 'format' && payload.border && typeof payload.border === 'object' && !Array.isArray(payload.border) ? Object.keys(payload.border) : operation === 'apply_table_style' && payload.withBorder !== false ? ['EdgeTop', 'EdgeBottom', 'EdgeLeft', 'EdgeRight'] : []
      const borders = requestedBorderSides.length ? await borderSnapshot(range, requestedBorderSides) : null
      if (requestedBorderSides.length && !borders) return fail('unsupported', 'WebEdit cannot read every requested border before mutation')
      const requiresValidation = ['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks'].includes(operation); const requiresHyperlinks = ['add_hyperlink', 'delete_hyperlinks'].includes(operation)
      const requiresConditionalFormats = ['add_conditional_format', 'clear_conditional_formats'].includes(operation)
      const precondition = await writePrecondition(range, address, requiresValidation, requiresHyperlinks, operation === 'add_hyperlink' && payload.screenTip !== undefined, requiresConditionalFormats)
      if (!precondition) return fail('unsupported', 'WebEdit cannot create a bounded writable-range precondition')
      if (['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_conditional_format', 'clear_conditional_formats'].includes(operation) && !completeDataValidationState(precondition.state)) return fail('unsupported', 'WebEdit cannot fully read all non-target range state before this feature write')
      if (operation === 'add_hyperlink' && payload.screenTip !== undefined && precondition.state.hyperlinks.length === 0) return fail('unsupported', 'WebEdit cannot prove ScreenTip readback before the first hyperlink mutation')
      if (borders) precondition.borders = borders
      return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } }
    }
    const parsed = parseAddress(address); const snapshot = await rangeSnapshot(resolved.sheet, address)
    if (!parsed || snapshot.error) return fail('unsupported', 'WebEdit operation requires a simple readable A1 range')
    let targets = [address]
    if (operation === 'replace_range_text' && typeof range.Replace !== 'function') return fail('unsupported', 'WebEdit does not expose Range.Replace')
    if (operation === 'remove_duplicates' && typeof range.RemoveDuplicates !== 'function') return fail('unsupported', 'WebEdit does not expose Range.RemoveDuplicates')
    if (operation === 'text_to_columns') {
      if (typeof range.TextToColumns !== 'function' || parsed.colFrom !== parsed.colTo) return fail('unsupported', 'WebEdit does not expose a readable single-column TextToColumns API')
      const delimiter = ({ comma: ',', tab: '\t', semicolon: ';', space: ' ', other: payload.otherDelimiter })[payload.delimiter ?? 'comma']
      if (typeof delimiter !== 'string' || delimiter.length !== 1) return fail('invalid_range', 'text_to_columns requires a supported one-character delimiter')
      const width = snapshot.snapshot.values.reduce((maximum, row) => Math.max(maximum, splitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true).length), 1)
      if (width > 50 || snapshot.snapshot.values.length * width > 20_000 || snapshot.snapshot.formulas.some((row) => row.some((formula) => !blankCell(formula))) || snapshot.snapshot.values.some((row) => hasUnclosedQuote(row[0]) || splitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true).some(textTokenIsTypeAmbiguous))) return fail('unsupported', 'text_to_columns formulas, unclosed quotes, or type-ambiguous tokens lack a safe exact readback contract')
      const output = { ...parsed, colTo: parsed.colFrom + width - 1 }; const outputAddress = addressFor(output)
      const outputRange = await rangeFor(resolved.sheet, outputAddress); if (!outputRange) return fail('unsupported', 'WebEdit cannot read the complete text_to_columns output footprint')
      const outputSnapshot = await rangeSnapshot(resolved.sheet, outputAddress); if (outputSnapshot.error) return outputSnapshot.error
      for (let row = 0; row < outputSnapshot.snapshot.values.length; row += 1) for (let column = 0; column < outputSnapshot.snapshot.values[row].length; column += 1) if (column > 0 && (!blankCell(outputSnapshot.snapshot.values[row][column]) || !blankCell(outputSnapshot.snapshot.formulas[row][column])) && payload.overwrite !== true) return fail('invalid_range', 'text_to_columns destination contains nonblank cells outside the source')
      targets = [address, outputAddress]
    }
    if (operation === 'move_range') {
      if (typeof range.Cut !== 'function' || typeof payload.destination !== 'string') return fail('unsupported', 'WebEdit does not expose a bounded Range.Cut destination API')
      const requested = parseAddress(payload.destination); if (!requested) return fail('invalid_range', 'move_range destination must be a simple A1 range')
      const rows = parsed.rowTo - parsed.rowFrom + 1; const columns = parsed.colTo - parsed.colFrom + 1
      if (!((requested.rowTo === requested.rowFrom && requested.colTo === requested.colFrom) || (requested.rowTo - requested.rowFrom + 1 === rows && requested.colTo - requested.colFrom + 1 === columns))) return fail('invalid_range', 'move_range destination must be one cell or match source dimensions')
      const output = { rowFrom: requested.rowFrom, colFrom: requested.colFrom, rowTo: requested.rowFrom + rows - 1, colTo: requested.colFrom + columns - 1 }
      if (overlap(parsed, output)) return fail('invalid_range', 'move_range source and destination must not overlap')
      const outputAddress = addressFor(output); const destination = await rangeFor(resolved.sheet, outputAddress); if (!destination) return fail('unsupported', 'WebEdit cannot read the complete move destination')
      const destinationSnapshot = await rangeSnapshot(resolved.sheet, outputAddress); if (destinationSnapshot.error) return destinationSnapshot.error
      if ((!blankMatrix(destinationSnapshot.snapshot.values) || !blankMatrix(destinationSnapshot.snapshot.formulas)) && payload.overwrite !== true) return fail('invalid_range', 'move_range destination must be blank unless overwrite is explicit')
      const sourceCondition = await writePrecondition(range, address); const destinationCondition = await writePrecondition(destination, outputAddress)
      if (!sourceCondition || !destinationCondition || !defaultMoveState(sourceCondition.state) || !defaultMoveState(destinationCondition.state)) return fail('unsupported', 'move_range requires explicitly readable unmerged default formatting before mutation')
      targets = [address, outputAddress]
    }
    const conditions = []
    for (const target of [...new Set(targets)]) { const targetRange = await rangeFor(resolved.sheet, target); const condition = await writePrecondition(targetRange, target); if (!condition) return fail('unsupported', 'WebEdit cannot create a bounded multi-range write precondition'); conditions.push({ range: target, state: condition.state }) }
    const precondition = { version: 2, targets: conditions }
    if (JSON.stringify(precondition).length > 96_000) return fail('unsupported', 'WebEdit multi-range precondition exceeds its safe bound')
    return { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } }
  }
  async function preconditionMatches(resolved, request) {
    const approved = request.precondition
    if (approved?.version === 9 && approved.structure) {
      const spec = structuralRequest(request.operation, request.payload ?? {})
      const saved = approved.structure.spec
      if (!spec || approved.structure.operation !== request.operation || !saved || !same({ count: spec.count, axis: spec.axis, direction: spec.direction, rows: spec.rows, columns: spec.columns, span: spec.span, target: spec.target, anchor: spec.anchor }, saved)) return fail('fingerprint_mismatch', 'The structural operation differs from its inspected footprint')
      const current = await structuralFootprint(resolved, spec)
      return current && same(current, approved.structure.footprint) ? null : fail('fingerprint_mismatch', 'The bounded structural anchor footprint or used-range identity changed since inspection')
    }
    if (approved?.version === 8 && approved.analytics) {
      if (!ANALYTICS_OPERATIONS.has(request.operation) || approved.analytics.operation !== request.operation) return fail('fingerprint_mismatch', 'The analytics operation differs from its inspected precondition')
      const current = await analyticsPrecondition(resolved, request.operation, request.payload ?? {})
      if (!current || !same(current.analytics, approved.analytics)) return fail('fingerprint_mismatch', 'The chart, pivot collection, target identity, field state, or source range changed since inspection; reread and inspect before writing')
      return null
    }
    if (approved?.version === 4 && approved.view) { const current = await viewSnapshot(resolved); return current.supported && same(current.view, approved.view) ? null : fail('fingerprint_mismatch', 'The worksheet view changed since inspection; reread and inspect before writing') }
    if (approved?.version === 5 && approved.printSettings) { const current = await printSettingsSnapshot(resolved); return current.supported && same(current.settings, approved.printSettings) ? null : fail('fingerprint_mismatch', 'The print settings changed since inspection; reread and inspect before writing') }
    if (approved?.version === 6 && approved.outline) { const target = parseOutlineRange(approved.outline.range, approved.outline.axis); const current = target && await outlineSnapshot(resolved, { ...target, axis: approved.outline.axis }); return current?.supported && same(current.outline, approved.outline) ? null : fail('fingerprint_mismatch', 'The outline levels changed since inspection; reread and inspect before writing') }
    if (approved?.version === 7 && approved.dimensions) { const target = parseOutlineRange(approved.dimensions.range, approved.dimensions.axis); const current = target && await dimensionSnapshot(resolved, { ...target, axis: approved.dimensions.axis }); return current?.supported && same(current.dimensions, approved.dimensions) ? null : fail('fingerprint_mismatch', 'The row or column dimensions changed since inspection; reread and inspect before writing') }
    if (approved?.version === 10 && Array.isArray(approved.sheets) && approved.undoRedo) {
      const sheets = await worksheetSnapshot(resolved.workbook); const state = await undoRedoSnapshot(resolved)
      return sheets && same(sheets.sheets, approved.sheets) && same(state, approved.undoRedo) ? null : fail('fingerprint_mismatch', 'The workbook, selection, used-range, or undo/redo history changed since inspection')
    }
    if (approved?.version === 11 && Array.isArray(approved.sheets)) {
      const sheets = await worksheetSnapshot(resolved.workbook); const current = await property(resolved.workbook, 'recalculateTime') ?? await property(resolved.workbook, 'RecalculateTime') ?? null
      return sheets && same(sheets.sheets, approved.sheets) && same(current, approved.recalculateTime) ? null : fail('fingerprint_mismatch', 'The workbook or recalculation state changed since inspection')
    }
    if (approved?.version === 3 && Array.isArray(approved.sheets)) {
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets || !same(sheets.sheets, approved.sheets)) return fail('fingerprint_mismatch', 'The workbook sheet order or visibility changed since inspection')
      if (approved.definedNames !== undefined) { const names = await definedNamesSnapshot(resolved.workbook); if (!names || !same(names.names, approved.definedNames)) return fail('fingerprint_mismatch', 'The workbook defined names changed since inspection') }
      return null
    }
    if (approved?.version === 2 && Array.isArray(approved.targets) && approved.targets.length >= 1 && approved.targets.length <= 2) {
      for (const target of approved.targets) {
        if (!target || typeof target.range !== 'string' || !target.state || typeof target.state !== 'object') return fail('fingerprint_mismatch', 'The spreadsheet write has an invalid inspected multi-range precondition')
        const range = await rangeFor(resolved.sheet, target.range); const current = await writePrecondition(range, target.range)
        if (!current || !same(current.state, target.state)) return fail('fingerprint_mismatch', 'A spreadsheet source or destination range changed since inspection; reread and inspect before writing')
      }
      return null
    }
    if (!approved || approved.version !== 1 || typeof approved.range !== 'string' || !approved.state || typeof approved.state !== 'object' || Array.isArray(approved.state)) return fail('fingerprint_mismatch', 'The spreadsheet write is missing its inspected precondition')
    const address = request.operation === 'batch_write' ? requestedBatchWrite(request.payload ?? {})?.range : request.payload?.range
    if (approved.range !== address) return fail('fingerprint_mismatch', 'The spreadsheet write range differs from its inspected precondition')
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const featureWrite = ['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_conditional_format', 'clear_conditional_formats'].includes(request.operation); const hyperlinkWrite = ['add_hyperlink', 'delete_hyperlinks'].includes(request.operation); const conditionalFormatWrite = ['add_conditional_format', 'clear_conditional_formats'].includes(request.operation)
    const current = await writePrecondition(range, address, featureWrite && !conditionalFormatWrite, hyperlinkWrite, request.operation === 'add_hyperlink' && request.payload?.screenTip !== undefined, conditionalFormatWrite)
    if (!current || !same(current.state, approved.state)) return fail('fingerprint_mismatch', 'The spreadsheet range changed since inspection; reread and inspect before writing')
    if (approved.borders) { const borders = await borderSnapshot(range, Object.keys(approved.borders)); if (!borders || !same(borders, approved.borders)) return fail('fingerprint_mismatch', 'The requested border state changed since inspection; reread and inspect before writing') }
    if (featureWrite && !completeDataValidationState(current.state)) return fail('unsupported', 'WebEdit cannot fully reread all non-target range state before this feature write')
    return null
  }
  async function setValues(range, values) { if (typeof range.setValue2 === 'function') { await call(range, 'setValue2', [values]); return true } if (typeof range.setValue === 'function') { await call(range, 'setValue', [values]); return true } return set(range, 'Value2', values) }
  async function setFormula(range, formulas) { if (typeof range.setFormula === 'function') { await call(range, 'setFormula', [formulas]); return true } return set(range, 'Formula', formulas) }
  function sortColumn(key, width) {
    if (Number.isInteger(key) && key >= 1 && key <= width) return key - 1
    if (typeof key === 'string' && /^[A-Z]{1,3}$/i.test(key)) return key.toUpperCase().split('').reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1
    return null
  }
  function comparable(value) { return value == null ? '' : typeof value === 'number' ? value : String(value).toLocaleLowerCase() }
  function sortedValues(values, sorts, hasHeader) {
    const rows = values.slice(hasHeader ? 1 : 0)
    return rows.every((row, index) => {
      if (index === 0) return true
      for (const sort of sorts) {
        const column = sortColumn(sort.key, row.length); if (column === null) return false
        const left = comparable(rows[index - 1][column]); const right = comparable(row[column])
        if (left === right) continue
        return sort.order === 'desc' ? left >= right : left <= right
      }
      return true
    })
  }
  async function advancedWrite(resolved, request, range, address) {
    const payload = request.payload ?? {}; const operation = request.operation
    if (operation === 'clear_formats') {
      // Full range state (values/formulas/format) is re-read below; callers
      // without readable state fail rather than mutating.
      if (typeof range.ClearFormats !== 'function' && typeof range.clearFormats !== 'function') return fail('unsupported', 'WebEdit does not expose Range.ClearFormats')
      const before = await writePrecondition(range, address); if (!before) return fail('unsupported', 'WebEdit cannot snapshot formats before ClearFormats')
      try { await resolve(typeof range.ClearFormats === 'function' ? range.ClearFormats() : range.clearFormats()) } catch { return fail('runtime_error', 'WebEdit ClearFormats failed') }
      const after = await writePrecondition(range, address); if (!after || !same(before.state.values, after.state.values) || !same(before.state.formulas, after.state.formulas)) return fail('readback_mismatch', 'ClearFormats changed values or formulas')
      return { requested: { range: address }, observed: { state: after.state, verified: true } }
    }
    if (operation === 'apply_filter') {
      if (!['values', 'custom', 'top', 'dynamic', 'color'].includes(payload.mode)) return fail('invalid_range', 'apply_filter mode is unsupported')
      if (typeof range.setAutoFilter !== 'function' && typeof range.SetAutoFilter !== 'function' && typeof range.AutoFilter !== 'function') return fail('unsupported', 'WebEdit does not expose structured filter APIs')
      const before = await filterCondition(range); let result
      try { result = typeof range.setAutoFilter === 'function' ? await resolve(range.setAutoFilter(true, payload)) : typeof range.SetAutoFilter === 'function' ? await resolve(range.SetAutoFilter(true, payload)) : await resolve(range.AutoFilter(payload)) } catch { return fail('runtime_error', 'WebEdit structured filter failed') }
      const after = await filterCondition(range)
      if (!after || after.operator === 'none' || same(before, after)) return fail('readback_mismatch', 'Structured filter did not expose a changed filter criterion')
      return { requested: { range: address, mode: payload.mode, criteria: payload.criteria ?? payload.values ?? null }, observed: { before, after, runtimeResult: result ?? null, verified: true } }
    }
    if (operation === 'apply_table_style') {
      if (!Object.keys(payload).every((key) => ['range', 'sheetName', 'headerRange', 'headerFill', 'headerBold', 'withBorder', 'borderColor'].includes(key))) return fail('invalid_range', 'apply_table_style received fields without a complete readable contract')
      if (payload.headerRange !== undefined && payload.headerRange !== address) return fail('unsupported', 'A separate header range requires a two-range inspected snapshot')
      const before = await writePrecondition(range, address); const font = await property(range, 'Font'); const interior = await property(range, 'Interior'); const borders = await property(range, 'Borders')
      if (!before || !font || !interior || (payload.withBorder !== false && !borders)) return fail('unsupported', 'WebEdit cannot fully inspect the table-style target')
      const fill = typeof payload.headerFill === 'string' ? payload.headerFill : '#D9EAF7'; if (!await set(font, 'Bold', payload.headerBold !== false) || !await set(interior, 'Color', fill)) return fail('runtime_error', 'WebEdit table style mutation failed')
      if (payload.withBorder !== false) for (const side of ['EdgeTop', 'EdgeBottom', 'EdgeLeft', 'EdgeRight']) if (!await set(borders[side] ?? borders, 'Color', payload.borderColor ?? '#4472C4')) return fail('unsupported', 'WebEdit cannot apply every table border')
      const after = await writePrecondition(range, address)
      const afterBorders = payload.withBorder !== false ? await borderSnapshot(range, ['EdgeTop', 'EdgeBottom', 'EdgeLeft', 'EdgeRight']) : null; const borderColor = payload.borderColor ?? '#4472C4'
      if (!after || after.state.format.bold !== (payload.headerBold !== false) || after.state.format.fill !== fill || !same({ ...after.state, format: before.state.format }, before.state) || (payload.withBorder !== false && (!afterBorders || !Object.values(afterBorders).every((item) => same(item.color, borderColor))))) return fail('readback_mismatch', 'Table style readback changed non-style state or missed requested values')
      return { requested: { range: address, headerRange: address, headerFill: fill, ...(payload.withBorder !== false ? { borderColor } : {}) }, observed: { state: after.state, ...(afterBorders ? { borders: afterBorders } : {}), verified: true } }
    }
    if (operation === 'add_comment' || operation === 'delete_comments') {
      // Midea WebEdit has shipped both Range.Comments and Sheet.Comments.  The
      // former is the only collection whose Count is target-scoped, but the
      // latter is often the only collection which exposes item text/address.
      const rangeComments = await property(range, 'Comments'); const sheetComments = await property(resolved.sheet, 'Comments')
      const beforeRangeCount = rangeComments ? Number(await property(rangeComments, 'Count')) : null; const beforeSheetCount = sheetComments ? Number(await property(sheetComments, 'Count')) : null
      const comments = rangeComments ?? sheetComments; const beforeCount = Number(await property(comments, 'Count'))
      if (!comments || !Number.isInteger(beforeCount) || (operation === 'add_comment' ? typeof range.AddComment !== 'function' : typeof range.ClearComments !== 'function')) return fail('unsupported', 'WebEdit does not expose readable range comment APIs')
      if (operation === 'add_comment') { if (typeof payload.text !== 'string' || payload.text.length > 20000) return fail('invalid_range', 'comment text is invalid'); await resolve(range.AddComment(payload.text)) } else await resolve(range.ClearComments())
      const afterRangeComments = await property(range, 'Comments'); const afterSheetComments = await property(resolved.sheet, 'Comments'); const afterRangeCount = afterRangeComments ? Number(await property(afterRangeComments, 'Count')) : null; const afterSheetCount = afterSheetComments ? Number(await property(afterSheetComments, 'Count')) : null; const afterComments = afterRangeComments ?? afterSheetComments; const afterCount = Number(await property(afterComments, 'Count'))
      if (!Number.isInteger(afterCount) || (operation === 'add_comment' ? afterCount !== beforeCount + 1 : afterCount !== 0)) return fail('readback_mismatch', 'comment count readback differs from request')
      const readable = (await Promise.all([...new Set([afterRangeComments, afterSheetComments].filter(Boolean))].map(commentEntries))).filter(Array.isArray).flat()
      const target = readable.find((item) => item.address === address && item.text === payload.text)
      if (operation === 'add_comment' && target) return { requested: { range: address, text: payload.text }, observed: { range: address, beforeCount, afterCount, comment: target, contentVerified: true, verified: true } }
      // A zero count proves only that the target-scoped collection is empty;
      // it cannot prove the precise deleted comment when item metadata is not
      // enumerable.  Preserve that distinction for the caller.
      const targetRangeEmpty = Number.isInteger(beforeRangeCount) && Number.isInteger(afterRangeCount) && afterRangeCount === 0
      const sheetDeltaMatchesTarget = Number.isInteger(beforeRangeCount) && Number.isInteger(beforeSheetCount) && Number.isInteger(afterSheetCount) && afterSheetCount === beforeSheetCount - beforeRangeCount
      const deletedVerified = operation === 'delete_comments' && targetRangeEmpty && (rangeComments === sheetComments || sheetDeltaMatchesTarget)
      if (deletedVerified) return { requested: { range: address, delete: true }, observed: { range: address, beforeRangeCount, afterRangeCount, beforeSheetCount, afterSheetCount, targetRangeEmpty: true, contentVerified: true, verified: true } }
      return { verificationStatus: 'write_incomplete', requested: { range: address, ...(operation === 'add_comment' ? { text: payload.text } : { delete: true }) }, observed: { range: address, beforeCount, afterCount, targetRangeEmpty, contentVerified: false, verificationStatus: 'write_incomplete' } }
    }
    if (['create_chart', 'create_pivot_table'].includes(operation)) return fail('unsupported', 'WebEdit analytics creation requires a published capability contract')
    if (!ADVANCED_OPERATIONS.has(operation)) return null
    if (operation === 'sort') {
      const sorts = Array.isArray(payload.sorts) ? payload.sorts.filter((item) => item && typeof item === 'object').slice(0, 3) : []
      if (sorts.length === 0 || sorts.length > 3) return fail('invalid_range', 'sort requires one to three bounded sort descriptors')
      const before = await rangeSnapshot(resolved.sheet, address); if (before.error) return before.error
      if (before.snapshot.formulas.some((row) => row.some((formula) => !blankCell(formula)))) return fail('unsupported', 'Sort is withheld for formulas because WebEdit does not expose a complete formula-row correspondence readback')
      const alreadySorted = sortedValues(before.snapshot.values, sorts, payload.hasHeader !== false)
      if (typeof range.sort === 'function') await resolve(range.sort(sorts.length === 1 ? sorts[0].key : { sorts, header: payload.hasHeader !== false }, sorts.length === 1 ? (sorts[0].order === 'desc' ? 'etDescending' : 'etAscending') : undefined))
      else if (typeof range.Sort === 'function' && sorts.length === 1) await resolve(range.Sort(sorts[0].key, sorts[0].order === 'desc' ? 'etDescending' : 'etAscending'))
      else return fail('unsupported', 'WebEdit does not expose a bounded range sort API')
      const after = await rangeSnapshot(resolved.sheet, address); if (after.error) return after.error
      if (!sortedValues(after.snapshot.values, sorts, payload.hasHeader !== false) || (!alreadySorted && same(before.snapshot.values, after.snapshot.values))) return fail('readback_mismatch', 'WebEdit sort readback does not match the requested order')
      return { requested: { range: address, sorts, hasHeader: payload.hasHeader !== false }, observed: { range: address, values: after.snapshot.values, alreadySorted, verified: true } }
    }
    if (operation === 'set_auto_filter') {
      if (typeof payload.enabled !== 'boolean') return fail('invalid_range', 'set_auto_filter requires enabled')
      const stateTarget = (await property(range, 'AutoFilter')) !== undefined ? range : resolved.sheet
      if ((await property(stateTarget, 'AutoFilter')) === undefined) return fail('unsupported', 'WebEdit does not expose auto-filter readback')
      if (typeof range.setAutoFilter === 'function') await resolve(range.setAutoFilter(payload.enabled)); else if (typeof range.SetAutoFilter === 'function') await resolve(range.SetAutoFilter(payload.enabled)); else return fail('unsupported', 'WebEdit does not expose an auto-filter API')
      const after = await property(stateTarget, 'AutoFilter'); const enabled = typeof after === 'boolean' ? after : after != null
      if (enabled !== payload.enabled) return fail('readback_mismatch', 'WebEdit auto-filter readback differs from request')
      return { requested: { range: address, enabled: payload.enabled }, observed: { range: address, enabled, verified: true } }
    }
    if (operation === 'clear_filters') {
      const before = await filterCondition(range)
      if (!before || typeof range.autoFilterShowAll !== 'function') return fail('unsupported', 'WebEdit does not expose readable auto-filter clearing APIs')
      const callback = await callbackResult((done) => range.autoFilterShowAll(done))
      if (!callback.callbackInvoked || callback.callbackError) return fail('readback_mismatch', callback.callbackError ?? 'WebEdit did not confirm filter clearing by callback')
      const after = await filterCondition(range)
      if (!after || after.operator !== 'none') return fail('readback_mismatch', 'WebEdit filter-state readback does not prove filters were cleared')
      return { requested: { range: address, clear: true }, observed: { range: address, before, after, verified: true } }
    }
    if (operation === 'set_data_validation' || operation === 'clear_data_validation') {
      const validation = await property(range, 'Validation'); const before = await validationSnapshot(range)
      if (!validation || !before.supported || typeof validation.Delete !== 'function' || (operation === 'set_data_validation' && typeof validation.Add !== 'function')) return fail('unsupported', 'WebEdit does not expose complete readable data-validation APIs')
      if (operation === 'clear_data_validation') {
        await resolve(validation.Delete()); const after = await validationSnapshot(range); const state = await writePrecondition(range, address, true)
        if (!after.supported || after.validation !== null || !state || !same({ ...state.state, validation: before.validation }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit did not clear data validation without changing the range')
        return { requested: { range: address, clear: true, validation: null }, observed: { range: address, validation: null, state: state.state, verified: true } }
      }
      const expected = requestedValidation(payload)
      if (!expected) return fail('invalid_range', 'set_data_validation requires a complete bounded validation schema')
      if (!VALIDATION_PROPERTY_NAMES.every((name) => hasProperty(validation, name))) return fail('unsupported', 'WebEdit does not expose every requested data-validation property before mutation')
      await resolve(validation.Delete()); await resolve(validation.Add(expected.type, expected.alertStyle, expected.operator, expected.formula1, expected.formula2))
      for (const [name, value] of [['IgnoreBlank', expected.ignoreBlank], ['ShowError', expected.showError], ['ErrorTitle', expected.errorTitle], ['ErrorMessage', expected.errorMessage]]) if (!await set(validation, name, value)) return fail('readback_mismatch', 'WebEdit rejected a requested data-validation property')
      const after = await validationSnapshot(range); const state = await writePrecondition(range, address, true)
      if (!after.supported || !same(after.validation, expected) || !state || !same({ ...state.state, validation: before.validation }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit data-validation readback differs from request or changed the range')
      return { requested: { range: address, validation: expected }, observed: { range: address, validation: after.validation, state: state.state, verified: true } }
    }
    if (operation === 'add_hyperlink' || operation === 'delete_hyperlinks') {
      const requireScreenTip = operation === 'add_hyperlink' && payload.screenTip !== undefined; const before = await hyperlinksSnapshot(range, requireScreenTip); const links = before.collection
      if (!before.supported || !links || (operation === 'add_hyperlink' ? (typeof links.Add !== 'function' || typeof links.Item !== 'function') : typeof links.Delete !== 'function')) return fail('unsupported', 'WebEdit does not expose complete readable hyperlink APIs')
      if (operation === 'add_hyperlink') {
        const expected = requestedHyperlink(payload); if (!expected || before.items.some((item) => item.address === expected.url && item.subAddress === expected.subAddress && item.textToDisplay === expected.textToDisplay)) return fail('invalid_range', 'add_hyperlink requires a uniquely identifiable new link')
        await resolve(links.Add(range, expected.url, expected.subAddress, expected.screenTip ?? '', expected.textToDisplay))
        const after = await hyperlinksSnapshot(range, requireScreenTip); const state = await writePrecondition(range, address, true, true, requireScreenTip)
        const added = after.supported ? after.items.filter((item) => !before.items.some((prior) => same(prior, item))) : []
        if (!after.supported || after.items.length !== before.items.length + 1 || added.length !== 1 || added[0].address !== expected.url || added[0].subAddress !== expected.subAddress || added[0].textToDisplay !== expected.textToDisplay || (requireScreenTip && added[0].screenTip !== expected.screenTip) || !state || !same({ ...state.state, hyperlinks: before.items }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit hyperlink add readback differs from request or changed the range')
        return { requested: { range: address, hyperlink: expected }, observed: { range: address, hyperlinks: after.items, newItem: added[0], state: state.state, verified: true } }
      }
      await resolve(links.Delete()); const after = await hyperlinksSnapshot(range); const state = await writePrecondition(range, address, true, true)
      if (!after.supported || after.items.length !== 0 || !state || !same({ ...state.state, hyperlinks: before.items }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit hyperlink delete readback differs from request or changed the range')
      return { requested: { range: address, delete: true }, observed: { range: address, hyperlinks: after.items, state: state.state, verified: true } }
    }
    if (operation === 'add_conditional_format' || operation === 'clear_conditional_formats') {
      const before = await conditionalFormatsSnapshot(range); const formats = before.collection
      if (!before.supported || !formats || (operation === 'add_conditional_format' ? typeof formats.Add !== 'function' : typeof formats.Delete !== 'function')) return fail('unsupported', 'WebEdit does not expose complete readable conditional-format APIs')
      if (operation === 'clear_conditional_formats') {
        await resolve(formats.Delete()); const after = await conditionalFormatsSnapshot(range); const state = await writePrecondition(range, address, false, false, false, true)
        if (!after.supported || after.items.length !== 0 || !state || !same({ ...state.state, conditionalFormats: before.items }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit conditional-format clear readback differs from the inspected range')
        return { requested: { range: address, clear: true }, observed: { range: address, conditionalFormats: after.items, state: state.state, verified: true } }
      }
      const expected = requestedConditionalFormat(payload)
      if (!expected || before.items.some((item) => item.type === expected.type && item.operator === expected.operator && item.formula1 === expected.formula1 && item.formula2 === expected.formula2 && (expected.fillColor === undefined || item.fillColor === expected.fillColor) && (expected.fontColor === undefined || item.fontColor === expected.fontColor) && (expected.bold === undefined || item.bold === expected.bold) && (expected.italic === undefined || item.italic === expected.italic))) return fail('invalid_range', 'add_conditional_format requires a uniquely identifiable new condition')
      const condition = await resolve(formats.Add(expected.type, expected.operator, expected.formula1, expected.formula2))
      const interior = await property(condition, 'Interior'); const font = await property(condition, 'Font')
      const styleApplied = !!condition && (expected.fillColor === undefined || !!interior && await set(interior, 'Color', Number.parseInt(expected.fillColor.slice(1), 16))) && (expected.fontColor === undefined || !!font && await set(font, 'Color', Number.parseInt(expected.fontColor.slice(1), 16))) && (expected.bold === undefined || !!font && await set(font, 'Bold', expected.bold)) && (expected.italic === undefined || !!font && await set(font, 'Italic', expected.italic))
      if (!styleApplied) return fail('unsupported', 'WebEdit cannot apply every requested conditional-format style property')
      const after = await conditionalFormatsSnapshot(range); const state = await writePrecondition(range, address, false, false, false, true)
      const added = after.supported ? after.items.filter((item) => !before.items.some((prior) => same(prior, item))) : []
      const matches = (item) => item && item.type === expected.type && item.operator === expected.operator && item.formula1 === expected.formula1 && item.formula2 === expected.formula2 && (expected.fillColor === undefined || item.fillColor === expected.fillColor) && (expected.fontColor === undefined || item.fontColor === expected.fontColor) && (expected.bold === undefined || item.bold === expected.bold) && (expected.italic === undefined || item.italic === expected.italic)
      if (!after.supported || after.items.length !== before.items.length + 1 || added.length !== 1 || !matches(added[0]) || !state || !same({ ...state.state, conditionalFormats: before.items }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit conditional-format add readback differs from request or changed the range')
      return { requested: { range: address, conditionalFormat: expected }, observed: { range: address, conditionalFormats: after.items, newItem: added[0], state: state.state, verified: true } }
    }
    if (operation === 'add_comment' || operation === 'delete_comments') return fail('unsupported', 'WebEdit cell-comment APIs do not expose range-scoped content readback, so Harness will not mutate comments')
    if (operation === 'insert_cell_image') {
      const parsed = parseAddress(address); const before = await rangeSnapshot(resolved.sheet, address)
      if (!parsed || parsed.rowFrom !== parsed.rowTo || parsed.colFrom !== parsed.colTo || before.error || typeof payload.url !== 'string' || !/^https:\/\//i.test(payload.url) || payload.url.length > 2048 || typeof range.insertCellPictureUrl !== 'function') return fail('unsupported', 'WebEdit cell-image insertion requires a bounded single cell and callback API')
      const callback = await callbackResult((done) => range.insertCellPictureUrl(payload.url, done))
      if (!callback.callbackInvoked || callback.callbackError) return fail('readback_mismatch', 'WebEdit did not callback-confirm cell-image insertion')
      const after = await rangeSnapshot(resolved.sheet, address); const formula = after.error ? null : after.snapshot.formulas[0][0]
      if (typeof formula !== 'string' || !/^=DISPIMG\(/i.test(formula) || formula === before.snapshot.formulas[0][0]) return fail('readback_mismatch', 'WebEdit did not expose a changed stable DISPIMG formula')
      return { requested: { range: address, url: payload.url }, observed: { range: address, formula, callbackInvoked: true, verified: true } }
    }
    if (operation === 'create_chart') {
      const charts = await chartCollection(resolved.sheet); const before = await collectionCount(charts)
      if (!charts || before === null || typeof resolved.sheet.addChart !== 'function') return fail('unsupported', 'WebEdit does not expose a readable Worksheet.addChart API')
      const chartType = typeof payload.chartType === 'string' || typeof payload.chartType === 'number' ? payload.chartType : 'columnClustered'
      const chartStyle = Number.isInteger(payload.chartStyle) ? payload.chartStyle : 0
      const callback = await callbackResult((done) => resolved.sheet.addChart(chartStyle, chartType, range, done, {}))
      if (!callback.callbackInvoked || callback.callbackError) return fail('unsupported', callback.callbackError ?? 'WebEdit did not confirm chart creation by callback')
      const after = await collectionCount(await chartCollection(resolved.sheet)); if (after === null || after <= before) return fail('readback_mismatch', 'WebEdit did not expose a newly-created chart')
      const created = await collectionItem(await chartCollection(resolved.sheet), after); const collectionIdentity = await objectIdentity(created)
      const callbackChart = callback.callbackInvoked ? callback.args?.[0] : null
      const callbackIdentity = await objectIdentity(callbackChart)
      if (!hasReadableIdentity(collectionIdentity) || !hasReadableIdentity(callbackIdentity) || !identityMatches(callbackIdentity, collectionIdentity)) return fail('readback_mismatch', 'WebEdit chart callback and collection readback do not identify the same created chart')
      if (collectionIdentity.type === null) return fail('unsupported', 'WebEdit chart readback does not expose a chart type')
      if (!same(collectionIdentity.type, chartType)) return fail('readback_mismatch', 'WebEdit chart type readback differs from request')
      return { requested: { range: address, chartType, chartStyle }, observed: { range: address, beforeCount: before, afterCount: after, chart: collectionIdentity, callbackInvoked: true, verified: true } }
    }
    if (operation === 'create_pivot_table') {
      if (payload.isNewSheet !== false || typeof payload.destination !== 'string' || !payload.destination.trim() || payload.destination.length > 128) return fail('invalid_range', 'create_pivot_table requires an explicit same-sheet destination and isNewSheet:false')
      const pivots = await pivotCollection(resolved.sheet); const before = await collectionCount(pivots)
      if (!pivots || before === null || typeof range.createPivotTable !== 'function') return fail('unsupported', 'WebEdit does not expose readable Range.createPivotTable APIs')
      const callback = await callbackResult((done) => range.createPivotTable({ destRangeText: payload.destination, isNewSheet: false, autoFitColumnWidth: payload.autoFitColumnWidth !== false, styleId: Number.isInteger(payload.styleId) ? payload.styleId : -1, layout: payload.layout }, done))
      if (!callback.callbackInvoked || callback.callbackError) return fail('unsupported', callback.callbackError ?? 'WebEdit did not confirm pivot-table creation by callback')
      const after = await collectionCount(await pivotCollection(resolved.sheet)); if (after === null || after <= before) return fail('readback_mismatch', 'WebEdit did not expose a newly-created pivot table')
      const pivot = await collectionItem(await pivotCollection(resolved.sheet), after); const runtime = callback.args?.[0] ?? null
      const collectionIdentity = await objectIdentity(pivot); const callbackIdentity = await objectIdentity(runtime)
      const callbackId = runtime && typeof runtime === 'object' ? await property(runtime, 'pivotTableId') ?? callbackIdentity.id : null
      if (!hasReadableIdentity(collectionIdentity) || callbackId === null || collectionIdentity.id === null || callbackId !== collectionIdentity.id) return fail('readback_mismatch', 'WebEdit pivot callback and collection readback do not identify the same created pivot table')
      const destination = await pivotDestination(pivot); const expectedDestination = await readableAddress(payload.destination)
      if (!expectedDestination) return fail('invalid_range', 'create_pivot_table destination must be a bounded cell address')
      if (!destination) return fail('unsupported', 'WebEdit pivot readback does not expose the destination')
      if (destination !== expectedDestination) return fail('readback_mismatch', 'WebEdit pivot destination readback differs from request')
      return { requested: { range: address, destination: payload.destination, isNewSheet: false }, observed: { range: address, beforeCount: before, afterCount: after, pivot: collectionIdentity, destination, callbackInvoked: true, verified: true } }
    }
    if (operation === 'export_pdf') {
      const scope = payload.scope === 'worksheet' ? 'worksheet' : payload.scope === 'workbook' || payload.scope === undefined ? 'workbook' : null
      const target = scope === 'worksheet' ? resolved.sheet : resolved.workbook
      if (!scope) return fail('invalid_range', 'export_pdf scope must be workbook or worksheet')
      if (!target || typeof target.ExportAsFixedFormat !== 'function') return fail('unsupported', 'WebEdit does not expose an auditable PDF export API')
      const exported = await resolve(target.ExportAsFixedFormat(0))
      const businessError = await property(exported, 'errorCode') ?? await property(exported, 'ErrorCode')
      if (await property(exported, 'isSuccessful') === false || await property(exported, 'success') === false || (businessError !== undefined && businessError !== null && String(businessError) !== '0')) return fail('runtime_error', 'WebEdit PDF export reported a business failure')
      const artifact = await artifactUrl(exported)
      if (!artifact) return fail('readback_mismatch', 'WebEdit PDF export did not return an auditable https artifact URL')
      return { requested: { range: address, scope }, observed: { range: address, artifact: { kind: 'pdf', mimeType: 'application/pdf', sourceOrigin: artifact.origin, expiresAt: artifact.expiresAt ? new Date(artifact.expiresAt * 1000).toISOString() : null, queryRedacted: artifact.queryRedacted, delivery: 'browser_session_only' }, verified: true } }
    }
    if (operation === 'export_range_image') {
      if (typeof range.ToImageDataURL !== 'function') return fail('unsupported', 'WebEdit does not expose Range.ToImageDataURL')
      const artifact = dataUrlMetadata(await resolve(range.ToImageDataURL()))
      if (!artifact || artifact.tooLarge) return fail('readback_mismatch', 'WebEdit range image export did not return a bounded image artifact')
      return { requested: { range: address }, observed: { range: address, artifact: { kind: 'range_image', mimeType: artifact.mimeType, byteLength: artifact.byteLength, delivery: artifact.delivery, ...(artifact.dataUrl ? { dataUrl: artifact.dataUrl } : {}) }, verified: true } }
    }
    if (operation === 'export_worksheet_image') {
      if (typeof resolved.sheet.ExportImage !== 'function') return fail('unsupported', 'WebEdit does not expose Worksheet.ExportImage')
      const result = await resolve(resolved.sheet.ExportImage({})); const status = await property(result, 'result'); const blob = await property(result, 'data')
      const byteLength = Number(await property(blob, 'size')); const mimeType = await property(blob, 'type')
      if (status !== 'ok' || !blob || typeof blob.arrayBuffer !== 'function' || !/^image\//i.test(String(mimeType)) || !Number.isFinite(byteLength) || byteLength < 1 || byteLength > MAX_IMAGE_ARTIFACT_BYTES) return fail('readback_mismatch', 'WebEdit worksheet image export returned an invalid or too_large image artifact')
      if (byteLength > MAX_INLINE_IMAGE_ARTIFACT_BYTES) return { requested: { range: address }, observed: { range: address, artifact: { kind: 'worksheet_image', mimeType, byteLength, delivery: 'metadata_only' }, verified: true } }
      const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      return { requested: { range: address }, observed: { range: address, artifact: { kind: 'worksheet_image', mimeType, byteLength, delivery: 'inline', dataUrl: `data:${mimeType};base64,${btoa(binary)}` }, verified: true } }
    }
    return fail('unsupported', `WebEdit does not expose an operation-specific API and readback contract for ${operation}`)
  }
  async function setAnalyticsProperty(target, key, value) {
    const setter = `set${key[0].toUpperCase()}${key.slice(1)}`
    if (typeof target?.[setter] === 'function') { await resolve(target[setter](value)); return true }
    return set(target, key[0].toUpperCase() + key.slice(1), value)
  }
  async function chartLayer(chart) { return await call(chart, 'getChartLayer') ?? await property(chart, 'ChartLayer') }
  async function writeAnalytics(resolved, request) {
    const payload = request.payload ?? {}; const operation = request.operation; const preflight = request.precondition?.analytics
    const charts = await chartCollection(resolved.sheet); const pivots = await pivotCollection(resolved.sheet)
    if (!preflight || !charts || !pivots) return fail('fingerprint_mismatch', 'The analytics write is missing its inspected object precondition')
    if (operation === 'create_chart') {
      const source = await rangeFor(resolved.sheet, payload.range); const before = await collectionCount(charts)
      if (!source || before === null || typeof resolved.sheet.addChart !== 'function') return fail('unsupported', 'WebEdit does not expose callback-driven chart creation with collection readback')
      const chartType = payload.chartType ?? 'columnClustered'; const chartStyle = Number.isInteger(payload.chartStyle) ? payload.chartStyle : 0
      const callback = await callbackMutation((done) => resolved.sheet.addChart(chartStyle, chartType, source, done, { dataLabelsPointUpperLimit: payload.dataLabelsPointUpperLimit }))
      if (!callback) return fail('runtime_error', 'WebEdit did not confirm chart creation by callback')
      const afterCollection = await chartCollection(resolved.sheet); const after = await collectionCount(afterCollection)
      if (after === null || after !== before + 1) return fail('readback_mismatch', 'Chart collection count did not increase by one')
      const created = await collectionItem(afterCollection, after); const callbackIdentity = await objectIdentity(callback.args?.[0]); const observed = await chartDetail(created, ['type'])
      if (!observed || observed.id === null || callbackIdentity.id === null || !identityMatches(callbackIdentity, observed) || !same(observed.type, chartType)) return fail('readback_mismatch', 'Created chart callback identity or type does not match collection readback')
      return { requested: { range: payload.range, chartType, chartStyle }, observed: { beforeCount: before, afterCount: after, chart: observed, callbackInvoked: true, verified: true } }
    }
    if (operation === 'create_pivot_table') {
      if (payload.isNewSheet !== false || typeof payload.destination !== 'string' || !parseAddress(payload.destination)) return fail('invalid_range', 'create_pivot_table requires isNewSheet:false and an explicit same-sheet destination')
      const source = await rangeFor(resolved.sheet, payload.range); const before = await collectionCount(pivots)
      if (!source || before === null || typeof source.createPivotTable !== 'function') return fail('unsupported', 'WebEdit does not expose callback-driven pivot creation with collection readback')
      const callback = await callbackMutation((done) => source.createPivotTable({ destRangeText: payload.destination, isNewSheet: false, autoFitColumnWidth: payload.autoFitColumnWidth !== false, styleId: Number.isInteger(payload.styleId) ? payload.styleId : -1, layout: payload.layout }, done))
      if (!callback) return fail('runtime_error', 'WebEdit did not confirm pivot-table creation by callback')
      const afterCollection = await pivotCollection(resolved.sheet); const after = await collectionCount(afterCollection)
      if (after === null || after !== before + 1) return fail('readback_mismatch', 'Pivot collection count did not increase by one')
      const created = await collectionItem(afterCollection, after); const observed = await pivotDetail(created, false, false); const callbackId = await property(callback.args?.[0], 'pivotTableId') ?? await property(callback.args?.[0], 'Id')
      if (!observed || observed.id === null || callbackId === undefined || String(observed.id) !== String(callbackId) || observed.destination !== await readableAddress(payload.destination)) return fail('readback_mismatch', 'Created pivot callback identity or destination does not match collection readback')
      return { requested: { range: payload.range, destination: payload.destination, isNewSheet: false }, observed: { beforeCount: before, afterCount: after, pivot: observed, callbackInvoked: true, verified: true } }
    }
    const chartOperation = ['update_chart', 'set_chart_data_source', 'resize_chart', 'delete_chart'].includes(operation)
    if (chartOperation) {
      const target = analyticsTarget(payload, 'chart'); const chart = await analyticsFind(charts, target); const before = preflight.target?.detail
      if (!target || !chart || !before || !identityMatches(await objectIdentity(chart), before)) return fail('fingerprint_mismatch', 'The inspected chart identity is no longer present')
      if (operation === 'delete_chart') {
        const count = await collectionCount(charts); const callback = typeof resolved.sheet.deleteShape === 'function' ? await callbackMutation((done) => resolved.sheet.deleteShape(chart, done)) : typeof chart.Delete === 'function' ? await callbackMutation((done) => chart.Delete(done)) : null
        if (!callback) return fail('unsupported', 'WebEdit does not expose callback-driven chart deletion')
        const afterCollection = await chartCollection(resolved.sheet); const after = await collectionCount(afterCollection); const remaining = await analyticsFind(afterCollection, { index: null, id: before.id, name: before.name })
        if (count === null || after === null || after !== count - 1 || remaining) return fail('readback_mismatch', 'Chart deletion was not proven by collection count and stable identity readback')
        return { requested: { chart: before }, observed: { beforeCount: count, afterCount: after, deleted: true, callbackInvoked: true, verified: true } }
      }
      const required = chartRequired(operation, payload); if (operation === 'set_chart_data_source') required.push('source')
      if (operation === 'resize_chart' && (!Number.isFinite(Number(payload.width)) || !Number.isFinite(Number(payload.height)) || Number(payload.width) <= 0 || Number(payload.height) <= 0)) return fail('invalid_range', 'resize_chart requires positive width and height')
      const layer = await chartLayer(chart); let didWrite = false
      const withCallback = async (method, args) => { if (!layer || typeof layer[method] !== 'function') return false; const result = await callbackMutation((done) => layer[method](...args, done)); if (!result) return false; didWrite = true; return true }
      if (operation === 'set_chart_data_source' || Object.hasOwn(payload, 'sourceRange')) { const source = await rangeFor(resolved.sheet, payload.sourceRange); const descriptor = source && (await call(source, 'getRANGE') ?? source); if (!source || !await withCallback('setDataSource', [descriptor])) return fail('unsupported', 'WebEdit cannot set and callback-confirm this chart data source') }
      if (operation === 'update_chart') {
        if (Object.hasOwn(payload, 'chartType') && !await withCallback('setChartType', [payload.chartType])) return fail('unsupported', 'WebEdit cannot callback-confirm this chart type update')
        if (Object.hasOwn(payload, 'title') && (typeof payload.title !== 'string' || payload.title.length > 512 || !await withCallback('setChartTitle', [payload.title]))) return fail('unsupported', 'WebEdit cannot callback-confirm this chart title update')
        for (const key of ['width', 'height', 'left', 'top']) if (Object.hasOwn(payload, key)) { const value = Number(payload[key]); if (!Number.isFinite(value) || value < 0 || !await setAnalyticsProperty(chart, key, value)) return fail('unsupported', `WebEdit cannot update chart ${key}`); didWrite = true }
      }
      if (operation === 'resize_chart') { if (!await setAnalyticsProperty(chart, 'width', Number(payload.width)) || !await setAnalyticsProperty(chart, 'height', Number(payload.height))) return fail('unsupported', 'WebEdit cannot resize chart'); didWrite = true }
      if (!didWrite) return fail('invalid_range', 'chart update requires at least one supported changed property')
      const observed = await chartDetail(chart, required)
      const matches = observed && identityMatches(observed, before) && (!Object.hasOwn(payload, 'chartType') || same(observed.type, payload.chartType)) && (!Object.hasOwn(payload, 'title') || observed.title === payload.title) && (!Object.hasOwn(payload, 'sourceRange') || observed.sourceRange === await readableAddress(payload.sourceRange)) && (!Object.hasOwn(payload, 'width') || observed.width === Number(payload.width)) && (!Object.hasOwn(payload, 'height') || observed.height === Number(payload.height)) && (!Object.hasOwn(payload, 'left') || observed.left === Number(payload.left)) && (!Object.hasOwn(payload, 'top') || observed.top === Number(payload.top))
      if (!matches) return fail('readback_mismatch', 'Chart operation-specific readback differs from the requested change')
      return { requested: { chart: before, ...(operation === 'set_chart_data_source' ? { sourceRange: payload.sourceRange } : payload) }, observed: { chart: observed, verified: true } }
    }
    if (operation === 'refresh_pivot_tables' || operation === 'refresh_all_pivot_tables') {
      const before = preflight.state?.pivots; const refresh = resolved.workbook && (resolved.workbook.refreshAllPivotTables ?? resolved.workbook.RefreshAllPivotTables)
      if (!before || typeof refresh !== 'function') return fail('unsupported', 'WebEdit does not expose callback-driven workbook pivot refresh')
      const callback = await callbackMutation((done) => refresh.call(resolved.workbook, done)); if (!callback) return fail('runtime_error', 'WebEdit did not confirm all-pivot refresh by callback')
      const afterState = await analyticsState(resolved, false, true); const after = afterState?.pivots
      const changed = before.items.length === 0 || (after && before.items.every((item) => { const current = after.items.find((candidate) => identityMatches(candidate, item)); return current && current.updateTime !== item.updateTime }))
      if (!after || !changed) return fail('readback_mismatch', 'All-pivot refresh did not expose a changed update-time readback for every inspected pivot')
      return { requested: { pivots: before.items.map((item) => ({ id: item.id, name: item.name })) }, observed: { pivots: after.items, callbackInvoked: true, verified: true } }
    }
    const target = analyticsTarget(payload, 'pivot'); const pivot = await analyticsFind(pivots, target); const before = preflight.target?.detail
    if (!target || !pivot || !before || !identityMatches(await objectIdentity(pivot), before)) return fail('fingerprint_mismatch', 'The inspected pivot identity is no longer present')
    if (operation === 'delete_pivot_table') {
      const command = await pivotCommand(resolved.app, pivot); const count = await collectionCount(pivots); const callback = command && typeof command.deleteTable === 'function' ? await callbackMutation((done) => command.deleteTable(done)) : null
      if (!callback) return fail('unsupported', 'WebEdit does not expose callback-driven pivot deletion')
      const afterCollection = await pivotCollection(resolved.sheet); const after = await collectionCount(afterCollection); const remaining = await analyticsFind(afterCollection, { index: null, id: before.id, name: before.name })
      if (count === null || after === null || after !== count - 1 || remaining) return fail('readback_mismatch', 'Pivot deletion was not proven by collection count and stable identity readback')
      return { requested: { pivot: before }, observed: { beforeCount: count, afterCount: after, deleted: true, callbackInvoked: true, verified: true } }
    }
    const command = await pivotCommand(resolved.app, pivot)
    if (!command) return fail('unsupported', 'WebEdit does not expose the public pivot command factory')
    if (operation === 'refresh_pivot_table') {
      if (typeof command.refresh !== 'function') return fail('unsupported', 'WebEdit does not expose callback-driven pivot refresh')
      const callback = await callbackMutation((done) => command.refresh(done)); const after = await pivotDetail(pivot, false, true)
      if (!callback || !after || after.updateTime === before.updateTime) return fail('readback_mismatch', 'Pivot refresh callback or update-time readback was not verified')
      return { requested: { pivot: before }, observed: { pivot: after, callbackInvoked: true, verified: true } }
    }
    const orientation = operation === 'set_pivot_value_function' || operation === 'set_pivot_show_values_as' ? 'value' : payload.orientation
    if (!Object.hasOwn(PIVOT_ORIENTATION, orientation) || typeof payload.fieldName !== 'string' || !payload.fieldName.trim()) return fail('invalid_range', 'Pivot field operations require an exact fieldName and supported orientation')
    const descriptor = { getName: () => payload.fieldName, getOrientation: () => PIVOT_ORIENTATION[orientation] }; let callback = null
    if (operation === 'add_pivot_field') callback = typeof command.addFieldByName === 'function' ? await callbackMutation((done) => command.addFieldByName(payload.fieldName, PIVOT_ORIENTATION[orientation], Number.isFinite(Number(payload.position)) ? Number(payload.position) : -1, done)) : null
    if (operation === 'remove_pivot_field') callback = typeof command.removeFieldByName === 'function' ? await callbackMutation((done) => command.removeFieldByName(payload.fieldName, PIVOT_ORIENTATION[orientation], done)) : null
    if (operation === 'sort_pivot_field') callback = typeof command.sortField === 'function' && (payload.order === 'asc' || payload.order === 'desc') ? await callbackMutation((done) => command.sortField(descriptor, payload.order === 'desc' ? 'etDescending' : 'etAscending', payload.sortByField ?? null, null, done)) : null
    if (operation === 'set_pivot_subtotals') { const subtotals = Array.isArray(payload.subtotals) ? payload.subtotals.map((value) => PIVOT_SUBTOTAL[value]).filter(Boolean) : []; callback = subtotals.length && typeof command.setSubtotals === 'function' ? await callbackMutation((done) => command.setSubtotals(descriptor, subtotals, done)) : null }
    if (operation === 'set_pivot_value_function') { const fn = PIVOT_FUNCTION[payload.summaryFunction]; callback = fn && typeof command.setFunction === 'function' ? await callbackMutation((done) => command.setFunction(descriptor, fn, done)) : null }
    if (operation === 'set_pivot_show_values_as') { const calculation = PIVOT_CALCULATION[payload.calculation]; callback = calculation && typeof command.setShowValuesAs === 'function' ? await callbackMutation((done) => command.setShowValuesAs(descriptor, { calculation, ...(payload.baseField ? { baseField: payload.baseField } : {}), ...(payload.baseItem ? { baseItem: payload.baseItem } : {}) }, done)) : null }
    if (!callback) return fail('unsupported', 'WebEdit does not expose this callback-driven pivot field operation')
    const after = await pivotDetail(pivot, true, false); const field = after?.fields?.find((item) => item.name === payload.fieldName); const beforeField = before.fields?.find((item) => item.name === payload.fieldName)
    const requestedSubtotals = Array.isArray(payload.subtotals) ? payload.subtotals.map((value) => PIVOT_SUBTOTAL[value]).filter(Boolean) : []
    const added = operation === 'add_pivot_field' && !beforeField && !!field && after.fields.length === before.fields.length + 1; const removed = operation === 'remove_pivot_field' && !!beforeField && !field && after.fields.length === before.fields.length - 1; const sorted = operation === 'sort_pivot_field' && field && beforeField && beforeField.autoSortOrder !== (payload.order === 'desc' ? 'etDescending' : 'etAscending') && field.autoSortOrder === (payload.order === 'desc' ? 'etDescending' : 'etAscending'); const subtotal = operation === 'set_pivot_subtotals' && field && beforeField && !same(beforeField.subtotals, requestedSubtotals) && same(field.subtotals, requestedSubtotals); const fn = operation === 'set_pivot_value_function' && field && beforeField && beforeField.summaryFunction !== PIVOT_FUNCTION[payload.summaryFunction] && field.summaryFunction === PIVOT_FUNCTION[payload.summaryFunction]; const valuesAs = operation === 'set_pivot_show_values_as' && field && beforeField && (beforeField.calculation !== PIVOT_CALCULATION[payload.calculation] || beforeField.baseField !== (payload.baseField ?? null) || beforeField.baseItem !== (payload.baseItem ?? null)) && field.calculation === PIVOT_CALCULATION[payload.calculation] && (!payload.baseField || field.baseField === payload.baseField) && (!payload.baseItem || field.baseItem === payload.baseItem)
    if (!after || !(added || removed || sorted || subtotal || fn || valuesAs)) return fail('readback_mismatch', 'Pivot field operation-specific readback differs from the requested change')
    return { requested: { pivot: before, fieldName: payload.fieldName, orientation, operation }, observed: { pivot: after, callbackInvoked: true, verified: true } }
  }
  async function writeRange(resolved, request) {
    const payload = request.payload ?? {}; const batch = request.operation === 'batch_write' ? requestedBatchWrite(payload) : null; const address = batch?.range ?? payload.range
    if (request.operation === 'export_pdf' || request.operation === 'export_worksheet_image') {
      const target = request.operation === 'export_worksheet_image' ? resolved.sheet : (payload.scope === 'worksheet' ? resolved.sheet : resolved.workbook)
      if (request.operation === 'export_pdf' && payload.scope !== undefined && payload.scope !== 'worksheet' && payload.scope !== 'workbook') return fail('invalid_range', 'export_pdf scope must be workbook or worksheet')
      if (!target) return fail('unsupported', 'export target is unavailable')
      const result = await advancedWrite(resolved, request, await rangeFor(resolved.sheet, payload.range ?? 'A1'), payload.range ?? 'A1'); if (result) return result
    }
    if (request.operation === 'copy_range' || request.operation === 'paste_special') {
      const sourceAddress = payload.sourceRange; const destinationAddress = payload.destinationRange
      const source = typeof sourceAddress === 'string' && await rangeFor(resolved.sheet, sourceAddress); const destination = typeof destinationAddress === 'string' && await rangeFor(resolved.sheet, destinationAddress)
      if (!source || !destination || typeof source.Copy !== 'function') return fail('unsupported', `${request.operation} requires source Copy and bounded destination APIs`)
      const before = await rangeSnapshot(resolved.sheet, destinationAddress); const sourceSnapshot = await rangeSnapshot(resolved.sheet, sourceAddress)
      if (before.error || sourceSnapshot.error) return fail('unsupported', `${request.operation} requires readable source and destination snapshots`)
      if (request.operation === 'copy_range') {
        if (typeof destinationAddress !== 'string' || typeof destination !== 'object') return fail('invalid_range', 'copy_range requires a destination range')
        let result; try { result = await resolve(source.Copy(destination)) } catch { return fail('runtime_error', 'WebEdit Range.Copy failed') }
        const after = await rangeSnapshot(resolved.sheet, destinationAddress); if (after.error || !same(after.snapshot.values, sourceSnapshot.snapshot.values) || !same(after.snapshot.formulas, sourceSnapshot.snapshot.formulas)) return fail('readback_mismatch', 'copy_range readback differs from source matrix')
        return { requested: { sourceRange: sourceAddress, destinationRange: destinationAddress }, observed: { sourceRange: sourceAddress, destinationRange: destinationAddress, values: after.snapshot.values, formulas: after.snapshot.formulas, runtimeResult: result, verified: true } }
      }
      if (typeof destination.PasteSpecial !== 'function') return fail('unsupported', 'WebEdit does not expose Range.PasteSpecial')
      const typeMap = { all: 1, formulas: 2, values: 3, allExceptBorders: 4, columnWidths: 5, valuesAndNumberFormats: 7, formats: 8, comments: 9, validation: 10 }; const operationMap = { none: 0, add: 1, subtract: 2, multiply: 3, divide: 4 }
      const pasteType = typeMap[payload.pasteType ?? 'values']; const pasteOperation = operationMap[payload.operation ?? 'none']
      if (!Number.isInteger(pasteType) || !Number.isInteger(pasteOperation)) return fail('invalid_range', 'paste_special options are not supported')
      const pasteKind = payload.pasteType ?? 'values'
      if (!['values', 'formulas'].includes(pasteKind) || payload.operation !== undefined && payload.operation !== 'none' || payload.skipBlanks === true || payload.transpose === true || !same(sourceSnapshot.snapshot.values.map((row) => row.length), before.snapshot.values.map((row) => row.length)) || sourceSnapshot.snapshot.values.length !== before.snapshot.values.length) return fail('unsupported', 'This PasteSpecial mode lacks a bounded exact matrix and non-target preservation contract')
      const expectedValues = pasteKind === 'values' ? sourceSnapshot.snapshot.values : before.snapshot.values; const expectedFormulas = pasteKind === 'formulas' ? sourceSnapshot.snapshot.formulas : before.snapshot.formulas
      try { await resolve(source.Copy()); await resolve(destination.PasteSpecial(pasteType, pasteOperation, payload.skipBlanks === true, payload.transpose === true)) } catch { return fail('runtime_error', 'WebEdit Range.PasteSpecial failed') }
      const after = await rangeSnapshot(resolved.sheet, destinationAddress); if (after.error) return after.error
      if (!same(after.snapshot.values, expectedValues) || !same(after.snapshot.formulas, expectedFormulas)) return fail('readback_mismatch', 'PasteSpecial readback differs from the exact requested matrix')
      return { requested: { sourceRange: sourceAddress, destinationRange: destinationAddress, pasteType: payload.pasteType ?? 'values', operation: payload.operation ?? 'none', skipBlanks: payload.skipBlanks === true, transpose: payload.transpose === true }, observed: { destinationRange: destinationAddress, values: after.snapshot.values, formulas: after.snapshot.formulas, verified: true } }
    }
    if (request.operation === 'recalculate') {
      const workbook = resolved.workbook; const method = workbook && (typeof workbook.Recalculate === 'function' ? 'Recalculate' : typeof workbook.recalculate === 'function' ? 'recalculate' : null)
      if (!method) return fail('unsupported', 'WebEdit does not expose Workbook.Recalculate')
      const before = request.precondition?.recalculateTime
      let result; try { result = await resolve(workbook[method]()) } catch { return fail('runtime_error', 'WebEdit workbook recalculation failed') }
      const callbackId = await property(result, 'callBackId') ?? await property(result, 'callbackId'); const after = await property(result, 'recalculateTime') ?? await property(workbook, 'recalculateTime') ?? await property(workbook, 'RecalculateTime')
      if ((callbackId === undefined || callbackId === null) && (after === undefined || after === null || same(before, after))) return fail('readback_mismatch', 'WebEdit Recalculate did not expose a completion token or changed recalculation time')
      return { requested: {}, observed: { callbackId: callbackId ?? null, before: before ?? null, after: after ?? null, commandVerified: true, formulaResultsVerified: false, verified: true } }
    }
    if (request.operation === 'undo' || request.operation === 'redo') {
      const count = Number.isInteger(payload.count) ? payload.count : 1; if (count < 1 || count > 20) return fail('invalid_range', `${request.operation} count is out of bounds`)
      const method = request.operation === 'undo' ? 'undo' : 'redo'; const fn = resolved.app && (typeof resolved.app[method] === 'function' ? resolved.app[method] : typeof resolved.app[method[0].toUpperCase() + method.slice(1)] === 'function' ? resolved.app[method[0].toUpperCase() + method.slice(1)] : null)
      if (!fn) return fail('unsupported', `WebEdit does not expose ${method}`)
      let result; try { result = await resolve(fn.call(resolved.app, count)) } catch { return fail('runtime_error', `WebEdit ${method} failed`) }
      if (result && (result.errName || result.errorCode)) return fail('runtime_error', `WebEdit ${method} reported failure`)
      const before = request.precondition?.undoRedo; const after = await undoRedoSnapshot(resolved)
      const verified = request.operation === 'undo'
        ? !!before?.history && !!after.history && after.history.undo === before.history.undo - count && after.history.redo === before.history.redo + count
        : !!before?.history && !!after.history && after.history.redo === before.history.redo - count && after.history.undo === before.history.undo + count
      if (verified) return { requested: { count }, observed: { count, runtimeResult: result ?? null, before, after, historyVerified: true, verified: true } }
      const observableChange = !same(before?.selection, after.selection) || !same(before?.usedRange, after.usedRange) || !same(before?.history, after.history)
      return { verificationStatus: 'write_incomplete', requested: { count }, observed: { count, runtimeResult: result ?? null, before, after, observableChange, historyVerified: false, reason: 'WebEdit did not expose matching bounded undo/redo history counters' } }
    }
    if (typeof address !== 'string' || address.length > 128) return fail('invalid_range', 'payload.range is required and bounded')
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const advanced = await advancedWrite(resolved, request, range, address); if (advanced) return advanced
    if (STRUCTURAL_OPERATIONS.has(request.operation)) {
      const spec = structuralRequest(request.operation, payload); const approved = request.precondition?.structure
      if (!spec || !approved?.footprint) return fail('fingerprint_mismatch', 'The structural write is missing its inspected bounded footprint')
      const targetAddress = spec.rows ? `${spec.target.rowFrom}:${spec.target.rowTo}` : spec.columns ? `${columnName(spec.target.colFrom)}:${columnName(spec.target.colTo)}` : address
      const base = await rangeFor(resolved.sheet, targetAddress); const target = spec.rows ? await property(base, 'EntireRow') : spec.columns ? await property(base, 'EntireColumn') : base
      const method = spec.inserting ? (typeof target?.Insert === 'function' ? 'Insert' : typeof target?.insert === 'function' ? 'insert' : null) : (typeof target?.Delete === 'function' ? 'Delete' : typeof target?.delete === 'function' ? 'delete' : null)
      if (!target || !method) return fail('unsupported', `WebEdit does not expose ${request.operation} API`)
      const direction = spec.direction === 'down' ? 'etShiftDown' : spec.direction === 'up' ? 'etShiftUp' : spec.direction === 'right' ? 'etShiftRight' : 'etShiftLeft'
      for (let index = 0; index < spec.count; index += 1) {
        const callback = await callbackResult((done) => spec.inserting ? target[method](direction, done, payload.position !== 'after') : target[method](direction, done))
        if (!callback.callbackInvoked || callback.callbackError) return fail('readback_mismatch', `WebEdit ${request.operation} did not callback-confirm structural completion`)
      }
      const after = await structuralFootprint(resolved, spec, approved.footprint.bounds); const expected = structuralExpected(approved.footprint, spec)
      if (!after || !expected || after.address !== approved.footprint.address || !same(after.values, expected.values) || !same(after.formulas, expected.formulas)) return fail('readback_mismatch', `${request.operation} readback does not match its exact bounded value/formula displacement`)
      return { requested: { range: payload.range, count: spec.count, ...(payload.shift ? { shift: payload.shift } : {}), ...(payload.position ? { position: payload.position } : {}) }, observed: { footprint: after.address, usedRangeBefore: approved.footprint.usedAddress, usedRangeAfter: after.usedAddress, values: after.values, formulas: after.formulas, verified: true } }
    }
    if (request.operation === 'auto_fill') {
      const destinationAddress = typeof payload.destination === 'string' ? payload.destination : ''
      const destination = await rangeFor(resolved.sheet, destinationAddress)
      const sourceParsed = parseAddress(address); const destinationParsed = parseAddress(destinationAddress)
      if (!destination || !sourceParsed || !destinationParsed || typeof range.AutoFill !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded Range.AutoFill contract')
      const before = await rangeSnapshot(resolved.sheet, destinationAddress); if (before.error) return before.error
      const sourceBefore = await rangeSnapshot(resolved.sheet, address); if (sourceBefore.error) return sourceBefore.error
      const destinationPrecondition = await writePrecondition(destination, destinationAddress)
      if (!destinationPrecondition) return fail('unsupported', 'WebEdit cannot inspect the auto_fill destination')
      const requestedRows = destinationParsed.rowTo - destinationParsed.rowFrom + 1; const requestedColumns = destinationParsed.colTo - destinationParsed.colFrom + 1
      const sourceRows = sourceParsed.rowTo - sourceParsed.rowFrom + 1; const sourceColumns = sourceParsed.colTo - sourceParsed.colFrom + 1
      if (requestedRows * requestedColumns > 20_000 || destinationParsed.rowFrom !== sourceParsed.rowFrom || destinationParsed.colFrom !== sourceParsed.colFrom || destinationParsed.rowTo < sourceParsed.rowTo || destinationParsed.colTo < sourceParsed.colTo || !((requestedRows > sourceRows && requestedColumns === sourceColumns) || (requestedColumns > sourceColumns && requestedRows === sourceRows))) return fail('invalid_range', 'auto_fill destination must contain the source at the same top-left and extend exactly one axis')
      for (let row = 0; row < requestedRows; row += 1) for (let column = 0; column < requestedColumns; column += 1) if (row >= sourceRows || column >= sourceColumns) if (!blankCell(before.snapshot.values[row][column]) || !blankCell(before.snapshot.formulas[row][column])) return fail('invalid_range', 'auto_fill extension cells must be blank')
      try { await resolve(range.AutoFill(destination, 0)) } catch { return fail('runtime_error', 'WebEdit AutoFill failed') }
      const after = await rangeSnapshot(resolved.sheet, destinationAddress); if (after.error) return after.error
      const sourceAfter = await rangeSnapshot(resolved.sheet, address); if (sourceAfter.error || blankSnapshot(after.snapshot) || !same(sourceAfter.snapshot, sourceBefore.snapshot)) return fail('readback_mismatch', 'WebEdit AutoFill did not preserve the source or produce a readable extension')
      return { requested: { range: address, destination: destinationAddress }, observed: { range: address, destination: destinationAddress, values: after.snapshot.values, formulas: after.snapshot.formulas, verified: true } }
    }
    if (request.operation === 'batch_write') {
      if (!batch || !await setValues(range, batch.values)) return fail('unsupported', 'WebEdit does not expose an atomic rectangular value write API')
      const after = await rangeSnapshot(resolved.sheet, batch.range)
      const state = await writePrecondition(range, batch.range)
      if (after.error || !state || !same(after.snapshot.values, batch.values) || !blankMatrix(after.snapshot.formulas) || !same({ ...state.state, values: request.precondition?.state?.values, formulas: request.precondition?.state?.formulas }, request.precondition?.state)) return fail('readback_mismatch', 'batch_write readback differs from every requested cell, formula state, or non-value target state')
      return { requested: { range: batch.range, cells: batch.cells }, observed: { range: batch.range, values: after.snapshot.values, formulas: after.snapshot.formulas, state: state.state, verified: true } }
    }
    if (request.operation === 'fill_range') {
      const before = await rangeSnapshot(resolved.sheet, address); const direction = payload.direction; const expected = before.error ? null : directionalFillExpected(before.snapshot.values, direction)
      if (before.error) return before.error
      if (!expected || before.snapshot.formulas.some((row) => row.some((formula) => !blankCell(formula)))) return fail('unsupported', 'fill_range supports only a changing, formula-free rectangular value range with deterministic directional output')
      if (!await setValues(range, expected)) return fail('unsupported', 'WebEdit does not expose an atomic rectangular value write API for deterministic directional fill')
      const after = await rangeSnapshot(resolved.sheet, address); if (after.error) return after.error
      const state = await writePrecondition(range, address)
      if (!state || !same(after.snapshot.values, expected) || !blankMatrix(after.snapshot.formulas) || !same({ ...state.state, values: request.precondition?.state?.values, formulas: request.precondition?.state?.formulas }, request.precondition?.state)) return fail('readback_mismatch', 'deterministic directional fill readback differs from expected values, formula state, or non-value target state')
      return { requested: { range: address, direction, strategy: 'atomic_set_values' }, observed: { range: address, values: after.snapshot.values, formulas: after.snapshot.formulas, state: state.state, verified: true } }
    }
    if (request.operation === 'replace_range_text') {
      const what = payload.what; const replacement = payload.replacement ?? ''
      if (typeof what !== 'string' || !what || what.length > 1000 || typeof replacement !== 'string' || replacement.length > 4000 || typeof range.Replace !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded Range.Replace contract')
      const before = await rangeSnapshot(resolved.sheet, address); if (before.error) return before.error
      let replacements = 0; let formulaMatch = false
      const expected = before.snapshot.values.map((row) => row.map((value) => { const next = replacementValue(value, what, replacement, payload.matchEntireCell === true, payload.matchCase === true); replacements += next.count; return next.value }))
      const expectedFormulas = before.snapshot.formulas.map((row) => row.map((formula) => typeof formula === 'string' && formula.startsWith('=') ? replacementValue(formula, what, replacement, payload.matchEntireCell === true, payload.matchCase === true).value : formula))
      before.snapshot.formulas.forEach((row) => row.forEach((formula) => { if (typeof formula === 'string' && formula.startsWith('=') && replacementValue(formula, what, replacement, payload.matchEntireCell === true, payload.matchCase === true).count > 0) formulaMatch = true }))
      if (formulaMatch && payload.allowFormulaChanges !== true) return fail('invalid_range', 'replace_range_text would change formulas without explicit confirmation')
      if (replacements === 0 && payload.allowNoop !== true) return fail('invalid_range', 'replace_range_text requires at least one matching value')
      await resolve(range.Replace(what, replacement, payload.matchEntireCell === true ? 'etWhole' : 'etPart', payload.searchOrder === 'columns' ? 'etByColumns' : 'etByRows', payload.matchCase === true))
      const after = await rangeSnapshot(resolved.sheet, address); if (after.error) return after.error
      if (!same(after.snapshot.values, expected) || !same(after.snapshot.formulas, expectedFormulas)) return fail('readback_mismatch', 'WebEdit Replace readback differs from the exact expected matrix or formulas')
      return { requested: { range: address, what, replacement, matchEntireCell: payload.matchEntireCell === true, matchCase: payload.matchCase === true, allowFormulaChanges: payload.allowFormulaChanges === true }, observed: { range: address, values: after.snapshot.values, formulas: after.snapshot.formulas, replacementCount: replacements, verified: true } }
    }
    if (request.operation === 'text_to_columns') {
      const parsed = parseAddress(address); const delimiter = ({ comma: ',', tab: '\t', semicolon: ';', space: ' ', other: payload.otherDelimiter })[payload.delimiter ?? 'comma']
      if (!parsed || parsed.colFrom !== parsed.colTo || typeof delimiter !== 'string' || delimiter.length !== 1 || typeof range.TextToColumns !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded single-column TextToColumns contract')
      const source = await rangeSnapshot(resolved.sheet, address); if (source.error) return source.error
      const split = source.snapshot.values.map((row) => splitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true)); const width = split.reduce((maximum, row) => Math.max(maximum, row.length), 1)
      if (width > 50 || split.length * width > 20_000 || source.snapshot.formulas.some((row) => row.some((formula) => !blankCell(formula))) || source.snapshot.values.some((row) => hasUnclosedQuote(row[0]) || splitDelimited(row[0], delimiter, payload.consecutiveDelimiter === true).some(textTokenIsTypeAmbiguous))) return fail('unsupported', 'text_to_columns formulas, unclosed quotes, or type-ambiguous tokens lack a safe exact readback contract')
      const outputAddress = addressFor({ ...parsed, colTo: parsed.colFrom + width - 1 }); const output = await rangeFor(resolved.sheet, outputAddress); const beforeOutput = await rangeSnapshot(resolved.sheet, outputAddress)
      if (!output || beforeOutput.error) return fail('unsupported', 'WebEdit cannot read the complete text_to_columns output footprint')
      for (let row = 0; row < beforeOutput.snapshot.values.length; row += 1) for (let column = 1; column < beforeOutput.snapshot.values[row].length; column += 1) if ((!blankCell(beforeOutput.snapshot.values[row][column]) || !blankCell(beforeOutput.snapshot.formulas[row][column])) && payload.overwrite !== true) return fail('invalid_range', 'text_to_columns destination contains nonblank cells outside the source')
      const expected = split.map((row) => [...row, ...Array(width - row.length).fill(null)])
      await resolve(range.TextToColumns(range, 1, 1, payload.consecutiveDelimiter === true, payload.delimiter === 'tab', payload.delimiter === 'semicolon', !payload.delimiter || payload.delimiter === 'comma', payload.delimiter === 'space', payload.delimiter === 'other', payload.delimiter === 'other' ? delimiter : undefined))
      const after = await rangeSnapshot(resolved.sheet, outputAddress); if (after.error) return after.error
      if (!same(after.snapshot.values, expected) || !blankMatrix(after.snapshot.formulas)) return fail('readback_mismatch', 'WebEdit TextToColumns readback differs from the exact expected matrix or blank formulas')
      return { requested: { range: address, outputRange: outputAddress, delimiter: payload.delimiter ?? 'comma', consecutiveDelimiter: payload.consecutiveDelimiter === true }, observed: { range: address, outputRange: outputAddress, values: after.snapshot.values, formulas: after.snapshot.formulas, verified: true } }
    }
    if (request.operation === 'remove_duplicates') {
      const columns = Array.isArray(payload.columns) ? payload.columns : []; const hasHeader = payload.hasHeader !== false
      const before = await rangeSnapshot(resolved.sheet, address); if (before.error) return before.error
      if (typeof range.RemoveDuplicates !== 'function' || columns.length === 0 || columns.length > before.snapshot.values[0]?.length || columns.some((column) => !Number.isInteger(column) || column < 1 || column > before.snapshot.values[0].length) || new Set(columns).size !== columns.length) return fail('unsupported', 'WebEdit does not expose a bounded RemoveDuplicates contract')
      const expected = hasHeader ? [before.snapshot.values[0].slice()] : []; const expectedFormulas = hasHeader ? [before.snapshot.formulas[0].slice()] : []; const seen = new Set(); let removed = 0
      for (let row = hasHeader ? 1 : 0; row < before.snapshot.values.length; row += 1) { const value = before.snapshot.values[row]; const key = columns.map((column) => duplicateValue(value[column - 1])).join('\u001f'); if (seen.has(key)) removed += 1; else { seen.add(key); expected.push(value.slice()); expectedFormulas.push(before.snapshot.formulas[row].slice()) } }
      if (removed === 0 && payload.allowNoop !== true) return fail('invalid_range', 'remove_duplicates requires at least one duplicate row')
      while (expected.length < before.snapshot.values.length) { expected.push(Array(before.snapshot.values[0].length).fill(null)); expectedFormulas.push(Array(before.snapshot.values[0].length).fill('')) }
      await resolve(range.RemoveDuplicates(columns, hasHeader ? 1 : 2))
      const after = await rangeSnapshot(resolved.sheet, address); if (after.error) return after.error
      if (!same(after.snapshot.values, expected) || !same(after.snapshot.formulas, expectedFormulas)) return fail('readback_mismatch', 'WebEdit RemoveDuplicates readback differs from the exact expected values or formulas')
      return { requested: { range: address, columns, hasHeader }, observed: { range: address, values: after.snapshot.values, formulas: after.snapshot.formulas, duplicateRowsRemoved: removed, verified: true } }
    }
    if (request.operation === 'move_range') {
      const sourceParsed = parseAddress(address); const requested = parseAddress(payload.destination)
      if (!sourceParsed || !requested || typeof range.Cut !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded Range.Cut contract')
      const source = await rangeSnapshot(resolved.sheet, address); if (source.error) return source.error
      const rows = sourceParsed.rowTo - sourceParsed.rowFrom + 1; const columns = sourceParsed.colTo - sourceParsed.colFrom + 1
      if (!((requested.rowFrom === requested.rowTo && requested.colFrom === requested.colTo) || (requested.rowTo - requested.rowFrom + 1 === rows && requested.colTo - requested.colFrom + 1 === columns))) return fail('invalid_range', 'move_range destination must be one cell or match source dimensions')
      const outputParsed = { rowFrom: requested.rowFrom, colFrom: requested.colFrom, rowTo: requested.rowFrom + rows - 1, colTo: requested.colFrom + columns - 1 }; if (overlap(sourceParsed, outputParsed)) return fail('invalid_range', 'move_range source and destination must not overlap')
      const outputAddress = addressFor(outputParsed); const destination = await rangeFor(resolved.sheet, outputAddress); const beforeDestination = await rangeSnapshot(resolved.sheet, outputAddress)
      if (!destination || beforeDestination.error) return fail('unsupported', 'WebEdit cannot read the complete move destination')
      if ((!blankMatrix(beforeDestination.snapshot.values) || !blankMatrix(beforeDestination.snapshot.formulas)) && payload.overwrite !== true) return fail('invalid_range', 'move_range destination must be blank unless overwrite is explicit')
      const sourceCondition = await writePrecondition(range, address); const destinationCondition = await writePrecondition(destination, outputAddress)
      if (!sourceCondition || !destinationCondition || !defaultMoveState(sourceCondition.state) || !defaultMoveState(destinationCondition.state)) return fail('unsupported', 'move_range requires explicitly readable unmerged default formatting before mutation')
      const result = await resolve(range.Cut(destination)); if (result !== true) return fail('readback_mismatch', 'WebEdit did not confirm Range.Cut completion')
      const sourceAfter = await rangeSnapshot(resolved.sheet, address); const destinationAfter = await rangeSnapshot(resolved.sheet, outputAddress); const destinationFormat = await writePrecondition(destination, outputAddress)
      if (sourceAfter.error || destinationAfter.error || !destinationFormat) return fail('readback_mismatch', 'WebEdit could not read move_range results')
      if (!blankMatrix(sourceAfter.snapshot.values) || !blankMatrix(sourceAfter.snapshot.formulas) || !same(destinationAfter.snapshot.values, source.snapshot.values) || !same(destinationAfter.snapshot.formulas, source.snapshot.formulas) || destinationFormat.state.merged !== sourceCondition.state.merged || !same(destinationFormat.state.format, sourceCondition.state.format)) return fail('readback_mismatch', 'WebEdit move_range readback does not prove values, formulas, and format moved')
      return { requested: { range: address, destination: payload.destination, outputRange: outputAddress }, observed: { range: address, outputRange: outputAddress, sourceBlank: true, sourceValues: sourceAfter.snapshot.values, sourceFormulas: sourceAfter.snapshot.formulas, values: destinationAfter.snapshot.values, formulas: destinationAfter.snapshot.formulas, format: destinationFormat.state.format, merged: destinationFormat.state.merged, verified: true } }
    }
    if (request.operation === 'set_values') {
      if (!Array.isArray(payload.values) || !await setValues(range, payload.values)) return fail('unsupported', 'WebEdit does not expose a range value write API')
      const readback = await rangeSnapshot(resolved.sheet, address); if (readback.error) return readback.error
      const observed = readback.snapshot; if (!same(observed.values, payload.values)) return fail('readback_mismatch', 'WebEdit readback differs from requested values')
      return { requested: { range: address, values: payload.values }, observed: { range: address, values: observed.values, verified: true } }
    }
    if (request.operation === 'set_formula') {
      if (!Array.isArray(payload.formulas) || !await setFormula(range, payload.formulas)) return fail('unsupported', 'WebEdit does not expose a range formula write API')
      const readback = await rangeSnapshot(resolved.sheet, address); if (readback.error) return readback.error
      const observed = readback.snapshot; if (!same(observed.formulas, payload.formulas)) return fail('readback_mismatch', 'WebEdit formula readback differs from request')
      return { requested: { range: address, formulas: payload.formulas }, observed: { range: address, formulas: observed.formulas, verified: true } }
    }
    if (request.operation === 'clear') {
      const hasClear = typeof range.clearContents === 'function' || typeof range.ClearContents === 'function'
      if (!hasClear) return fail('unsupported', 'WebEdit must expose ClearContents; generic Clear may also erase format, comments, or validation')
      if (typeof range.clearContents === 'function') await resolve(range.clearContents())
      else await resolve(range.ClearContents())
      const readback = await rangeSnapshot(resolved.sheet, address); if (readback.error) return readback.error
      const observed = readback.snapshot; const state = await writePrecondition(range, address)
      if (!blankSnapshot(observed) || !state || !same({ ...state.state, values: request.precondition?.state?.values, formulas: request.precondition?.state?.formulas }, request.precondition?.state)) return fail('readback_mismatch', 'WebEdit clear did not preserve every inspected non-content range state')
      return { requested: { range: address, clear: true }, observed: { range: address, values: observed.values, formulas: observed.formulas, state: state.state, isBlank: true, verified: true } }
    }
    if (request.operation === 'format') {
      const allowed = new Set(['range', 'font', 'fill', 'numberFormat', 'alignment', 'wrap', 'border'])
      const fontKeys = new Set(['bold', 'italic', 'underline', 'size', 'name', 'color'])
      const hasUnsupportedFormatField = !Object.keys(payload).every((key) => allowed.has(key))
      const hasUnsupportedFontField = payload.font !== undefined && (!payload.font || typeof payload.font !== 'object' || Array.isArray(payload.font) || !Object.keys(payload.font).every((key) => fontKeys.has(key)))
      if (hasUnsupportedFormatField || hasUnsupportedFontField) return fail('unsupported', 'WebEdit format request includes fields without a readable verification contract')
      const font = await property(range, 'Font') ?? {}; const interior = await property(range, 'Interior') ?? {}; const requested = payload
      let applied = false
      if (requested.font && typeof requested.font === 'object') for (const [key, value] of Object.entries(requested.font)) { const mapped = ({ bold: 'Bold', italic: 'Italic', underline: 'Underline', size: 'Size', name: 'Name', color: 'Color' })[key] ?? key; applied = await set(font, mapped, value) || applied; await set(font, key, value) }
      if (typeof requested.fill === 'string') { applied = await set(interior, 'Color', requested.fill) || applied; await set(interior, 'color', requested.fill) }
      const requestedBorders = requested.border && typeof requested.border === 'object' && !Array.isArray(requested.border) ? Object.fromEntries(Object.entries(requested.border).map(([side, spec]) => [side, spec && typeof spec === 'object' ? spec.color : spec])) : null
      if (requested.border && (!requestedBorders || Object.keys(requestedBorders).length === 0 || Object.values(requestedBorders).some((color) => color === undefined || color === null))) return fail('invalid_range', 'format border requires one or more sides with exact colors')
      if (requestedBorders) { const borders = await property(range, 'Borders'); if (!borders || !request.precondition?.borders) return fail('unsupported', 'WebEdit does not expose preflighted readable Borders'); for (const [side, color] of Object.entries(requestedBorders)) { const target = borders[side]; if (!target || !await set(target, 'Color', color)) return fail('unsupported', 'WebEdit border mutation is unavailable'); applied = true } }
      for (const [key, value] of [['NumberFormat', requested.numberFormat], ['HorizontalAlignment', requested.alignment], ['WrapText', requested.wrap]]) if (value !== undefined) { applied = await set(range, key, value) || applied; await set(range, key === 'NumberFormat' ? 'numberFormat' : key === 'WrapText' ? 'wrap' : 'alignment', value) }
      if (!applied) return fail('unsupported', 'WebEdit does not expose requested formatting APIs')
      const observed = { font: { bold: await property(font, 'bold') ?? await property(font, 'Bold'), italic: await property(font, 'italic') ?? await property(font, 'Italic'), underline: await property(font, 'underline') ?? await property(font, 'Underline'), size: await property(font, 'size') ?? await property(font, 'Size'), name: await property(font, 'name') ?? await property(font, 'Name'), color: await property(font, 'color') ?? await property(font, 'Color') }, fill: await property(interior, 'color') ?? await property(interior, 'Color'), numberFormat: await property(range, 'numberFormat') ?? await property(range, 'NumberFormat'), alignment: await property(range, 'alignment') ?? await property(range, 'HorizontalAlignment'), wrap: await property(range, 'wrap') ?? await property(range, 'WrapText') }
      const fontMatches = !requested.font || Object.entries(requested.font).every(([key, value]) => same(observed.font[key], value))
      const observedBorders = requestedBorders ? await borderSnapshot(range, Object.keys(requestedBorders)) : null
      if (!fontMatches || (requested.fill !== undefined && !same(observed.fill, requested.fill)) || (requested.numberFormat !== undefined && !same(observed.numberFormat, requested.numberFormat)) || (requested.alignment !== undefined && !same(observed.alignment, requested.alignment)) || (requested.wrap !== undefined && !same(observed.wrap, requested.wrap)) || (requestedBorders && (!observedBorders || !Object.entries(requestedBorders).every(([side, color]) => same(observedBorders[side]?.color, color))))) return fail('readback_mismatch', 'WebEdit format readback differs from the requested fields')
      return { requested: { range: address, format: payload }, observed: { range: address, format: { ...observed, ...(observedBorders ? { borders: observedBorders } : {}) }, verified: true } }
    }
    if (request.operation === 'merge' || request.operation === 'unmerge') {
      const merged = request.operation === 'merge'; const method = merged ? (await call(range, 'merge', []) ?? await call(range, 'Merge', [])) : (await call(range, 'unmerge', []) ?? await call(range, 'UnMerge', []))
      if (method === undefined && !await set(range, 'MergeCells', merged)) return fail('unsupported', 'WebEdit does not expose merge APIs')
      const observed = await property(range, 'MergeCells')
      if (typeof observed !== 'boolean' || observed !== merged) return fail('readback_mismatch', 'WebEdit merge readback differs from request')
      return { requested: { range: address, merged }, observed: { range: address, merged: observed, verified: true } }
    }
    const dimension = request.operation.includes('columns') || request.operation === 'column_width' ? await property(range, 'EntireColumn') : await property(range, 'EntireRow')
    if (request.operation === 'row_height' || request.operation === 'column_width') {
      const key = request.operation === 'row_height' ? 'RowHeight' : 'ColumnWidth'; const amount = payload.value
      const method = request.operation === 'row_height' ? 'setRowHeight' : 'setColumnWidth'
      if (typeof amount !== 'number' || !Number.isFinite(amount) || (!(dimension ?? range) || (typeof (dimension ?? range)[method] !== 'function' && !await set(dimension ?? range, key, amount)))) return fail('unsupported', 'WebEdit does not expose requested dimension API')
      if (typeof (dimension ?? range)[method] === 'function') await resolve((dimension ?? range)[method](amount))
      const observed = await property(dimension ?? range, key); if (observed !== amount) return fail('readback_mismatch', 'WebEdit dimension readback differs from request')
      return { requested: { range: address, [key]: amount }, observed: { range: address, [key]: observed, verified: true } }
    }
    return fail('unsupported', `WebEdit does not expose a range API/readback contract for ${request.operation}`)
  }
  async function writeSheet(resolved, request) {
    const payload = request.payload ?? {}; const before = await worksheetSnapshot(resolved.workbook)
    if (!before) return fail('unsupported', 'WebEdit does not expose readable worksheet enumeration')
    const validName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 31
    if (request.operation === 'sheet_add') {
      const name = payload.name?.trim()
      if (!validName(payload.name) || before.names.includes(name)) return fail('invalid_range', 'sheet_add requires a unique bounded worksheet name')
      const created = await call(before.collection, 'Add', [name]) ?? await call(before.collection, 'add', [name])
      if (created && (await property(created, 'Name')) !== name && !await set(created, 'Name', name)) return fail('unsupported', 'WebEdit cannot name a newly-created worksheet')
      const after = await worksheetSnapshot(resolved.workbook)
      if (!after || after.count !== before.count + 1 || after.names.filter((item) => item === name).length !== 1) return fail('readback_mismatch', 'WebEdit worksheet add readback differs from request')
      return { requested: { name }, observed: { name, beforeCount: before.count, afterCount: after.count, verified: true } }
    }
    if (request.operation === 'copy_worksheet') {
      const sourceName = typeof payload.sourceName === 'string' ? payload.sourceName : payload.name
      if (typeof sourceName !== 'string' || !before.names.includes(sourceName) || typeof before.collection.copy !== 'function') return fail('unsupported', 'WebEdit does not expose worksheet copy with bounded collection readback')
      const source = await call(before.collection, 'Item', [sourceName]); if (!source) return fail('invalid_range', 'WebEdit could not resolve the worksheet to copy')
      const activeBefore = before.sheets.find((item) => item.active === true)?.name
      if (activeBefore !== sourceName) {
        if (typeof source.Activate !== 'function' || !activeBefore) return fail('unsupported', 'WebEdit cannot select the requested worksheet before copy')
        await resolve(source.Activate())
      }
      const copied = await resolve(before.collection.copy(false))
      if (!copied) return fail('unsupported', 'WebEdit worksheet copy did not return a worksheet')
      const requestedName = typeof payload.newName === 'string' ? payload.newName.trim() : null
      if (requestedName !== null) {
        if (!validName(requestedName) || before.names.includes(requestedName) || typeof copied.setName !== 'function') return fail('unsupported', 'WebEdit cannot safely name the copied worksheet')
        await resolve(copied.setName(requestedName))
      }
      const after = await worksheetSnapshot(resolved.workbook); const copiedName = requestedName ?? await property(copied, 'Name')
      if (!after || after.count !== before.count + 1 || typeof copiedName !== 'string' || !after.names.includes(copiedName)) return fail('readback_mismatch', 'WebEdit worksheet copy readback differs from request')
      if (activeBefore && activeBefore !== sourceName) { const restore = await call(before.collection, 'Item', [activeBefore]); if (restore && typeof restore.Activate === 'function') await resolve(restore.Activate()) }
      return { requested: { sourceName, newName: requestedName }, observed: { sourceName, name: copiedName, beforeCount: before.count, afterCount: after.count, verified: true } }
    }
    const name = payload.name ?? payload.sheetName; const sheet = await call(before.collection, 'Item', [name]) ?? await call(resolved.workbook, 'getWorksheet', [name])
    if (typeof name !== 'string' || !sheet || !before.names.includes(name)) return fail('invalid_range', 'WebEdit could not resolve the requested worksheet')
    if (request.operation === 'sheet_rename') {
      const newName = payload.newName?.trim()
      if (!validName(payload.newName) || before.names.includes(newName)) return fail('invalid_range', 'sheet_rename requires a unique bounded worksheet name')
      if (typeof sheet.setName === 'function') await resolve(sheet.setName(newName)); else if (!await set(sheet, 'Name', newName)) return fail('unsupported', 'WebEdit cannot rename this worksheet')
      const after = await worksheetSnapshot(resolved.workbook)
      if (!after || after.count !== before.count || after.names.includes(name) || after.names.filter((item) => item === newName).length !== 1) return fail('readback_mismatch', 'WebEdit worksheet rename readback differs from request')
      return { requested: { name, newName }, observed: { name: newName, beforeCount: before.count, afterCount: after.count, verified: true } }
    }
    if (request.operation === 'sheet_delete') {
      if (before.count <= 1) return fail('unsupported', 'WebEdit will not delete the last worksheet')
      if (typeof sheet.Delete === 'function') await resolve(sheet.Delete()); else if (typeof sheet.delete === 'function') await resolve(sheet.delete()); else return fail('unsupported', 'WebEdit cannot delete this worksheet')
      const after = await worksheetSnapshot(resolved.workbook)
      if (!after || after.count !== before.count - 1 || after.names.includes(name)) return fail('readback_mismatch', 'WebEdit worksheet delete readback differs from request')
      return { requested: { name, deleted: true }, observed: { name, deleted: true, beforeCount: before.count, afterCount: after.count, verified: true } }
    }
    if (request.operation === 'sheet_select') {
      if (typeof sheet.Activate === 'function') await resolve(sheet.Activate()); else if (typeof sheet.Select === 'function') await resolve(sheet.Select()); else if (typeof sheet.activate === 'function') await resolve(sheet.activate()); else return fail('unsupported', 'WebEdit cannot select this worksheet')
      const active = await call(resolved.app, 'getActiveSheet') ?? await property(resolved.app, 'ActiveSheet')
      const activeName = await call(active, 'getName') ?? await property(active, 'Name')
      if (activeName !== name) return fail('readback_mismatch', 'WebEdit active worksheet readback differs from request')
      return { requested: { name }, observed: { name: activeName, verified: true } }
    }
    return fail('unsupported', 'unsupported spreadsheet sheet operation')
  }
  async function writeWorkbook(resolved, request) {
    const payload = request.payload ?? {}; const before = await worksheetSnapshot(resolved.workbook); if (!before) return fail('unsupported', 'WebEdit does not expose readable worksheet enumeration')
    const sheetsByName = new Map(before.sheets.map((sheet) => [sheet.name, sheet])); const validName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 31
    if (request.operation === 'create_defined_name' || request.operation === 'delete_defined_name') {
      const names = await definedNamesSnapshot(resolved.workbook); if (!names) return fail('unsupported', 'WebEdit does not expose readable defined names')
      const name = typeof payload.name === 'string' ? payload.name.trim() : ''
      if (!validName(name) || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return fail('invalid_range', 'defined name must be a bounded identifier')
      const existing = names.names.find((item) => item.name === name)
      if (request.operation === 'create_defined_name') {
        const refersTo = typeof payload.refersTo === 'string' ? payload.refersTo.trim() : ''; const visible = payload.visible === undefined ? true : payload.visible
        if (payload.scope !== undefined && payload.scope !== 'workbook') return fail('unsupported', 'only workbook-scope defined names have a stable write/readback contract')
        if (!refersTo || typeof visible !== 'boolean' || existing || typeof names.collection.Add !== 'function') return fail('unsupported', 'WebEdit cannot create this defined name with exact readback')
        await resolve(names.collection.Add(name, refersTo)); const after = await definedNamesSnapshot(resolved.workbook); const created = after?.names.find((item) => item.name === name)
        if (!after || !created || created.refersTo !== refersTo || created.visible !== visible || created.scope !== 'workbook' || !same(after.names.filter((item) => item.name !== name), names.names)) return fail('readback_mismatch', 'WebEdit defined-name create readback differs from request')
        return { requested: { name, refersTo, visible, scope: 'workbook' }, observed: { name: created.name, refersTo: created.refersTo, visible: created.visible, scope: created.scope, names: after.names, verified: true } }
      }
      if (!existing || typeof (await collectionItem(names.collection, names.names.indexOf(existing) + 1))?.Delete !== 'function') return fail('unsupported', 'WebEdit cannot delete this defined name with exact readback')
      const item = await collectionItem(names.collection, names.names.indexOf(existing) + 1); await resolve(item.Delete()); const after = await definedNamesSnapshot(resolved.workbook)
      if (!after || after.names.some((entry) => entry.name === name) || !same(after.names, names.names.filter((entry) => entry.name !== name))) return fail('readback_mismatch', 'WebEdit defined-name delete readback differs from request')
      return { requested: { name, refersTo: existing.refersTo, visible: existing.visible, scope: existing.scope }, observed: { name, deleted: true, names: after.names, verified: true } }
    }
    const sourceName = typeof payload.sourceName === 'string' ? payload.sourceName : typeof payload.sheetName === 'string' ? payload.sheetName : ''
    const source = await call(before.collection, 'Item', [sourceName]) ?? await call(resolved.workbook, 'getWorksheet', [sourceName])
    if (!source || !sheetsByName.has(sourceName)) return fail('invalid_range', 'WebEdit could not resolve the requested worksheet')
    if (request.operation === 'activate_worksheet') {
      if (!Object.keys(payload).every((key) => key === 'sheetName') || typeof payload.sheetName !== 'string' || payload.sheetName !== sourceName || before.sheets.filter((sheet) => sheet.active === true).length !== 1 || before.sheets.some((sheet) => sheet.active === null)) return fail('unsupported', 'WebEdit cannot prove a complete active-worksheet transition')
      if (typeof source.Activate === 'function') await resolve(source.Activate()); else if (typeof source.activate === 'function') await resolve(source.activate()); else if (typeof source.Select === 'function') await resolve(source.Select()); else return fail('unsupported', 'WebEdit does not expose worksheet activation')
      const after = await worksheetSnapshot(resolved.workbook); const expected = before.sheets.map((sheet) => ({ ...sheet, active: sheet.name === sourceName }))
      if (!after || after.sheets.filter((sheet) => sheet.active === true).length !== 1 || !same(after.sheets, expected)) return fail('readback_mismatch', 'WebEdit worksheet activation changed workbook state or did not activate the requested sheet')
      return { requested: { sheetName: sourceName }, observed: { sheetName: sourceName, sheets: after.sheets, verified: true } }
    }
    if (request.operation === 'set_worksheet_visibility') {
      const visible = payload.visible; if (typeof visible !== 'boolean' || before.sheets.some((sheet) => sheet.visible === null) || (visible === false && (before.sheets.filter((sheet) => sheet.visible === true).length <= 1 || sheetsByName.get(sourceName)?.active === true))) return fail('invalid_range', 'cannot hide the last or active worksheet')
      if (typeof source.setVisible === 'function') await resolve(source.setVisible(visible)); else if (!await set(source, 'Visible', visible)) return fail('unsupported', 'WebEdit does not expose worksheet visibility write/readback')
      const after = await worksheetSnapshot(resolved.workbook); const observed = after?.sheets.find((sheet) => sheet.name === sourceName)
      const expected = before.sheets.map((sheet) => sheet.name === sourceName ? { ...sheet, visible } : sheet)
      if (!after || !observed || observed.visible !== visible || !same(after.sheets, expected)) return fail('readback_mismatch', 'WebEdit worksheet visibility readback changed workbook state')
      return { requested: { sheetName: sourceName, visible }, observed: { sheetName: sourceName, visible: observed.visible, sheets: after.sheets, verified: true } }
    }
    if (request.operation === 'move_worksheet') {
      const index = payload.index; if (!Number.isInteger(index) || index < 1 || index > before.count || typeof before.collection.move !== 'function') return fail('invalid_range', 'move_worksheet requires a bounded target index and readable move API')
      const sourceId = await call(source, 'getObjID') ?? await property(source, 'Id'); const target = before.sheets.find((sheet) => sheet.index === index); const targetSheet = target ? await call(before.collection, 'Item', [target.index]) : null; const targetId = await call(targetSheet, 'getObjID') ?? await property(targetSheet, 'Id')
      if (sourceId == null || targetId == null) return fail('unsupported', 'WebEdit does not expose stable worksheet move identities')
      await resolve(before.collection.move(sourceId, targetId, null, false)); const after = await worksheetSnapshot(resolved.workbook)
      const expected = before.sheets.filter((sheet) => sheet.name !== sourceName); expected.splice(index - 1, 0, sheetsByName.get(sourceName)); const expectedSnapshot = expected.map((sheet, sheetIndex) => ({ ...sheet, index: sheetIndex + 1 }))
      if (!after || !same(after.sheets, expectedSnapshot)) return fail('readback_mismatch', 'WebEdit worksheet move order or non-target state differs from request')
      return { requested: { sourceName, index }, observed: { order: after.sheets.map((sheet) => sheet.name), sheets: after.sheets, verified: true } }
    }
    return fail('unsupported', 'unsupported workbook operation')
  }
  async function writeView(resolved, request) {
    const payload = request.payload ?? {}; const expected = requestedViewOperation(request.operation, payload); const before = request.precondition?.view; const snapshot = await viewSnapshot(resolved)
    if (!expected || !before || !snapshot.supported || !same(snapshot.view, before)) return fail('fingerprint_mismatch', 'The worksheet view changed since inspection; reread and inspect before writing')
    const window = snapshot.activeWindow
    if (request.operation === 'set_zoom') {
      if (!await set(window, 'Zoom', expected.zoom)) return fail('unsupported', 'WebEdit does not expose worksheet zoom mutation')
      const after = await viewSnapshot(resolved); if (!after.supported || after.view.zoom !== expected.zoom || !same({ ...after.view, zoom: before.zoom }, before)) return fail('readback_mismatch', 'WebEdit zoom readback changed another view field')
      return { requested: { zoom: expected.zoom }, observed: { view: after.view, verified: true } }
    }
    if (!expected.freeze) {
      if (!await set(window, 'FreezePanes', false)) return fail('unsupported', 'WebEdit does not expose worksheet freeze mutation')
      const after = await viewSnapshot(resolved); if (!after.supported || after.view.freezePanes !== false || after.view.zoom !== before.zoom || after.view.scrollRow !== before.scrollRow || after.view.scrollColumn !== before.scrollColumn || after.view.sheetName !== before.sheetName || after.view.activeCell !== before.activeCell) return fail('readback_mismatch', 'WebEdit unfreeze readback changed a non-target view field')
      return { requested: { freeze: false }, observed: { view: after.view, verified: true } }
    }
    const parsed = parseAddress(expected.target); const target = parsed && await rangeFor(resolved.sheet, expected.target)
    if (!parsed || !target || typeof target.Select !== 'function') return fail('unsupported', 'WebEdit does not expose a selectable freeze target')
    await resolve(target.Select()); const selected = await viewSnapshot(resolved)
    if (!selected.supported || selected.view.activeCell !== expected.target || selected.view.zoom !== before.zoom || selected.view.scrollRow !== before.scrollRow || selected.view.scrollColumn !== before.scrollColumn || selected.view.sheetName !== before.sheetName) return fail('readback_mismatch', 'WebEdit cannot prove the selected freeze target before changing panes')
    if (!await set(window, 'FreezePanes', false) || !await set(window, 'FreezePanes', true)) return fail('unsupported', 'WebEdit does not expose worksheet freeze mutation')
    const after = await viewSnapshot(resolved); if (!after.supported || after.view.freezePanes !== true || after.view.splitRow !== parsed.rowFrom - 1 || after.view.splitColumn !== parsed.colFrom - 1 || after.view.activeCell !== expected.target || after.view.zoom !== before.zoom || after.view.scrollRow !== before.scrollRow || after.view.scrollColumn !== before.scrollColumn || after.view.sheetName !== before.sheetName) return fail('readback_mismatch', 'WebEdit freeze readback differs from target or changed another view field')
    return { requested: { freeze: true, target: expected.target }, observed: { view: after.view, verified: true } }
  }
  async function writePrintSettings(resolved, request) {
    const requested = requestedPrintOperation(request.payload ?? {}); const before = request.precondition?.printSettings; const snapshot = await printSettingsSnapshot(resolved)
    if (!requested || !before || !snapshot.supported || !same(snapshot.settings, before)) return fail('fingerprint_mismatch', 'The print settings changed since inspection; reread and inspect before writing')
    const expected = { ...before, ...requested, ...(Object.hasOwn(requested, 'fitToPagesWide') || Object.hasOwn(requested, 'fitToPagesTall') ? { zoom: false } : {}) }
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'sheetName' || (!Object.hasOwn(requested, key) && !(key === 'zoom' && expected.zoom === false))) continue
      const assigned = key === 'orientation' ? value === 'landscape' ? 2 : 1 : value
      if (!await set(snapshot.pageSetup, PRINT_PROPERTY[key], assigned)) return fail('unsupported', `WebEdit does not expose ${key} print mutation`)
    }
    const after = await printSettingsSnapshot(resolved)
    if (!after.supported || !same(after.settings, expected)) return fail('readback_mismatch', 'WebEdit print settings readback differs from the requested complete state')
    return { requested: { ...requested, ...(expected.zoom === false ? { zoom: false } : {}) }, observed: { printSettings: after.settings, verified: true } }
  }
  async function writeOutline(resolved, request) {
    const target = requestedOutlineOperation(request.payload ?? {}); const before = request.precondition?.outline
    if (!target || !before || before.range !== target.range || before.axis !== target.axis) return fail('fingerprint_mismatch', 'The outline request no longer matches inspection')
    const snapshot = await outlineSnapshot(resolved, target); if (!snapshot.supported || !same(snapshot.outline, before)) return fail('fingerprint_mismatch', 'The outline levels changed since inspection; reread and inspect before writing')
    const range = await rangeFor(resolved.sheet, target.range); const member = range && await property(range, target.axis === 'row' ? 'Rows' : 'Columns'); const method = target.grouped ? 'Group' : 'Ungroup'
    if (!member || typeof member[method] !== 'function') return fail('unsupported', 'WebEdit does not expose outline mutation')
    await resolve(member[method]()); const after = await outlineSnapshot(resolved, target)
    const expected = before.levels.map((level) => target.grouped ? level + 1 : level - 1)
    if (!after.supported || !same(after.outline.levels, expected)) return fail('readback_mismatch', 'WebEdit outline level readback differs from each requested target')
    return { requested: { range: target.range, axis: target.axis, grouped: target.grouped }, observed: { outline: after.outline, verified: true } }
  }
  async function writeDimensions(resolved, request) {
    const target = requestedDimensionOperation(request.operation, request.payload ?? {}); const before = request.precondition?.dimensions
    if (!target || !before || before.range !== target.range || before.axis !== target.axis) return fail('fingerprint_mismatch', 'The dimension request no longer matches inspection')
    const snapshot = await dimensionSnapshot(resolved, target)
    if (!snapshot.supported || !same(snapshot.dimensions, before)) return fail('fingerprint_mismatch', 'The row or column dimensions changed since inspection; reread and inspect before writing')
    const range = await rangeFor(resolved.sheet, target.range); const member = range && await property(range, target.axis === 'row' ? 'Rows' : 'Columns')
    if (!member) return fail('unsupported', 'WebEdit does not expose the requested dimension collection')
    if (request.operation === 'auto_fit') {
      if (typeof member.AutoFit !== 'function') return fail('unsupported', 'WebEdit does not expose Rows/Columns.AutoFit')
      try { await resolve(member.AutoFit()) } catch { return fail('runtime_error', 'WebEdit AutoFit failed') }
      const after = await dimensionSnapshot(resolved, target)
      if (!after.supported || !after.dimensions.items.every((item, index) => item.hidden === before.items[index]?.hidden)) return fail('readback_mismatch', 'WebEdit AutoFit changed hidden state or did not return every target size')
      const changed = after.dimensions.items.some((item, index) => item.size !== before.items[index]?.size)
      return { requested: { range: target.range, axis: target.axis }, observed: { dimensions: after.dimensions, changed, invocationObserved: true, verified: true } }
    }
    if (!await set(member, 'Hidden', target.hidden)) return fail('unsupported', 'WebEdit does not expose row/column hidden mutation')
    const after = await dimensionSnapshot(resolved, target)
    if (!after.supported || !after.dimensions.items.every((item, index) => item.hidden === target.hidden && item.size === before.items[index]?.size)) return fail('readback_mismatch', 'WebEdit hidden-state readback differs from every target or changed a size')
    return { requested: { range: target.range, axis: target.axis, hidden: target.hidden }, observed: { dimensions: after.dimensions, verified: true } }
  }
  async function write(request) {
    const resolved = await appAndSheet(request.resource?.sheetName); if (resolved.error) return resolved.error
    if (request.operation === 'sheet_select') return fail('unsupported', 'WebEdit structural mutation lacks a mutation-safe preflight and is unavailable')
    const denied = await writable(resolved, request); if (denied) return denied
    if ((SHEET_LIFECYCLE_OPERATIONS.has(request.operation) || ['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'insert_cells', 'delete_cells', 'copy_range', 'paste_special', 'recalculate'].includes(request.operation)) && !request.precondition) return fail('unsupported', 'this write requires an inspect-before-write precondition')
    const stale = await preconditionMatches(resolved, request); if (stale) return stale
    if (ANALYTICS_OPERATIONS.has(request.operation)) {
      const result = await writeAnalytics(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    if (WORKBOOK_OPERATIONS.has(request.operation)) {
      const result = await writeWorkbook(resolved, request)
      if (!result.ok && result.error) return result
      const current = await appAndSheet(); return { ok: true, result: { status: 'verified_write', resource: current.error ? resolved.resource : current.resource, operation: request.operation, ...result } }
    }
    if (VIEW_OPERATIONS.has(request.operation)) {
      const result = await writeView(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    if (PRINT_OPERATIONS.has(request.operation)) {
      const result = await writePrintSettings(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    if (OUTLINE_OPERATIONS.has(request.operation)) {
      const result = await writeOutline(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    if (DIMENSION_OPERATIONS.has(request.operation)) {
      const result = await writeDimensions(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    const sheetOperation = String(request.operation).startsWith('sheet_') || request.operation === 'copy_worksheet'
    const result = sheetOperation ? await writeSheet(resolved, request) : await writeRange(resolved, request)
    if (!result.ok && result.error) return result
    const current = sheetOperation ? await appAndSheet() : null
    const resource = current?.error ? resolved.resource : current?.resource ?? resolved.resource
    if (result.verificationStatus === 'write_incomplete') return { ok: false, error: { code: 'write_incomplete', message: `WebEdit executed ${request.operation} but could not complete its operation-specific Verified Write readback`, details: { resource, operation: request.operation, ...result } } }
    return { ok: true, result: { status: 'verified_write', resource, operation: request.operation, ...result } }
  }
  // Probe identity lets the background disambiguate several ready WebEdit
  // frames: a doc.midea.com page can preload a blank editor (workbookName
  // null, fresh Sheet1, no content) next to the user's real document, and a
  // blind "first ready frame wins" reads the wrong one. hasContent is a
  // best-effort scalar signal (null = unknown, never guessed): any content
  // signal beyond the first row/column marks the frame as the real document.
  // Probe must never block the background sweep. A Team Knowledge page hosts
  // a blank preload iframe beside the real sheet; APP getters on the wrong
  // frame can hang until the content-script 8s timeout, which used to eat the
  // entire sendToWebEditFrame budget so the ready spreadsheet was never asked.
  const PROBE_IDENTITY_BUDGET_MS = 250
  const unknownIdentity = () => ({ path: location.pathname, workbookName: null, sheetName: null, hasContent: null })
  function withBudget(work, ms) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
      const timer = setTimeout(() => finish(null), ms)
      Promise.resolve().then(work).then(finish, () => finish(null))
    })
  }
  async function probeIdentity() {
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    try {
      const resolved = await appAndSheet()
      if (resolved.error) return unknownIdentity()
      const lastRow = Number(await call(resolved.sheet, 'getLastRow') ?? await property(resolved.sheet, 'LastRow') ?? await call(app, 'getLastRow'))
      const lastColumn = Number(await call(resolved.sheet, 'getLastColumn') ?? await property(resolved.sheet, 'LastColumn') ?? await call(app, 'getLastCol'))
      const hasContent = (Number.isInteger(lastRow) && lastRow > 1) || (Number.isInteger(lastColumn) && lastColumn > 1)
      return { path: location.pathname, workbookName: resolved.resource.workbookName, sheetName: resolved.resource.sheetName, hasContent: hasContent === false ? null : true }
    } catch { return unknownIdentity() }
  }
  async function run(request) {
    if (request?.action === 'probe') {
      const ready = readyNow()
      // A light-document APP still exposes ActiveWorkbook-like getters that
      // never settle. Do not call them when this frame is not a spreadsheet.
      if (!ready) return { ok: true, result: { status: 'probe', ready: false, identity: unknownIdentity() } }
      return { ok: true, result: { status: 'probe', ready: true, identity: await withBudget(probeIdentity, PROBE_IDENTITY_BUDGET_MS) ?? unknownIdentity() } }
    }
    return request?.action === 'write' ? write(request) : request?.action === 'inspect_write' ? inspectWrite(request) : read(request ?? {})
  }
  globalThis.__deepseekHarnessOfficeSpreadsheet = { run }
  const REQUEST = 'deepseek-harness-office-spreadsheet-request/v1'; const RESPONSE = 'deepseek-harness-office-spreadsheet-response/v1'
  window.addEventListener?.(REQUEST, (event) => { const detail = event.detail; if (!detail || typeof detail.id !== 'string') return; void run(detail).then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...payload } }))).catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...fail('runtime_error', 'WebEdit spreadsheet operation failed') } }))) })
})()
