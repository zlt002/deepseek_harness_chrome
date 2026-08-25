import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const root = new URL('.', import.meta.url)
const source = await readFile(new URL('./visual-selection.ts', root), 'utf8')
const editor = await readFile(new URL('./visual-markdown-editor.tsx', root), 'utf8')

const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports })
const { canRestoreVisualSelection, isCompleteTableMarkdown, visualSelectionFor } = module.exports

test('visual selection carries structured block context and never claims Markdown source offsets', () => {
  for (const kind of ['heading', 'paragraph', 'list_item', 'table_cell', 'code_block']) assert.match(source, new RegExp(`'${kind}'`))
  assert.match(source, /editorRevision/)
  assert.match(source, /ProseMirror positions, intentionally not Markdown source offsets/)
  assert.doesNotMatch(source, /startUtf16|endUtf16|sourceFingerprint/)
})

test('candidate review is backed by Milkdown first-party diff and streaming commands', () => {
  assert.match(editor, /startDiffReviewCmd/)
  assert.match(editor, /acceptAllDiffsCmd/)
  assert.match(editor, /clearDiffReviewCmd/)
  assert.match(editor, /startStreamingCmd/)
  assert.match(editor, /endStreamingCmd/)
  assert.match(editor, /reviewCandidateMarkdown/)
  assert.match(editor, /reviewSelectionReplacement/)
})

test('selection replacement refuses a stale revision, invalid range, or changed quote', () => {
  const document = { content: { size: 11 }, textBetween: (from, to) => 'hello world'.slice(from, to) }
  const selection = { quote: 'world', editorRevision: 3, from: 6, to: 11, blocks: [] }
  assert.equal(canRestoreVisualSelection(document, selection, 3), true)
  assert.equal(canRestoreVisualSelection(document, selection, 4), false)
  assert.equal(canRestoreVisualSelection(document, { ...selection, to: 12 }, 3), false)
  assert.equal(canRestoreVisualSelection(document, { ...selection, quote: 'other' }, 3), false)
})

test('visual selection deduplicates block context and caps it at 24 blocks', () => {
  const blocks = Array.from({ length: 30 }, (_, index) => ({
    isBlock: true,
    type: { name: 'paragraph' },
    content: { size: 1 },
    nodeSize: 2,
    textBetween: () => `block-${index}`,
  }))
  const document = {
    textBetween: () => 'selected text',
    nodesBetween: (_from, _to, visit) => {
      visit(blocks[0], 1)
      visit(blocks[0], 1)
      blocks.slice(1).forEach((block, index) => visit(block, index + 3))
    },
  }
  const selection = visualSelectionFor(document, { empty: false, from: 1, to: 100 }, 2)
  assert.equal(selection.blocks.length, 24)
  assert.equal(selection.blocks.filter(({ from, to }) => from === 1 && to === 3).length, 1)
  assert.equal(selection.limitReason, 'too_many_blocks')
})

test('table selections retain cell-level structure without treating inner paragraphs as peer blocks', () => {
  const cell = (text) => ({ isBlock: true, type: { name: 'table_cell' }, content: { size: text.length }, nodeSize: text.length + 2, textBetween: () => text })
  const paragraph = (text) => ({ isBlock: true, type: { name: 'paragraph' }, content: { size: text.length }, nodeSize: text.length + 2, textBetween: () => text })
  const row = (cells) => ({ type: { name: 'table_row' }, nodeSize: cells.reduce((size, item) => size + item.nodeSize, 2), forEach: (visit) => cells.forEach(visit) })
  const rows = [row([cell('表头 A'), cell('表头 B')]), row([cell('客户系'), cell('文本输入')]), row([cell('客户名称(全称)'), cell('文本输入')])]
  const table = { type: { name: 'table' }, nodeSize: rows.reduce((size, item) => size + item.nodeSize, 2), forEach: (visit) => rows.forEach(visit) }
  const document = {
    content: { size: 80 },
    textBetween: () => '客户系\n文本输入\n客户名称(全称)\n文本输入',
    nodesBetween: (_from, _to, visit) => {
      visit(table, 5, { type: { name: 'doc' } })
      visit(rows[1], 20, table)
      visit(cell('客户系'), 21, rows[1])
      visit(paragraph('客户系'), 22, { type: { name: 'table_cell' } })
      visit(rows[2], 33, table)
      visit(cell('客户名称(全称)'), 34, rows[2])
      visit(paragraph('客户名称(全称)'), 35, { type: { name: 'table_cell' } })
    },
    descendants: (visit) => { visit(table, 5) },
  }
  const selection = visualSelectionFor(document, { empty: false, from: 21, to: 50 }, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(selection.blocks.map(({ kind, text }) => ({ kind, text })))), [
    { kind: 'table_cell', text: '客户系' },
    { kind: 'table_cell', text: '客户名称(全称)' },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(selection.table)), {
    from: 5, to: 52, rowCount: 3, columnCount: 2,
    selectedRowStart: 1, selectedRowEnd: 2, selectedColumnStart: 0, selectedColumnEnd: 1,
    isWholeTable: false,
    header: ['表头 A', '表头 B'],
    rows: [['客户系', '文本输入'], ['客户名称(全称)', '文本输入']],
  })
  assert.equal(selection.limitReason, undefined)
})

