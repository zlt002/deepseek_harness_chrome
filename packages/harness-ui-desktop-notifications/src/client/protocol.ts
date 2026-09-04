export type WorkspaceNotificationKind = 'completed' | 'approval' | 'question' | 'plan-review'
export interface WorkspaceNotificationEvent { sessionId: string; eventId: string; kind: WorkspaceNotificationKind }

interface Pending { key?: unknown; kind?: unknown; payload?: { questions?: unknown } }
interface Entry {
  sessionId?: unknown
  origin?: unknown
  updatedAt?: unknown
  pendingInteraction?: unknown
  projectionValues?: { workspaceDesktopNotification?: unknown }
}
interface SessionListSnapshot { ids?: unknown; byId?: unknown }

export function workspaceNotificationEventKey(event: WorkspaceNotificationEvent): string {
  return `${event.sessionId}\u0000${event.kind}\u0000${event.eventId}`
}

/** Keeps the completion visible at first connection as history, while current pending requests remain live. */
export function activeWorkspaceNotificationSnapshot(
  events: readonly WorkspaceNotificationEvent[],
  historicalCompleted: Set<string>,
  initial: boolean,
): WorkspaceNotificationEvent[] {
  if (initial) {
    for (const event of events) if (event.kind === 'completed') historicalCompleted.add(workspaceNotificationEventKey(event))
  }
  return events.filter(event => !historicalCompleted.has(workspaceNotificationEventKey(event)))
}

function planReview(pending: Pending): boolean {
  const questions = pending.payload?.questions
  if (!Array.isArray(questions) || questions.length !== 1) return false
  const question = questions[0] as { intent?: { kind?: unknown; approve?: unknown }; detail?: unknown; multiSelect?: unknown; options?: unknown[] }
  if (question.intent?.kind !== 'plan-review' || question.detail === undefined || question.multiSelect === true || !Array.isArray(question.options) || question.options.length > 2) return false
  return question.options.some(option => option !== null && typeof option === 'object' && (option as { label?: unknown }).label === question.intent?.approve)
}

function completion(value: unknown): { eventSeq: number; durationMs: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const completed = (value as { completed?: unknown }).completed
  if (completed === null || typeof completed !== 'object') return undefined
  const item = completed as { eventSeq?: unknown; durationMs?: unknown }
  return Number.isSafeInteger(item.eventSeq) && (item.eventSeq as number) >= 0 && Number.isSafeInteger(item.durationMs) && (item.durationMs as number) >= 30_000
    ? { eventSeq: item.eventSeq as number, durationMs: item.durationMs as number }
    : undefined
}

/** Pure Client projection of durable completion plus live, stable pending request identities. */
export function collectWorkspaceNotificationEvents(
  entries: readonly Entry[],
  pendingFor: (sessionId: string) => readonly Pending[] | undefined,
): WorkspaceNotificationEvent[] {
  const out: WorkspaceNotificationEvent[] = []
  for (const entry of entries) {
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0 || entry.origin === 'subagent') continue
    const done = completion(entry.projectionValues?.workspaceDesktopNotification)
    if (done !== undefined) out.push({ sessionId: entry.sessionId, eventId: `turn:${done.eventSeq}`, kind: 'completed' })
    const pendingEvents: WorkspaceNotificationEvent[] = []
    for (const pending of pendingFor(entry.sessionId) ?? []) {
      if (typeof pending.key !== 'string' || pending.key.length === 0) continue
      const kind: WorkspaceNotificationKind | undefined = pending.kind === 'approval'
        ? 'approval' : pending.kind === 'question' ? planReview(pending) ? 'plan-review' : 'question' : undefined
      if (kind !== undefined) pendingEvents.push({ sessionId: entry.sessionId, eventId: pending.key, kind })
    }
    out.push(...pendingEvents)
    // The list store is the authoritative cross-session pending signal. A Session binding can be
    // temporarily absent during restore/background navigation even though the blocking card is live.
    if (pendingEvents.length === 0 && (entry.pendingInteraction === 'approval' || entry.pendingInteraction === 'question' || entry.pendingInteraction === 'plan-review')) {
      const revision = Number.isSafeInteger(entry.updatedAt) && (entry.updatedAt as number) >= 0 ? `:${entry.updatedAt as number}` : ''
      out.push({ sessionId: entry.sessionId, eventId: `summary:${entry.pendingInteraction}${revision}`, kind: entry.pendingInteraction })
    }
  }
  return out
}

/** Adapts the public SessionRuntime list store (`ids` plus `byId`) to notification entries. */
export function collectWorkspaceNotificationEventsFromSessionList(
  snapshot: SessionListSnapshot,
  pendingFor: (sessionId: string) => readonly Pending[] | undefined,
): WorkspaceNotificationEvent[] {
  if (!Array.isArray(snapshot.ids) || snapshot.byId === null || typeof snapshot.byId !== 'object') return []
  const byId = snapshot.byId as Record<string, Entry>
  return collectWorkspaceNotificationEvents(snapshot.ids.flatMap((id): Entry[] => {
    if (typeof id !== 'string' || id.length === 0) return []
    const entry = byId[id]
    return entry === undefined ? [] : [{ ...entry, sessionId: id }]
  }), pendingFor)
}
