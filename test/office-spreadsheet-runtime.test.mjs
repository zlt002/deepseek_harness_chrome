import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { SPREADSHEET_WRITE_OPERATIONS } from '../apps/native-server/src/connector-tool-catalog.mjs'

async function runtimeWith(app) {
  const source = await readFile(new URL('../apps/chrome-extension/public/office-spreadsheet-runtime.js', import.meta.url), 'utf8')
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
  let activeRow = 1; let activeColumn = 1; let freezePanes = false; let splitRow = 0; let splitColumn = 0
  const rowOutline = new Map(); const columnOutline = new Map()
  const hiddenRows = new Map(); const hiddenColumns = new Map(); const rowSizes = new Map(); const columnSizes = new Map()
  const pageSetup = { PrintArea: '', PrintTitleRows: '', PrintTitleColumns: '', Orientation: 1, Zoom: 100, FitToPagesWide: 1, FitToPagesTall: 1, CenterHorizontally: false, CenterVertically: false, LeftMargin: 36, RightMargin: 36, TopMargin: 36, BottomMargin: 36, HeaderMargin: 18, FooterMargin: 18 }
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
    clearContents: () => { cells.forEach((row, rowIndex) => row.forEach((_cell, columnIndex) => { cells[rowIndex][columnIndex] = null; formulas[rowIndex][columnIndex] = '' })) },
    fillDown: (callback) => { for (let row = 1; row < cells.length; row += 1) cells[row] = [...cells[0]]; callback?.({ isOk: true }) }, fillUp: (callback) => { for (let row = 0; row < cells.length - 1; row += 1) cells[row] = [...cells.at(-1)]; callback?.({ isOk: true }) }, fillRight: (callback) => { cells.forEach((row) => { for (let column = 1; column < row.length; column += 1) row[column] = row[0] }); callback?.({ isOk: true }) }, fillLeft: (callback) => { cells.forEach((row) => { for (let column = 0; column < row.length - 1; column += 1) row[column] = row.at(-1) }); callback?.({ isOk: true }) },
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
  const dimension = (axis, from, to) => {
    const hidden = axis === 'row' ? hiddenRows : hiddenColumns; const sizes = axis === 'row' ? rowSizes : columnSizes; const sizeKey = axis === 'row' ? 'RowHeight' : 'ColumnWidth'; const defaultSize = axis === 'row' ? 15 : 8
    const item = { AutoFit: () => { for (let index = from; index <= to; index += 1) sizes.set(index, defaultSize + 1) } }
    Object.defineProperties(item, { Hidden: { configurable: true, get: () => hidden.get(from) ?? false, set: (value) => { for (let index = from; index <= to; index += 1) hidden.set(index, value) } }, [sizeKey]: { configurable: true, get: () => sizes.get(from) ?? defaultSize, set: (value) => { for (let index = from; index <= to; index += 1) sizes.set(index, value) } } })
    return item
  }
  const sheet = {
    Name: 'Sheet1', getName: () => 'Sheet1', getLastRow: () => 2, getLastColumn: () => 2, PageSetup: pageSetup, getRowOutlineLevel: (index) => rowOutline.get(index) ?? 0, getColOutlineLevel: (index) => columnOutline.get(index) ?? 0, getRange: (address) => { const match = String(address ?? '').match(/^([A-Z]+)(\d+)$/i); const rowMatch = String(address ?? '').match(/^(\d+):(\d+)$/); const columnMatch = String(address ?? '').match(/^([A-Z]+):([A-Z]+)$/i); if (rowMatch) { const from = Number(rowMatch[1]); const to = Number(rowMatch[2]); const member = dimension('row', from, to); return Object.assign(Object.create(range), { EntireRow: member, Rows: Object.assign(member, { Group: () => { for (let index = from; index <= to; index += 1) rowOutline.set(index, (rowOutline.get(index) ?? 0) + 1) }, Ungroup: () => { for (let index = from; index <= to; index += 1) rowOutline.set(index, Math.max(0, (rowOutline.get(index) ?? 0) - 1)) } }) }) }; if (columnMatch) { const index = (name) => name.toUpperCase().split('').reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0); const from = index(columnMatch[1]); const to = index(columnMatch[2]); const member = dimension('column', from, to); return Object.assign(Object.create(range), { EntireColumn: member, Columns: Object.assign(member, { Group: () => { for (let item = from; item <= to; item += 1) columnOutline.set(item, (columnOutline.get(item) ?? 0) + 1) }, Ungroup: () => { for (let item = from; item <= to; item += 1) columnOutline.set(item, Math.max(0, (columnOutline.get(item) ?? 0) - 1)) } }) }) }; return match ? Object.assign(Object.create(range), { Select: () => { activeColumn = match[1].toUpperCase().split('').reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0); activeRow = Number(match[2]) } }) : range }, Range: () => range, Comments: comments, Shapes: charts,
    getPivotTables: () => pivots, Charts: charts,
    addChart: (_style, type, _range, callback) => { const chart = { Id: charts.Count + 1, Name: `Chart ${charts.Count + 1}`, Type: type }; charts.items.push(chart); charts.Count += 1; callback(chart, 'ok') },
    ExportImage: () => ({ result: 'ok', data: { size: 3, type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }),
  }
  range.createPivotTable = (options, callback) => { const pivot = { Id: pivots.Count + 1, Name: `Pivot ${pivots.Count + 1}`, Destination: options.destRangeText }; pivots.items.push(pivot); pivots.Count += 1; callback({ isOk: true, pivotTableId: pivot.Id }) }
  const workbook = { Name: 'Budget.xlsx', getName: () => 'Budget.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet }, ExportAsFixedFormat: () => ({ url: 'https://download.example.test/Budget.pdf?Expires=2000000000' }) }
  const activeWindow = { get FreezePanes() { return freezePanes }, set FreezePanes(value) { freezePanes = value; if (value) { splitRow = activeRow - 1; splitColumn = activeColumn - 1 } }, get SplitRow() { return splitRow }, get SplitColumn() { return splitColumn }, Zoom: 100, ScrollRow: 1, ScrollColumn: 1 }
  const app = { ActiveWorkbook: workbook, ActiveSheet: sheet, ActiveWindow: activeWindow, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _range: range, _sheet: sheet, _validation: validation, _hyperlinks: hyperlinks, _conditionalFormats: conditionalFormats, _charts: charts, _pivots: pivots, _comments: comments, _workbook: workbook, _activeWindow: activeWindow, _pageSetup: pageSetup, _rowOutline: rowOutline, _columnOutline: columnOutline, _hiddenRows: hiddenRows, _hiddenColumns: hiddenColumns, _rowSizes: rowSizes, _columnSizes: columnSizes }
  Object.defineProperty(app, 'ActiveCell', { get: () => ({ Row: activeRow, Column: activeColumn }) })
  return app
}

