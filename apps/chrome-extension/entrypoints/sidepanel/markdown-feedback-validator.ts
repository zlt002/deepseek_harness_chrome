export interface MarkdownFeedbackBase {
  id: string
  selectionId: string
  harnessSessionId: string
  reviewId: string
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
  quote: string
  comment: string
}

export interface SourceMarkdownFeedback extends MarkdownFeedbackBase {
  anchorKind: 'source'
  startUtf16: number
  endUtf16: number
  prefix: string
  suffix: string
}

export interface VisualMarkdownFeedback extends MarkdownFeedbackBase {
  anchorKind: 'visual'
  editorRevision: number
  from: number
  to: number
  blocks: Array<{ kind: string; text: string }>
  table?: VisualMarkdownTableContext
}

export interface VisualMarkdownTableContext {
  from: number
  to: number
  rowCount: number
  columnCount: number
  selectedRowStart: number
  selectedRowEnd: number
  selectedColumnStart: number
  selectedColumnEnd: number
  isWholeTable: boolean
  header: string[]
  rows: string[][]
}

export type WorkspaceMarkdownFeedback = SourceMarkdownFeedback | VisualMarkdownFeedback

export interface WorkspaceMarkdownReviewAction {
  action: 'rewrite' | 'accept'
  reviewId: string
  harnessSessionId: string
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
  pmdReviewReceipt?: string
}

export type MarkdownFeedbackValidation =
  | { ok: true; feedback: WorkspaceMarkdownFeedback }
  | { ok: false; error: string }

const baseKeys = ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'anchorKind', 'quote', 'comment']
const sourceKeys = [...baseKeys, 'startUtf16', 'endUtf16', 'prefix', 'suffix']
const visualKeys = [...baseKeys, 'editorRevision', 'from', 'to', 'blocks']
const visualTableKeys = [...visualKeys, 'table']
const tableKeys = ['from', 'to', 'rowCount', 'columnCount', 'selectedRowStart', 'selectedRowEnd', 'selectedColumnStart', 'selectedColumnEnd', 'isWholeTable', 'header', 'rows']

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim() !== '')
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function visualTable(value: unknown): value is VisualMarkdownTableContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const table = value as Record<string, unknown>
  if (!hasExactKeys(table, tableKeys)) return false
  const integer = (key: string) => Number.isSafeInteger(table[key])
  if (!['from', 'to', 'rowCount', 'columnCount', 'selectedRowStart', 'selectedRowEnd', 'selectedColumnStart', 'selectedColumnEnd'].every(integer)) return false
  const { from, to, rowCount, columnCount, selectedRowStart, selectedRowEnd, selectedColumnStart, selectedColumnEnd } = table as Record<string, number>
  if (from < 0 || to <= from || rowCount < 1 || columnCount < 1
    || selectedRowStart < 0 || selectedRowEnd < selectedRowStart || selectedRowEnd >= rowCount
    || selectedColumnStart < 0 || selectedColumnEnd < selectedColumnStart || selectedColumnEnd >= columnCount
    || typeof table.isWholeTable !== 'boolean') return false
  const row = (value: unknown) => Array.isArray(value) && value.length === columnCount && value.every(cell => boundedString(cell, 2_000, true))
  return row(table.header) && Array.isArray(table.rows) && table.rows.length + 1 === rowCount && table.rows.every(row)
}

function invalid(message: string): MarkdownFeedbackValidation {
  return { ok: false, error: `Invalid Markdown review feedback: ${message}` }
}

