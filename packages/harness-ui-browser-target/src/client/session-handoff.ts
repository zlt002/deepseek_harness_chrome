import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

export interface HandoffSessionSnapshot {
  current: SessionId | undefined
  byId: Record<string, unknown>
}

export interface HandoffSessionList {
  getSnapshot(): HandoffSessionSnapshot
  subscribe(listener: () => void): () => void
}

/** Restore one handoff session without re-opening it from its own sync update. */
export function restoreHandoffSession({
  sessionId,
  list,
  open,
  reportApplied,
}: {
  sessionId: SessionId
  list: HandoffSessionList
  open: (id: SessionId) => void
  reportApplied: () => void
}): (() => void) | undefined {
  let handoffApplied = false
  const select = (): boolean => {
    const snapshot = list.getSnapshot()
    if (snapshot.byId[sessionId] === undefined) return false
    // SessionRuntime notifies list subscribers synchronously. Opening an
    // already-current session here would recursively notify this listener.
    if (snapshot.current !== sessionId) open(sessionId)
    if (list.getSnapshot().current !== sessionId) return false
    if (!handoffApplied) {
      handoffApplied = true
      reportApplied()
    }
    return true
  }

  if (select()) return undefined
  let stop: (() => void) | undefined
  const onListChanged = (): void => {
    if (select()) stop?.()
  }
  stop = list.subscribe(onListChanged)
  // Observable stores may call their listener before returning its disposer.
  if (handoffApplied) stop()
  return () => stop?.()
}