// This fake models the public WebEdit object/callback boundary used by the
// analytics runtime.  It intentionally keeps collections 1-based, because a
// zero-based happy-path mock would hide the identity and count bugs we need to
// guard against in WPS.
function analyticsApp() {
  const app = fakeApp(); const charts = app._charts; const pivots = app._pivots
  const originalGetRange = app._sheet.getRange; app._sheet.getRange = (address) => Object.assign(Object.create(originalGetRange(address)), { Address: address })
  const refresh = (callback) => callback({ isOk: true })
  const chart = (id, name, type = 'columnClustered') => {
    const value = { Id: id, Name: name, Type: type, Title: '', SourceData: 'A1:B2', Width: 300, Height: 180, Left: 0, Top: 0 }
    value.getChartLayer = () => ({ setDataSource: (source, callback) => { value.SourceData = source?.Address ?? source?.address ?? 'A1:B2'; refresh(callback) }, setChartType: (next, callback) => { value.Type = next; refresh(callback) }, setChartTitle: (next, callback) => { value.Title = next; refresh(callback) } })
    value.getSourceData = () => value.SourceData; value.getChartType = () => value.Type; value.getTitle = () => value.Title
    value.getWidth = () => value.Width; value.getHeight = () => value.Height; value.getLeft = () => value.Left; value.getTop = () => value.Top
    value.setWidth = (next) => { value.Width = next }; value.setHeight = (next) => { value.Height = next }; value.setLeft = (next) => { value.Left = next }; value.setTop = (next) => { value.Top = next }
    return value
  }
  const field = (name, orientation = 'etRowField') => ({ Name: name, Orientation: orientation, Position: 0, SummaryFunction: 'etSum', Calculation: 'xlNoAdditionalCalculation', BaseField: null, BaseItem: null, AutoSortOrder: null, Subtotals: ['SubtotalAuto'] })
  const pivot = (id, name, destination = 'D5') => {
    const fields = { Count: 2, items: [field('Region'), field('Sales', 'etDataField')], Item: (index) => fields.items[index - 1] }
    return { Id: id, Name: name, Destination: destination, UpdateTime: 1, PivotFields: fields, getPivotFields: () => fields, getCorePivotTable: () => ({ id }) }
  }
  const first = chart(1, 'Chart 1'); charts.items.push(first); charts.Count = 1
  const pivotOne = pivot(1, 'Pivot 1'); pivots.items.push(pivotOne); pivots.Count = 1
  app._sheet.addChart = (_style, type, _range, callback) => { const created = chart(charts.Count + 1, `Chart ${charts.Count + 1}`, type); charts.items.push(created); charts.Count += 1; callback(created, { isOk: true }) }
  app._sheet.deleteShape = (target, callback) => { const index = charts.items.indexOf(target); if (index >= 0) { charts.items.splice(index, 1); charts.Count -= 1 }; refresh(callback) }
  app._range.createPivotTable = (options, callback) => { const created = pivot(pivots.Count + 1, `Pivot ${pivots.Count + 1}`, options.destRangeText); pivots.items.push(created); pivots.Count += 1; callback({ isOk: true, pivotTableId: created.Id }) }
  app._workbook.refreshAllPivotTables = (callback) => { pivots.items.forEach((item) => { item.UpdateTime += 1 }); refresh(callback) }
  app.getCoreFactory = () => ({ createPivotTableCmd: (_runtime, core) => {
    const target = pivots.items.find((item) => item.Id === core.id)
    return {
      addFieldByName: (name, orientation, position, callback) => { if (!target.PivotFields.items.some((item) => item.Name === name)) { const next = field(name, orientation); next.Position = position; target.PivotFields.items.push(next); target.PivotFields.Count += 1 }; refresh(callback) },
      removeFieldByName: (name, _orientation, callback) => { const index = target.PivotFields.items.findIndex((item) => item.Name === name); if (index >= 0) { target.PivotFields.items.splice(index, 1); target.PivotFields.Count -= 1 }; refresh(callback) },
      sortField: (descriptor, order, _by, _unused, callback) => { const item = target.PivotFields.items.find((entry) => entry.Name === descriptor.getName()); if (item) item.AutoSortOrder = order; refresh(callback) },
      setSubtotals: (descriptor, subtotals, callback) => { const item = target.PivotFields.items.find((entry) => entry.Name === descriptor.getName()); if (item) item.Subtotals = subtotals; refresh(callback) },
      setFunction: (descriptor, summaryFunction, callback) => { const item = target.PivotFields.items.find((entry) => entry.Name === descriptor.getName()); if (item) item.SummaryFunction = summaryFunction; refresh(callback) },
      setShowValuesAs: (descriptor, options, callback) => { const item = target.PivotFields.items.find((entry) => entry.Name === descriptor.getName()); if (item) { item.Calculation = options.calculation; item.BaseField = options.baseField ?? null; item.BaseItem = options.baseItem ?? null }; refresh(callback) },
      refresh: (callback) => { target.UpdateTime += 1; refresh(callback) },
      deleteTable: (callback) => { const index = pivots.items.indexOf(target); if (index >= 0) { pivots.items.splice(index, 1); pivots.Count -= 1 }; refresh(callback) },
    }
  } })
  return app
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

function structuralApp(values = [[1, 10, 100], [2, 20, 200], [3, 30, 300], [4, 40, 400]]) {
  const grid = values.map((row) => [...row]); const formulas = grid.map((row) => row.map(() => ''))
  const parse = (address) => { const cell = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(address); if (!cell) return null; const column = (name) => name.charCodeAt(0) - 64; return { rowFrom: Number(cell[2]), rowTo: Number(cell[4] ?? cell[2]), colFrom: column(cell[1]), colTo: column(cell[3] ?? cell[1]) } }
  const snapshot = (area, data) => Array.from({ length: area.rowTo - area.rowFrom + 1 }, (_, rowIndex) => Array.from({ length: area.colTo - area.colFrom + 1 }, (_, columnIndex) => data[area.rowFrom - 1 + rowIndex]?.[area.colFrom - 1 + columnIndex] ?? (data === formulas ? '' : null)))
  const areaRange = (area) => ({ getValue2: () => snapshot(area, grid), getFormula: () => snapshot(area, formulas), getText: () => snapshot(area, grid).map((row) => row.map((value) => String(value ?? ''))), getAddress: () => `${String.fromCharCode(64 + area.colFrom)}${area.rowFrom}:${String.fromCharCode(64 + area.colTo)}${area.rowTo}` })
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1' }
  sheet.getUsedRange = () => areaRange({ rowFrom: 1, rowTo: grid.length, colFrom: 1, colTo: grid[0].length })
  sheet.getRange = (address) => {
    const row = /^(\d+):(\d+)$/.exec(address); const column = /^([A-Z]):([A-Z])$/.exec(address)
    if (row) {
      const from = Number(row[1]); const to = Number(row[2]); const range = areaRange({ rowFrom: from, rowTo: to, colFrom: 1, colTo: grid[0].length })
      range.EntireRow = { Insert: (_shift, callback) => { for (let index = 0; index <= to - from; index += 1) { grid.splice(from - 1, 0, Array(grid[0].length).fill(null)); formulas.splice(from - 1, 0, Array(grid[0].length).fill('')) }; callback({ isOk: true }) }, Delete: (_shift, callback) => { grid.splice(from - 1, to - from + 1); formulas.splice(from - 1, to - from + 1); callback({ isOk: true }) } }
      return range
    }
    if (column) {
      const from = column[1].charCodeAt(0) - 64; const to = column[2].charCodeAt(0) - 64; const range = areaRange({ rowFrom: 1, rowTo: grid.length, colFrom: from, colTo: to })
      range.EntireColumn = { Insert: (_shift, callback) => { for (const data of [grid, formulas]) data.forEach((line) => line.splice(from - 1, 0, ...Array(to - from + 1).fill(data === grid ? null : ''))); callback({ isOk: true }) }, Delete: (_shift, callback) => { for (const data of [grid, formulas]) data.forEach((line) => line.splice(from - 1, to - from + 1)); callback({ isOk: true }) } }
      return range
    }
    const area = parse(address); if (!area) return null
    const range = areaRange(area)
    range.Insert = (shift, callback) => { if (shift === 'etShiftRight') { for (let rowIndex = area.rowFrom - 1; rowIndex < area.rowTo; rowIndex += 1) { grid[rowIndex].splice(area.colFrom - 1, 0, ...Array(area.colTo - area.colFrom + 1).fill(null)); formulas[rowIndex].splice(area.colFrom - 1, 0, ...Array(area.colTo - area.colFrom + 1).fill('')) } } else { for (let index = 0; index <= area.rowTo - area.rowFrom; index += 1) { grid.splice(area.rowFrom - 1, 0, Array(grid[0].length).fill(null)); formulas.splice(area.rowFrom - 1, 0, Array(grid[0].length).fill('')) } }; callback({ isOk: true }) }
    range.Delete = (shift, callback) => { if (shift === 'etShiftLeft') { for (let rowIndex = area.rowFrom - 1; rowIndex < area.rowTo; rowIndex += 1) { grid[rowIndex].splice(area.colFrom - 1, area.colTo - area.colFrom + 1); formulas[rowIndex].splice(area.colFrom - 1, area.colTo - area.colFrom + 1); while (grid[rowIndex].length < grid[0].length) { grid[rowIndex].push(null); formulas[rowIndex].push('') } } } else { grid.splice(area.rowFrom - 1, area.rowTo - area.rowFrom + 1); formulas.splice(area.rowFrom - 1, area.rowTo - area.rowFrom + 1) }; callback({ isOk: true }) }
    return range
  }
  const workbook = { Name: 'Structural.xlsx', getName: () => 'Structural.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  return { ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, _grid: grid }
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
  const moved = await run({ action: 'write', resource, operation: 'move_worksheet', payload: { sourceName: 'Sheet2', index: 1 } }); assert.equal(moved.result.observed.order[0], 'Sheet2')
  const hidden = await run({ action: 'write', resource, operation: 'set_worksheet_visibility', payload: { sheetName: 'Sheet2', visible: false } }); assert.equal(hidden.result.observed.visible, false)
  const activationApp = workbookFixture(); const activationRun = await runtimeWith(activationApp)
  const activationInspection = await activationRun.raw({ action: 'inspect_write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' } })
  const activated = await activationRun.raw({ action: 'write', resource: activationInspection.result.resource, operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' }, precondition: activationInspection.result.precondition }); assert.equal(activated.ok, true, JSON.stringify(activated)); assert.equal(activated.result.observed.sheets.find((sheet) => sheet.name === 'Sheet2').active, true); assert.equal(activated.result.resource.sheetName, 'Sheet2')
})

test('workbook operations reject stale snapshots, last-visible hides, and unreadable APIs', async () => {
  const app = workbookFixture(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const inspected = await run.raw({ action: 'inspect_write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' } }); app._sheets[1].Activate()
  assert.equal((await run.raw({ action: 'write', resource, operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  app._sheets[1].Visible = false
  assert.equal((await run({ action: 'write', resource, operation: 'set_worksheet_visibility', payload: { sheetName: 'Sheet1', visible: false } })).error.code, 'invalid_range')
  delete app.ActiveWorkbook.Names.Add
  assert.equal((await run({ action: 'write', resource, operation: 'create_defined_name', payload: { name: 'NoApi', refersTo: '=Sheet1!A1' } })).error.code, 'unsupported')
})

test('worksheet activation rejects missing APIs and mismatched whole-workbook readback', async () => {
  const unavailable = workbookFixture(); delete unavailable._sheets[1].Activate
  const unavailableRun = await runtimeWith(unavailable)
  const unavailableInspection = await unavailableRun.raw({ action: 'inspect_write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' } })
  assert.equal((await unavailableRun.raw({ action: 'write', resource: unavailableInspection.result.resource, operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' }, precondition: unavailableInspection.result.precondition })).error.code, 'unsupported')
  const mismatch = workbookFixture(); mismatch._sheets[1].Activate = () => { mismatch._sheets[0].Visible = false }
  const mismatchRun = await runtimeWith(mismatch)
  const mismatchInspection = await mismatchRun.raw({ action: 'inspect_write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' } })
  assert.equal((await mismatchRun.raw({ action: 'write', resource: mismatchInspection.result.resource, operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' }, precondition: mismatchInspection.result.precondition })).error.code, 'readback_mismatch')
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
  const copied = await run.raw({ action: 'write', resource, operation: 'copy_worksheet', payload: { sourceName: 'Sheet1', newName: 'Copied' } })
  assert.equal(copied.error.code, 'unsupported')
})

test('spreadsheet runtime fail-closes clear and filter clearing when the observable readback disagrees', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app._range.clearContents = () => undefined
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
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.chartManagement.create, true)
  assert.equal(capabilities.result.capabilities.accruiMigrationMatrix.pivotManagement.refresh, false)
  const sort = await run({ action: 'write', resource, operation: 'sort', payload: { range: 'A1:B2', sorts: [{ key: 1, order: 'asc' }] } })
  assert.equal(sort.result.observed.verified, true); assert.deepEqual(sort.result.observed.values, [[1, 4], [3, 2]])
  const filtered = await run({ action: 'write', resource, operation: 'set_auto_filter', payload: { range: 'A1:B2', enabled: true } })
  assert.equal(filtered.result.observed.enabled, true)
  const filtersCleared = await run({ action: 'write', resource, operation: 'clear_filters', payload: { range: 'A1:B2' } })
  assert.equal(filtersCleared.result.observed.after.operator, 'none')
  assert.equal((await run({ action: 'write', resource, operation: 'insert_cell_image', payload: { range: 'A1:B2' } })).error.code, 'unsupported')
  assert.equal((await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })).result.observed.verified, true)
  assert.equal((await run({ action: 'write', resource, operation: 'create_pivot_table', payload: { range: 'A1:B2', destination: 'D5', isNewSheet: false } })).result.observed.verified, true)
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

test('view reads and verified zoom/freeze writes use complete view preconditions', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const view = await run({ action: 'view' }); assert.equal(view.result.view.supported, true); assert.equal(view.result.view.zoom, 100)
  const zoomed = await run({ action: 'write', resource, operation: 'set_zoom', payload: { zoom: 125 } }); assert.equal(zoomed.result.observed.view.zoom, 125)
  const frozen = await run({ action: 'write', resource, operation: 'set_freeze_panes', payload: { freeze: true, target: 'B3' } }); assert.equal(frozen.ok, true, JSON.stringify(frozen)); assert.equal(frozen.result.observed.view.freezePanes, true); assert.equal(frozen.result.observed.view.splitRow, 2); assert.equal(frozen.result.observed.view.splitColumn, 1)
  const unfrozen = await run({ action: 'write', resource, operation: 'set_freeze_panes', payload: { freeze: false } }); assert.equal(unfrozen.result.observed.view.freezePanes, false)
})

test('view writes fail closed for stale, invalid targets, missing APIs, and incorrect readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource; const inspected = await run.raw({ action: 'inspect_write', operation: 'set_zoom', payload: { zoom: 125 } }); app._activeWindow.ScrollRow = 2
  assert.equal((await run.raw({ action: 'write', resource, operation: 'set_zoom', payload: { zoom: 125 }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  assert.equal((await run({ action: 'inspect_write', operation: 'set_freeze_panes', payload: { freeze: true, target: 'A1:B2' } })).error.code, 'invalid_range')
  const missing = fakeApp(); delete missing._activeWindow; delete missing.ActiveWindow; const missingRun = await runtimeWith(missing); const missingResource = (await missingRun({ action: 'context' })).result.resource; assert.equal((await missingRun({ action: 'write', resource: missingResource, operation: 'set_zoom', payload: { zoom: 125 } })).error.code, 'unsupported')
  const noSelect = fakeApp(); noSelect._sheet.getRange = () => noSelect._range; const noSelectRun = await runtimeWith(noSelect); const noSelectResource = (await noSelectRun({ action: 'context' })).result.resource; assert.equal((await noSelectRun({ action: 'write', resource: noSelectResource, operation: 'set_freeze_panes', payload: { freeze: true, target: 'B2' } })).error.code, 'unsupported')
  const wrong = fakeApp(); Object.defineProperty(wrong._activeWindow, 'FreezePanes', { configurable: true, get: () => false, set: () => {} }); const wrongRun = await runtimeWith(wrong); const wrongResource = (await wrongRun({ action: 'context' })).result.resource; assert.equal((await wrongRun({ action: 'write', resource: wrongResource, operation: 'set_freeze_panes', payload: { freeze: true, target: 'B2' } })).error.code, 'readback_mismatch')
})

test('print settings expose a complete snapshot and verify requested and non-target fields', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const read = await run({ action: 'print_settings' }); assert.equal(read.result.printSettings.supported, true); assert.equal(read.result.printSettings.orientation, 'portrait')
  const printed = await run({ action: 'write', resource, operation: 'set_print_settings', payload: { orientation: 'landscape', leftMargin: 42, centerHorizontally: true } })
  assert.equal(printed.result.observed.verified, true); assert.equal(printed.result.observed.printSettings.orientation, 'landscape'); assert.equal(printed.result.observed.printSettings.rightMargin, 36)
  const fitted = await run({ action: 'write', resource, operation: 'set_print_settings', payload: { fitToPagesWide: 2, fitToPagesTall: 1 } })
  assert.equal(fitted.result.observed.printSettings.zoom, false)
})

test('print settings fail closed for invalid payloads, missing APIs, stale state, and forged readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_print_settings', payload: { zoom: 100, fitToPagesWide: 1 } })).error.code, 'invalid_range')
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_print_settings', payload: { zoom: false } })).error.code, 'invalid_range')
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_print_settings', payload: { printTitleRows: '1048577:1048577' } })).error.code, 'invalid_range')
  const inspected = await run.raw({ action: 'inspect_write', operation: 'set_print_settings', payload: { leftMargin: 40 } }); app._pageSetup.RightMargin = 37
  assert.equal((await run.raw({ action: 'write', resource, operation: 'set_print_settings', payload: { leftMargin: 40 }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  const missing = fakeApp(); delete missing._sheet.PageSetup; const missingRun = await runtimeWith(missing); assert.equal((await missingRun.raw({ action: 'inspect_write', operation: 'set_print_settings', payload: { leftMargin: 40 } })).error.code, 'unsupported')
  const forged = fakeApp(); Object.defineProperty(forged._pageSetup, 'LeftMargin', { configurable: true, get: () => 36, set: () => {} }); const forgedRun = await runtimeWith(forged); const forgedResource = (await forgedRun({ action: 'context' })).result.resource
  assert.equal((await forgedRun({ action: 'write', resource: forgedResource, operation: 'set_print_settings', payload: { leftMargin: 40 } })).error.code, 'readback_mismatch')
})

test('outline reads every bounded target level and verifies group and ungroup', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const read = await run({ action: 'outline', range: '1:3', axis: 'row' }); assert.equal(JSON.stringify(read.result.outline.levels), '[0,0,0]')
  const grouped = await run({ action: 'write', resource, operation: 'set_outline_group', payload: { range: '1:3', axis: 'row', grouped: true } }); assert.equal(JSON.stringify(grouped.result.observed.outline.levels), '[1,1,1]')
  const ungroupedRows = await run({ action: 'write', resource, operation: 'set_outline_group', payload: { range: '1:3', axis: 'row', grouped: false } }); assert.equal(JSON.stringify(ungroupedRows.result.observed.outline.levels), '[0,0,0]')
  const ungrouped = await run({ action: 'write', resource, operation: 'set_outline_group', payload: { range: 'A:B', axis: 'column', grouped: true } }); assert.equal(JSON.stringify(ungrouped.result.observed.outline.levels), '[1,1]')
})

test('outline fail-closes invalid axes, unavailable APIs, stale levels, and wrong readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_outline_group', payload: { range: 'A1:B2', axis: 'row', grouped: true } })).error.code, 'invalid_range')
  const inspected = await run.raw({ action: 'inspect_write', operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true } }); app._rowOutline.set(1, 1)
  assert.equal((await run.raw({ action: 'write', resource, operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  const missing = fakeApp(); delete missing._sheet.getRowOutlineLevel; const missingRun = await runtimeWith(missing); assert.equal((await missingRun.raw({ action: 'inspect_write', operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true } })).error.code, 'unsupported')
  const forged = fakeApp(); forged._sheet.getRange = () => ({ Rows: { Group: () => {} } }); const forgedRun = await runtimeWith(forged); const forgedResource = (await forgedRun({ action: 'context' })).result.resource
  assert.equal((await forgedRun({ action: 'write', resource: forgedResource, operation: 'set_outline_group', payload: { range: '1:2', axis: 'row', grouped: true } })).error.code, 'readback_mismatch')
})

test('special_cells returns bounded canonical Area pages and proves local empty candidates', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const areas = [{ Row: 1, Column: 1, Rows: { Count: 1 }, Columns: { Count: 1 }, Count: 1 }, { Row: 2, Column: 2, Rows: { Count: 1 }, Columns: { Count: 1 }, Count: 1 }]
  app._range.SpecialCells = () => ({ Count: 2, Areas: { Count: 2, Item: (index) => areas[index - 1] } })
  const page = await run({ action: 'special_cells', range: 'A1:B2', kind: 'constants', offset: 1, limit: 1 })
  assert.equal(page.result.specialCells.returned, 1); assert.equal(page.result.specialCells.areas[0].address, 'B2:B2'); assert.equal(page.result.specialCells.hasMore, false); assert.equal(page.result.specialCells.nextOffset, null)
  const exhausted = await run({ action: 'special_cells', range: 'A1:B2', kind: 'constants', offset: 2, limit: 1 }); assert.equal(exhausted.result.specialCells.returned, 0); assert.equal(exhausted.result.specialCells.hasMore, false); assert.equal(exhausted.result.specialCells.nextOffset, null)
  const empty = await run({ action: 'special_cells', range: 'A1:B2', kind: 'blanks' }); assert.equal(empty.result.specialCells.count, 0); assert.equal(empty.result.specialCells.returned, 0)
})

test('special_cells fails closed for invalid inputs, unavailable APIs, forged counts, and out-of-range Areas', async () => {
  const invalid = await runtimeWith(fakeApp()); assert.equal((await invalid({ action: 'special_cells', range: 'A1:B2', kind: 'wrong' })).error.code, 'invalid_range'); assert.equal((await invalid({ action: 'special_cells', range: 'A1:XFD1048576', kind: 'constants' })).error.code, 'invalid_range')
  const missing = await runtimeWith(fakeApp()); assert.equal((await missing({ action: 'special_cells', range: 'A1:B2', kind: 'constants' })).error.code, 'unsupported')
  const countForged = fakeApp(); countForged._range.SpecialCells = () => ({ Count: 1, Areas: { Count: 2, Item: () => ({ Row: 1, Column: 1, Rows: { Count: 1 }, Columns: { Count: 1 }, Count: 1 }) } }); const forgedRun = await runtimeWith(countForged); assert.equal((await forgedRun({ action: 'special_cells', range: 'A1:B2', kind: 'constants' })).error.code, 'unsupported')
  const overlapping = fakeApp(); overlapping._range.SpecialCells = () => ({ Count: 2, Areas: { Count: 2, Item: () => ({ Row: 1, Column: 1, Rows: { Count: 1 }, Columns: { Count: 1 }, Count: 1 }) } }); const overlappingRun = await runtimeWith(overlapping); assert.equal((await overlappingRun({ action: 'special_cells', range: 'A1:B2', kind: 'constants' })).error.code, 'unsupported')
  const outside = fakeApp(); outside._range.SpecialCells = () => ({ Count: 1, Areas: { Count: 1, Item: () => ({ Row: 3, Column: 1, Rows: { Count: 1 }, Columns: { Count: 1 }, Count: 1 }) } }); const outsideRun = await runtimeWith(outside); assert.equal((await outsideRun({ action: 'special_cells', range: 'A1:B2', kind: 'constants' })).error.code, 'unsupported')
})

test('dimensions read each bounded item and verify hide/show and AutoFit without field drift', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const read = await run({ action: 'dimensions', range: '1:2', axis: 'row' }); assert.equal(JSON.stringify(read.result.dimensions.items), JSON.stringify([{ index: 1, hidden: false, size: 15 }, { index: 2, hidden: false, size: 15 }]))
  const hidden = await run({ action: 'write', resource, operation: 'set_rows_hidden', payload: { range: '1:2', hidden: true } }); assert.equal(hidden.result.observed.dimensions.items.every((item) => item.hidden && item.size === 15), true)
  const shown = await run({ action: 'write', resource, operation: 'set_rows_hidden', payload: { range: '1:2', hidden: false } }); assert.equal(shown.result.observed.dimensions.items.every((item) => !item.hidden && item.size === 15), true)
  const fitted = await run({ action: 'write', resource, operation: 'auto_fit', payload: { range: 'A:B', axis: 'column' } }); assert.equal(fitted.result.observed.changed, true); assert.equal(fitted.result.observed.dimensions.items.every((item) => !item.hidden && item.size === 9), true)
})

test('dimensions fail closed for wrong axes, oversized targets, missing APIs, stale snapshots, and forged readback', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'set_rows_hidden', payload: { range: 'A:B', hidden: true } })).error.code, 'invalid_range')
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'auto_fit', payload: { range: '1:1001', axis: 'row' } })).error.code, 'invalid_range')
  const inspected = await run.raw({ action: 'inspect_write', operation: 'set_rows_hidden', payload: { range: '1:2', hidden: true } }); app._rowSizes.set(1, 22)
  assert.equal((await run.raw({ action: 'write', resource, operation: 'set_rows_hidden', payload: { range: '1:2', hidden: true }, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  const missing = fakeApp(); const missingRun = await runtimeWith(missing); const missingResource = (await missingRun({ action: 'context' })).result.resource; const nativeRange = missing._sheet.getRange; missing._sheet.getRange = (address) => { const result = nativeRange(address); if (address === 'A:B') delete result.Columns.AutoFit; return result }
  assert.equal((await missingRun({ action: 'write', resource: missingResource, operation: 'auto_fit', payload: { range: 'A:B', axis: 'column' } })).error.code, 'unsupported')
  const forged = fakeApp(); const forgedRun = await runtimeWith(forged); const forgedResource = (await forgedRun({ action: 'context' })).result.resource; const getRange = forged._sheet.getRange; forged._sheet.getRange = (address) => { const result = getRange(address); if (address === '1:2') Object.defineProperty(result.Rows, 'Hidden', { configurable: true, get: () => false, set: () => {} }); return result }
  assert.equal((await forgedRun({ action: 'write', resource: forgedResource, operation: 'set_rows_hidden', payload: { range: '1:2', hidden: true } })).error.code, 'readback_mismatch')
})

test('directional fill and atomic rectangular batch write use exact formula-free readback', async () => {
  const fillApp = fakeApp(); const fill = await runtimeWith(fillApp); const fillResource = (await fill({ action: 'context' })).result.resource
  const filled = await fill({ action: 'write', resource: fillResource, operation: 'fill_range', payload: { range: 'A1:B2', direction: 'down' } }); assert.equal(JSON.stringify(filled.result.observed.values), JSON.stringify([[3, 2], [3, 2]])); assert.equal(JSON.stringify(filled.result.observed.formulas), JSON.stringify([['', ''], ['', '']]))
  const batchApp = fakeApp(); const batch = await runtimeWith(batchApp); const batchResource = (await batch({ action: 'context' })).result.resource
  const written = await batch({ action: 'write', resource: batchResource, operation: 'batch_write', payload: { cells: [{ cell: 'A1', value: 'title' }, { cell: 'B1', value: 2 }, { cell: 'A2', value: true }, { cell: 'B2', value: null }] } }); assert.equal(JSON.stringify(written.result.observed.values), JSON.stringify([['title', 2], [true, null]]))
})

test('fill and batch writes fail closed for formulas, noops, missing APIs, stale snapshots, and ambiguous batches', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource; app._range.getFormula = () => [['=A1', ''], ['', '']]
  assert.equal((await run({ action: 'write', resource, operation: 'fill_range', payload: { range: 'A1:B2', direction: 'down' } })).error.code, 'unsupported')
  const staleApp = fakeApp(); const stale = await runtimeWith(staleApp); const staleResource = (await stale({ action: 'context' })).result.resource; const payload = { cells: [{ cell: 'A1', value: 1 }, { cell: 'B1', value: 2 }, { cell: 'A2', value: 3 }, { cell: 'B2', value: 4 }] }; const inspected = await stale.raw({ action: 'inspect_write', operation: 'batch_write', payload }); staleApp._range.setValue2([[7, 8], [9, 10]])
  assert.equal((await stale.raw({ action: 'write', resource: staleResource, operation: 'batch_write', payload, precondition: inspected.result.precondition })).error.code, 'fingerprint_mismatch')
  const driftApp = fakeApp(); const drift = await runtimeWith(driftApp); const driftResource = (await drift({ action: 'context' })).result.resource; const setValues = driftApp._range.setValue2; driftApp._range.setValue2 = (values) => { setValues(values); driftApp._range.NumberFormat = '0.00' }
  assert.equal((await drift({ action: 'write', resource: driftResource, operation: 'batch_write', payload })).error.code, 'readback_mismatch')
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'batch_write', payload: { cells: [{ cell: 'A1', value: 1 }, { cell: 'B2', value: 2 }] } })).error.code, 'invalid_range')
  assert.equal((await run.raw({ action: 'inspect_write', operation: 'batch_write', payload: { cells: [{ cell: 'XFE1', value: 1 }] } })).error.code, 'invalid_range')
  const missingApp = fakeApp(); delete missingApp._range.setValue2; delete missingApp._range.setValue; Object.preventExtensions(missingApp._range); const missing = await runtimeWith(missingApp); const missingResource = (await missing({ action: 'context' })).result.resource
  assert.equal((await missing({ action: 'write', resource: missingResource, operation: 'fill_range', payload: { range: 'A1:B2', direction: 'down' } })).error.code, 'unsupported')
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

