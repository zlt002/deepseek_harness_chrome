import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { Selection } from '@milkdown/kit/prose/state'

export type VisualBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table_cell'
  | 'code_block'
  | 'blockquote'
  | 'other'

export interface VisualBlockContext {
  kind: VisualBlockKind
  /** ProseMirror positions, intentionally not Markdown source offsets. */
  from: number
  to: number
  text: string
}

/**
 * Editor-native table bounds. These positions identify the live ProseMirror
 * table only; they are deliberately not Markdown source offsets.
 */
export interface VisualTableContext {
  from: number
  to: number
  rowCount: number
  columnCount: number
  selectedRowStart: number
  selectedRowEnd: number
  selectedColumnStart: number
  selectedColumnEnd: number
  isWholeTable: boolean
}

export interface VisualSelection {
  quote: string
  editorRevision: number
  from: number
  to: number
  blocks: VisualBlockContext[]
  table?: VisualTableContext
  limitReason?: 'quote_too_long' | 'too_many_blocks' | 'multiple_tables' | 'table_selection_requires_whole_table' | 'invalid_table_structure'
}

type SelectionDocument = Pick<ProseNode, 'textBetween'> & { content: { size: number } }

/** True only while a captured visual range still identifies the same document text. */
export function canRestoreVisualSelection(doc: SelectionDocument, selection: VisualSelection, editorRevision: number): boolean {
  return selection.limitReason === undefined
    && selection.editorRevision === editorRevision
    && Number.isSafeInteger(selection.from)
    && Number.isSafeInteger(selection.to)
    && selection.from >= 0
    && selection.to > selection.from
    && selection.to <= doc.content.size
    && doc.textBetween(selection.from, selection.to, '\n') === selection.quote
}

const BLOCK_KINDS = new Set<VisualBlockKind>([
  'heading',
  'paragraph',
  'list_item',
  'table_cell',
  'code_block',
  'blockquote',
])
const MAX_SELECTION_BLOCKS = 24
const MAX_SELECTION_QUOTE_LENGTH = 8_000

function blockKind(node: ProseNode): VisualBlockKind {
  if (node.type.name === 'table_header') return 'table_cell'
  return BLOCK_KINDS.has(node.type.name as VisualBlockKind)
    ? node.type.name as VisualBlockKind
    : 'other'
}

function isTableCell(node: ProseNode): boolean {
  return node.type.name === 'table_cell' || node.type.name === 'table_header'
}

function nodeText(node: ProseNode): string {
  return node.textBetween(0, node.content.size, '\n').slice(0, 2_000)
}

function intersects(from: number, to: number, rangeFrom: number, rangeTo: number): boolean {
  return from < rangeTo && to > rangeFrom
}

function tableContextFor(doc: ProseNode, selection: Selection): { table?: VisualTableContext; limitReason?: VisualSelection['limitReason'] } {
  if (typeof doc.descendants !== 'function') return {}
  const tables: Array<{ node: ProseNode; from: number }> = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'table' && intersects(selection.from, selection.to, pos, pos + node.nodeSize)) tables.push({ node, from: pos })
  })
  if (tables.length === 0) return {}
  if (tables.length > 1) return { limitReason: 'multiple_tables' }

  const { node: table, from } = tables[0]
  const rows: Array<Array<{ from: number; to: number }>> = []
  let rowPosition = from + 1
  let columnCount: number | undefined
  let invalid = false
  table.forEach((row) => {
    if (row.type.name !== 'table_row') { invalid = true; return }
    const cells: Array<{ from: number; to: number }> = []
    let cellPosition = rowPosition + 1
    row.forEach((cell) => {
      if (cell.type.name !== 'table_cell' && cell.type.name !== 'table_header') invalid = true
      cells.push({ from: cellPosition, to: cellPosition + cell.nodeSize })
      cellPosition += cell.nodeSize
    })
    if (cells.length === 0 || (columnCount !== undefined && columnCount !== cells.length)) invalid = true
    columnCount ??= cells.length
    rows.push(cells)
    rowPosition += row.nodeSize
  })
  if (invalid || rows.length === 0 || columnCount === undefined) return { limitReason: 'invalid_table_structure' }

  const selected = rows.flatMap((cells, row) => cells.flatMap((cell, column) =>
    intersects(selection.from, selection.to, cell.from + 1, cell.to - 1) ? [{ row, column }] : [],
  ))
  if (selected.length === 0) return { limitReason: 'invalid_table_structure' }
  const firstCell = rows[0][0]
  const lastCell = rows.at(-1)?.at(-1)
  if (lastCell === undefined) return { limitReason: 'invalid_table_structure' }
  const tableContext: VisualTableContext = {
    from,
    to: from + table.nodeSize,
    rowCount: rows.length,
    columnCount,
    selectedRowStart: Math.min(...selected.map(({ row }) => row)),
    selectedRowEnd: Math.max(...selected.map(({ row }) => row)),
    selectedColumnStart: Math.min(...selected.map(({ column }) => column)),
    selectedColumnEnd: Math.max(...selected.map(({ column }) => column)),
    isWholeTable: selection.from <= firstCell.from + 1 && selection.to >= lastCell.to - 1,
  }
  return tableContext.isWholeTable
    ? { table: tableContext }
    : { table: tableContext, limitReason: 'table_selection_requires_whole_table' }
}

