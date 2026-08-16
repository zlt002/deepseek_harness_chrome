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
  const ADVANCED_OPERATIONS = new Set(['sort', 'set_auto_filter', 'clear_filters', 'set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks', 'add_comment', 'delete_comments', 'create_chart', 'create_pivot_table', 'insert_cell_image'])
  const MAX_IMAGE_ARTIFACT_BYTES = 256 * 1024
  const MAX_INLINE_IMAGE_ARTIFACT_BYTES = 8 * 1024
  const VALIDATION_TYPES = { wholeNumber: 1, decimal: 2, list: 3, date: 4, time: 5, textLength: 6, custom: 7 }
  const ALERT_STYLES = { stop: 1, warning: 2, information: 3 }
  const VALIDATION_OPERATORS = { between: 1, notBetween: 2, equal: 3, notEqual: 4, greater: 5, less: 6, greaterEqual: 7, lessEqual: 8 }
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
  const WORKBOOK_OPERATIONS = new Set(['create_defined_name', 'delete_defined_name', 'copy_worksheet', 'move_worksheet', 'set_worksheet_visibility'])

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
    if (!matrixMatchesAddress(values, address) || !matrixMatchesAddress(formulas, address)) return { error: fail('readback_mismatch', 'WebEdit returned a non-rectangular or wrong-sized values/formulas matrix') }
    const rows = values.map((row, rowIndex) => row.map((cell, columnIndex) => ({ value: cell ?? null, text: valueOf(text, rowIndex, columnIndex) == null ? (cell == null ? '' : String(cell)) : String(valueOf(text, rowIndex, columnIndex)), formula: typeof valueOf(formulas, rowIndex, columnIndex) === 'string' ? valueOf(formulas, rowIndex, columnIndex) : null })))
    return { range, snapshot: { address, values, formulas, text, rows } }
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
  async function writePrecondition(range, address, includeValidation = false, includeHyperlinks = false, requireHyperlinkScreenTip = false) {
    const snapshot = await rangeSnapshotFromRange(range, address)
    if (!snapshot) return null
    const font = await property(range, 'Font') ?? {}
    const interior = await property(range, 'Interior') ?? {}
    const validation = includeValidation ? await validationSnapshot(range) : null
    if (includeValidation && !validation.supported) return null
    const hyperlinks = includeHyperlinks ? await hyperlinksSnapshot(range, requireHyperlinkScreenTip) : null
    if (includeHyperlinks && !hyperlinks.supported) return null
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
    }
    const precondition = { version: 1, range: address, state }
    return JSON.stringify(precondition).length <= 96_000 ? precondition : null
  }
  function completeDataValidationState(state) {
    const format = state?.format
    return !!state && typeof state === 'object' && typeof state.merged === 'boolean' && !!state.filter && typeof state.filter.operator === 'string' && typeof state.rowHeight === 'number' && Number.isFinite(state.rowHeight) && typeof state.columnWidth === 'number' && Number.isFinite(state.columnWidth)
      && !!format && typeof format === 'object' && ['bold', 'italic', 'underline', 'size', 'name', 'color', 'fill', 'numberFormat', 'alignment', 'wrap'].every((key) => Object.hasOwn(format, key) && format[key] !== null)
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
    return rowFrom > 0 && rowTo >= rowFrom && colTo >= colFrom ? { rowFrom, rowTo, colFrom, colTo } : null
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
    const names = []; const active = await call(workbook, 'getActiveSheet') ?? await property(workbook, 'ActiveSheet')
    for (let index = 1; index <= count; index += 1) {
      const sheet = await collectionItem(collection, index)
      const name = await call(sheet, 'getName') ?? await property(sheet, 'Name')
      if (typeof name !== 'string' || !name) return null
      const visible = await property(sheet, 'Visible') ?? await property(sheet, 'visible')
      names.push({ index, name, visible: typeof visible === 'boolean' ? visible : null, active: sheet === active ? true : null })
    }
    return { collection, count, sheets: names }
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
  async function worksheetContentIdentity(sheet) {
    const range = await call(sheet, 'getUsedRange') ?? await property(sheet, 'UsedRange')
    const address = await readableAddress(range); if (!range || !address) return null
    const snapshot = await rangeSnapshotFromRange(range, address); return snapshot ? { address, values: snapshot.values, formulas: snapshot.formulas } : null
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
  async function chartCollection(sheet) { return await property(sheet, 'Shapes') ?? await property(sheet, 'Charts') }
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
  async function pivotDestination(pivot) {
    const destination = await call(pivot, 'getDestination') ?? await call(pivot, 'getDestinationRange') ?? await property(pivot, 'Destination') ?? await property(pivot, 'DestinationRange')
    return readableAddress(destination)
  }
  function hasReadableIdentity(identity) { return identity.id !== null || identity.name !== null }
  function identityMatches(callbackIdentity, collectionIdentity) {
    const comparable = ['id', 'name'].filter((key) => callbackIdentity[key] !== null && collectionIdentity[key] !== null)
    return comparable.length > 0 && comparable.every((key) => callbackIdentity[key] === collectionIdentity[key])
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
    const filterState = await property(range, 'AutoFilter') ?? await property(resolved.sheet, 'AutoFilter')
    const workbookSheets = await worksheetSnapshot(resolved.workbook); const workbookNames = await definedNamesSnapshot(resolved.workbook)
    const detected = {
      sort: !!(range && (typeof range.sort === 'function' || typeof range.Sort === 'function')),
      autoFilter: !!(range && (typeof range.setAutoFilter === 'function' || typeof range.SetAutoFilter === 'function') && filterState !== undefined),
      dataValidation: !!(range && validationState.supported && validation && typeof validation.Delete === 'function' && typeof validation.Add === 'function' && VALIDATION_PROPERTY_NAMES.every((name) => hasProperty(validation, name))),
      hyperlinks: !!(range && hyperlinkState.supported && hyperlinks && typeof hyperlinks.Add === 'function' && typeof hyperlinks.Delete === 'function' && typeof hyperlinks.Item === 'function'),
      comments: false,
      charts: false, pivots: false, cellImages: false,
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
      cellInsertDeleteHidden: { supported: false, reason: unavailable },
      fillReplaceTextToColumnsRemoveDuplicates: { supported: false, replaceRangeText: typeof range?.Replace === 'function', textToColumns: !!(range && typeof range.TextToColumns === 'function' && parseAddress(address)?.colFrom === parseAddress(address)?.colTo), removeDuplicates: typeof range?.RemoveDuplicates === 'function', requiresInspectableTarget: true, reason: 'fill remains unavailable; enabled text operations require an inspected readable target' },
      autoFit: { supported: false, reason: unavailable },
      conditionalFormatting: { supported: false, reason: unavailable },
      copyPasteMove: { supported: false, moveRange: typeof range?.Cut === 'function', requiresInspectableTarget: true, reason: 'copy and paste remain unavailable; move_range requires inspected source and destination state' },
      viewFreeze: { supported: false, reason: unavailable },
      definedNames: { supported: !!workbookNames, create: !!(workbookNames && typeof workbookNames.collection.Add === 'function'), delete: !!workbookNames, requiresInspectableTarget: true, reason: 'defined-name writes require a complete bounded name snapshot and exact readback' },
      printSettings: { supported: false, reason: unavailable },
      worksheetCopyMoveHide: { supported: false, copy: !!(workbookSheets && typeof workbookSheets.collection.copy === 'function'), move: !!(workbookSheets && typeof workbookSheets.collection.move === 'function'), visibility: !!workbookSheets, requiresInspectableTarget: true, reason: 'worksheet writes require a complete bounded sheet-order snapshot and exact readback' },
      undoRedo: { supported: false, reason: unavailable },
      chartManagement: { create: false, list: false, update: false, resize: false, delete: false, reason: unavailable },
      pivotManagement: { create: false, list: false, refresh: false, fields: false, delete: false, reason: unavailable },
    }
    return { ok: true, result: { status: 'ok', resource: resolved.resource, capabilities: { ...detected, detectedButUnsupported, accruiMigrationMatrix } } }
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
    const snapshot = await worksheetSnapshot(resolved.workbook); if (!snapshot) return fail('unsupported', 'WebEdit does not expose bounded worksheet enumeration')
    return { ok: true, result: { status: 'ok', resource: resolved.resource, sheets: snapshot.sheets } }
  }
  async function read(request) {
    if (request.action === 'context') return context()
    if (request.action === 'sheets') return listSheets()
    const resolved = await appAndSheet(request.sheetName); if (resolved.error) return resolved.error
    if (request.action === 'defined_names') {
      const names = await definedNamesSnapshot(resolved.workbook); if (!names) return fail('unsupported', 'WebEdit does not expose bounded defined-name enumeration')
      return { ok: true, result: { status: 'ok', resource: resolved.resource, definedNames: names.names } }
    }
    if (request.action === 'capabilities') return capabilities(resolved, request.range)
    if (request.action === 'range_features') {
      if (typeof request.range !== 'string' || request.range.length === 0 || request.range.length > 128) return fail('invalid_range', 'range is required and bounded')
      const range = await rangeFor(resolved.sheet, request.range); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
      const validation = await validationSnapshot(range); const hyperlinks = await hyperlinksSnapshot(range)
      return { ok: true, result: { status: 'ok', resource: resolved.resource, rangeFeatures: { range: request.range, supported: validation.supported && hyperlinks.supported, validation: validation.validation, hyperlinks: hyperlinks.supported ? hyperlinks.items : null, hyperlinksSupported: hyperlinks.supported } } }
    }
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
  async function inspectWrite(request) {
    const payload = request.payload ?? {}; const operation = request.operation
    if (WORKBOOK_OPERATIONS.has(operation)) {
      const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets) return fail('unsupported', 'WebEdit cannot create a bounded worksheet precondition')
      const names = ['create_defined_name', 'delete_defined_name'].includes(operation) ? await definedNamesSnapshot(resolved.workbook) : null
      if (['create_defined_name', 'delete_defined_name'].includes(operation) && !names) return fail('unsupported', 'WebEdit cannot create a bounded defined-name precondition')
      let sourceContent
      if (operation === 'copy_worksheet') { const sourceName = typeof payload.sourceName === 'string' ? payload.sourceName : typeof payload.sheetName === 'string' ? payload.sheetName : ''; const source = await call(sheets.collection, 'Item', [sourceName]) ?? await call(resolved.workbook, 'getWorksheet', [sourceName]); sourceContent = await worksheetContentIdentity(source); if (!sourceContent) return fail('unsupported', 'WebEdit cannot prove worksheet copy content with a bounded used-range readback') }
      const precondition = { version: 3, sheets: sheets.sheets, ...(names ? { definedNames: names.names } : {}), ...(sourceContent ? { sourceContent } : {}) }
      return JSON.stringify(precondition).length <= 96_000 ? { ok: true, result: { status: 'ok', resource: resolved.resource, precondition } } : fail('unsupported', 'WebEdit workbook precondition exceeds its safe bound')
    }
    const address = payload.range
    if (typeof address !== 'string' || !address || address.length > 128) return fail('invalid_range', 'payload.range is required and bounded')
    const resolved = await appAndSheet(payload.sheetName); if (resolved.error) return resolved.error
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    if (operation === 'set_data_validation' && !requestedValidation(payload)) return fail('invalid_range', 'set_data_validation requires a complete bounded validation schema')
    if (operation === 'clear_data_validation' && !Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))) return fail('invalid_range', 'clear_data_validation accepts only a bounded range')
    if (operation === 'add_hyperlink' && !requestedHyperlink(payload)) return fail('invalid_range', 'add_hyperlink requires a safe bounded URL or internal reference and exact display text')
    if (operation === 'delete_hyperlinks' && !Object.keys(payload).every((key) => ['range', 'sheetName'].includes(key))) return fail('invalid_range', 'delete_hyperlinks accepts only a bounded range')
    if (!['replace_range_text', 'text_to_columns', 'remove_duplicates', 'move_range'].includes(operation)) {
      const requiresValidation = ['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks'].includes(operation); const requiresHyperlinks = ['add_hyperlink', 'delete_hyperlinks'].includes(operation)
      const precondition = await writePrecondition(range, address, requiresValidation, requiresHyperlinks, operation === 'add_hyperlink' && payload.screenTip !== undefined)
      if (!precondition) return fail('unsupported', 'WebEdit cannot create a bounded writable-range precondition')
      if (['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks'].includes(operation) && !completeDataValidationState(precondition.state)) return fail('unsupported', 'WebEdit cannot fully read all non-target range state before this feature write')
      if (operation === 'add_hyperlink' && payload.screenTip !== undefined && precondition.state.hyperlinks.length === 0) return fail('unsupported', 'WebEdit cannot prove ScreenTip readback before the first hyperlink mutation')
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
    if (approved?.version === 3 && Array.isArray(approved.sheets)) {
      const sheets = await worksheetSnapshot(resolved.workbook); if (!sheets || !same(sheets.sheets, approved.sheets)) return fail('fingerprint_mismatch', 'The workbook sheet order or visibility changed since inspection')
      if (approved.definedNames !== undefined) { const names = await definedNamesSnapshot(resolved.workbook); if (!names || !same(names.names, approved.definedNames)) return fail('fingerprint_mismatch', 'The workbook defined names changed since inspection') }
      if (approved.sourceContent !== undefined) { const sourceName = request.payload?.sourceName ?? request.payload?.sheetName; const sheet = await call(sheets.collection, 'Item', [sourceName]) ?? await call(resolved.workbook, 'getWorksheet', [sourceName]); const content = await worksheetContentIdentity(sheet); if (!content || !same(content, approved.sourceContent)) return fail('fingerprint_mismatch', 'The worksheet content changed since inspection') }
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
    const address = request.payload?.range
    if (approved.range !== address) return fail('fingerprint_mismatch', 'The spreadsheet write range differs from its inspected precondition')
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const featureWrite = ['set_data_validation', 'clear_data_validation', 'add_hyperlink', 'delete_hyperlinks'].includes(request.operation); const hyperlinkWrite = ['add_hyperlink', 'delete_hyperlinks'].includes(request.operation)
    const current = await writePrecondition(range, address, featureWrite, hyperlinkWrite, request.operation === 'add_hyperlink' && request.payload?.screenTip !== undefined)
    if (!current || !same(current.state, approved.state)) return fail('fingerprint_mismatch', 'The spreadsheet range changed since inspection; reread and inspect before writing')
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
    if (['add_comment', 'delete_comments', 'create_chart', 'create_pivot_table', 'insert_cell_image', 'export_pdf', 'export_range_image', 'export_worksheet_image'].includes(operation)) return fail('unsupported', 'WebEdit operation lacks a mutation-safe preflight and deliverable-artifact contract and is unavailable')
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
    if (operation === 'add_comment' || operation === 'delete_comments') return fail('unsupported', 'WebEdit cell-comment APIs do not expose range-scoped content readback, so Harness will not mutate comments')
    if (operation === 'insert_cell_image') {
      if (typeof payload.url !== 'string' || !/^https:\/\//i.test(payload.url) || payload.url.length > 2048 || typeof range.insertCellPictureUrl !== 'function') return fail('unsupported', 'WebEdit does not expose a bounded cell-image API')
      await resolve(range.insertCellPictureUrl(payload.url)); const after = await property(range, 'Formula') ?? await call(range, 'getFormula')
      if (!/^=DISPIMG\(/i.test(String(valueOf(after, 0, 0) ?? after))) return fail('readback_mismatch', 'WebEdit did not expose an inserted cell-image formula')
      return { requested: { range: address, url: payload.url }, observed: { range: address, formula: valueOf(after, 0, 0) ?? after, verified: true } }
    }
    if (operation === 'create_chart') {
      const charts = await chartCollection(resolved.sheet); const before = await collectionCount(charts)
      if (!charts || before === null || typeof resolved.sheet.addChart !== 'function') return fail('unsupported', 'WebEdit does not expose a readable Worksheet.addChart API')
      const chartType = typeof payload.chartType === 'string' || typeof payload.chartType === 'number' ? payload.chartType : 'columnClustered'
      const chartStyle = Number.isInteger(payload.chartStyle) ? payload.chartStyle : 0
      const callback = await callbackResult((done) => resolved.sheet.addChart(chartStyle, chartType, range, done, {}))
      if (!callback.callbackInvoked || callback.callbackError) return fail('readback_mismatch', callback.callbackError ?? 'WebEdit did not confirm chart creation by callback')
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
      if (!callback.callbackInvoked || callback.callbackError) return fail('readback_mismatch', callback.callbackError ?? 'WebEdit did not confirm pivot-table creation by callback')
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
    return fail('unsupported', `WebEdit ${operation} is intentionally unavailable until an operation-specific readback contract is confirmed`)
  }
  async function writeRange(resolved, request) {
    const payload = request.payload ?? {}; const address = payload.range
    if (typeof address !== 'string' || address.length > 128) return fail('invalid_range', 'payload.range is required and bounded')
    const range = await rangeFor(resolved.sheet, address); if (!range) return fail('invalid_range', 'WebEdit could not resolve the requested range')
    const advanced = await advancedWrite(resolved, request, range, address); if (advanced) return advanced
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
      const hasClear = typeof range.clear === 'function' || typeof range.Clear === 'function' || typeof range.clearContents === 'function' || typeof range.ClearContents === 'function'
      if (!hasClear) return fail('unsupported', 'WebEdit does not expose a bounded clear API')
      if (typeof range.clear === 'function') await resolve(range.clear())
      else if (typeof range.Clear === 'function') await resolve(range.Clear())
      else if (typeof range.clearContents === 'function') await resolve(range.clearContents())
      else await resolve(range.ClearContents())
      const readback = await rangeSnapshot(resolved.sheet, address); if (readback.error) return readback.error
      const observed = readback.snapshot
      if (!blankSnapshot(observed)) return fail('readback_mismatch', 'WebEdit clear readback still contains values or formulas')
      return { requested: { range: address, clear: true }, observed: { range: address, values: observed.values, formulas: observed.formulas, isBlank: true, verified: true } }
    }
    if (request.operation === 'format') {
      const allowed = new Set(['range', 'font', 'fill', 'numberFormat', 'alignment', 'wrap'])
      const fontKeys = new Set(['bold', 'italic', 'underline', 'size', 'name', 'color'])
      const hasUnsupportedFormatField = !Object.keys(payload).every((key) => allowed.has(key))
      const hasUnsupportedFontField = payload.font !== undefined && (!payload.font || typeof payload.font !== 'object' || Array.isArray(payload.font) || !Object.keys(payload.font).every((key) => fontKeys.has(key)))
      if (hasUnsupportedFormatField || hasUnsupportedFontField) return fail('unsupported', 'WebEdit format request includes fields without a readable verification contract')
      const font = await property(range, 'Font') ?? {}; const interior = await property(range, 'Interior') ?? {}; const requested = payload
      let applied = false
      if (requested.font && typeof requested.font === 'object') for (const [key, value] of Object.entries(requested.font)) { const mapped = ({ bold: 'Bold', italic: 'Italic', underline: 'Underline', size: 'Size', name: 'Name', color: 'Color' })[key] ?? key; applied = await set(font, mapped, value) || applied; await set(font, key, value) }
      if (typeof requested.fill === 'string') { applied = await set(interior, 'Color', requested.fill) || applied; await set(interior, 'color', requested.fill) }
      for (const [key, value] of [['NumberFormat', requested.numberFormat], ['HorizontalAlignment', requested.alignment], ['WrapText', requested.wrap]]) if (value !== undefined) { applied = await set(range, key, value) || applied; await set(range, key === 'NumberFormat' ? 'numberFormat' : key === 'WrapText' ? 'wrap' : 'alignment', value) }
      if (!applied) return fail('unsupported', 'WebEdit does not expose requested formatting APIs')
      const observed = { font: { bold: await property(font, 'bold') ?? await property(font, 'Bold'), italic: await property(font, 'italic') ?? await property(font, 'Italic'), underline: await property(font, 'underline') ?? await property(font, 'Underline'), size: await property(font, 'size') ?? await property(font, 'Size'), name: await property(font, 'name') ?? await property(font, 'Name'), color: await property(font, 'color') ?? await property(font, 'Color') }, fill: await property(interior, 'color') ?? await property(interior, 'Color'), numberFormat: await property(range, 'numberFormat') ?? await property(range, 'NumberFormat'), alignment: await property(range, 'alignment') ?? await property(range, 'HorizontalAlignment'), wrap: await property(range, 'wrap') ?? await property(range, 'WrapText') }
      const fontMatches = !requested.font || Object.entries(requested.font).every(([key, value]) => same(observed.font[key], value))
      if (!fontMatches || (requested.fill !== undefined && !same(observed.fill, requested.fill)) || (requested.numberFormat !== undefined && !same(observed.numberFormat, requested.numberFormat)) || (requested.alignment !== undefined && !same(observed.alignment, requested.alignment)) || (requested.wrap !== undefined && !same(observed.wrap, requested.wrap))) return fail('readback_mismatch', 'WebEdit format readback differs from the requested fields')
      return { requested: { range: address, format: payload }, observed: { range: address, format: observed, verified: true } }
    }
    if (request.operation === 'merge' || request.operation === 'unmerge') {
      const merged = request.operation === 'merge'; const method = merged ? (await call(range, 'merge', []) ?? await call(range, 'Merge', [])) : (await call(range, 'unmerge', []) ?? await call(range, 'UnMerge', []))
      if (method === undefined && !await set(range, 'MergeCells', merged)) return fail('unsupported', 'WebEdit does not expose merge APIs')
      const observed = await property(range, 'MergeCells')
      if (typeof observed !== 'boolean' || observed !== merged) return fail('readback_mismatch', 'WebEdit merge readback differs from request')
      return { requested: { range: address, merged }, observed: { range: address, merged: observed, verified: true } }
    }
    const dimension = request.operation.includes('columns') || request.operation === 'column_width' ? await property(range, 'EntireColumn') : await property(range, 'EntireRow')
    if (['insert_rows', 'insert_columns', 'delete_rows', 'delete_columns'].includes(request.operation)) {
      return fail('unsupported', 'WebEdit structural row and column APIs have no stable non-mutating readback contract yet')
    }
    if (request.operation === 'row_height' || request.operation === 'column_width') {
      const key = request.operation === 'row_height' ? 'RowHeight' : 'ColumnWidth'; const amount = payload.value
      const method = request.operation === 'row_height' ? 'setRowHeight' : 'setColumnWidth'
      if (typeof amount !== 'number' || !Number.isFinite(amount) || (!(dimension ?? range) || (typeof (dimension ?? range)[method] !== 'function' && !await set(dimension ?? range, key, amount)))) return fail('unsupported', 'WebEdit does not expose requested dimension API')
      if (typeof (dimension ?? range)[method] === 'function') await resolve((dimension ?? range)[method](amount))
      const observed = await property(dimension ?? range, key); if (observed !== amount) return fail('readback_mismatch', 'WebEdit dimension readback differs from request')
      return { requested: { range: address, [key]: amount }, observed: { range: address, [key]: observed, verified: true } }
    }
    return fail('unsupported', 'unsupported spreadsheet range operation')
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
    if (request.operation === 'set_worksheet_visibility') {
      const visible = payload.visible; if (typeof visible !== 'boolean' || (visible === false && before.sheets.filter((sheet) => sheet.visible === true).length <= 1)) return fail('invalid_range', 'cannot hide the last visible worksheet')
      if (typeof source.setVisible === 'function') await resolve(source.setVisible(visible)); else if (!await set(source, 'Visible', visible)) return fail('unsupported', 'WebEdit does not expose worksheet visibility write/readback')
      const after = await worksheetSnapshot(resolved.workbook); const observed = after?.sheets.find((sheet) => sheet.name === sourceName)
      if (!after || !observed || observed.visible !== visible) return fail('readback_mismatch', 'WebEdit worksheet visibility readback differs from request')
      if (!same(after.sheets.filter((sheet) => sheet.name !== sourceName), before.sheets.filter((sheet) => sheet.name !== sourceName))) return fail('readback_mismatch', 'WebEdit worksheet visibility changed another sheet')
      return { requested: { sheetName: sourceName, visible }, observed: { sheetName: sourceName, visible: observed.visible, sheets: after.sheets, verified: true } }
    }
    if (request.operation === 'copy_worksheet') {
      const newName = typeof payload.newName === 'string' ? payload.newName.trim() : ''; if (payload.index !== undefined || !validName(newName) || sheetsByName.has(newName) || typeof before.collection.copy !== 'function') return fail('unsupported', 'WebEdit cannot copy and uniquely read back this worksheet')
      const active = before.sheets.find((sheet) => sheet.active === true); const previous = active ? await call(before.collection, 'Item', [active.index]) : null
      if (!active || typeof source.Activate !== 'function' || (previous && typeof previous.Activate !== 'function')) return fail('unsupported', 'WebEdit cannot prove the source worksheet used by copy')
      await resolve(source.Activate()); await resolve(before.collection.copy(false)); if (previous && previous !== source) await resolve(previous.Activate()); const interim = await worksheetSnapshot(resolved.workbook); const added = interim?.sheets.find((sheet) => !sheetsByName.has(sheet.name)); const copied = added ? await call(before.collection, 'Item', [added.name]) ?? await call(resolved.workbook, 'getWorksheet', [added.name]) : null
      if (!interim || !added || !copied || (typeof copied.setName !== 'function' && !await set(copied, 'Name', newName))) return fail('readback_mismatch', 'WebEdit copy did not expose a uniquely readable worksheet')
      if (typeof copied.setName === 'function') await resolve(copied.setName(newName)); const after = await worksheetSnapshot(resolved.workbook); const observed = after?.sheets.find((sheet) => sheet.name === newName)
      const copiedContent = await worksheetContentIdentity(copied)
      if (!after || after.count !== before.count + 1 || !observed || !copiedContent || !same(copiedContent, request.precondition?.sourceContent)) return fail('readback_mismatch', 'WebEdit worksheet copy readback differs from request')
      return { requested: { sourceName, newName, index: payload.index ?? null }, observed: { sheetName: newName, count: after.count, order: after.sheets.map((sheet) => sheet.name), content: copiedContent, verified: true } }
    }
    if (request.operation === 'move_worksheet') {
      const index = payload.index; if (!Number.isInteger(index) || index < 1 || index > before.count || typeof before.collection.move !== 'function') return fail('invalid_range', 'move_worksheet requires a bounded target index and readable move API')
      const sourceId = await call(source, 'getObjID') ?? await property(source, 'Id'); const target = before.sheets.find((sheet) => sheet.index === index); const targetSheet = target ? await call(before.collection, 'Item', [target.index]) : null; const targetId = await call(targetSheet, 'getObjID') ?? await property(targetSheet, 'Id')
      if (sourceId == null || targetId == null) return fail('unsupported', 'WebEdit does not expose stable worksheet move identities')
      await resolve(before.collection.move(sourceId, targetId, null, false)); const after = await worksheetSnapshot(resolved.workbook)
      if (!after || after.sheets.find((sheet) => sheet.name === sourceName)?.index !== index) return fail('readback_mismatch', 'WebEdit worksheet move order differs from request')
      return { requested: { sourceName, index }, observed: { order: after.sheets.map((sheet) => sheet.name), active: after.sheets.find((sheet) => sheet.active === true)?.name ?? null, verified: true } }
    }
    return fail('unsupported', 'unsupported workbook operation')
  }
  async function write(request) {
    const resolved = await appAndSheet(request.resource?.sheetName); if (resolved.error) return resolved.error
    if (['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'sheet_add', 'sheet_rename', 'sheet_delete', 'sheet_select'].includes(request.operation)) return fail('unsupported', 'WebEdit structural sheet mutation lacks a mutation-safe preflight and is unavailable')
    const denied = await writable(resolved, request); if (denied) return denied
    const stale = await preconditionMatches(resolved, request); if (stale) return stale
    if (WORKBOOK_OPERATIONS.has(request.operation)) {
      const result = await writeWorkbook(resolved, request)
      if (!result.ok && result.error) return result
      return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
    }
    const sheetOperation = String(request.operation).startsWith('sheet_')
    const result = sheetOperation ? await writeSheet(resolved, request) : await writeRange(resolved, request)
    if (!result.ok && result.error) return result
    return { ok: true, result: { status: 'verified_write', resource: resolved.resource, operation: request.operation, ...result } }
  }
  async function run(request) { return request?.action === 'write' ? write(request) : request?.action === 'inspect_write' ? inspectWrite(request) : read(request ?? {}) }
  globalThis.__deepseekHarnessOfficeSpreadsheet = { run }
  const REQUEST = 'deepseek-harness-office-spreadsheet-request/v1'; const RESPONSE = 'deepseek-harness-office-spreadsheet-response/v1'
  window.addEventListener?.(REQUEST, (event) => { const detail = event.detail; if (!detail || typeof detail.id !== 'string') return; void run(detail).then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...payload } }))).catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...fail('runtime_error', 'WebEdit spreadsheet operation failed') } }))) })
})()