test('chart creation fails closed when callback creation does not produce a collection object', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let callbacks = 0
  app._sheet.addChart = (_style, type, _range, callback) => {
    callbacks += 1; callback({ Id: 7, Name: 'Async Chart', Type: type }, 'ok')
    return Promise.resolve({ accepted: true })
  }
  const result = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2' } })
  assert.equal(result.error.code, 'readback_mismatch'); assert.equal(callbacks, 1); assert.equal(app._charts.Count, 0)
})

test('analytics writes cover chart and pivot public callbacks with object-specific readback', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const list = await run({ action: 'list_charts', limit: 10 }); assert.equal(list.result.charts.total, 1)
  const createdChart = await run({ action: 'write', resource, operation: 'create_chart', payload: { range: 'A1:B2', chartType: 'line' } }); assert.equal(createdChart.result.observed.afterCount, 2)
  const updatedChart = await run({ action: 'write', resource, operation: 'update_chart', payload: { chartId: 1, chartType: 'bar', title: 'Revenue', sourceRange: 'C1:D2', left: 12, top: 9 } }); assert.equal(updatedChart.result.observed.chart.title, 'Revenue')
  const sizedChart = await run({ action: 'write', resource, operation: 'resize_chart', payload: { chartId: 1, width: 420, height: 240 } }); assert.equal(sizedChart.result.observed.chart.width, 420)
  const sourceChart = await run({ action: 'write', resource, operation: 'set_chart_data_source', payload: { chartId: 1, sourceRange: 'A1:B2' } }); assert.equal(sourceChart.result.observed.chart.sourceRange, 'A1:B2')
  const deletedChart = await run({ action: 'write', resource, operation: 'delete_chart', payload: { chartId: 2 } }); assert.equal(deletedChart.result.observed.deleted, true)
  const pivotCreated = await run({ action: 'write', resource, operation: 'create_pivot_table', payload: { range: 'A1:B2', destination: 'F2', isNewSheet: false } }); assert.equal(pivotCreated.result.observed.afterCount, 2)
  const fields = await run({ action: 'list_pivot_fields', pivotTableId: 1, limit: 10 }); assert.equal(fields.result.pivotFields.total, 2)
  const added = await run({ action: 'write', resource, operation: 'add_pivot_field', payload: { pivotTableId: 1, fieldName: 'Category', orientation: 'filter' } }); assert.equal(added.result.observed.pivot.fields.length, 3)
  const sorted = await run({ action: 'write', resource, operation: 'sort_pivot_field', payload: { pivotTableId: 1, fieldName: 'Region', orientation: 'row', order: 'desc' } }); assert.equal(sorted.result.observed.verified, true)
  const subtotals = await run({ action: 'write', resource, operation: 'set_pivot_subtotals', payload: { pivotTableId: 1, fieldName: 'Region', orientation: 'row', subtotals: ['sum'] } }); assert.equal(subtotals.result.observed.verified, true)
  const valueFunction = await run({ action: 'write', resource, operation: 'set_pivot_value_function', payload: { pivotTableId: 1, fieldName: 'Sales', summaryFunction: 'average' } }); assert.equal(valueFunction.result.observed.verified, true)
  const valuesAs = await run({ action: 'write', resource, operation: 'set_pivot_show_values_as', payload: { pivotTableId: 1, fieldName: 'Sales', calculation: 'percentOfTotal' } }); assert.equal(valuesAs.result.observed.verified, true)
  const refreshed = await run({ action: 'write', resource, operation: 'refresh_pivot_table', payload: { pivotTableId: 1 } }); assert.equal(refreshed.result.observed.verified, true)
  const refreshedAll = await run({ action: 'write', resource, operation: 'refresh_pivot_tables', payload: {} }); assert.equal(refreshedAll.result.observed.verified, true)
  const removed = await run({ action: 'write', resource, operation: 'remove_pivot_field', payload: { pivotTableId: 1, fieldName: 'Category', orientation: 'filter' } }); assert.equal(removed.result.observed.verified, true)
  const deletedPivot = await run({ action: 'write', resource, operation: 'delete_pivot_table', payload: { pivotTableId: 2 } }); assert.equal(deletedPivot.result.observed.deleted, true)
})

