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
}

export type WorkspaceMarkdownFeedback = SourceMarkdownFeedback | VisualMarkdownFeedback

export type MarkdownFeedbackValidation =
  | { ok: true; feedback: WorkspaceMarkdownFeedback }
  | { ok: false; error: string }

const baseKeys = ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'anchorKind', 'quote', 'comment']
const sourceKeys = [...baseKeys, 'startUtf16', 'endUtf16', 'prefix', 'suffix']
const visualKeys = [...baseKeys, 'editorRevision', 'from', 'to', 'blocks']

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim() !== '')
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function invalid(message: string): MarkdownFeedbackValidation {
  return { ok: false, error: `Invalid Markdown review feedback: ${message}` }
}

export function validateWorkspaceMarkdownFeedback(value: unknown): MarkdownFeedbackValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('feedback must be an object.')
  const item = value as Record<string, unknown>
  const kind = item.anchorKind
  if (kind !== 'source' && kind !== 'visual') return invalid('anchorKind must be "source" or "visual".')

  const expectedKeys = kind === 'source' ? sourceKeys : visualKeys
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
  return { ok: true, feedback: item as unknown as VisualMarkdownFeedback }
}

export function isWorkspaceMarkdownFeedback(value: unknown): value is WorkspaceMarkdownFeedback {
  return validateWorkspaceMarkdownFeedback(value).ok
}
