import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function runtimeWith(app) {
  const source = await readFile(new URL('../public/office-spreadsheet-runtime.js', import.meta.url), 'utf8')
  const context = vm.createContext({ APP: app, location: { origin: 'https://webedit.midea.com', pathname: '/sheet/1' }, globalThis: null, window: null, console, btoa: (value) => Buffer.from(value, 'binary').toString('base64'), setTimeout, clearTimeout, Uint8Array, Date, URL })
  context.globalThis = context; context.window = context
  vm.runInContext(source, context)
  const raw = context.__deepseekHarnessOfficeSpreadsheet.run
  const run = async (request) => {
    if (request?.action !== 'write' || request.precondition !== undefined) return raw(request)
    const inspected = await raw({ action: 'inspect_write', operation: request.operation, payload: request.payload })
    if (inspected.ok !== true) return inspected
    return raw({ ...request, precondition: inspected.result.precondition })
  }
  run.raw = raw
  return run
}

function fakeApp() {
  const cells = [[3, 2], [1, 4]]
  const formulas = [['', ''], ['', '']]
  let filterOperator = 'equals'
  const comments = { Count: 0 }
  let nextHyperlink = 1; const hyperlinks = { Count: 0, items: [], Add: (_range, url, subAddress, screenTip, textToDisplay) => { hyperlinks.items.push({ Address: url, SubAddress: subAddress, ScreenTip: screenTip, TextToDisplay: textToDisplay, Name: `Link${nextHyperlink++}`, Type: 'hyperlink' }); hyperlinks.Count += 1 }, Delete: () => { hyperlinks.Count = 0; hyperlinks.items = [] }, Item: (index) => hyperlinks.items[index - 1] }
  const conditionalFormats = { Count: 0, items: [], Add: (type, operator, formula1, formula2) => { const item = { Type: type, Operator: operator, Formula1: formula1, Formula2: formula2 ?? '', Priority: conditionalFormats.Count + 1, Interior: { Color: '#FFFFFF' }, Font: { Color: '#000000', Bold: false, Italic: false } }; conditionalFormats.items.push(item); conditionalFormats.Count += 1; return item }, Delete: () => { conditionalFormats.Count = 0; conditionalFormats.items = [] }, Item: (index) => conditionalFormats.items[index - 1] }
  const validation = { Type: 0, AlertStyle: 1, Operator: 1, Formula1: '', Formula2: '', IgnoreBlank: true, ShowError: true, ErrorTitle: '', ErrorMessage: '', Add: (type, alertStyle, operator, formula1, formula2) => { validation.Type = type; validation.AlertStyle = alertStyle; validation.Operator = operator; validation.Formula1 = formula1 ?? ''; validation.Formula2 = formula2 ?? '' }, Delete: () => { validation.Type = 0; validation.Formula1 = ''; validation.Formula2 = '' } }
  const charts = { Count: 0, Item: (index) => charts.items[index - 1], items: [] }
  const pivots = { Count: 0, Item: (index) => pivots.items[index - 1], items: [] }
  const range = {
    getValue2: () => cells.map((row) => [...row]), getText: () => cells.map((row) => row.map(String)), getFormula: () => formulas.map((row) => [...row]),
    setValue2: (next) => { cells.splice(0, cells.length, ...next.map((row) => [...row])) },
    setFormula: (next) => { formulas.splice(0, formulas.length, ...next.map((row) => [...row])) },
    clear: () => { cells.forEach((row, rowIndex) => row.forEach((_cell, columnIndex) => { cells[rowIndex][columnIndex] = null; formulas[rowIndex][columnIndex] = '' })) },
    Font: { Bold: false, Italic: false, Underline: false, Size: 11, Name: 'Arial', Color: '#000000' }, Interior: { Color: '#FFFFFF' }, MergeCells: false, NumberFormat: 'General', HorizontalAlignment: 'general', WrapText: false, EntireRow: { RowHeight: 15 }, EntireColumn: { ColumnWidth: 8 },
    merge: () => { range.MergeCells = true }, unmerge: () => { range.MergeCells = false },
    sort: (key) => { const column = Number(key) - 1; cells.sort((left, right) => Number(left[column]) - Number(right[column])) },
    AutoFilter: false, setAutoFilter: (enabled) => { range.AutoFilter = enabled },
    queryAutoFilterListItems: (_kind, _options, callback) => callback({ result: { fieldData: { condition: { operator: filterOperator } } } }),
    autoFilterShowAll: (callback) => { filterOperator = 'none'; callback({ isOk: true }) },
    Validation: validation, Hyperlinks: hyperlinks, FormatConditions: conditionalFormats,
    AddComment: () => { comments.Count += 1 }, ClearComments: () => { comments.Count = 0 },
    insertCellPictureUrl: () => { range.Formula = '=DISPIMG("image")' },
    ToImageDataURL: () => 'data:image/png;base64,AQID',
  }
  const sheet = {
    Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => range, Range: () => range, Comments: comments, Shapes: charts,
    getPivotTables: () => pivots,
    addChart: (_style, type, _range, callback) => { const chart = { Id: charts.Count + 1, Name: `Chart ${charts.Count + 1}`, Type: type }; charts.items.push(chart); charts.Count += 1; callback(chart, 'ok') },
    ExportImage: () => ({ result: 'ok', data: { size: 3, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }),
  }
  range.createPivotTable = (options, callback) => { const pivot = { Id: pivots.Count + 1, Name: `Pivot ${pivots.Count + 1}`, Destination: options.destRangeText }; pivots.items.push(pivot); pivots.Count += 1; callback({ isOk: true, pivotTableId: pivot.Id }) }
  const workbook = { Name: 'Budget.xlsx', getName: () => 'Budget.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet }, ExportAsFixedFormat: () => ({ url: 'https://download.example.test/Budget.pdf?Expires=2000000000' }) }
  return { ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _range: range, _sheet: sheet, _validation: validation, _hyperlinks: hyperlinks, _conditionalFormats: conditionalFormats, _charts: charts, _pivots: pivots, _comments: comments, _workbook: workbook }
}

function p0App(values, options = {}) {
  const grid = values.map((row) => [...row]); const formulas = grid.map((row) => row.map(() => ''))
  const validation = { Type: 0, AlertStyle: 1, Operator: 1, Formula1: '', Formula2: '', IgnoreBlank: true, ShowError: true, ErrorTitle: '', ErrorMessage: '', Add: () => {}, Delete: () => {} }
  const defaultFont = { Bold: false, Italic: false, Underline: false, Size: 11, Name: 'Arial', Color: '#000000' }
  const defaultInterior = { Color: '#FFFFFF' }
  const parse = (address) => { const match = address.match(/^([A-Z])(\d+)(?::([A-Z])(\d+))?$/); const column = (name) => name.charCodeAt(0) - 65; return { left: column(match[1]), top: Number(match[2]) - 1, right: column(match[3] ?? match[1]), bottom: Number(match[4] ?? match[2]) - 1 } }
  const matrix = (data, area) => data.slice(area.top, area.bottom + 1).map((row) => row.slice(area.left, area.right + 1))
  const write = (data, area, next) => next.forEach((row, rowIndex) => row.forEach((value, columnIndex) => { data[area.top + rowIndex][area.left + columnIndex] = value }))
  const range = (address) => {
    const area = parse(address)
    return {
      getValue2: () => options.valuesOverride ?? matrix(grid, area), getValue: () => options.valuesOverride ?? matrix(grid, area), getFormula: () => options.formulasOverride ?? matrix(formulas, area), getText: () => options.textOverride ?? matrix(grid, area).map((row) => row.map((value) => value == null ? '' : String(value))), Font: options.font ?? defaultFont, Interior: options.interior ?? defaultInterior, MergeCells: Object.hasOwn(options, 'merged') ? options.merged : false, NumberFormat: Object.hasOwn(options, 'numberFormat') ? options.numberFormat : 'General', HorizontalAlignment: Object.hasOwn(options, 'alignment') ? options.alignment : 'general', WrapText: Object.hasOwn(options, 'wrap') ? options.wrap : false, Validation: validation,
      Replace: (what, replacement, whole, _order, matchCase) => { const replace = (value) => typeof value !== 'string' ? value : whole === 'etWhole' ? ((matchCase ? value === what : value.toLowerCase() === what.toLowerCase()) ? replacement : value) : value.replace(new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi'), replacement); write(grid, area, matrix(grid, area).map((row) => row.map(replace))); write(formulas, area, matrix(formulas, area).map((row) => row.map(replace))) },
      TextToColumns: () => { const source = matrix(grid, area); source.forEach((row, rowIndex) => String(row[0]).split(',').forEach((value, columnIndex) => { grid[area.top + rowIndex][area.left + columnIndex] = value })) },
      RemoveDuplicates: (columns, header) => { const source = matrix(grid, area); const sourceFormulas = matrix(formulas, area); const kept = header === 1 ? [source[0]] : []; const keptFormulas = header === 1 ? [sourceFormulas[0]] : []; const seen = new Set(); source.forEach((row, index) => { if (header === 1 && index === 0) return; const key = columns.map((column) => String(row[column - 1]).toLowerCase()).join('|'); if (!seen.has(key)) { seen.add(key); kept.push(row); keptFormulas.push(sourceFormulas[index]) } }); while (kept.length < source.length) { kept.push(Array(source[0].length).fill(null)); keptFormulas.push(Array(source[0].length).fill('')) }; write(grid, area, kept); write(formulas, area, keptFormulas) },
      Cut: (destination) => { if (options.cutNoop) return true; const source = matrix(grid, area); const sourceFormulas = matrix(formulas, area); const destinationArea = destination._area; write(grid, destinationArea, source); write(formulas, destinationArea, sourceFormulas); write(grid, area, Array(source.length).fill(null).map(() => Array(source[0].length).fill(null))); write(formulas, area, Array(source.length).fill(null).map(() => Array(source[0].length).fill(''))); return true },
      _area: area,
    }
  }
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: range, Range: range }
  const workbook = { Name: 'P0.xlsx', getName: () => 'P0.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  return { ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _grid: grid, _formulas: formulas }
}

function sheetApp() {
  const sheets = []
  let active
  const collection = {
    get Count() { return sheets.length },
    Item: (indexOrName) => typeof indexOrName === 'number' ? sheets[indexOrName - 1] : sheets.find((sheet) => sheet.Name === indexOrName),
    Add: (name) => addSheet(name),
  }
  const addSheet = (name) => {
    const sheet = {
      Name: name,
      getName: () => sheet.Name,
      setName: (next) => { sheet.Name = next },
      Activate: () => { active = sheet },
      Delete: () => { const index = sheets.indexOf(sheet); if (index >= 0) sheets.splice(index, 1); if (active === sheet) active = sheets[0] },
      getRange: () => ({}),
    }
    sheets.push(sheet)
    return sheet
  }
  addSheet('Sheet1'); addSheet('Sheet2'); active = sheets[0]
  const workbook = { Name: 'Sheets.xlsx', getName: () => 'Sheets.xlsx', Worksheets: collection, getWorksheet: (name) => collection.Item(name) }
  return { ActiveWorkbook: workbook, getActiveWorkbook: () => workbook, getActiveSheet: () => active, get ActiveSheet() { return active } }
}

function workbookFixture() {
  let active; let nextId = 1; const names = []
  const makeSheet = (name, values = [[name]]) => { const sheet = { Name: name, Id: nextId++, Visible: true, _values: values, getName: () => sheet.Name, getObjID: () => sheet.Id, setName: (value) => { sheet.Name = value }, setVisible: (value) => { sheet.Visible = value }, Activate: () => { active = sheet } }; sheet.getUsedRange = () => ({ getAddress: () => 'A1', getValue2: () => sheet._values.map((row) => [...row]), getFormula: () => sheet._values.map((row) => row.map(() => '')) }); return sheet }
  const sheets = [makeSheet('Sheet1'), makeSheet('Sheet2')]; active = sheets[0]
  const collection = { get Count() { return sheets.length }, Item: (value) => typeof value === 'number' ? sheets[value - 1] : sheets.find((sheet) => sheet.Name === value), copy: () => { const copy = makeSheet(`${active.Name} Copy`, active._values.map((row) => [...row])); sheets.push(copy); return copy }, move: (id, beforeId) => { const from = sheets.findIndex((sheet) => sheet.Id === id); const target = sheets.findIndex((sheet) => sheet.Id === beforeId); const [sheet] = sheets.splice(from, 1); sheets.splice(target, 0, sheet) } }
  const nameCollection = { get Count() { return names.length }, Item: (value) => typeof value === 'number' ? names[value - 1] : names.find((item) => item.Name === value), Add: (name, refersTo) => { const item = { Name: name, RefersTo: refersTo, Visible: true, Scope: 'workbook', Delete: () => { names.splice(names.indexOf(item), 1) } }; names.push(item); return item } }
  const workbook = { Name: 'Workbook.xlsx', ActiveSheet: active, getName: () => 'Workbook.xlsx', getWorksheet: (name) => collection.Item(name), Worksheets: collection, Names: nameCollection }
  Object.defineProperty(workbook, 'ActiveSheet', { get: () => active })
  return { ActiveWorkbook: workbook, getActiveWorkbook: () => workbook, getActiveSheet: () => active, get ActiveSheet() { return active }, _sheets: sheets, _names: names }
}

test('spreadsheet runtime reads formulas and performs verified values, formulas, format, and merge writes', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const context = await run({ action: 'context' })
  assert.equal(context.ok, true)
  const resource = context.result.resource
  const written = await run({ action: 'write', resource, operation: 'set_values', payload: { range: 'A1:B2', values: [[10, 20], [30, 40]] } })
  assert.equal(written.result.status, 'verified_write')
  const formula = await run({ action: 'write', resource, operation: 'set_formula', payload: { range: 'A1:B2', formulas: [['=1+1', '=2+2'], ['', '']] } })
  assert.deepEqual(formula.result.observed.formulas, [['=1+1', '=2+2'], ['', '']])
  const formatted = await run({ action: 'write', resource, operation: 'format', payload: { range: 'A1:B2', font: { bold: true }, fill: '#ff0000', numberFormat: '0.00', wrap: true } })
  assert.equal(formatted.result.observed.format.font.bold, true)
  const merged = await run({ action: 'write', resource, operation: 'merge', payload: { range: 'A1:B2' } })
  assert.equal(merged.result.observed.merged, true)
  const cleared = await run({ action: 'write', resource, operation: 'clear', payload: { range: 'A1:B2' } })
  assert.equal(cleared.result.observed.isBlank, true)
})

test('spreadsheet runtime rejects a stale resource and unsupported structural API without reporting success', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const resource = (await run({ action: 'context' })).result.resource
  const stale = await run({ action: 'write', resource: { ...resource, fingerprint: 'stale' }, operation: 'set_values', payload: { range: 'A1:B2', values: [[1, 2], [3, 4]] } })
  assert.equal(stale.error.code, 'fingerprint_mismatch')
  const unsupported = await run({ action: 'write', resource, operation: 'insert_rows', payload: { range: '1:1', count: 1 } })
  assert.equal(unsupported.error.code, 'unsupported')
})

test('workbook operations use bounded snapshots and exact readback', async () => {
  const app = workbookFixture(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const created = await run({ action: 'write', resource, operation: 'create_defined_name', payload: { name: 'Budget', refersTo: '=Sheet1!A1', visible: true } })
  assert.equal(created.result.observed.refersTo, '=Sheet1!A1')
  assert.equal((await run({ action: 'defined_names' })).result.definedNames.length, 1)
  const deleted = await run({ action: 'write', resource, operation: 'delete_defined_name', payload: { name: 'Budget' } }); assert.equal(deleted.result.observed.deleted, true)
  const copied = await run({ action: 'write', resource, operation: 'copy_worksheet', payload: { sourceName: 'Sheet1', newName: 'Copied' } }); assert.equal(copied.result.observed.sheetName, 'Copied')
  const moved = await run({ action: 'write', resource, operation: 'move_worksheet', payload: { sourceName: 'Sheet2', index: 1 } }); assert.equal(moved.result.observed.order[0], 'Sheet2')
  const hidden = await run({ action: 'write', resource, operation: 'set_worksheet_visibility', payload: { sheetName: 'Sheet1', visible: false } }); assert.equal(hidden.result.observed.visible, false)
})

test('workbook operations reject stale snapshots, last-visible hides, and unreadable APIs', async () => {
  const app = workbookFixture(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const inspected = await run.raw({ action: 'inspect_write', operation: 'copy_worksheet', payload: { sourceName: 'Sheet1', newName: 'Copied' } }); app._sheets[0]._values[0][0] = 'changed'
  assert.equal((await run.raw({ action: 'write', resource, operation: 'copy_worksheet', payload: { sourceName: 'Sheet1', newName: 'Copied' }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  app._sheets[1].Visible = false
  assert.equal((await run({ action: 'write', resource, operation: 'set_worksheet_visibility', payload: { sheetName: 'Sheet1', visible: false } })).error.code, 'invalid_range')
  delete app.ActiveWorkbook.Names.Add
  assert.equal((await run({ action: 'write', resource, operation: 'create_defined_name', payload: { name: 'NoApi', refersTo: '=Sheet1!A1' } })).error.code, 'unsupported')
})

test('spreadsheet write rereads its inspected precondition before mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const payload = { range: 'A1:B2', values: [[10, 20], [30, 40]] }
  const inspected = await run.raw({ action: 'inspect_write', operation: 'set_values', payload })
  assert.equal(inspected.ok, true)
  const setValues = app._range.setValue2
  setValues([[99, 2], [1, 4]])
  let writes = 0; app._range.setValue2 = (value) => { writes += 1; setValues(value) }
  const result = await run.raw({ action: 'write', resource, operation: 'set_values', payload, precondition: inspected.result.precondition })
  assert.equal(result.error.code, 'fingerprint_mismatch'); assert.equal(writes, 0)
})

test('P0 spreadsheet operations use multi-range preconditions and exact matrix readback', async () => {
  const replaceApp = p0App([['alpha', 'beta'], ['alpha', 'gamma']]); const replace = await runtimeWith(replaceApp); const replaceResource = (await replace({ action: 'context' })).result.resource
  const replaceResult = await replace({ action: 'write', resource: replaceResource, operation: 'replace_range_text', payload: { range: 'A1:B2', what: 'alpha', replacement: 'omega' } })
  assert.equal(replaceResult.result.observed.replacementCount, 2); assert.deepEqual(replaceApp._grid.slice(0, 2).map((row) => row.slice(0, 2)), [['omega', 'beta'], ['omega', 'gamma']])

  const splitApp = p0App([['a,b', null, null], ['c,d', null, null]]); const split = await runtimeWith(splitApp); const splitResource = (await split({ action: 'context' })).result.resource
  const splitInspection = await split.raw({ action: 'inspect_write', operation: 'text_to_columns', payload: { range: 'A1:A2', delimiter: 'comma' } })
  assert.equal(splitInspection.result.precondition.version, 2); assert.equal(splitInspection.result.precondition.targets.length, 2); assert.equal(splitInspection.result.precondition.targets[0].state.validation, undefined)
  const splitResult = await split.raw({ action: 'write', resource: splitResource, operation: 'text_to_columns', payload: { range: 'A1:A2', delimiter: 'comma' }, precondition: splitInspection.result.precondition })
  assert.deepEqual(splitResult.result.observed.values, [['a', 'b'], ['c', 'd']])

  const dedupeApp = p0App([['name', 'id'], ['A', 1], ['A', 1], ['B', 2]]); const dedupe = await runtimeWith(dedupeApp); const dedupeResource = (await dedupe({ action: 'context' })).result.resource
  const dedupeResult = await dedupe({ action: 'write', resource: dedupeResource, operation: 'remove_duplicates', payload: { range: 'A1:B4', columns: [1, 2], hasHeader: true } })
  assert.equal(dedupeResult.result.observed.duplicateRowsRemoved, 1); assert.deepEqual(dedupeApp._grid.slice(0, 4).map((row) => row.slice(0, 2)), [['name', 'id'], ['A', 1], ['B', 2], [null, null]])

  const moveApp = p0App([['A', 'B', null, null], ['C', 'D', null, null]]); const move = await runtimeWith(moveApp); const moveResource = (await move({ action: 'context' })).result.resource
  const moveInspection = await move.raw({ action: 'inspect_write', operation: 'move_range', payload: { range: 'A1:B2', destination: 'C1' } })
  const moveResult = await move.raw({ action: 'write', resource: moveResource, operation: 'move_range', payload: { range: 'A1:B2', destination: 'C1' }, precondition: moveInspection.result.precondition })
  assert.equal(moveResult.result.observed.sourceBlank, true); assert.deepEqual(moveApp._grid.slice(0, 2), [[null, null, 'A', 'B'], [null, null, 'C', 'D']])
})

test('P0 spreadsheet operations reject stale multi-range preconditions and unsafe destinations before mutation', async () => {
  const app = p0App([['a,b', 'occupied', null], ['c,d', null, null]]); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const conflict = await run.raw({ action: 'inspect_write', operation: 'text_to_columns', payload: { range: 'A1:A2', delimiter: 'comma' } })
  assert.equal(conflict.error.code, 'invalid_range')
  const inspected = await run.raw({ action: 'inspect_write', operation: 'move_range', payload: { range: 'A1:A2', destination: 'C1' } })
  app._grid[0][2] = 'changed'
  const stale = await run.raw({ action: 'write', resource, operation: 'move_range', payload: { range: 'A1:A2', destination: 'C1' }, precondition: inspected.result.precondition })
  assert.equal(stale.error.code, 'fingerprint_mismatch'); assert.equal(app._grid[0][0], 'a,b')
  const overlap = await run.raw({ action: 'inspect_write', operation: 'move_range', payload: { range: 'A1:A2', destination: 'A2' } })
  assert.equal(overlap.error.code, 'invalid_range')
})

test('P0 text and formula operations fail closed for ambiguous parsing and formula mutations', async () => {
  for (const value of ['"a,b', '001,2']) {
    const run = await runtimeWith(p0App([[value, null]]))
    const inspected = await run.raw({ action: 'inspect_write', operation: 'text_to_columns', payload: { range: 'A1', delimiter: 'comma' } })
    assert.equal(inspected.error.code, 'unsupported')
  }
  const app = p0App([['alpha']]); app._formulas[0][0] = '=IF(A1="alpha",1,0)'
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const blocked = await run({ action: 'write', resource, operation: 'replace_range_text', payload: { range: 'A1', what: 'alpha', replacement: 'omega' } })
  assert.equal(blocked.error.code, 'invalid_range'); assert.equal(app._formulas[0][0], '=IF(A1="alpha",1,0)')
  const allowed = await run({ action: 'write', resource, operation: 'replace_range_text', payload: { range: 'A1', what: 'alpha', replacement: 'omega', allowFormulaChanges: true } })
  assert.equal(allowed.result.observed.formulas[0][0], '=IF(A1="omega",1,0)')
})

test('P0 remove_duplicates keeps formulas with retained rows and clears formula tail', async () => {
  const app = p0App([['name'], ['A'], ['A'], ['B']]); app._formulas[1][0] = '=1'; app._formulas[2][0] = '=2'; app._formulas[3][0] = '=3'
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const result = await run({ action: 'write', resource, operation: 'remove_duplicates', payload: { range: 'A1:A4', columns: [1], hasHeader: true } })
  assert.equal(result.result.observed.formulas[1][0], '=1'); assert.equal(result.result.observed.formulas[2][0], '=3'); assert.equal(result.result.observed.formulas[3][0], '')
})

test('P0 move_range rejects non-default formats and merged source before mutation', async () => {
  const safe = await runtimeWith(p0App([['A', null]]))
  assert.equal((await safe.raw({ action: 'inspect_write', operation: 'move_range', payload: { range: 'A1', destination: 'B1' } })).ok, true)
  for (const options of [{ merged: null }, { merged: true }, { font: { Bold: null } }, { font: { Bold: true, Italic: false, Underline: false, Size: 11, Name: 'Arial', Color: '#000000' } }]) {
    const run = await runtimeWith(p0App([['A', null]], options))
    const inspected = await run.raw({ action: 'inspect_write', operation: 'move_range', payload: { range: 'A1', destination: 'B1' } })
    assert.equal(inspected.error.code, 'unsupported')
  }
})

test('P0 move_range rejects a write whose explicit default-state readback disagrees', async () => {
  const app = p0App([['A', null]], { cutNoop: true }); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const result = await run({ action: 'write', resource, operation: 'move_range', payload: { range: 'A1', destination: 'B1' } })
  assert.equal(result.error.code, 'readback_mismatch')
})

test('spreadsheet preconditions reject ragged, undersized, and empty matrices before mutation', async () => {
  for (const options of [
    { valuesOverride: [[1, 2], [3]], formulasOverride: [['', ''], ['', '']] },
    { valuesOverride: [[1]], formulasOverride: [['']] },
    { valuesOverride: [], formulasOverride: [] },
  ]) {
    const run = await runtimeWith(p0App([[1, 2], [3, 4]], options))
    const result = await run.raw({ action: 'inspect_write', operation: 'set_values', payload: { range: 'A1:B2', values: [[5, 6], [7, 8]] } })
    assert.equal(result.ok, false)
  }
})

test('P0 spreadsheet operations fail before mutation when their WebEdit API is absent', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const operations = [
    ['replace_range_text', { range: 'A1', what: 'a', replacement: 'b' }],
    ['text_to_columns', { range: 'A1', delimiter: 'comma' }],
    ['remove_duplicates', { range: 'A1:B2', columns: [1] }],
    ['move_range', { range: 'A1', destination: 'C1' }],
  ]
  for (const [operation, payload] of operations) {
    const result = await run.raw({ action: 'inspect_write', operation, payload })
    assert.equal(result.error.code, 'unsupported')
  }
  const capabilities = await run({ action: 'capabilities', range: 'A1' })
  const migration = capabilities.result.capabilities.accruiMigrationMatrix
  assert.equal(migration.fillReplaceTextToColumnsRemoveDuplicates.replaceRangeText, false)
  assert.equal(migration.fillReplaceTextToColumnsRemoveDuplicates.textToColumns, false)
  assert.equal(migration.fillReplaceTextToColumnsRemoveDuplicates.removeDuplicates, false)
  assert.equal(migration.copyPasteMove.moveRange, false)
})

test('spreadsheet runtime fails closed for sheet lifecycle mutations without preflight contracts', async () => {
  const app = sheetApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const added = await run.raw({ action: 'write', resource, operation: 'sheet_add', payload: { name: 'Plan' } })
  assert.equal(added.error.code, 'unsupported')
})

test('spreadsheet runtime fail-closes clear and filter clearing when the observable readback disagrees', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app._range.clear = () => undefined
  const uncleared = await run({ action: 'write', resource, operation: 'clear', payload: { range: 'A1:B2' } })
  assert.equal(uncleared.error.code, 'readback_mismatch')
  app._range.autoFilterShowAll = (callback) => callback({ isOk: true })
  app._range.queryAutoFilterListItems = (_kind, _options, callback) => callback({ result: { fieldData: { condition: { operator: 'equals' } } } })
  const filtersRemain = await run({ action: 'write', resource, operation: 'clear_filters', payload: { range: 'A1:B2' } })
  assert.equal(filtersRemain.error.code, 'readback_mismatch')
})

test('spreadsheet runtime probes and verifies AccrUI-derived advanced range operations', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const resource = (await run({ action: 'context' })).result.resource
  const capabilities = await run({ action: 'capabilities', range: 'A1:B2' })
  assert.equal(capabilities.result.capabilities.sort, true)
  assert.equal(capabilities.result.capabilities.dataValidation, true)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.cellInsertDeleteHidden.supported, false)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.chartManagement.create, false)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.pivotManagement.refresh, false)
  const sort = await run({ action: 'write', resource, operation: 'sort', payload: { range: 'A1:B2', sorts: [{ key: 1, order: 'asc' }] } })
  assert.equal(sort.result.observed.verified, true); assert.deepEqual(sort.result.observed.values, [[1, 4], [3, 2]])
  const filtered = await run({ action: 'write', resource, operation: 'set_auto_filter', payload: { range: 'A1:B2', enabled: true } })
  assert.equal(filtered.result.observed.enabled, true)
  const filtersCleared = await run({ action: 'write', resource, operation: 'clear_filters', payload: { range: 'A1:B2' } })
  assert.equal(filtersCleared.result.observed.after.operator, 'none')
  for (const operation of ['insert_cell_image', 'create_chart', 'create_pivot_table']) assert.equal((await run({ action: 'write', resource, operation, payload: { range: 'A1:B2' } })).error.code, 'unsupported')
  assert.equal((await run({ action: 'write', resource, operation: 'set_data_validation', payload: { range: 'A1:B2' } })).error.code, 'invalid_range')
  assert.equal(capabilities.result.capabilities.exportPdf, false)
  assert.equal(capabilities.result.capabilities.exportRangeImage, false)
  assert.equal(capabilities.result.capabilities.exportWorksheetImage, false)
})

test('data validation reads bounded features and verifies all requested fields without changing range state', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const features = await run({ action: 'range_features', range: 'A1:B2' })
  assert.equal(features.result.rangeFeatures.range, 'A1:B2'); assert.equal(features.result.rangeFeatures.supported, true); assert.equal(features.result.rangeFeatures.validation, null)
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_data_validation', payload: { range: 'A1:B2', validationType: 'wholeNumber', formula1: '1' } })).error.code, 'invalid_range')
  const payload = { range: 'A1:B2', validationType: 'list', formula1: '"A,B"', formula2: '', ignoreBlank: false, showError: false, errorTitle: '无效', errorMessage: '请选择 A 或 B' }
  const written = await run({ action: 'write', resource, operation: 'set_data_validation', payload })
  assert.equal(JSON.stringify(written.result.observed.validation), JSON.stringify({ type: 3, alertStyle: 1, operator: 1, formula1: '"A,B"', formula2: '', ignoreBlank: false, showError: false, errorTitle: '无效', errorMessage: '请选择 A 或 B' }))
  assert.deepEqual(written.result.observed.state.values, [[3, 2], [1, 4]])
  assert.equal(written.result.observed.state.format.numberFormat, 'General')
  const cleared = await run({ action: 'write', resource, operation: 'clear_data_validation', payload: { range: 'A1:B2' } })
  assert.equal(cleared.result.observed.validation, null)
})