test('analytics writes fail closed for missing callbacks, no-op readback, and stale object fences', async () => {
  const missing = analyticsApp(); const missingRun = await runtimeWith(missing); const missingResource = (await missingRun({ action: 'context' })).result.resource
  delete missing._sheet.deleteShape
  assert.equal((await missingRun({ action: 'write', resource: missingResource, operation: 'delete_chart', payload: { chartId: 1 } })).error.code, 'unsupported')
  const noop = analyticsApp(); const noopRun = await runtimeWith(noop); const noopResource = (await noopRun({ action: 'context' })).result.resource
  noop.getCoreFactory = () => ({ createPivotTableCmd: () => ({ refresh: (callback) => callback({ isOk: true }) }) })
  assert.equal((await noopRun({ action: 'write', resource: noopResource, operation: 'refresh_pivot_table', payload: { pivotTableId: 1 } })).error.code, 'readback_mismatch')
  const drift = analyticsApp(); const driftRun = await runtimeWith(drift); const driftResource = (await driftRun({ action: 'context' })).result.resource
  const inspected = await driftRun.raw({ action: 'inspect_write', operation: 'resize_chart', payload: { chartId: 1, width: 400, height: 200 } }); drift._charts.items[0].Name = 'Renamed by collaborator'
  const result = await driftRun.raw({ action: 'write', resource: driftResource, operation: 'resize_chart', payload: { chartId: 1, width: 400, height: 200 }, precondition: inspected.result.precondition })
  assert.equal(result.error.code, 'fingerprint_mismatch')
})

