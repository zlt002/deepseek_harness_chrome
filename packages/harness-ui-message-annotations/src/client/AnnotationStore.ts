import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { addAnnotation, removeAcceptedAnnotations } from './annotation-state.js'

export interface MessageAnnotation {
  readonly id: string
  readonly source: 'assistant-message'
  readonly messageId: string
  readonly selectedText: string
  readonly comment: string
}

export interface MarkdownSelectionAnchor {
  readonly version: 1
  readonly startUtf16: number
  readonly endUtf16: number
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly sourceFingerprint: string
}
export interface VisualMarkdownSelectionAnchor {
  readonly version: 2
  readonly editorRevision: number
  readonly from: number
  readonly to: number
  readonly quote: string
  readonly blocks: ReadonlyArray<{ readonly kind: string; readonly text: string }>
  readonly table?: VisualMarkdownTableContext
  readonly sourceFingerprint: string
}
export interface VisualMarkdownTableContext {
  readonly from: number
  readonly to: number
  readonly rowCount: number
  readonly columnCount: number
  readonly selectedRowStart: number
  readonly selectedRowEnd: number
  readonly selectedColumnStart: number
  readonly selectedColumnEnd: number
  readonly isWholeTable: boolean
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}
export type WorkspaceMarkdownAnchor = MarkdownSelectionAnchor | VisualMarkdownSelectionAnchor

interface WorkspaceMarkdownFeedbackBase {
  readonly id: string
  readonly selectionId: string
  readonly reviewId: string
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
  readonly quote: string
  readonly comment: string
}
export interface SourceWorkspaceMarkdownFeedbackInput extends WorkspaceMarkdownFeedbackBase {
  readonly anchorKind: 'source'
  readonly startUtf16: number
  readonly endUtf16: number
  readonly prefix: string
  readonly suffix: string
}
export interface VisualWorkspaceMarkdownFeedbackInput extends WorkspaceMarkdownFeedbackBase {
  readonly anchorKind: 'visual'
  readonly editorRevision: number
  readonly from: number
  readonly to: number
  readonly blocks: ReadonlyArray<{ readonly kind: string; readonly text: string }>
  readonly table?: VisualMarkdownTableContext
}
export type WorkspaceMarkdownFeedbackInput = SourceWorkspaceMarkdownFeedbackInput | VisualWorkspaceMarkdownFeedbackInput

export interface WorkspaceMarkdownFeedback {
  readonly id: string
  readonly selectionId: string
  readonly source: 'workspace-markdown'
  readonly reviewId: string
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
  readonly comment: string
  readonly anchor: WorkspaceMarkdownAnchor
}

export type ReviewFeedback = MessageAnnotation | WorkspaceMarkdownFeedback
export { assistantMessageFeedback } from './annotation-state.js'

export interface ReviewFeedbackSnapshot {
  readonly bySession: ReadonlyMap<string, readonly ReviewFeedback[]>
}

/** Compatibility name retained for existing slot consumers. */
export type AnnotationSnapshot = ReviewFeedbackSnapshot

const emptySnapshot: ReviewFeedbackSnapshot = { bySession: new Map() }

/** Browser-local review feedback from every review surface, scoped by Harness session. */
export class ReviewFeedbackStore {
  readonly snapshot: SnapshotStore<ReviewFeedbackSnapshot> = createSnapshotStore(emptySnapshot)

  add(sessionId: string, messageId: string, selectedText: string, comment: string): void {
    const quote = selectedText.trim()
    const note = comment.trim()
    if (quote === '' || note === '') return
    const current = this.snapshot.getSnapshot()
    const annotation: MessageAnnotation = {
      id: crypto.randomUUID(),
      source: 'assistant-message',
      messageId,
      selectedText: quote,
      comment: note,
    }
    const bySession = new Map(current.bySession)
    bySession.set(sessionId, addAnnotation(bySession.get(sessionId) ?? [], annotation))
    this.set({ bySession })
  }

  importWorkspaceMarkdown(sessionId: string, feedback: WorkspaceMarkdownFeedbackInput): boolean {
    if (sessionId.trim() === '' || !validWorkspaceFeedback(feedback)) return false
    const current = this.snapshot.getSnapshot()
    const items = current.bySession.get(sessionId) ?? []
    if (items.some(item => item.id === feedback.id)) return true
    const bySession = new Map(current.bySession)
    const normalized: WorkspaceMarkdownFeedback = {
      id: feedback.id,
      selectionId: feedback.selectionId,
      source: 'workspace-markdown',
      reviewId: feedback.reviewId,
      resourceId: feedback.resourceId,
      displayPath: feedback.displayPath,
      revision: feedback.revision,
      fingerprint: feedback.fingerprint,
      comment: feedback.comment,
      anchor: feedback.anchorKind === 'visual'
        ? { version: 2, editorRevision: feedback.editorRevision, from: feedback.from, to: feedback.to, quote: feedback.quote, blocks: feedback.blocks.map(({ kind, text }) => ({ kind, text })), ...(feedback.table === undefined ? {} : { table: feedback.table }), sourceFingerprint: feedback.fingerprint }
        : { version: 1, startUtf16: feedback.startUtf16, endUtf16: feedback.endUtf16, quote: feedback.quote, prefix: feedback.prefix, suffix: feedback.suffix, sourceFingerprint: feedback.fingerprint },
    }
    bySession.set(sessionId, addAnnotation(items, normalized))
    this.set({ bySession })
    return true
  }