function markdownTableCells(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined
  const cells: string[] = []
  let cell = ''
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]
    if (character === '\\' && index + 1 < trimmed.length - 1) {
      cell += character + trimmed[index + 1]
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

/** Accept only a standalone, complete GFM table before entering Milkdown diff. */
export function isCompleteTableMarkdown(candidate: string, columnCount: number): boolean {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) return false
  const lines = candidate.trim().split(/\r?\n/)
  if (lines.length < 3 || lines.some(line => line.trim() === '')) return false
  const header = markdownTableCells(lines[0])
  const separator = markdownTableCells(lines[1])
  if (header?.length !== columnCount || separator?.length !== columnCount
    || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return false
  return lines.slice(2).every(line => markdownTableCells(line)?.length === columnCount)
}

/**
 * Produces editor-native context for a visual selection.  `from` and `to`
 * belong to the live ProseMirror document and must never be treated as
 * Markdown file offsets: Milkdown parsing/serialization intentionally makes
 * no such positional guarantee.
 */
export function visualSelectionFor(doc: ProseNode, selection: Selection, editorRevision: number): VisualSelection | undefined {
  if (selection.empty || selection.from >= selection.to) return undefined
  const blocks: VisualBlockContext[] = []
  const tableCellRanges: Array<{ from: number; to: number }> = []
  const seen = new Set<string>()
  let tooManyBlocks = false
  doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
    if (!node.isBlock) return
    const from = pos
    const to = pos + node.nodeSize
    // A GFM table cell is the structured editable block. Its paragraph and
    // any deeper child blocks are implementation details, never peer blocks.
    if (tableCellRanges.some(cell => from > cell.from && to < cell.to)
      || (parent != null && isTableCell(parent))) return false
    const kind = blockKind(node)
    if (kind === 'other') return
    const key = `${kind}:${from}:${to}`
    if (seen.has(key)) return
    seen.add(key)
    if (blocks.length >= MAX_SELECTION_BLOCKS) {
      tooManyBlocks = true
      return false
    }
    blocks.push({ kind, from, to, text: nodeText(node) })
    if (isTableCell(node)) {
      tableCellRanges.push({ from, to })
      return false
    }
    return blocks.length < MAX_SELECTION_BLOCKS
  })
  const fullQuote = doc.textBetween(selection.from, selection.to, '\n')
  const quote = fullQuote.slice(0, MAX_SELECTION_QUOTE_LENGTH)
  const table = tableContextFor(doc, selection)
  const limitReason = fullQuote.length > MAX_SELECTION_QUOTE_LENGTH
    ? 'quote_too_long'
    : tooManyBlocks ? 'too_many_blocks' : table.limitReason
  return quote.trim().length === 0 ? undefined : {
    quote,
    editorRevision,
    from: selection.from,
    to: selection.to,
    blocks,
    ...(table.table === undefined ? {} : { table: table.table }),
    limitReason,
  }
}