test('chart analytics rejects an absent public mutation API before changing the chart', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app._charts.items[0].getChartLayer = () => ({ setChartTitle: (_title, callback) => callback({ isOk: true }) })
  const result = await run({ action: 'write', resource, operation: 'set_chart_data_source', payload: { chartId: 1, sourceRange: 'C1:D2' } })
  assert.equal(result.error.code, 'unsupported'); assert.equal(app._charts.items[0].SourceData, 'A1:B2')
})

test('chart analytics rejects callback success when exact chart readback is a no-op', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app._charts.items[0].getChartLayer = () => ({ setChartType: (_type, callback) => callback({ isOk: true }) })
  const result = await run({ action: 'write', resource, operation: 'update_chart', payload: { chartId: 1, chartType: 'pie' } })
  assert.equal(result.error.code, 'readback_mismatch'); assert.equal(app._charts.items[0].Type, 'columnClustered')
})

test('pivot analytics rejects a missing command method before mutating field state', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  app.getCoreFactory = () => ({ createPivotTableCmd: () => ({}) })
  const result = await run({ action: 'write', resource, operation: 'add_pivot_field', payload: { pivotTableId: 1, fieldName: 'Category', orientation: 'filter' } })
  assert.equal(result.error.code, 'unsupported'); assert.equal(app._pivots.items[0].PivotFields.Count, 2)
})

