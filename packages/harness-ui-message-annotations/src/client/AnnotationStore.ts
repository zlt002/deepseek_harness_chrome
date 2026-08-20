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

export interface WorkspaceMarkdownFeedbackInput {
  readonly id: string
  readonly reviewId: string
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
  readonly startUtf16: number
  readonly endUtf16: number
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly comment: string
}

export interface WorkspaceMarkdownFeedback extends Omit<WorkspaceMarkdownFeedbackInput, 'startUtf16' | 'endUtf16' | 'quote' | 'prefix' | 'suffix'> {
  readonly source: 'workspace-markdown'
  readonly anchor: MarkdownSelectionAnchor
}

export type ReviewFeedback = MessageAnnotation | WorkspaceMarkdownFeedback

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
      source: 'workspace-markdown',
      reviewId: feedback.reviewId,
      resourceId: feedback.resourceId,
      displayPath: feedback.displayPath,
      revision: feedback.revision,
      fingerprint: feedback.fingerprint,
      comment: feedback.comment,
      anchor: {
        version: 1,
        startUtf16: feedback.startUtf16,
        endUtf16: feedback.endUtf16,
        quote: feedback.quote,
        prefix: feedback.prefix,
        suffix: feedback.suffix,
        sourceFingerprint: feedback.fingerprint,
      },
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
  return boundedText(value.id, 160)
    && boundedText(value.reviewId, 160)
    && boundedText(value.resourceId, 160)
    && boundedText(value.displayPath, 2_048)
    && boundedText(value.revision, 160)
    && boundedText(value.fingerprint, 160)
    && boundedText(value.comment, 8_000)
    && Number.isSafeInteger(value.startUtf16) && value.startUtf16 >= 0
    && Number.isSafeInteger(value.endUtf16) && value.endUtf16 > value.startUtf16
    && boundedText(value.quote, 8_000)
    && boundedText(value.prefix, 512, true)
    && boundedText(value.suffix, 512, true)
}
