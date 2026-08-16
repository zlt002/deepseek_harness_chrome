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
  const ADVANCED_OPERATIONS = new Set(['sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'create_chart', 'create_pivot_table', 'insert_cell_image', 'export_pdf', 'export_range_image'])
  const VALIDATION_TYPES = { wholeNumber: 1, decimal: 2, list: 3, date: 4, time: 5, textLength: 6, custom: 7 }
  const ALERT_STYLES = { stop: 1, warning: 2, information: 3 }
  const VALIDATION_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }

  async function appAndSheet(requestedSheet) {
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    if (!app) return { error: fail('unsupported', 'WebEdit spreadsheet runtime is unavailable') }
    const workbook = await property(app, 'ActiveWorkbook') ?? await call(app, 'getActiveWorkbook')
    let sheet = await call(app, 'getActiveSheet') ?? await property(app, 'ActiveSheet')
    if (requestedSheet && workbook) sheet = await call(workbook, 'getWorksheet', [requestedSheet]) ?? await call(workbook, 'getItem', [requestedSheet]) ?? sheet
    if (!sheet) return { error: fail('preview', 'WebEdit does not expose an active spreadsheet sheet') }
    const workbookName = await call(workbook, 'getName') ?? await property(workbook, 'Name') ?? null
    const sheetName = await call(sheet, 'getName') ?? await property(sheet, 'Name') ?? requestedSheet ?? null
    return { app, workbook, sheet, resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: typeof workbookName === 'string' ? workbookName : null, sheetName: typeof sheetName === 'string' ? sheetName : null, fingerprint: resourceFingerprint(workbookName, sheetName) } }
  }
  async function rangeFor(sheet, address) { return await call(sheet, 'getRange', [address]) ?? await call(sheet, 'Range', [address]) }
  async function rangeSnapshot(sheet, address) {
    const range = await rangeFor(sheet, address)
    if (!range) return { error: fail('invalid_range', 'WebEdit could not resolve the requested range') }
    const values = matrix(await call(range, 'getValue2') ?? await call(range, 'getValue') ?? await property(range, 'Value2') ?? await property(range, 'Value'))
    const formulas = matrix(await call(range, 'getFormula') ?? await property(range, 'Formula'))
    const text = matrix(await call(range, 'getText') ?? await property(range, 'Text'))
    const rows = values.map((row, rowIndex) => row.map((cell, columnIndex) => ({ value: cell ?? null, text: valueOf(text, rowIndex, columnIndex) == null ? (cell == null ? '' : String(cell)) : String(valueOf(text, rowIndex, columnIndex)), formula: typeof valueOf(formulas, rowIndex, columnIndex) === 'string' ? valueOf(formulas, rowIndex, columnIndex) : null })))
    return { range, snapshot: { address, values, formulas, text, rows } }
  }
  async function collectionCount(collection) {
    const count = Number(await property(collection, 'Count'))
    return Number.isInteger(count) && count >= 0 && count <= 100000 ? count : null
  }
  async function capabilities(resolved, address) {
    const range = typeof address === 'string' ? await rangeFor(resolved.sheet, address) : null
    if (typeof address === 'string' && !range) return fail('invalid_range', 'WebEdit could not resolve the requested capability range')
    const validation = await property(range, 'Validation')
    const hyperlinks = await property(range, 'Hyperlinks')
    const comments = await property(resolved.sheet, 'Comments')
    const chartCollection = await property(resolved.sheet, 'Shapes') ?? await property(resolved.sheet, 'Charts')
    const filterState = await property(range, 'AutoFilter') ?? await property(resolved.sheet, 'AutoFilter')
    const detected = {
      sort: !!(range && (typeof range.sort === 'function' || typeof range.Sort === 'function')),
      autoFilter: !!(range && (typeof range.setAutoFilter === 'function' || typeof range.SetAutoFilter === 'function') && filterState !== undefined),
      dataValidation: !!(validation && typeof validation.Add === 'function' && await property(validation, 'Type') !== undefined),
      hyperlinks: !!(hyperlinks && typeof hyperlinks.Add === 'function' && await collectionCount(hyperlinks) !== null),
      comments: !!(range && typeof range.AddComment === 'function' && comments && await collectionCount(comments) !== null),
      charts: !!(resolved.sheet && typeof resolved.sheet.addChart === 'function' && chartCollection && await collectionCount(chartCollection) !== null),
      pivots: !!(range && typeof range.createPivotTable === 'function'),
      cellImages: !!(range && typeof range.insertCellPictureUrl === 'function'),
      exportPdf: !!(resolved.workbook && typeof resolved.workbook.ExportAsFixedFormat === 'function'),
      exportRangeImage: !!(range && typeof range.ToImageDataURL === 'function'),
    }
    return { ok: true, result: { status: 'ok', resource: resolved.resource, capabilities: {
      ...detected, charts: false, pivots: false, exportPdf: false, exportRangeImage: false,
      detectedButUnsupported: Object.entries(detected).filter(([name, available]) => available && ['charts', 'pivots', 'exportPdf', 'exportRangeImage'].includes(name)).map(([name]) => name),
    } } }
  }
  async function context() {
    const resolved = await appAndSheet()
    if (resolved.error) return resolved.error
    const { workbook, sheet, resource } = resolved
    const sheetCount = Number(await property(workbook?.Worksheets, 'Count') ?? await property(workbook?.Sheets, 'Count'))
    return { ok: true, result: { status: 'ok', resource, context: { workbookName: resource.workbookName, activeSheet: resource.sheetName, sheetCount: Number.isInteger(sheetCount) ? sheetCount : null, readOnly: await property(resolved.app, 'ReadOnly') === true || await property(resolved.app, 'readonly') === true } } }
  }
  async function listSheets() {
    const resolved = await appAndSheet(); if (resolved.error) return resolved.error
    const collection = resolved.workbook?.Worksheets ?? resolved.workbook?.Sheets
    const count = Number(await property(collection, 'Count'))
    if (!Number.isInteger(count) || count < 0 || count > 200) return fail('unsupported', 'WebEdit does not expose bounded worksheet enumeration')
    const sheets = []
    for (let index = 1; index <= count; index += 1) {
      const sheet = await call(collection, 'Item', [index]) ?? await call(collection, 'getItemAt', [index - 1])
      const name = await call(sheet, 'getName') ?? await property(sheet, 'Name')
      if (typeof name === 'string') sheets.push({ index, name })
    }
    return { ok: true, result: { status: 'ok', resource: resolved.resource, sheets } }
  }
  async function read(request) {
    if (request.action === 'context') return context()
    if (request.action === 'sheets') return listSheets()
    const resolved = await appAndSheet(request.sheetName); if (resolved.error) return resolved.error
    if (request.action === 'capabilities') return capabilities(resolved, request.range)
    if (request.action === 'range') {
      if (typeof request.range !== 'string' || request.range.length > 128) return fail('invalid_range', 'range is required and bounded')
      const read = await rangeSnapshot(resolved.sheet, request.range); if (read.error) return read.error
      return { ok: true, result: { status: 'ok', resource: resolved.resource, range: read.snapshot } }
    }
    if (request.action === 'search') {
      if (typeof request.query !== 'string' || !request.query.trim() || typeof request.range !== 'string') return fail('invalid_range', 'query and bounded range are required')
      const read = await rangeSnapshot(resolved.sheet, request.range); if (read.error) return read.error
      const query = request.matchCase ? request.query : request.query.toLowerCase(); const field = request.searchBy === 'formula' ? 'formulas' : request.searchBy === 'text' ? 'text' : 'values'
      const matches = []
      read.snapshot[field].forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        const candidate = cell == null ? '' : String(cell); const comparable = request.matchCase ? candidate : candidate.toLowerCase()
        if (request.matchEntireCell ? comparable === query : comparable.includes(query)) matches.push({ row: rowIndex + 1, column: columnIndex + 1, value: candidate })
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
    if (!ADVANCED_OPERATIONS.has(operation)) return null
    if (operation === 'sort') {
      const sorts = Array.isArray(payload.sorts) ? payload.sorts.filter((item) => item && typeof item === 'object').slice(0, 3) : []
      if (sorts.length === 0 || sorts.length > 3) return fail('invalid_range', 'sort requires one to three bounded sort descriptors')
      const before = await rangeSnapshot(resolved.sheet, address); if (before.error) return before.error
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
    if (operation === 'set_data_validation' || operation === 'clear_data_validation') {
      const validation = await property(range, 'Validation'); const beforeType = await property(validation, 'Type')
      if (!validation || beforeType === undefined || typeof validation.Add !== 'function' || typeof validation.Delete !== 'function') return fail('unsupported', 'WebEdit does not expose readable data-validation APIs')
      if (operation === 'clear_data_validation') {
        await resolve(validation.Delete()); const afterType = await property(validation, 'Type')
        if (afterType !== null && afterType !== undefined && afterType !== 0) return fail('readback_mismatch', 'WebEdit did not clear data validation')
        return { requested: { range: address, clear: true }, observed: { range: address, type: afterType ?? null, verified: true } }
      }
      const type = VALIDATION_TYPES[payload.validationType]; const alertStyle = ALERT_STYLES[payload.alertStyle ?? 'stop']; const operator = VALIDATION_OPERATORS[payload.operator ?? 'between']
      if (!type || !alertStyle || !operator || (payload.formula1 !== undefined && typeof payload.formula1 !== 'string') || (payload.formula2 !== undefined && typeof payload.formula2 !== 'string')) return fail('invalid_range', 'set_data_validation requires a supported validation type and bounded formulas')
      await resolve(validation.Delete()); await resolve(validation.Add(type, alertStyle, operator, payload.formula1, payload.formula2))
      const afterType = await property(validation, 'Type'); if (afterType !== type) return fail('readback_mismatch', 'WebEdit data-validation type differs from request')
      return { requested: { range: address, validationType: payload.validationType, formula1: payload.formula1, formula2: payload.formula2 }, observed: { range: address, type: afterType, verified: true } }
    }
    if (operation === 'add_hyperlink' || operation === 'delete_hyperlinks') {
      const links = await property(range, 'Hyperlinks'); const before = await collectionCount(links)
      if (!links || before === null || (operation === 'add_hyperlink' ? typeof links.Add !== 'function' : typeof links.Delete !== 'function')) return fail('unsupported', 'WebEdit does not expose readable hyperlink APIs')
      if (operation === 'add_hyperlink') {
        if ((typeof payload.url !== 'string' || !/^https:\/\//i.test(payload.url) || payload.url.length > 2048) && (typeof payload.subAddress !== 'string' || !payload.subAddress.trim() || payload.subAddress.length > 128)) return fail('invalid_range', 'add_hyperlink requires a bounded https URL or workbook subAddress')
        await resolve(links.Add(range, payload.url ?? '', payload.subAddress ?? '', typeof payload.screenTip === 'string' ? payload.screenTip.slice(0, 500) : '', typeof payload.textToDisplay === 'string' ? payload.textToDisplay.slice(0, 500) : undefined))
        const after = await collectionCount(await property(range, 'Hyperlinks')); if (after !== before + 1) return fail('readback_mismatch', 'WebEdit did not add the requested hyperlink')
        return { requested: { range: address, url: payload.url ?? null, subAddress: payload.subAddress ?? null }, observed: { range: address, count: after, verified: true } }
      }
      await resolve(links.Delete()); const after = await collectionCount(await property(range, 'Hyperlinks')); if (after !== 0) return fail('readback_mismatch', 'WebEdit did not delete range hyperlinks')
      return { requested: { range: address, delete: true }, observed: { range: address, count: after, verified: true } }
    }
    if (operation === 'add_comment' || operation === 'delete_comments') {
      const comments = await property(resolved.sheet, 'Comments'); const before = await collectionCount(comments)
      const method = operation === 'add_comment' ? 'AddComment' : 'ClearComments'
      if (!comments || before === null || typeof range[method] !== 'function') return fail('unsupported', 'WebEdit does not expose readable cell-comment APIs')
      if (operation === 'add_comment' && (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000)) return fail('invalid_range', 'add_comment requires bounded text')
      await resolve(range[method](operation === 'add_comment' ? payload.text : undefined)); const after = await collectionCount(await property(resolved.sheet, 'Comments'))
      if (after === null || (operation === 'add_comment' ? after !== before + 1 : after > before)) return fail('readback_mismatch', 'WebEdit cell-comment readback differs from request')
      return { requested: { range: address, [operation === 'add_comment' ? 'text' : 'delete']: operation === 'add_comment' ? payload.text : true }, observed: { range: address, count: after, verified: true } }
    }
    if (operation === 'insert_cell_image') {
      if (typeof payload.url !== 'string' || !/^https:\/\//i.test(payload.url) || payload.url.length > 2048 || typeof range.insertCellPictureUrl !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded cell-image API')
      await resolve(range.insertCellPictureUrl(payload.url)); const after = await property(range, 'Formula') ?? await call(range, 'getFormula')
      if (!/^=DISPIMG\(/i.test(String(valueOf(after, 0, 0) ?? after))) return fail('readback_mismatch', 'WebEdit did not expose an inserted cell-image formula')
      return { requested: { range: address, url: payload.url }, observed: { range: address, formula: valueOf(after, 0, 0) ?? after, verified: true } }
    }
    return fail('unsupported', `WebEdit ${operation} is intentionally unavailable until an operation-specific readback contract is confirmed`)
  }
  async function writeRange(resolved, request) {
    const payload = request.payload ?? {}; const address = payload.range
    if (typeof address !== 'string' || address.length > 128) return fail('invalid_range', 'payload.range is required and bounded')
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const advanced = await advancedWrite(resolved, request, range, address); if (advanced) return advanced
    if (request.operation === 'set_values') {
      if (!Array.isArray(payload.values) || !await setValues(range, payload.values)) return fail('unsupported', 'WebEdit does not expose a range value write API')
      const observed = (await rangeSnapshot(resolved.sheet, address)).snapshot; if (!same(observed.values, payload.values)) return fail('readback_mismatch', 'WebEdit readback differs from requested values')
      return { requested: { range: address, values: payload.values }, observed: { range: address, values: observed.values } }
    }
    if (request.operation === 'set_formula') {
      if (!Array.isArray(payload.formulas) || !await setFormula(range, payload.formulas)) return fail('unsupported', 'WebEdit does not expose a range formula write API')
      const observed = (await rangeSnapshot(resolved.sheet, address)).snapshot; if (!same(observed.formulas, payload.formulas)) return fail('readback_mismatch', 'WebEdit formula readback differs from request')
      return { requested: { range: address, formulas: payload.formulas }, observed: { range: address, formulas: observed.formulas } }
    }
    if (request.operation === 'clear') {
      const cleared = await call(range, 'clear', []) ?? await call(range, 'Clear', []) ?? await call(range, 'clearContents', [])
      if (cleared === undefined && !await setValues(range, [[null]])) return fail('unsupported', 'WebEdit does not expose a clear API')
      const observed = (await rangeSnapshot(resolved.sheet, address)).snapshot
      return { requested: { range: address, clear: true }, observed: { range: address, values: observed.values } }
    }
    if (request.operation === 'format') {
      const font = await property(range, 'Font') ?? {}; const interior = await property(range, 'Interior') ?? {}; const requested = payload
      let applied = false
      if (requested.font && typeof requested.font === 'object') for (const [key, value] of Object.entries(requested.font)) { const mapped = ({ bold: 'Bold', italic: 'Italic', underline: 'Underline', size: 'Size', name: 'Name', color: 'Color' })[key] ?? key; applied = await set(font, mapped, value) || applied; await set(font, key, value) }
      if (typeof requested.fill === 'string') { applied = await set(interior, 'Color', requested.fill) || applied; await set(interior, 'color', requested.fill) }
      for (const [key, value] of [['NumberFormat', requested.numberFormat], ['HorizontalAlignment', requested.alignment], ['WrapText', requested.wrap]]) if (value !== undefined) { applied = await set(range, key, value) || applied; await set(range, key === 'NumberFormat' ? 'numberFormat' : key === 'WrapText' ? 'wrap' : 'alignment', value) }
      if (requested.borders && typeof requested.borders === 'object') { applied = await set(range, 'Borders', requested.borders) || applied; await set(range, 'borders', requested.borders) }
      if (!applied) return fail('unsupported', 'WebEdit does not expose requested formatting APIs')
      const observed = { font: { bold: await property(font, 'bold') ?? await property(font, 'Bold'), italic: await property(font, 'italic') ?? await property(font, 'Italic') }, fill: await property(interior, 'color') ?? await property(interior, 'Color'), numberFormat: await property(range, 'numberFormat') ?? await property(range, 'NumberFormat'), alignment: await property(range, 'alignment') ?? await property(range, 'HorizontalAlignment'), wrap: await property(range, 'wrap') ?? await property(range, 'WrapText'), borders: await property(range, 'borders') ?? await property(range, 'Borders') }
      return { requested: { range: address, format: payload }, observed: { range: address, format: observed } }
    }
    if (request.operation === 'merge' || request.operation === 'unmerge') {
      const merged = request.operation === 'merge'; const method = merged ? (await call(range, 'merge', []) ?? await call(range, 'Merge', [])) : (await call(range, 'unmerge', []) ?? await call(range, 'UnMerge', []))
      if (method === undefined && !await set(range, 'MergeCells', merged)) return fail('unsupported', 'WebEdit does not expose merge APIs')
      const observed = await property(range, 'MergeCells')
      if (observed !== undefined && observed !== merged) return fail('readback_mismatch', 'WebEdit merge readback differs from request')
      return { requested: { range: address, merged }, observed: { range: address, merged: observed === undefined ? merged : observed } }
    }
    const dimension = request.operation.includes('columns') || request.operation === 'column_width' ? await property(range, 'EntireColumn') : await property(range, 'EntireRow')
    if (['insert_rows', 'insert_columns', 'delete_rows', 'delete_columns'].includes(request.operation)) {
      const deleting = request.operation.startsWith('delete'); const result = deleting ? await call(dimension, 'Delete', []) ?? await call(dimension, 'delete', []) : await call(dimension, 'Insert', []) ?? await call(dimension, 'insert', [])
      if (result === undefined) return fail('unsupported', 'WebEdit does not expose requested structural API')
      return { requested: { range: address, operation: request.operation }, observed: { range: address, operation: request.operation } }
    }
    if (request.operation === 'row_height' || request.operation === 'column_width') {
      const key = request.operation === 'row_height' ? 'RowHeight' : 'ColumnWidth'; const amount = payload.value
      if (typeof amount !== 'number' || !await set(dimension ?? range, key, amount)) return fail('unsupported', 'WebEdit does not expose requested dimension API')
      const observed = await property(dimension ?? range, key); if (observed !== amount) return fail('readback_mismatch', 'WebEdit dimension readback differs from request')
      return { requested: { range: address, [key]: amount }, observed: { range: address, [key]: observed } }
    }
    return fail('unsupported', 'unsupported spreadsheet range operation')
  }
  async function writeSheet(resolved, request) {
    const payload = request.payload ?? {}; const collection = resolved.workbook?.Worksheets ?? resolved.workbook?.Sheets
    if (!collection) return fail('unsupported', 'WebEdit does not expose worksheet APIs')
    if (request.operation === 'sheet_add') { const sheet = await call(collection, 'Add', [payload.name]) ?? await call(collection, 'add', [payload.name]); const name = await property(sheet, 'Name') ?? payload.name; if (!sheet || typeof name !== 'string') return fail('unsupported', 'WebEdit cannot add a worksheet'); return { requested: { name: payload.name }, observed: { name } } }
    const name = payload.name ?? payload.sheetName; const sheet = await call(collection, 'Item', [name]) ?? await call(resolved.workbook, 'getWorksheet', [name])
    if (!sheet) return fail('invalid_range', 'WebEdit could not resolve the requested worksheet')
    if (request.operation === 'sheet_rename') { if (typeof payload.newName !== 'string' || !await set(sheet, 'Name', payload.newName)) return fail('unsupported', 'WebEdit cannot rename this worksheet'); return { requested: { name, newName: payload.newName }, observed: { name: await property(sheet, 'Name') } } }
    if (request.operation === 'sheet_delete') { const result = await call(sheet, 'Delete', []) ?? await call(sheet, 'delete', []); if (result === undefined) return fail('unsupported', 'WebEdit cannot delete this worksheet'); return { requested: { name, deleted: true }, observed: { name, deleted: true } } }
    if (request.operation === 'sheet_select') { const result = await call(sheet, 'Activate', []) ?? await call(sheet, 'Select', []); if (result === undefined) return fail('unsupported', 'WebEdit cannot select this worksheet'); return { requested: { name }, observed: { name: await property(resolved.app, 'ActiveSheet')?.Name ?? name } } }
    return fail('unsupported', 'unsupported spreadsheet sheet operation')
  }
  async function write(request) {
    const resolved = await appAndSheet(request.resource?.sheetName); if (resolved.error) return resolved.error
    const denied = await writable(resolved, request); if (denied) return denied
    const sheetOperation = String(request.operation).startsWith('sheet_')
    const result = sheetOperation ? await writeSheet(resolved, request) : await writeRange(resolved, request)
    if (!result.ok && result.error) return result
    return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
  }
  async function run(request) { return request?.action === 'write' ? write(request) : request?.action === 'inspect_write' ? context() : read(request ?? {}) }
  globalThis.__deepseekHarnessOfficeSpreadsheet = { run }
  const REQUEST = 'deepseek-harness-office-spreadsheet-request/v1'; const RESPONSE = 'deepseek-harness-office-spreadsheet-response/v1'
  window.addEventListener?.(REQUEST, (event) => { const detail = event.detail; if (!detail || typeof detail.id !== 'string') return; void run(detail).then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...payload } }))).catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...fail('runtime_error', 'WebEdit spreadsheet operation failed') } }))) })
})()