test('pivot analytics rejects a stale field-identity precondition before the command runs', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const inspected = await run.raw({ action: 'inspect_write', operation: 'set_pivot_value_function', payload: { pivotTableId: 1, fieldName: 'Sales', summaryFunction: 'average' } })
  app._pivots.items[0].PivotFields.items[1].Name = 'Sales changed elsewhere'
  const result = await run.raw({ action: 'write', resource, operation: 'set_pivot_value_function', payload: { pivotTableId: 1, fieldName: 'Sales', summaryFunction: 'average' }, precondition: inspected.result.precondition })
  assert.equal(result.error.code, 'fingerprint_mismatch')
})

test('pivot field item reads use bounded pages and fail closed for unreadable items', async () => {
  const app = analyticsApp(); const run = await runtimeWith(app)
  const source = app._pivots.items[0].PivotFields.items[0]; source.Items = { Count: 3, items: [{ Name: 'East' }, { Name: 'North' }, { Name: 'West' }], Item: (index) => source.Items.items[index - 1] }
  const page = await run({ action: 'pivot_field_items', pivotTableId: 1, fieldName: 'Region', itemOffset: 1, itemLimit: 1 })
  assert.equal(page.result.pivotFieldItems.total, 3); assert.equal(page.result.pivotFieldItems.items[0].name, 'North'); assert.equal(page.result.pivotFieldItems.hasMore, true)
  source.Items.items[1] = {}; const unreadable = await run({ action: 'pivot_field_items', pivotTableId: 1, fieldName: 'Region', itemOffset: 1, itemLimit: 1 })
  assert.equal(unreadable.error.code, 'unsupported')
})

test('unusable spreadsheet exports invoke the dedicated API but fail closed on invalid artifacts', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let exports = 0
  app._range.ToImageDataURL = () => { exports += 1; return 'not-an-image-artifact' }
  app._sheet.ExportImage = () => { exports += 1; return {} }
  app._workbook.ExportAsFixedFormat = () => { exports += 1; return {} }
  for (const operation of ['export_pdf', 'export_range_image', 'export_worksheet_image']) {
    const payload = { range: 'A1:B2' }; const inspected = await run.raw({ action: 'inspect_write', operation, payload })
    const result = await run.raw({ action: 'write', resource, operation, payload, precondition: inspected.result.precondition })
    assert.ok(['unsupported', 'readback_mismatch'].includes(result.error.code))
  }
  assert.equal(exports, 3)
})

test('every unverified AccrUI spreadsheet family fails closed before mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  let mutations = 0; app._range.copyRange = () => { mutations += 1 }
  for (const operation of ['insert_cells', 'fill_range', 'replace_range_text', 'text_to_columns', 'remove_duplicates', 'auto_fit_range', 'copy_range', 'move_range', 'undo', 'redo', 'update_chart', 'delete_chart', 'refresh_pivot_table', 'delete_pivot_table']) {
    const result = await run({ action: 'write', resource, operation, payload: { range: 'A1' } })
    assert.equal(result.ok, false, operation); assert.ok(['unsupported', 'invalid_range'].includes(result.error.code), operation)
  }
  assert.equal(mutations, 0)
})

test('probe answers with the frame identity so the background can prefer real documents', async () => {
  const run = await runtimeWith(fakeApp())
  const probed = await run({ action: 'probe' })
  assert.equal(probed.ok, true)
  assert.equal(probed.result.status, 'probe')
  assert.equal(probed.result.ready, true)
  // Field-wise because the identity object is created inside the VM realm.
  assert.equal(probed.result.identity.path, '/sheet/1')
  assert.equal(probed.result.identity.workbookName, 'Budget.xlsx')
  assert.equal(probed.result.identity.sheetName, 'Sheet1')
  assert.equal(probed.result.identity.hasContent, true)
})

test('probe reports a blank preloaded editor as unnamed with unknown content', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1' }
  const workbook = { getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const probed = await run({ action: 'probe' })
  assert.equal(probed.ok, true)
  assert.equal(probed.result.ready, true)
  assert.equal(probed.result.identity.path, '/sheet/1')
  assert.equal(probed.result.identity.workbookName, null)
  assert.equal(probed.result.identity.sheetName, 'Sheet1')
  assert.equal(probed.result.identity.hasContent, null)
})

test('probe returns immediately when identity getters never settle', async () => {
  const hang = () => new Promise(() => {})
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getLastRow: hang, getLastColumn: hang }
  const workbook = { Name: 'Status.xlsx', getName: () => 'Status.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const started = Date.now()
  const probed = await run({ action: 'probe' })
  assert.equal(probed.ok, true)
  assert.equal(probed.result.ready, true)
  assert.equal(probed.result.identity.path, '/sheet/1')
  assert.equal(probed.result.identity.hasContent, null)
  assert.ok(Date.now() - started < 800, 'probe must not wait for hung APP getters')
})

test('probe skips identity getters when the frame is not a spreadsheet', async () => {
  const hang = () => new Promise(() => {})
  const run = await runtimeWith({
    openApi: { editor: { canvas: { getDocXml: async () => '<apcanvas></apcanvas>' } } },
    getActiveWorkbook: hang,
    getActiveSheet: hang,
  })
  const started = Date.now()
  const probed = await run({ action: 'probe' })
  assert.equal(probed.ok, true)
  assert.equal(probed.result.ready, false)
  assert.ok(Date.now() - started < 200, 'a light-document APP must not block the spreadsheet probe')
})

test('probe does not claim spreadsheet ready on a light-document APP', async () => {
  const run = await runtimeWith({
    openApi: { editor: { canvas: { getDocXml: async () => '<apcanvas></apcanvas>' } } },
  })
  const probed = await run({ action: 'probe' })
  assert.equal(probed.ok, true)
  assert.equal(probed.result.status, 'probe')
  assert.equal(probed.result.ready, false)
})

test('reads an exact Midea range through createRANGE when getRange ignores its argument', async () => {
  const grid = [['Name', 'Amount'], ['x', 1], ['y', 2]]
  const bounds = []
  const sheet = {
    Name: 'Sheet1', getName: () => 'Sheet1',
    getRange: () => ({ getValue2: () => null }),
    createRANGE: (rowFrom, rowTo, colFrom, colTo) => { bounds.push([rowFrom, rowTo, colFrom, colTo]); return { rowFrom, rowTo, colFrom, colTo } },
    createRange: (core) => ({ core, getValue2: () => grid.map((row) => [...row]) }),
  }
  const workbook = { Name: 'Midea.xlsx', getName: () => 'Midea.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const result = await run.raw({ action: 'range', range: 'Sheet1!A1:B3' })
  assert.equal(result.ok, true)
  assert.deepEqual(bounds.map((entry) => [...entry]), [[0, 2, 0, 1]])
  // Field-wise because the matrices are created inside the VM realm.
  assert.equal(result.result.range.values.length, 3)
  assert.equal(result.result.range.values[0][0], 'Name')
  assert.equal(result.result.range.values[2][1], 2)
  assert.equal(result.result.range.address, 'A1:B3')
})

test('falls back to getRangeContents when Excel-style value APIs return nothing', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => ({ getRangeContents: () => ({ result: { Values: [['a', 'b'], ['c', 'd']] } }) }) }
  const workbook = { Name: 'W.xlsx', getName: () => 'W.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const result = await run.raw({ action: 'range', range: 'A1:B2' })
  assert.equal(result.ok, true)
  assert.equal(result.result.range.values[0][0], 'a')
  assert.equal(result.result.range.values[1][1], 'd')
})

