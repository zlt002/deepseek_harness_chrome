import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function runtimeWith(app) {
  const source = await readFile(new URL('../public/office-spreadsheet-runtime.js', import.meta.url), 'utf8')
  const context = vm.createContext({ APP: app, location: { origin: 'https://webedit.midea.com', pathname: '/sheet/1' }, globalThis: null, window: null, console, btoa: (value) => Buffer.from(value, 'binary').toString('base64'), setTimeout, clearTimeout, Uint8Array, Date, URL })
  context.globalThis = context; context.window = context
  vm.runInContext(source, context)
  return context.__deepseekHarnessOfficeSpreadsheet.run
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

test('spreadsheet runtime verifies sheet lifecycle against worksheet enumeration and active-sheet readback', async () => {
  const app = sheetApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const added = await run({ action: 'write', resource, operation: 'sheet_add', payload: { name: 'Plan' } })
  assert.equal(added.result.observed.afterCount, 3)
  const renamed = await run({ action: 'write', resource, operation: 'sheet_rename', payload: { name: 'Plan', newName: 'Final' } })
  assert.equal(renamed.result.observed.name, 'Final')
  const selected = await run({ action: 'write', resource, operation: 'sheet_select', payload: { name: 'Final' } })
  assert.equal(selected.result.observed.name, 'Final')
  const deleted = await run({ action: 'write', resource, operation: 'sheet_delete', payload: { name: 'Final' } })
  assert.equal(deleted.result.observed.afterCount, 2)
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
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.capabilities)), {
    sort: true, autoFilter: true, dataValidation: true, hyperlinks: true, comments: false,
    charts: true, pivots: true, cellImages: true, exportPdf: true, exportRangeImage: true, exportWorksheetImage: true, detectedButUnsupported: ['comments'],
  })
  const sort = await run({ action: 'write', resource, operation: 'sort', payload: { range: 'A1:B2', sorts: [{ key: 1, order: 'asc' }] } })
  assert.equal(sort.result.observed.verified, true); assert.deepEqual(sort.result.observed.values, [[1, 4], [3, 2]])
  const filtered = await run({ action: 'write', resource, operation: 'set_auto_filter', payload: { range: 'A1:B2', enabled: true } })
  assert.equal(filtered.result.observed.enabled, true)
  const filtersCleared = await run({ action: 'write', resource, operation: 'clear_filters', payload: { range: 'A1:B2' } })
  assert.equal(filtersCleared.result.observed.after.operator, 'none')
  const validated = await run({ action: 'write', resource, operation: 'set_data_validation', payload: { range: 'A1', validationType: 'list', formula1: 'yes,no' } })
  assert.equal(validated.result.observed.type, 3)
  const linked = await run({ action: 'write', resource, operation: 'add_hyperlink', payload: { range: 'A1', url: 'https://example.test' } })
  assert.equal(linked.result.observed.count, 1)
  const commentUnsupported = await run({ action: 'write', resource, operation: 'add_comment', payload: { range: 'A1', text: '复核' } })
  assert.equal(commentUnsupported.error.code, 'unsupported')
  const deleteCommentsUnsupported = await run({ action: 'write', resource, operation: 'delete_comments', payload: { range: 'A1' } })
  assert.equal(deleteCommentsUnsupported.error.code, 'unsupported')
  assert.equal(app._comments.Count, 0)
  const image = await run({ action: 'write', resource, operation: 'insert_cell_image', payload: { range: 'A1', url: 'https://example.test/image.png' } })
  assert.match(image.result.observed.formula, /^=DISPIMG\(/)
  const chart = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2', chartType: 'columnClustered' } })
  assert.equal(chart.result.observed.afterCount, 1); assert.equal(chart.result.observed.chart.name, 'Chart 1')
  const pivot = await run({ action: 'write', resource, operation: 'create_pivot_table', payload: { range: 'A1:B2', destination: 'D1', isNewSheet: false } })
  assert.equal(pivot.result.observed.afterCount, 1); assert.equal(pivot.result.observed.pivot.name, 'Pivot 1')
  const pdf = await run({ action: 'write', resource, operation: 'export_pdf', payload: { range: 'A1', scope: 'workbook' } })
  assert.equal(pdf.result.observed.artifact.mimeType, 'application/pdf'); assert.equal(pdf.result.observed.artifact.sourceOrigin, 'https://download.example.test'); assert.equal(pdf.result.observed.artifact.queryRedacted, true)
  const rangeImage = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1' } })
  assert.equal(rangeImage.result.observed.artifact.byteLength, 3)
  const worksheetImage = await run({ action: 'write', resource, operation: 'export_worksheet_image', payload: { range: 'A1' } })
  assert.equal(worksheetImage.result.observed.artifact.byteLength, 3)
})

test('chart waits for its callback, rejects callback failures, and binds callback identity to collection readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app._sheet.addChart = (_style, type, _range, callback) => {
    const chart = { Id: 7, Name: 'Async Chart', Type: type }
    queueMicrotask(() => { app._charts.items.push(chart); app._charts.Count += 1; callback(chart, 'ok') })
    return Promise.resolve({ accepted: true })
  }
  const completed = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })
  assert.equal(completed.result.observed.chart.id, 7)

  app._sheet.addChart = (_style, _type, _range, callback) => { queueMicrotask(() => callback({ isOk: false, error: 'chart rejected' })); return Promise.resolve({ accepted: true }) }
  const rejected = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })
  assert.equal(rejected.error.code, 'readback_mismatch'); assert.match(rejected.error.message, /chart rejected/)

  app._sheet.addChart = (_style, type, _range, callback) => {
    const collectionChart = { Id: 8, Name: 'Collection Chart', Type: type }
    app._charts.items.push(collectionChart); app._charts.Count += 1; callback({ Id: 9, Name: 'Different Chart', Type: type }, 'ok')
  }
  const mismatched = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })
  assert.equal(mismatched.error.code, 'readback_mismatch'); assert.match(mismatched.error.message, /identify the same created chart/)
})

test('spreadsheet artifacts keep data URLs small and redact PDF query credentials', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const imageDataUrl = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`
  app._range.ToImageDataURL = () => imageDataUrl(8 * 1024)
  const inline = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1' } })
  assert.equal(inline.result.observed.artifact.delivery, 'inline'); assert.ok(inline.result.observed.artifact.dataUrl)

  app._range.ToImageDataURL = () => imageDataUrl(8 * 1024 + 1)
  const metadataOnly = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1' } })
  assert.equal(metadataOnly.result.observed.artifact.delivery, 'metadata_only'); assert.equal('dataUrl' in metadataOnly.result.observed.artifact, false)

  app._range.ToImageDataURL = () => imageDataUrl(256 * 1024)
  const maximum = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1' } })
  assert.equal(maximum.result.observed.artifact.delivery, 'metadata_only'); assert.equal(maximum.result.observed.artifact.byteLength, 256 * 1024)

  app._range.ToImageDataURL = () => imageDataUrl(256 * 1024 + 1)
  const tooLarge = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1' } })
  assert.equal(tooLarge.error.code, 'readback_mismatch'); assert.match(tooLarge.error.message, /bounded image artifact/)

  app._workbook.ExportAsFixedFormat = () => ({ url: 'https://download.example.test/Budget.pdf?X-Amz-Signature=secret&token=also-secret&Expires=2000000000' })
  const pdf = await run({ action: 'write', resource, operation: 'export_pdf', payload: { range: 'A1', scope: 'workbook' } })
  assert.equal(pdf.result.observed.artifact.queryRedacted, true)
  assert.equal(JSON.stringify(pdf.result).includes('secret'), false)
})
