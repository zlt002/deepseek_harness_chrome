import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { addAnnotation, removeAcceptedAnnotations } from './annotation-state.js'

export interface MessageAnnotation {
  readonly id: string
  readonly messageId: string
  readonly selectedText: string
  readonly comment: string
}

export interface AnnotationSnapshot {
  readonly bySession: ReadonlyMap<string, readonly MessageAnnotation[]>
}

const emptySnapshot: AnnotationSnapshot = { bySession: new Map() }

/** Browser-local pending annotations, scoped by Harness session. */
export class AnnotationStore {
  readonly snapshot: SnapshotStore<AnnotationSnapshot> = createSnapshotStore(emptySnapshot)

  add(sessionId: string, messageId: string, selectedText: string, comment: string): void {
    const quote = selectedText.trim()
    const note = comment.trim()
    if (quote === '' || note === '') return
    const current = this.snapshot.getSnapshot()
    const annotation: MessageAnnotation = {
      id: crypto.randomUUID(),
      messageId,
      selectedText: quote,
      comment: note,
    }
    const bySession = new Map(current.bySession)
    bySession.set(sessionId, addAnnotation(bySession.get(sessionId) ?? [], annotation))
    this.set({ bySession })
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

  annotations(sessionId: string): readonly MessageAnnotation[] {
    return this.snapshot.getSnapshot().bySession.get(sessionId) ?? []
  }

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

  private set(next: AnnotationSnapshot): void {
    this.snapshot.set(next)
  }
}