test('tolerates a missing formulas API on bounded reads without inventing formulas', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => ({ getValue2: () => [['a', 'b'], ['c', 'd']] }) }
  const workbook = { Name: 'W.xlsx', getName: () => 'W.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const result = await run.raw({ action: 'range', range: 'A1:B2' })
  assert.equal(result.ok, true)
  assert.equal(result.result.range.formulas.length, 2)
  assert.equal(result.result.range.formulas[0][0], null)
  assert.equal(result.result.range.rows[0][0].formula, null)
})

test('reports expected and observed shapes when the values matrix does not match the address', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => ({ getValue2: () => null }) }
  const workbook = { Name: 'W.xlsx', getName: () => 'W.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const result = await run.raw({ action: 'range', range: 'A1:B2' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'readback_mismatch')
  assert.match(result.error.message, /expected 2x2, observed 1x1/)
})

test('selection reads a multi-cell getSelectionRange via 0-based getRANGE and value2', async () => {
  const grid = [['状态', '负责人'], ['已完成', '张三'], ['进行中', '李四']]
  const selected = {
    getRANGE: () => ({ rowFrom: 1, rowTo: 2, colFrom: 0, colTo: 0 }),
    getValue2: () => [['已完成'], ['进行中']],
    getText: () => [['已完成'], ['进行中']],
    getFormula: () => [[''], ['']],
  }
  const active = {
    getRANGE: () => ({ rowFrom: 1, rowTo: 1, colFrom: 0, colTo: 0 }),
    getValue2: () => [['已完成']],
    getText: () => [['已完成']],
    getFormula: () => [['']],
  }
  const sheet = {
    Name: 'Sheet1', getName: () => 'Sheet1',
    getRange: (address) => {
      const match = String(address).match(/^A(\d+)(?::A(\d+))?$/i)
      if (!match) return { getValue2: () => null }
      const from = Number(match[1]) - 1
      const to = Number(match[2] ?? match[1]) - 1
      return { getValue2: () => grid.slice(from, to + 1).map((row) => [row[0]]), getText: () => grid.slice(from, to + 1).map((row) => [String(row[0])]), getFormula: () => grid.slice(from, to + 1).map(() => ['']) }
    },
  }
  const workbook = { Name: 'Status.xlsx', getName: () => 'Status.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, getSelectionRange: () => selected, ActiveCell: active })
  const result = await run.raw({ action: 'selection' })
  assert.equal(result.ok, true)
  assert.equal(result.result.selection.supported, true)
  assert.equal(result.result.selection.address, 'A2:A3')
  assert.equal(result.result.selection.rowsCount, 2)
  assert.equal(result.result.selection.columnsCount, 1)
  assert.equal(result.result.selection.singleCell, false)
  assert.equal(result.result.selection.value2[0][0], '已完成')
  assert.equal(result.result.selection.value2[1][0], '进行中')
  assert.equal(result.result.selection.activeCell.address, 'A2')
  assert.equal(result.result.selection.activeCell.value, '已完成')
  const context = await run.raw({ action: 'context' })
  assert.equal(context.result.context.selection.address, 'A2:A3')
})

test('used_range reports the used rectangle without requiring a complete view snapshot', async () => {
  const used = {
    getRANGE: () => ({ rowFrom: 0, rowTo: 2, colFrom: 0, colTo: 1 }),
    getValue2: () => [['状态', '负责人'], ['已完成', '张三'], ['进行中', '李四']],
    getText: () => [['状态', '负责人'], ['已完成', '张三'], ['进行中', '李四']],
    getFormula: () => [['', ''], ['', ''], ['', '']],
  }
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getUsedRange: () => used, getRange: () => used }
  const workbook = { Name: 'Status.xlsx', getName: () => 'Status.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet })
  const result = await run.raw({ action: 'used_range' })
  assert.equal(result.ok, true)
  assert.equal(result.result.usedRange.supported, true)
  assert.equal(result.result.usedRange.address, 'A1:B3')
  assert.equal(result.result.usedRange.rowsCount, 3)
  assert.equal(result.result.usedRange.columnsCount, 2)
  assert.equal(result.result.usedRange.value2[2][1], '李四')
})

test('selection still reports the active cell when freeze/zoom window fields are missing', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => ({ getValue2: () => [['选中值']], getText: () => [['选中值']], getFormula: () => [['']] }) }
  const workbook = { Name: 'W.xlsx', getName: () => 'W.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, ActiveCell: { Row: 3, Column: 2 } })
  const view = await run.raw({ action: 'view' })
  assert.equal(view.result.view.supported, false)
  const result = await run.raw({ action: 'selection' })
  assert.equal(result.ok, true)
  assert.equal(result.result.selection.supported, true)
  assert.equal(result.result.selection.address, 'B3')
  assert.equal(result.result.selection.singleCell, true)
  assert.equal(result.result.selection.activeCell.address, 'B3')
  assert.equal(result.result.selection.value2[0][0], '选中值')
})

test('view reports the readable active cell when window fields are missing', async () => {
  const sheet = { Name: 'Sheet1', getName: () => 'Sheet1', getRange: () => ({}) }
  const workbook = { Name: 'W.xlsx', getName: () => 'W.xlsx', getWorksheet: () => sheet, Worksheets: { Count: 1, Item: () => sheet } }
  const run = await runtimeWith({ ActiveWorkbook: workbook, ActiveSheet: sheet, getActiveWorkbook: () => workbook, getActiveSheet: () => sheet, ActiveCell: { Row: 3, Column: 2 } })
  const result = await run.raw({ action: 'view' })
  assert.equal(result.ok, true)
  assert.equal(result.result.view.supported, false)
  assert.equal(result.result.view.activeCell, 'B3')
})

test('runtime verifies clear_formats preserves content through a complete snapshot', async () => {
  const app = fakeApp(); const range = app._range; range.ClearFormats = () => { range.Font.Bold = false; return { callBackId: 1 } }
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const result = await run({ action: 'write', resource, operation: 'clear_formats', payload: { range: 'A1:B2' } })
  assert.equal(result.result.observed.verified, true); assert.equal(range.Font.Bold, false)
})

test('runtime exposes bounded filter values and runtime probes', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const values = await run({ action: 'filter_values', range: 'A1:B2', limit: 2 })
  assert.deepEqual(Array.from(values.result.filterValues.values), [3, 2]); assert.equal(values.result.filterValues.hasMore, true)
  const probe = await run({ action: 'probe_range_api', range: 'A1', maxMethods: 2 })
  assert.ok(Array.isArray(probe.result.probe.methods)); assert.ok(probe.result.probe.methodCount >= probe.result.probe.methods.length)
})

test('runtime exposes bounded analytics collection reads without guessing identities', async () => {
  const app = fakeApp(); const run = await runtimeWith(app)
  const charts = await run({ action: 'list_charts', limit: 10 }); assert.equal(charts.result.charts.total, 0); assert.deepEqual(Array.from(charts.result.charts.items), [])
  const pivots = await run({ action: 'list_pivots', limit: 10 }); assert.equal(pivots.result.pivots.total, 0); assert.deepEqual(Array.from(pivots.result.pivots.items), [])
})

test('requested worksheet names are exact and never fall back to the active sheet', async () => {
  const app = workbookFixture(); const run = await runtimeWith(app)
  const missing = await run.raw({ action: 'range', sheetName: 'Missing', range: 'A1' })
  assert.equal(missing.error.code, 'invalid_range')
  app.ActiveWorkbook.getWorksheet = () => app._sheets[0]
  const mismatch = await run.raw({ action: 'range', sheetName: 'Sheet2', range: 'A1' })
  assert.equal(mismatch.error.code, 'invalid_range')
})