test('normalizes a TextSelection inside one Milkdown GFM table cell to its table row and column focus', () => {
  const cell = (text, name = 'table_cell') => ({ isBlock: true, type: { name }, content: { size: text.length }, nodeSize: text.length + 2, textBetween: () => text })
  const row = (cells, name) => ({ type: { name }, nodeSize: cells.reduce((size, item) => size + item.nodeSize, 2), forEach: (visit) => cells.forEach(visit) })
  const header = row(['字段', '类型', '是否必填', '范围', '条件'].map(text => cell(text, 'table_header')), 'table_header_row')
  const first = row([cell('行业'), cell('下拉'), cell('否'), cell('字典'), cell('无')], 'table_row')
  const second = row([cell('名称'), cell('文本'), cell('否'), cell('100'), cell('匹配')], 'table_row')
  const table = { type: { name: 'table' }, nodeSize: 2 + header.nodeSize + first.nodeSize + second.nodeSize, forEach: (visit) => [header, first, second].forEach(visit) }
  const document = {
    content: { size: 100 }, textBetween: () => '否',
    nodesBetween: (_from, _to, visit) => { visit(cell('否'), 39, first); visit({ isBlock: true, type: { name: 'paragraph' }, content: { size: 1 }, nodeSize: 3, textBetween: () => '否' }, 40, cell('否')) },
    descendants: (visit) => { visit(table, 5) },
  }
  // The anchor/head are inside the third data-cell text, not at any cell or row boundary.
  const selection = visualSelectionFor(document, { empty: false, from: 40, to: 41 }, 2)
  assert.equal(selection.limitReason, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(selection.table?.header)), ['字段', '类型', '是否必填', '范围', '条件'])
  assert.deepEqual(JSON.parse(JSON.stringify(selection.table?.rows)), [['行业', '下拉', '否', '字典', '无'], ['名称', '文本', '否', '100', '匹配']])
  assert.deepEqual(JSON.parse(JSON.stringify({ rowStart: selection.table?.selectedRowStart, rowEnd: selection.table?.selectedRowEnd, columnStart: selection.table?.selectedColumnStart, columnEnd: selection.table?.selectedColumnEnd })), { rowStart: 1, rowEnd: 1, columnStart: 2, columnEnd: 2 })
})

test('normalizes CellSelection endpoints across rows without treating intervening columns as selected', () => {
  const cell = (text, name = 'table_cell') => ({ isBlock: true, type: { name }, content: { size: text.length }, nodeSize: text.length + 2, textBetween: () => text })
  const row = (cells, name) => ({ type: { name }, nodeSize: cells.reduce((size, item) => size + item.nodeSize, 2), forEach: (visit) => cells.forEach(visit) })
  const header = row(['一', '二', '三', '四', '五'].map(text => cell(text, 'table_header')), 'table_header_row')
  const first = row(['a', 'b', '否', 'd', 'e'].map(text => cell(text)), 'table_row')
  const second = row(['f', 'g', '否', 'i', 'j'].map(text => cell(text)), 'table_row')
  const table = { type: { name: 'table' }, nodeSize: 2 + header.nodeSize + first.nodeSize + second.nodeSize, forEach: (visit) => [header, first, second].forEach(visit) }
  const document = { content: { size: 100 }, textBetween: () => '否\n否', nodesBetween: () => {}, descendants: (visit) => { visit(table, 5) } }
  // GFM table layout: first data row's third cell begins at 30, second at 47.
  const selection = visualSelectionFor(document, { empty: false, from: 30, to: 50, $anchorCell: { pos: 30 }, $headCell: { pos: 47 } }, 2)
  assert.equal(selection.limitReason, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify({ rowStart: selection.table?.selectedRowStart, rowEnd: selection.table?.selectedRowEnd, columnStart: selection.table?.selectedColumnStart, columnEnd: selection.table?.selectedColumnEnd })), { rowStart: 1, rowEnd: 2, columnStart: 2, columnEnd: 2 })
})

test('table replacement accepts only a complete column-consistent Markdown table', () => {
  assert.equal(isCompleteTableMarkdown('| 字段 | 类型 |\n| --- | --- |', 2), false)
  assert.equal(isCompleteTableMarkdown('| 字段 | 类型 |\n| --- | --- |\n| 客户 | 文本 |', 2), true)
  assert.equal(isCompleteTableMarkdown('| 字段 | 类型 |\n| --- | --- |\n| 客户 |', 2), false)
})

test('an overlong quote is visibly invalid instead of being truncated and delivered', () => {
  const quote = 'x'.repeat(8_001)
  const document = { textBetween: () => quote, nodesBetween: () => {} }
  const selection = visualSelectionFor(document, { empty: false, from: 1, to: 8_002 }, 2)
  assert.equal(selection.quote.length, 8_000)
  assert.equal(selection.limitReason, 'quote_too_long')
})
