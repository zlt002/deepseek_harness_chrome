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

export interface VisualSelection {
  quote: string
  editorRevision: number
  from: number
  to: number
  blocks: VisualBlockContext[]
  limitReason?: 'quote_too_long' | 'too_many_blocks'
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
  return BLOCK_KINDS.has(node.type.name as VisualBlockKind)
    ? node.type.name as VisualBlockKind
    : 'other'
}

function nodeText(node: ProseNode): string {
  return node.textBetween(0, node.content.size, '\n').slice(0, 2_000)
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
  const seen = new Set<string>()
  let tooManyBlocks = false
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.isBlock) return
    const kind = blockKind(node)
    if (kind === 'other') return
    const from = pos
    const to = pos + node.nodeSize
    const key = `${kind}:${from}:${to}`
    if (seen.has(key)) return
    seen.add(key)
    if (blocks.length >= MAX_SELECTION_BLOCKS) {
      tooManyBlocks = true
      return false
    }
    blocks.push({ kind, from, to, text: nodeText(node) })
    return blocks.length < MAX_SELECTION_BLOCKS
  })
  const fullQuote = doc.textBetween(selection.from, selection.to, '\n')
  const quote = fullQuote.slice(0, MAX_SELECTION_QUOTE_LENGTH)
  const limitReason = fullQuote.length > MAX_SELECTION_QUOTE_LENGTH
    ? 'quote_too_long'
    : tooManyBlocks ? 'too_many_blocks' : undefined
  return quote.trim().length === 0 ? undefined : {
    quote,
    editorRevision,
    from: selection.from,
    to: selection.to,
    blocks,
    limitReason,
  }
}
