import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function runtimeWith(app) {
  const source = await readFile(new URL('../public/office-spreadsheet-runtime.js', import.meta.url), 'utf8')
  const context = vm.createContext({ APP: app, location: { origin: 'https://webedit.midea.com', pathname: '/sheet/1' }, globalThis: null, window: null, console })
  context.globalThis = context; context.window = context
  vm.runInContext(source, context)
  return context.__deepseekHarnessOfficeSpreadsheet.run
}

function fakeApp() {
  const cells = [[3, 2], [1, 4]]
  const formulas = [['', ''], ['', '']]
  const comments = { Count: 0 }
  const hyperlinks = { Count: 0, Add: () => { hyperlinks.Count += 1 }, Delete: () => { hyperlinks.Count = 0 } }
  const validation = { Type: 0, Add: (type) => { validation.Type = type }, Delete: () => { validation.Type = 0 } }
  const range = {
    getValue2: () => cells.map((row) => [...row]), getText: () => cells.map((row) => row.map(String)), getFormula: () => formulas.map((row) => [...row]),
    setValue2: (next) => { cells.splice(0, cells.length, ...next.map((row) => [...row])) },
    setFormula: (next) => { formulas.splice(0, formulas.length, ...next.map((row) => [...row])) },
    Font: {}, Interior: {},
    merge: () => { range.MergeCells = true }, unmerge: () => { range.MergeCells = false },
    sort: (key) => { const column = Number(key) - 1; cells.sort((left, right) => Number(left[column]) - Number(right[column])) },
    AutoFilter: false, setAutoFilter: (enabled) => { range.AutoFilter = enabled },
    Validation: validation, Hyperlinks: hyperlinks,
    AddComment: () => { comments.Count += 1 }, ClearComments: () => { comments.Count = 0 },
    insertCellPictureUrl: () => { range.Formula = '=DISPIMG("image")' },
  }
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => range, Range: () => range, Comments: comments }
  const workbook = { Name: 'Budget.xlsx', getName: () => 'Budget.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  return { ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _range: range }
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
})

test('spreadsheet runtime rejects a stale resource and unsupported structural API without reporting success', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const resource = (await run({ action: 'context' })).result.resource
  const stale = await run({ action: 'write', resource: { ...resource, fingerprint: 'stale' }, operation: 'set_values', payload: { range: 'A1', values: [[1]] } })
  assert.equal(stale.error.code, 'fingerprint_mismatch')
  const unsupported = await run({ action: 'write', resource, operation: 'insert_rows', payload: { range: '1:1', count: 1 } })
  assert.equal(unsupported.error.code, 'unsupported')
})

test('spreadsheet runtime probes and verifies AccrUI-derived advanced range operations', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const resource = (await run({ action: 'context' })).result.resource
  const capabilities = await run({ action: 'capabilities', range: 'A1:B2' })
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.capabilities)), {
    sort: true, autoFilter: true, dataValidation: true, hyperlinks: true, comments: true,
    charts: false, pivots: false, cellImages: true, exportPdf: false, exportRangeImage: false, detectedButUnsupported: [],
  })
  const sort = await run({ action: 'write', resource, operation: 'sort', payload: { range: 'A1:B2', sorts: [{ key: 1, order: 'asc' }] } })
  assert.equal(sort.result.observed.verified, true); assert.deepEqual(sort.result.observed.values, [[1, 4], [3, 2]])
  const filtered = await run({ action: 'write', resource, operation: 'set_auto_filter', payload: { range: 'A1:B2', enabled: true } })
  assert.equal(filtered.result.observed.enabled, true)
  const validated = await run({ action: 'write', resource, operation: 'set_data_validation', payload: { range: 'A1', validationType: 'list', formula1: 'yes,no' } })
  assert.equal(validated.result.observed.type, 3)
  const linked = await run({ action: 'write', resource, operation: 'add_hyperlink', payload: { range: 'A1', url: 'https://example.test' } })
  assert.equal(linked.result.observed.count, 1)
  const commented = await run({ action: 'write', resource, operation: 'add_comment', payload: { range: 'A1', text: '复核' } })
  assert.equal(commented.result.observed.count, 1)
  const image = await run({ action: 'write', resource, operation: 'insert_cell_image', payload: { range: 'A1', url: 'https://example.test/image.png' } })
  assert.match(image.result.observed.formula, /^=DISPIMG\(/)
  const unsupported = await run({ action: 'write', resource, operation: 'create_pivot_table', payload: { range: 'A1:B2' } })
  assert.equal(unsupported.error.code, 'unsupported')
})