test('ordinary range writes do not require Validation, while validation writes fail before mutation when it is unavailable', async () => {
  const app = fakeApp(); delete app._range.Validation; delete app._range.Hyperlinks; delete app._range.FormatConditions; const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const values = await run({ action: 'write', resource, operation: 'set_values', payload: { range: 'A1:B2', values: [[10, 20], [30, 40]] } })
  assert.equal(values.result.observed.verified, true)
  assert.equal((await run({ action: 'write', resource, operation: 'set_data_validation', payload: { range: 'A1:B2', validationType: 'wholeNumber', formula1: '1', formula2: '9' } })).error.code, 'unsupported')
})

test('hyperlinks read, add, and delete with complete collection and non-target state readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const before = await run({ action: 'range_features', range: 'A1:B2' }); assert.equal(before.result.rangeFeatures.hyperlinksSupported, true); assert.equal(before.result.rangeFeatures.hyperlinks.length, 0)
  const payload = { range: 'A1:B2', url: 'https://example.com/', subAddress: '', textToDisplay: 'Example' }
  const added = await run({ action: 'write', resource, operation: 'add_hyperlink', payload })
  assert.equal(added.result.observed.hyperlinks.length, 1); assert.equal(added.result.observed.newItem.address, payload.url); assert.deepEqual(added.result.observed.state.values, [[3, 2], [1, 4]])
  const sheetReference = await run({ action: 'write', resource, operation: 'add_hyperlink', payload: { range: 'A1:B2', url: '', subAddress: "'Sales 2026'!$A$1:$B$2", textToDisplay: 'Sales' } })
  assert.equal(sheetReference.result.observed.newItem.subAddress, "'Sales 2026'!$A$1:$B$2")
  const namedReference = await run({ action: 'write', resource, operation: 'add_hyperlink', payload: { range: 'A1:B2', url: '', subAddress: 'QuarterlySales', textToDisplay: 'Quarterly sales' } })
  assert.equal(namedReference.result.observed.newItem.subAddress, 'QuarterlySales')
  const withScreenTip = await run({ action: 'write', resource, operation: 'add_hyperlink', payload: { range: 'A1:B2', url: 'https://example.org/', subAddress: '', textToDisplay: 'Example 2', screenTip: 'Open Example 2' } })
  assert.equal(withScreenTip.result.observed.newItem.screenTip, 'Open Example 2')
  const deleted = await run({ action: 'write', resource, operation: 'delete_hyperlinks', payload: { range: 'A1:B2' } })
  assert.equal(deleted.result.observed.hyperlinks.length, 0)
})

