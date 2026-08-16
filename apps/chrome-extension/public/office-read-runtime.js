(() => {
  'use strict'
  const REQUEST = 'deepseek-harness-office-read-request/v1'
  const RESPONSE = 'deepseek-harness-office-read-response/v1'
  const MAX_ROWS = 100
  const MAX_COLUMNS = 50
  const MAX_CELLS = MAX_ROWS * MAX_COLUMNS

  const fail = (code, message) => ({ ok: false, error: { code, message } })
  const value = async (candidate) => candidate && typeof candidate.then === 'function' ? await candidate : candidate
  const call = async (target, name, args = []) => target && typeof target[name] === 'function' ? value(target[name](...args)) : undefined
  const property = async (target, name) => { try { return await value(target?.[name]) } catch { return undefined } }

  function parseRange(input) {
    const match = /^\s*(?:'((?:[^']|'')+)'|([^'!\s]+))?!?\s*\$?([A-Z]+)\$?(\d+)(?:\s*:\s*\$?([A-Z]+)\$?(\d+))?\s*$/i.exec(input)
    if (!match) return null
    const column = (letters) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0)
    const firstColumn = column(match[3]); const lastColumn = column(match[5] ?? match[3]); const firstRow = Number(match[4]); const lastRow = Number(match[6] ?? match[4])
    if (firstRow < 1 || lastRow < 1) return null
    const rowCount = Math.abs(lastRow - firstRow) + 1; const columnCount = Math.abs(lastColumn - firstColumn) + 1
    if (rowCount > MAX_ROWS || columnCount > MAX_COLUMNS || rowCount * columnCount > MAX_CELLS) return 'too_large'
    return { sheetName: (match[1] ?? match[2] ?? '').replace(/''/g, "'") || null, firstRow: Math.min(firstRow, lastRow), firstColumn: Math.min(firstColumn, lastColumn), rowCount, columnCount }
  }
  function columnName(column) { let result = ''; for (let current = column; current > 0; current = Math.floor((current - 1) / 26)) result = String.fromCharCode(65 + (current - 1) % 26) + result; return result }
  function resourceFingerprint(workbookName, sheetName) { return `webedit:${location.origin}${location.pathname}|${workbookName ?? ''}|${sheetName ?? ''}` }
  async function run(rangeAddress) {
    const parsed = parseRange(rangeAddress)
    if (parsed === null) return fail('invalid_range', 'range must be a bounded A1 rectangle')
    if (parsed === 'too_large') return fail('invalid_range', `range exceeds the ${MAX_ROWS}x${MAX_COLUMNS} read bound`)
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    if (!app) return fail('unsupported', 'WebEdit spreadsheet runtime is unavailable')
    const workbook = await property(app, 'ActiveWorkbook') ?? await call(app, 'getActiveWorkbook')
    let sheet = await call(app, 'getActiveSheet') ?? await property(app, 'ActiveSheet')
    if (parsed.sheetName) sheet = await call(workbook, 'getWorksheet', [parsed.sheetName]) ?? await call(workbook, 'getItem', [parsed.sheetName]) ?? sheet
    if (!sheet) return fail('preview', 'WebEdit does not expose an active spreadsheet sheet')
    const range = await call(sheet, 'getRange', [rangeAddress]) ?? await call(sheet, 'Range', [rangeAddress])
    if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const matrix = await call(range, 'getValue2') ?? await call(range, 'getValue') ?? await property(range, 'Value2') ?? await property(range, 'Value')
    const formulas = await call(range, 'getFormula') ?? await property(range, 'Formula')
    const text = await call(range, 'getText') ?? await property(range, 'Text')
    const matrixAt = (source, row, column) => Array.isArray(source) ? (Array.isArray(source[row]) ? source[row][column] : source[row]) : source
    const sheetName = await call(sheet, 'getName') ?? await property(sheet, 'Name') ?? parsed.sheetName
    const workbookName = await call(workbook, 'getName') ?? await property(workbook, 'Name') ?? null
    const rows = Array.from({ length: parsed.rowCount }, (_, rowOffset) => ({ index: rowOffset + 1, cells: Array.from({ length: parsed.columnCount }, (_, columnOffset) => {
      const raw = matrixAt(matrix, rowOffset, columnOffset); const rendered = matrixAt(text, rowOffset, columnOffset); const formula = matrixAt(formulas, rowOffset, columnOffset)
      return { address: `${columnName(parsed.firstColumn + columnOffset)}${parsed.firstRow + rowOffset}`, row: rowOffset + 1, column: columnOffset + 1, text: rendered == null ? (raw == null ? '' : String(raw)) : String(rendered), value: ['string', 'number', 'boolean'].includes(typeof raw) ? raw : null, formula: typeof formula === 'string' ? formula : null }
    }) }))
    const normalizedWorkbookName = typeof workbookName === 'string' ? workbookName : null
    const normalizedSheetName = typeof sheetName === 'string' ? sheetName : null
    return { ok: true, result: { status: 'ok', resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: normalizedWorkbookName, sheetName: normalizedSheetName, fingerprint: resourceFingerprint(normalizedWorkbookName, normalizedSheetName) }, range: { address: rangeAddress, rowCount: parsed.rowCount, columnCount: parsed.columnCount, rows } } }
  }
  function sameResource(left, right) { return left && right && left.kind === right.kind && left.origin === right.origin && left.workbookName === right.workbookName && left.sheetName === right.sheetName && left.fingerprint === right.fingerprint }
  async function write(detail) {
    const before = await run(detail.range)
    if (!before.ok) return before
    if (!sameResource(before.result.resource, detail.resource)) return fail('fingerprint_mismatch', 'The WebEdit workbook or sheet changed since it was read')
    const app = globalThis.APP ?? globalThis.WPSOpenApi?.Application
    if (!app || await property(app, 'ReadOnly') === true || await property(app, 'readonly') === true) return fail('readonly', 'WebEdit reports this spreadsheet as read-only')
    const workbook = await property(app, 'ActiveWorkbook') ?? await call(app, 'getActiveWorkbook')
    let sheet = await call(app, 'getActiveSheet') ?? await property(app, 'ActiveSheet')
    if (detail.resource.sheetName) sheet = await call(workbook, 'getWorksheet', [detail.resource.sheetName]) ?? await call(workbook, 'getItem', [detail.resource.sheetName]) ?? sheet
    const range = await call(sheet, 'getRange', [detail.range]) ?? await call(sheet, 'Range', [detail.range])
    if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    let wrote = false
    if (typeof range.setValue2 === 'function') { await call(range, 'setValue2', [detail.values]); wrote = true }
    else if (typeof range.setValue === 'function') { await call(range, 'setValue', [detail.values]); wrote = true }
    else { try { range.Value2 = detail.values; wrote = true } catch {} }
    if (!wrote) return fail('unsupported', 'WebEdit does not expose a range write API')
    const after = await run(detail.range)
    if (!after.ok) return after
    const observed = after.result.range.rows.map((row) => row.cells.map((cell) => cell.value))
    if (JSON.stringify(observed) !== JSON.stringify(detail.values)) return fail('readback_mismatch', 'WebEdit readback differs from the requested values')
    return { ok: true, result: { status: 'verified_write', resource: after.result.resource, requested: { range: detail.range, values: detail.values }, observed: { range: detail.range, values: observed } } }
  }
  window.addEventListener(REQUEST, (event) => {
    const detail = event.detail
    if (!detail || typeof detail.id !== 'string' || typeof detail.range !== 'string' || !['read', 'write'].includes(detail.action)) return
    const action = detail.action === 'write' ? write(detail) : run(detail.range)
    void action.then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...payload } }))).catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...fail('runtime_error', 'WebEdit operation failed') } })))
  })
})()
