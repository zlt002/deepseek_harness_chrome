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
  const hyperlinks = { Count: 0, items: [], Add: (_range, url, subAddress) => { hyperlinks.items.push({ Address: url, SubAddress: subAddress }); hyperlinks.Count += 1 }, Delete: () => { hyperlinks.Count = 0; hyperlinks.items = [] }, Item: (index) => hyperlinks.items[index - 1] }
  const validation = { Type: 0, Formula1: undefined, Formula2: undefined, Add: (type, _alertStyle, _operator, formula1, formula2) => { validation.Type = type; validation.Formula1 = formula1; validation.Formula2 = formula2 }, Delete: () => { validation.Type = 0; validation.Formula1 = undefined; validation.Formula2 = undefined } }
  const charts = { Count: 0, Item: (index) => charts.items[index - 1], items: [] }
  const pivots = { Count: 0, Item: (index) => pivots.items[index - 1], items: [] }
  const range = {
    getValue2: () => cells.map((row) => [...row]), getText: () => cells.map((row) => row.map(String)), getFormula: () => formulas.map((row) => [...row]),
    setValue2: (next) => { cells.splice(0, cells.length, ...next.map((row) => [...row])) },
    setFormula: (next) => { formulas.splice(0, formulas.length, ...next.map((row) => [...row])) },
    clear: () => { cells.forEach((row, rowIndex) => row.forEach((_cell, columnIndex) => { cells[rowIndex][columnIndex] = null; formulas[rowIndex][columnIndex] = '' })) },
    Font: {}, Interior: {},
    merge: () => { range.MergeCells = true }, unmerge: () => { range.MergeCells = false },
    sort: (key) => { const column = Number(key) - 1; cells.sort((left, right) => Number(left[column]) - Number(right[column])) },
    AutoFilter: false, setAutoFilter: (enabled) => { range.AutoFilter = enabled },
    queryAutoFilterListItems: (_kind, _options, callback) => callback({ result: { fieldData: { condition: { operator: filterOperator } } } }),
    autoFilterShowAll: (callback) => { filterOperator = 'none'; callback({ isOk: true }) },
    Validation: validation, Hyperlinks: hyperlinks,
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
  return { ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _range: range, _sheet: sheet, _charts: charts, _pivots: pivots, _comments: comments, _workbook: workbook }
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
  const stale = await run({ action: 'write', resource: { ...resource, fingerprint: 'stale' }, operation: 'set_values', payload: { range: 'A1', values: [[1]] } })
  assert.equal(stale.error.code, 'fingerprint_mismatch')
  const unsupported = await run({ action: 'write', resource, operation: 'insert_rows', payload: { range: '1:1', count: 1 } })
  assert.equal(unsupported.error.code, 'unsupported')
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
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.cellInsertDeleteHidden.supported, false)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.chartManagement.create, false)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.pivotManagement.refresh, false)
  const sort = await run({ action: 'write', resource, operation: 'sort', payload: { range: 'A1:B2', sorts: [{ key: 1, order: 'asc' }] } })
  assert.equal(sort.result.observed.verified, true); assert.deepEqual(sort.result.observed.values, [[1, 4], [3, 2]])
  const filtered = await run({ action: 'write', resource, operation: 'set_auto_filter', payload: { range: 'A1:B2', enabled: true } })
  assert.equal(filtered.result.observed.enabled, true)
  const filtersCleared = await run({ action: 'write', resource, operation: 'clear_filters', payload: { range: 'A1:B2' } })
  assert.equal(filtersCleared.result.observed.after.operator, 'none')
  for (const operation of ['set_data_validation', 'add_hyperlink', 'insert_cell_image', 'create_chart', 'create_pivot_table']) assert.equal((await run({ action: 'write', resource, operation, payload: { range: 'A1:B2' } })).error.code, 'unsupported')
  assert.equal(capabilities.result.capabilities.exportPdf, false)
  assert.equal(capabilities.result.capabilities.exportRangeImage, false)
  assert.equal(capabilities.result.capabilities.exportWorksheetImage, false)
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
    const payload = { range: 'A1' }; const inspected = await run.raw({ action: 'inspect_write', operation, payload })
    const result = await run.raw({ action: 'write', resource, operation, payload, precondition: inspected.result.precondition })
    assert.equal(result.error.code, 'unsupported')
  }
  assert.equal(exports, 0)
})

test('every unverified AccrUI spreadsheet family fails closed before mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let mutations = 0; app._range.copyRange = () => { mutations += 1 }
  for (const operation of ['insert_cells', 'set_rows_hidden', 'fill_range', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'auto_fit_range', 'add_conditional_format', 'copy_range', 'move_range', 'set_freeze_panes', 'create_defined_name', 'set_print_settings', 'copy_worksheet', 'move_worksheet', 'set_worksheet_visibility', 'undo', 'redo', 'update_chart', 'delete_chart', 'refresh_pivot_table', 'delete_pivot_table']) {
    const result = await run({ action: 'write', resource, operation, payload: { range: 'A1' } })
    assert.equal(result.ok, false, operation); assert.equal(result.error.code, 'unsupported', operation)
  }
  assert.equal(mutations, 0)
})