  remove(sessionId: string, annotationId: string): void {
    const current = this.snapshot.getSnapshot()
    const items = current.bySession.get(sessionId) ?? []
    const next = items.filter(item => item.id !== annotationId)
    if (next.length === items.length) return
    const bySession = new Map(current.bySession)
    if (next.length === 0) bySession.delete(sessionId)
    else bySession.set(sessionId, next)
    this.set({ ...current, bySession })
  }

  feedback(sessionId: string): readonly ReviewFeedback[] {
    return this.snapshot.getSnapshot().bySession.get(sessionId) ?? []
  }

  /** Compatibility face for the existing assistant-selection UI. */
  annotations(sessionId: string): readonly ReviewFeedback[] { return this.feedback(sessionId) }

  accept(sessionId: string, annotationIds: readonly string[]): void {
    const current = this.snapshot.getSnapshot()
    const items = current.bySession.get(sessionId) ?? []
    const next = removeAcceptedAnnotations(items, annotationIds)
    if (next.length === items.length) return
    const bySession = new Map(current.bySession)
    if (next.length === 0) bySession.delete(sessionId)
    else bySession.set(sessionId, next)
    this.set({ ...current, bySession })
  }

  private set(next: ReviewFeedbackSnapshot): void {
    this.snapshot.set(next)
  }
}

/** Compatibility export; there is still only one shared Store instance. */
export class AnnotationStore extends ReviewFeedbackStore {}

function boundedText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim() !== '')
}

function validWorkspaceFeedback(value: WorkspaceMarkdownFeedbackInput): boolean {
  const base = boundedText(value.id, 160)
    && boundedText(value.selectionId, 160)
    && boundedText(value.reviewId, 160)
    && boundedText(value.resourceId, 160)
    && boundedText(value.displayPath, 2_048)
    && boundedText(value.revision, 160)
    && boundedText(value.fingerprint, 160)
    && boundedText(value.comment, 8_000)
    && boundedText(value.quote, 8_000)
  if (!base) return false
  if (value.anchorKind === 'source') {
    return Number.isSafeInteger(value.startUtf16) && value.startUtf16 >= 0 && Number.isSafeInteger(value.endUtf16) && value.endUtf16 > value.startUtf16
      && boundedText(value.prefix, 512, true) && boundedText(value.suffix, 512, true)
  }
  if (value.anchorKind === 'visual') {
    return Number.isSafeInteger(value.editorRevision) && value.editorRevision >= 0
      && Number.isSafeInteger(value.from) && value.from >= 0 && Number.isSafeInteger(value.to) && value.to > value.from
      && Array.isArray(value.blocks) && value.blocks.length <= 24 && value.blocks.every(block => boundedText(block.kind, 32) && boundedText(block.text, 2_000, true))
      && (value.table === undefined || validVisualTableContext(value.table))
  }
  return false
}

function validVisualTableContext(value: unknown): value is VisualMarkdownTableContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const table = value as Record<string, unknown>
  return Object.keys(table).every(key => ['from', 'to', 'rowCount', 'columnCount', 'selectedRowStart', 'selectedRowEnd', 'selectedColumnStart', 'selectedColumnEnd', 'isWholeTable', 'header', 'rows'].includes(key))
    && Number.isSafeInteger(table.from) && Number.isSafeInteger(table.to) && (table.from as number) >= 0 && (table.to as number) > (table.from as number)
    && Number.isSafeInteger(table.rowCount) && (table.rowCount as number) > 0 && Number.isSafeInteger(table.columnCount) && (table.columnCount as number) > 0
    && Number.isSafeInteger(table.selectedRowStart) && Number.isSafeInteger(table.selectedRowEnd)
    && (table.selectedRowStart as number) >= 0 && (table.selectedRowEnd as number) >= (table.selectedRowStart as number) && (table.selectedRowEnd as number) < (table.rowCount as number)
    && Number.isSafeInteger(table.selectedColumnStart) && Number.isSafeInteger(table.selectedColumnEnd)
    && (table.selectedColumnStart as number) >= 0 && (table.selectedColumnEnd as number) >= (table.selectedColumnStart as number) && (table.selectedColumnEnd as number) < (table.columnCount as number)
    && typeof table.isWholeTable === 'boolean'
    && validVisualTableRow(table.header, table.columnCount as number)
    && Array.isArray(table.rows) && table.rows.length + 1 === table.rowCount && table.rows.every(row => validVisualTableRow(row, table.columnCount as number))
}

function validVisualTableRow(value: unknown, columnCount: number): boolean {
  return Array.isArray(value) && value.length === columnCount && value.every(cell => boundedText(cell, 2_000, true))
}
