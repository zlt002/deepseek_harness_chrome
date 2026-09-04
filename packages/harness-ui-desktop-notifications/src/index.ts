import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

export const DESKTOP_NOTIFICATION_LONG_RUN_MS = 30_000

export interface CompletedWorkspaceTurn {
  turn: number
  eventSeq: number
  durationMs: number
}
export interface WorkspaceDesktopNotificationProjection { v: 1; completed?: CompletedWorkspaceTurn }
interface ProjectionState { started?: { turn: number; at: number }; completed?: CompletedWorkspaceTurn }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { workspaceDesktopNotification: WorkspaceDesktopNotificationProjection }
}

function eventTime(event: SessionEvent): number { return Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : 0 }
function validCompleted(value: unknown): value is CompletedWorkspaceTurn {
  return value !== null && typeof value === 'object'
    && Number.isSafeInteger((value as CompletedWorkspaceTurn).turn) && (value as CompletedWorkspaceTurn).turn >= 0
    && Number.isSafeInteger((value as CompletedWorkspaceTurn).eventSeq) && (value as CompletedWorkspaceTurn).eventSeq >= 0
    && Number.isSafeInteger((value as CompletedWorkspaceTurn).durationMs) && (value as CompletedWorkspaceTurn).durationMs >= DESKTOP_NOTIFICATION_LONG_RUN_MS
}

const projectionSchema = { parse(value: unknown): WorkspaceDesktopNotificationProjection {
  if (value === null || typeof value !== 'object' || (value as { v?: unknown }).v !== 1 || !Object.keys(value).every(key => key === 'v' || key === 'completed')) throw new Error('Invalid Workspace desktop notification projection.')
  const completed = (value as WorkspaceDesktopNotificationProjection).completed
  if (completed !== undefined && !validCompleted(completed)) throw new Error('Invalid completed Workspace turn projection.')
  return completed === undefined ? { v: 1 } : { v: 1, completed }
} }

export const workspaceDesktopNotificationProjection: ProjectionDefinition<'workspaceDesktopNotification', ProjectionState> = {
  key: 'workspaceDesktopNotification', stateVersion: 1, schema: projectionSchema as never,
  init: () => ({}),
  apply(state, event) {
    if (event.type === 'turn/start') return { started: { turn: event.data.turn, at: eventTime(event) } }
    if (event.type !== 'turn/end') return state
    const started = state.started
    const sameTurn = started !== undefined && started.turn === event.data.turn
    if (!sameTurn || event.data.reason.kind !== 'completed') return {}
    const durationMs = Math.max(0, eventTime(event) - started.at)
    return durationMs < DESKTOP_NOTIFICATION_LONG_RUN_MS ? {} : { completed: { turn: event.data.turn, eventSeq: event.seq, durationMs } }
  },
  view(state) { return state.completed === undefined ? { v: 1 } : { v: 1, completed: state.completed } },
}

/** Host-owned event projection: the Client never guesses completion from rendered text or a status edge. */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], projectionCtx => {
    projectionCtx.sessionProjections.register(workspaceDesktopNotificationProjection)
  })
}