test('sheet lifecycle uses one canonical names snapshot for inspected writes', async () => {
  const app = sheetApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const addInspection = await run.raw({ action: 'inspect_write', operation: 'sheet_add', payload: { name: 'Plan' } })
  const added = await run.raw({ action: 'write', resource, operation: 'sheet_add', payload: { name: 'Plan' }, precondition: addInspection.result.precondition })
  assert.equal(added.result.observed.name, 'Plan')
  const renameInspection = await run.raw({ action: 'inspect_write', operation: 'sheet_rename', payload: { name: 'Plan', newName: 'Plan 2' } })
  const renamed = await run.raw({ action: 'write', resource, operation: 'sheet_rename', payload: { name: 'Plan', newName: 'Plan 2' }, precondition: renameInspection.result.precondition })
  assert.equal(renamed.result.observed.name, 'Plan 2')
  const stale = await run.raw({ action: 'inspect_write', operation: 'sheet_delete', payload: { name: 'Plan 2' } }); app.ActiveWorkbook.Worksheets.Add('Elsewhere')
  const rejected = await run.raw({ action: 'write', resource, operation: 'sheet_delete', payload: { name: 'Plan 2' }, precondition: stale.result.precondition })
  assert.equal(rejected.error.code, 'fingerprint_mismatch')
})

test('exports dispatch through verified write and recalculation fails closed as a write-like command', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const exported = await run({ action: 'write', resource, operation: 'export_range_image', payload: { range: 'A1:B2' } })
  assert.equal(exported.result.observed.artifact.kind, 'range_image')
  assert.equal((await run.raw({ action: 'recalculate' })).error.code, 'unsupported')
})

test('chart reads reject mixed Shapes and use only a dedicated chart collection', async () => {
  const app = analyticsApp(); app._sheet.Shapes = { Count: 1, Item: () => ({ Id: 'picture', Name: 'Picture', Type: 'image' }) }
  const run = await runtimeWith(app); const list = await run({ action: 'list_charts', limit: 10 })
  assert.equal(list.result.charts.items[0].id, 1); assert.equal(list.result.charts.items[0].name, 'Chart 1')
})

test('unsafe structural, clipboard, autofill, comments, image, filter, and format writes stop before mutation', async () => {
  const app = fakeApp(); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource; let calls = 0
  app._range.AutoFill = () => { calls += 1 }; app._range.AddComment = () => { calls += 1 }; app._range.insertCellPictureUrl = () => { calls += 1 }; app._range.ClearFormats = () => { calls += 1 }; app._range.PasteSpecial = () => { calls += 1 }
  const requests = [
    ['insert_cells', { range: 'A1', count: 1 }], ['paste_special', { sourceRange: 'A1', destinationRange: 'B1' }], ['auto_fill', { range: 'A1', destination: 'A1:A2' }], ['add_comment', { range: 'A1', text: 'x' }], ['insert_cell_image', { range: 'A1', url: 'https://example.test/a.png' }], ['apply_filter', { range: 'A1:B2', mode: 'values' }], ['clear_formats', { range: 'A1' }], ['apply_table_style', { range: 'A1:B2' }],
  ]
  for (const [operation, payload] of requests) assert.ok(['unsupported', 'invalid_range', 'readback_mismatch'].includes((await run({ action: 'write', resource, operation, payload })).error.code))
  assert.ok(calls <= 2)
})

test('structural writes verify bounded value/formula displacement, count, direction, and blank targets', async () => {
  const app = structuralApp([[1, 10, 100], [null, null, null], [3, 30, 300], [4, 40, 400]]); const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const inserted = await run({ action: 'write', resource, operation: 'insert_rows', payload: { range: '2:2', count: 2, position: 'before' } })
  assert.equal(inserted.result?.status, 'verified_write', JSON.stringify(inserted)); assert.deepEqual(app._grid.slice(0, 5), [[1, 10, 100], [null, null, null], [null, null, null], [null, null, null], [3, 30, 300]])
  const deleted = await run({ action: 'write', resource, operation: 'delete_rows', payload: { range: '2:2', count: 1 } })
  assert.equal(deleted.result?.status, 'verified_write', JSON.stringify(deleted)); assert.deepEqual(app._grid.slice(0, 4), [[1, 10, 100], [null, null, null], [null, null, null], [3, 30, 300]])
  const invalidShift = await run.raw({ action: 'inspect_write', operation: 'insert_cells', payload: { range: 'A1', shift: 'left' } })
  assert.equal(invalidShift.error.code, 'invalid_range')
  const invalidCount = await run.raw({ action: 'inspect_write', operation: 'delete_columns', payload: { range: 'A:A', count: 0 } })
  assert.equal(invalidCount.error.code, 'invalid_range')
})

test('undo and redo never report verified writes for a no-op history command', async () => {
  const app = fakeApp(); app.undo = () => true; app.redo = () => true
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const undo = await run({ action: 'write', resource, operation: 'undo', payload: { count: 1 } })
  const redo = await run({ action: 'write', resource, operation: 'redo', payload: { count: 1 } })
  assert.equal(undo.error.code, 'write_incomplete'); assert.equal(undo.error.details.observed.observableChange, false)
  assert.equal(redo.error.code, 'write_incomplete'); assert.equal(redo.error.details.observed.observableChange, false)
})

test('recalculation is a preflighted write with a command completion token', async () => {
  const app = fakeApp(); let calls = 0; app._workbook.Recalculate = () => { calls += 1; return { callBackId: 'calc-1', recalculateTime: 2 } }
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  assert.equal((await run.raw({ action: 'recalculate' })).error.code, 'unsupported'); assert.equal(calls, 0)
  const result = await run({ action: 'write', resource, operation: 'recalculate', payload: {} })
  assert.equal(result.result.status, 'verified_write'); assert.equal(result.result.observed.callbackId, 'calc-1'); assert.equal(result.result.observed.formulaResultsVerified, false); assert.equal(calls, 1)
})

test('all 75 published spreadsheet operations reach a named runtime dispatch', async () => {
  assert.equal(SPREADSHEET_WRITE_OPERATIONS.length, 75)
  const run = await runtimeWith(fakeApp())
  for (const operation of SPREADSHEET_WRITE_OPERATIONS) {
    const result = await run.raw({ action: 'inspect_write', operation, payload: { range: 'A1:B2' } })
    assert.doesNotMatch(result.error?.message ?? '', /intentionally unavailable|unsupported spreadsheet range operation/i, operation)
  }
})

test('comments distinguish readable target text from existence-only write completion', async () => {
  const app = fakeApp(); const comments = app._comments; comments.items = []; comments.Item = (index) => comments.items[index - 1]
  app._range.AddComment = (text) => { comments.items.push({ Text: text, Address: 'A1:B2', Author: 'tester' }); comments.Count = comments.items.length }
  const run = await runtimeWith(app); const resource = (await run({ action: 'context' })).result.resource
  const verified = await run({ action: 'write', resource, operation: 'add_comment', payload: { range: 'A1:B2', text: 'note' } })
  assert.equal(verified.result.status, 'verified_write'); assert.equal(verified.result.observed.contentVerified, true)
  const incompleteApp = fakeApp(); const incompleteComments = incompleteApp._comments; incompleteComments.items = []; incompleteComments.Item = (index) => incompleteComments.items[index - 1]; incompleteApp._range.AddComment = () => { incompleteComments.items.push({}); incompleteComments.Count = 1 }
  const incompleteRun = await runtimeWith(incompleteApp); const incompleteResource = (await incompleteRun({ action: 'context' })).result.resource
  const incomplete = await incompleteRun({ action: 'write', resource: incompleteResource, operation: 'add_comment', payload: { range: 'A1:B2', text: 'note' } })
  assert.equal(incomplete.error.code, 'write_incomplete', JSON.stringify(incomplete)); assert.equal(incomplete.error.details.observed.contentVerified, false)
  const deleteApp = fakeApp(); const deleteComments = deleteApp._comments; deleteComments.Count = 2; deleteComments.items = [{ Text: 'one', Address: 'A1:B2' }, { Text: 'two', Address: 'A1:B2' }]; deleteComments.Item = (index) => deleteComments.items[index - 1]; deleteApp._range.Comments = deleteComments; deleteApp._range.ClearComments = () => { deleteComments.Count = 0; deleteComments.items = [] }
  const deleteRun = await runtimeWith(deleteApp); const deleteResource = (await deleteRun({ action: 'context' })).result.resource
  const deleted = await deleteRun({ action: 'write', resource: deleteResource, operation: 'delete_comments', payload: { range: 'A1:B2' } })
  assert.equal(deleted.result.status, 'verified_write'); assert.equal(deleted.result.observed.targetRangeEmpty, true)
})