export function validateWorkspaceMarkdownFeedback(value: unknown): MarkdownFeedbackValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('feedback must be an object.')
  const item = value as Record<string, unknown>
  const kind = item.anchorKind
  if (kind !== 'source' && kind !== 'visual') return invalid('anchorKind must be "source" or "visual".')

  const expectedKeys = kind === 'source' ? sourceKeys : Object.prototype.hasOwnProperty.call(item, 'table') ? visualTableKeys : visualKeys
  if (!hasExactKeys(item, expectedKeys)) return invalid(`unexpected, missing, or mixed ${kind} anchor fields.`)

  const identifiers = ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'revision', 'fingerprint']
  if (!identifiers.every(key => boundedString(item[key], 160))) return invalid('identity fields must be non-empty strings of at most 160 characters.')
  if (!boundedString(item.displayPath, 2_048)) return invalid('displayPath must be a non-empty string of at most 2048 characters.')
  if (!boundedString(item.quote, 8_000)) return invalid('quote must be a non-empty string of at most 8000 characters.')
  if (!boundedString(item.comment, 8_000)) return invalid('comment must be a non-empty string of at most 8000 characters.')

  if (kind === 'source') {
    if (!Number.isSafeInteger(item.startUtf16) || (item.startUtf16 as number) < 0
      || !Number.isSafeInteger(item.endUtf16) || (item.endUtf16 as number) <= (item.startUtf16 as number)) return invalid('source offsets must be safe, non-negative, increasing integers.')
    if (!boundedString(item.prefix, 512, true) || !boundedString(item.suffix, 512, true)) return invalid('source context must be strings of at most 512 characters.')
    return { ok: true, feedback: item as unknown as SourceMarkdownFeedback }
  }

  if (!Number.isSafeInteger(item.editorRevision) || (item.editorRevision as number) < 0
    || !Number.isSafeInteger(item.from) || (item.from as number) < 0
    || !Number.isSafeInteger(item.to) || (item.to as number) <= (item.from as number)) return invalid('visual positions and editorRevision must be safe, non-negative, increasing integers.')
  if (!Array.isArray(item.blocks) || item.blocks.length > 24) return invalid('visual blocks must be an array with at most 24 entries.')
  if (!item.blocks.every(block => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return false
    const entry = block as Record<string, unknown>
    return hasExactKeys(entry, ['kind', 'text']) && boundedString(entry.kind, 32) && boundedString(entry.text, 2_000, true)
  })) return invalid('each visual block must have only a non-empty kind (at most 32 chars) and text (at most 2000 chars).')
  if (Object.prototype.hasOwnProperty.call(item, 'table') && !visualTable(item.table)) return invalid('visual table context must contain only valid table fields.')
  return { ok: true, feedback: item as unknown as VisualMarkdownFeedback }
}

export function isWorkspaceMarkdownFeedback(value: unknown): value is WorkspaceMarkdownFeedback {
  return validateWorkspaceMarkdownFeedback(value).ok
}

/** Session actions carry review identity plus the accepted resource version, never body or capability. */
export function validateWorkspaceMarkdownReviewAction(value: unknown): { ok: true; action: WorkspaceMarkdownReviewAction } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Invalid Markdown review action: action must be an object.' }
  const item = value as Record<string, unknown>
  const keys = ['action', 'reviewId', 'harnessSessionId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'pmdReviewReceipt']
  const allowed = item.action === 'accept' ? keys : keys.slice(0, -1)
  if (!hasExactKeys(item, allowed) || (item.action !== 'rewrite' && item.action !== 'accept')) return { ok: false, error: 'Invalid Markdown review action: unexpected, missing, or mixed fields.' }
  if (!['reviewId', 'harnessSessionId', 'resourceId', 'revision', 'fingerprint'].every(key => boundedString(item[key], 160)) || !boundedString(item.displayPath, 2_048)) {
    return { ok: false, error: 'Invalid Markdown review action: identity fields are invalid.' }
  }
  if (item.action === 'accept' && (!boundedString(item.pmdReviewReceipt, 256) || !/^[A-Za-z0-9_-]{16,256}$/.test(item.pmdReviewReceipt as string))) return { ok: false, error: 'Invalid Markdown review action: adoption receipt is invalid.' }
  return { ok: true, action: item as unknown as WorkspaceMarkdownReviewAction }
}