test('hyperlinks fail closed for stale collections, unsafe URLs, missing APIs, wrong items, unrelated link changes, state drift, and oversized collections', async () => {
  const payload = { range: 'A1:B2', url: 'https://example.com/', subAddress: '', textToDisplay: 'Example' }
  const staleApp = fakeApp(); const stale = await runtimeWith(staleApp); const staleResource = (await stale({ action: 'context' })).result.resource; const inspected = await stale.raw({ action: 'inspect_write', operation: 'add_hyperlink', payload }); staleApp._hyperlinks.Add(staleApp._range, 'https://before.example/', '', '', 'Before')
  let staleAdds = 0; const staleAdd = staleApp._hyperlinks.Add; staleApp._hyperlinks.Add = (...args) => { staleAdds += 1; staleAdd(...args) }
  assert.equal((await stale.raw({ action: 'write', resource: staleResource, operation: 'add_hyperlink', payload, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch'); assert.equal(staleAdds, 0)

  const unsafe = await runtimeWith(fakeApp()); assert.equal((await unsafe.raw({ action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: 'javascript:alert(1)' } })).error.code, 'invalid_range')
  for (const subAddress of ['javascript:alert(1)', '[Other.xlsx]Sheet1!A1', 'Sheet1!A1:javascript']) {
    assert.equal((await unsafe.raw({ action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, url: '', subAddress } })).error.code, 'invalid_range')
  }
  assert.equal((await unsafe.raw({ action: 'inspect_write', operation: 'add_hyperlink', payload: { ...payload, subAddress: 'javascript:alert(1)' } })).error.code, 'invalid_range')

  const noApiApp = fakeApp(); const noApi = await runtimeWith(noApiApp); const noApiResource = (await noApi({ action: 'context' })).result.resource; let noApiAdds = 0; delete noApiApp._hyperlinks.Item; const noApiAdd = noApiApp._hyperlinks.Add; noApiApp._hyperlinks.Add = (...args) => { noApiAdds += 1; noApiAdd(...args) }
  assert.equal((await noApi({ action: 'write', resource: noApiResource, operation: 'add_hyperlink', payload })).error.code, 'unsupported'); assert.equal(noApiAdds, 0)

  const noAddApp = fakeApp(); const noAdd = await runtimeWith(noAddApp); const noAddResource = (await noAdd({ action: 'context' })).result.resource; delete noAddApp._hyperlinks.Add
  assert.equal((await noAdd({ action: 'write', resource: noAddResource, operation: 'add_hyperlink', payload })).error.code, 'unsupported'); assert.equal(noAddApp._hyperlinks.Count, 0)

  const noDeleteApp = fakeApp(); noDeleteApp._hyperlinks.Add(noDeleteApp._range, 'https://before.example/', '', '', 'Before'); const noDelete = await runtimeWith(noDeleteApp); const noDeleteResource = (await noDelete({ action: 'context' })).result.resource; delete noDeleteApp._hyperlinks.Delete
  assert.equal((await noDelete({ action: 'write', resource: noDeleteResource, operation: 'delete_hyperlinks', payload: { range: 'A1:B2' } })).error.code, 'unsupported'); assert.equal(noDeleteApp._hyperlinks.Count, 1)

  const screenApp = fakeApp(); screenApp._hyperlinks.Add(screenApp._range, 'https://before.example/', '', '', 'Before'); delete screenApp._hyperlinks.items[0].ScreenTip; const screen = await runtimeWith(screenApp); const screenResource = (await screen({ action: 'context' })).result.resource; let screenAdds = 0; const screenAdd = screenApp._hyperlinks.Add; screenApp._hyperlinks.Add = (...args) => { screenAdds += 1; screenAdd(...args) }
  assert.equal((await screen({ action: 'write', resource: screenResource, operation: 'add_hyperlink', payload: { ...payload, screenTip: 'Tip' } })).error.code, 'unsupported'); assert.equal(screenAdds, 0)

  const wrongApp = fakeApp(); const wrong = await runtimeWith(wrongApp); const wrongResource = (await wrong({ action: 'context' })).result.resource; const wrongAdd = wrongApp._hyperlinks.Add; wrongApp._hyperlinks.Add = (range, _url, subAddress, screenTip, text) => wrongAdd(range, 'https://wrong.example/', subAddress, screenTip, text)
  assert.equal((await wrong({ action: 'write', resource: wrongResource, operation: 'add_hyperlink', payload })).error.code, 'readback_mismatch')

  const changedLinksApp = fakeApp(); changedLinksApp._hyperlinks.Add(changedLinksApp._range, 'https://before.example/', '', '', 'Before'); const changedLinks = await runtimeWith(changedLinksApp); const changedLinksResource = (await changedLinks({ action: 'context' })).result.resource; const changedLinksAdd = changedLinksApp._hyperlinks.Add; changedLinksApp._hyperlinks.Add = (...args) => { changedLinksAdd(...args); changedLinksApp._hyperlinks.items[0].TextToDisplay = 'Changed' }
  assert.equal((await changedLinks({ action: 'write', resource: changedLinksResource, operation: 'add_hyperlink', payload })).error.code, 'readback_mismatch')

  const driftApp = fakeApp(); const drift = await runtimeWith(driftApp); const driftResource = (await drift({ action: 'context' })).result.resource; const driftAdd = driftApp._hyperlinks.Add; driftApp._hyperlinks.Add = (...args) => { driftAdd(...args); driftApp._range.NumberFormat = '0.00' }
  assert.equal((await drift({ action: 'write', resource: driftResource, operation: 'add_hyperlink', payload })).error.code, 'readback_mismatch')

  const oversizedApp = fakeApp(); oversizedApp._hyperlinks.Count = 201; const oversized = await runtimeWith(oversizedApp); const features = await oversized({ action: 'range_features', range: 'A1:B2' }); assert.equal(features.result.rangeFeatures.hyperlinksSupported, false); assert.equal(features.result.rangeFeatures.hyperlinks, null)
})

test('conditional formats read, add, and clear with complete collection and core-state readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const before = await run({ action: 'range_features', range: 'A1:B2' }); assert.equal(before.result.rangeFeatures.conditionalFormatsSupported, true); assert.equal(before.result.rangeFeatures.conditionalFormats.length, 0)
  const payload = { range: 'A1:B2', conditionType: 'cellValue', operator: 'between', formula1: '1', formula2: '9', fillColor: '#ff0000', fontColor: '#00ff00', bold: true, italic: true }
  const added = await run({ action: 'write', resource, operation: 'add_conditional_format', payload })
  assert.equal(added.result.observed.conditionalFormats.length, 1); assert.equal(JSON.stringify(added.result.observed.newItem), JSON.stringify({ type: 1, operator: 1, formula1: '1', formula2: '9', priority: 1, fillColor: '#FF0000', fontColor: '#00FF00', bold: true, italic: true })); assert.deepEqual(added.result.observed.state.values, [[3, 2], [1, 4]])
  const cleared = await run({ action: 'write', resource, operation: 'clear_conditional_formats', payload: { range: 'A1:B2' } })
  assert.equal(cleared.result.observed.conditionalFormats.length, 0)
})

test('conditional formats fail closed for stale, incomplete, wrong, changed, drifted, and oversized collections', async () => {
  const payload = { range: 'A1:B2', conditionType: 'cellValue', operator: 'between', formula1: '1', formula2: '9', fillColor: '#FF0000', fontColor: '#00FF00', bold: true, italic: true }
  const staleApp = fakeApp(); const stale = await runtimeWith(staleApp); const staleResource = (await stale({ action: 'context' })).result.resource; const inspected = await stale.raw({ action: 'inspect_write', operation: 'add_conditional_format', payload }); staleApp._conditionalFormats.Add(1, 3, '4', '')
  let staleAdds = 0; const staleAdd = staleApp._conditionalFormats.Add; staleApp._conditionalFormats.Add = (...args) => { staleAdds += 1; return staleAdd(...args) }
  assert.equal((await stale.raw({ action: 'write', resource: staleResource, operation: 'add_conditional_format', payload, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch'); assert.equal(staleAdds, 0)

  const incompleteApp = fakeApp(); incompleteApp._conditionalFormats.Add(1, 3, '4', ''); delete incompleteApp._conditionalFormats.items[0].Font.Italic; const incomplete = await runtimeWith(incompleteApp); const incompleteResource = (await incomplete({ action: 'context' })).result.resource; let incompleteAdds = 0; const incompleteAdd = incompleteApp._conditionalFormats.Add; incompleteApp._conditionalFormats.Add = (...args) => { incompleteAdds += 1; return incompleteAdd(...args) }
  assert.equal((await incomplete({ action: 'write', resource: incompleteResource, operation: 'add_conditional_format', payload })).error.code, 'unsupported'); assert.equal(incompleteAdds, 0)

  const noItemApp = fakeApp(); delete noItemApp._conditionalFormats.Item; const noItem = await runtimeWith(noItemApp); const noItemResource = (await noItem({ action: 'context' })).result.resource; let noItemAdds = 0; const noItemAdd = noItemApp._conditionalFormats.Add; noItemApp._conditionalFormats.Add = (...args) => { noItemAdds += 1; return noItemAdd(...args) }
  assert.equal((await noItem({ action: 'write', resource: noItemResource, operation: 'add_conditional_format', payload })).error.code, 'unsupported'); assert.equal(noItemAdds, 0)

  const noAddApp = fakeApp(); delete noAddApp._conditionalFormats.Add; const noAdd = await runtimeWith(noAddApp); const noAddResource = (await noAdd({ action: 'context' })).result.resource
  assert.equal((await noAdd({ action: 'write', resource: noAddResource, operation: 'add_conditional_format', payload })).error.code, 'unsupported')

  const noDeleteApp = fakeApp(); noDeleteApp._conditionalFormats.Add(1, 3, '4', ''); delete noDeleteApp._conditionalFormats.Delete; const noDelete = await runtimeWith(noDeleteApp); const noDeleteResource = (await noDelete({ action: 'context' })).result.resource
  assert.equal((await noDelete({ action: 'write', resource: noDeleteResource, operation: 'clear_conditional_formats', payload: { range: 'A1:B2' } })).error.code, 'unsupported'); assert.equal(noDeleteApp._conditionalFormats.Count, 1)

  const wrongApp = fakeApp(); const wrong = await runtimeWith(wrongApp); const wrongResource = (await wrong({ action: 'context' })).result.resource; const wrongAdd = wrongApp._conditionalFormats.Add; wrongApp._conditionalFormats.Add = (type, operator, _formula1, formula2) => wrongAdd(type, operator, 'wrong', formula2)
  assert.equal((await wrong({ action: 'write', resource: wrongResource, operation: 'add_conditional_format', payload })).error.code, 'readback_mismatch')

  const changedApp = fakeApp(); changedApp._conditionalFormats.Add(1, 3, '4', ''); const changed = await runtimeWith(changedApp); const changedResource = (await changed({ action: 'context' })).result.resource; const changedAdd = changedApp._conditionalFormats.Add; changedApp._conditionalFormats.Add = (...args) => { const item = changedAdd(...args); changedApp._conditionalFormats.items[0].Font.Bold = true; return item }
  assert.equal((await changed({ action: 'write', resource: changedResource, operation: 'add_conditional_format', payload })).error.code, 'readback_mismatch')

  const driftApp = fakeApp(); const drift = await runtimeWith(driftApp); const driftResource = (await drift({ action: 'context' })).result.resource; const driftAdd = driftApp._conditionalFormats.Add; driftApp._conditionalFormats.Add = (...args) => { const item = driftAdd(...args); driftApp._range.NumberFormat = '0.00'; return item }
  assert.equal((await drift({ action: 'write', resource: driftResource, operation: 'add_conditional_format', payload })).error.code, 'readback_mismatch')

  const oversizedApp = fakeApp(); oversizedApp._conditionalFormats.Count = 201; const oversized = await runtimeWith(oversizedApp); const features = await oversized({ action: 'range_features', range: 'A1:B2' }); assert.equal(features.result.rangeFeatures.conditionalFormatsSupported, false); assert.equal(features.result.rangeFeatures.conditionalFormats, null)
})

test('data validation fails closed for stale state, missing API, wrong property readback, changed range state, and oversized feature reads', async () => {
  const staleApp = fakeApp(); const stale = await runtimeWith(staleApp); const resource = (await stale({ action: 'context' })).result.resource; const payload = { range: 'A1:B2', validationType: 'wholeNumber', formula1: '1', formula2: '9' }
  const inspected = await stale.raw({ action: 'inspect_write', operation: 'set_data_validation', payload }); staleApp._validation.Type = 3
  let deletes = 0; const remove = staleApp._validation.Delete; staleApp._validation.Delete = () => { deletes += 1; remove() }
  assert.equal((await stale.raw({ action: 'write', resource, operation: 'set_data_validation', payload, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch'); assert.equal(deletes, 0)

  const missingApp = fakeApp(); const missing = await runtimeWith(missingApp); const missingResource = (await missing({ action: 'context' })).result.resource; let adds = 0; delete missingApp._validation.Delete; const add = missingApp._validation.Add; missingApp._validation.Add = (...args) => { adds += 1; add(...args) }
  assert.equal((await missing({ action: 'write', resource: missingResource, operation: 'set_data_validation', payload })).error.code, 'unsupported'); assert.equal(adds, 0)

  const noAddApp = fakeApp(); const noAdd = await runtimeWith(noAddApp); const noAddResource = (await noAdd({ action: 'context' })).result.resource; let noAddDeletes = 0; delete noAddApp._validation.Add; const noAddDelete = noAddApp._validation.Delete; noAddApp._validation.Delete = () => { noAddDeletes += 1; noAddDelete() }
  assert.equal((await noAdd({ action: 'write', resource: noAddResource, operation: 'set_data_validation', payload })).error.code, 'unsupported'); assert.equal(noAddDeletes, 0)

  const incompleteApp = fakeApp(); const incomplete = await runtimeWith(incompleteApp); const incompleteResource = (await incomplete({ action: 'context' })).result.resource; let incompleteDeletes = 0; const incompleteDelete = incompleteApp._validation.Delete; incompleteApp._validation.Delete = () => { incompleteDeletes += 1; incompleteDelete() }; delete incompleteApp._range.EntireRow
  assert.equal((await incomplete({ action: 'write', resource: incompleteResource, operation: 'set_data_validation', payload })).error.code, 'unsupported'); assert.equal(incompleteDeletes, 0)

  const wrongApp = fakeApp(); const wrong = await runtimeWith(wrongApp); const wrongResource = (await wrong({ action: 'context' })).result.resource
  Object.defineProperty(wrongApp._validation, 'ErrorTitle', { configurable: true, get: () => '', set: () => {} })
  assert.equal((await wrong({ action: 'write', resource: wrongResource, operation: 'set_data_validation', payload: { ...payload, errorTitle: 'expected' } })).error.code, 'readback_mismatch')

  const changedApp = fakeApp(); const changed = await runtimeWith(changedApp); const changedResource = (await changed({ action: 'context' })).result.resource; const changedAdd = changedApp._validation.Add; changedApp._validation.Add = (...args) => { changedAdd(...args); changedApp._range.NumberFormat = '0.00' }
  assert.equal((await changed({ action: 'write', resource: changedResource, operation: 'set_data_validation', payload })).error.code, 'readback_mismatch')

  const oversizedApp = fakeApp(); oversizedApp._validation.Type = 3; oversizedApp._validation.ErrorMessage = 'x'.repeat(1025); const oversized = await runtimeWith(oversizedApp)
  const features = (await oversized({ action: 'range_features', range: 'A1:B2' })).result.rangeFeatures; assert.equal(features.range, 'A1:B2'); assert.equal(features.supported, false); assert.equal(features.validation, null)
})

test('chart creation is unavailable before callback-driven mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let callbacks = 0
  app._sheet.addChart = (_style, type, _range, callback) => {
    callbacks += 1; callback({ Id: 7, Name: 'Async Chart', Type: type }, 'ok')
    return Promise.resolve({ accepted: true })
  }
  const result = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })
  assert.equal(result.error.code, 'unsupported'); assert.equal(callbacks, 0); assert.equal(app._charts.Count, 0)
})

test('unusable spreadsheet exports fail closed before invoking WebEdit export APIs', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let exports = 0
  app._range.ToImageDataURL = () => { exports += 1; return 'data:image/png;base64,AQID' }
  app._sheet.ExportImage = () => { exports += 1; return {} }
  app._workbook.ExportAsFixedFormat = () => { exports += 1; return {} }
  for (const operation of ['export_pdf', 'export_range_image', 'export_worksheet_image']) {
    const payload = { range: 'A1:B2' }; const inspected = await run.raw({ action: 'inspect_write', operation, payload })
    const result = await run.raw({ action: 'write', resource, operation, payload, precondition: inspected.result.precondition })
    assert.equal(result.error.code, 'unsupported')
  }
  assert.equal(exports, 0)
})

test('every unverified AccrUI spreadsheet family fails closed before mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let mutations = 0; app._range.copyRange = () => { mutations += 1 }
  for (const operation of ['insert_cells', 'set_rows_hidden', 'fill_range', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'auto_fit_range', 'copy_range', 'move_range', 'set_freeze_panes', 'set_print_settings', 'undo', 'redo', 'update_chart', 'delete_chart', 'refresh_pivot_table', 'delete_pivot_table']) {
    const result = await run({ action: 'write', resource, operation, payload: { range: 'A1' } })
    assert.equal(result.ok, false, operation); assert.equal(result.error.code, 'unsupported', operation)
  }
  assert.equal(mutations, 0)
})
