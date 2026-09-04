import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { activeWorkspaceNotificationSnapshot, collectWorkspaceNotificationEventsFromSessionList } from './protocol.ts'

export const inject = ['sessions']

/** The loopback Client forwards only opaque lifecycle identities through the already nonce-bound extension iframe bridge. */
export function apply(ctx: ClientContext): void {
  const query = new URLSearchParams(window.location.search)
  const nonce = query.get('dshBrowserTargetNonce')
  const parentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (query.get('dshBrowserTargetBridge') !== '1' || nonce === null || parentOrigin === null) return
  try {
    const origin = new URL(parentOrigin)
    if (origin.protocol !== 'chrome-extension:' || origin.host === '' || `${origin.protocol}//${origin.host}` !== parentOrigin) return
  } catch { return }
  const historicalCompleted = new Set<string>()
  let initialized = false
  const publish = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const events = collectWorkspaceNotificationEventsFromSessionList(snapshot, sessionId => ctx.sessions.binding(sessionId as SessionId)?.session.getSnapshot().pending)
    const active = activeWorkspaceNotificationSnapshot(events, historicalCompleted, !initialized)
    initialized = true
    window.parent.postMessage({
      type: 'workspace-desktop-notification-snapshot/v1',
      nonce,
      events: active,
    }, parentOrigin)
  }
  ctx.effect(() => {
    const sessionSubscriptions = new Map<string, () => void>()
    const sync = (): void => {
      const ids = ctx.sessions.list.getSnapshot().ids.map(String)
      const expected = new Set(ids)
      for (const id of ids) {
        if (sessionSubscriptions.has(id)) continue
        const session = ctx.sessions.binding(id as SessionId)?.session
        if (session !== undefined) sessionSubscriptions.set(id, session.subscribe(publish))
      }
      for (const [id, unsubscribe] of sessionSubscriptions) {
        if (expected.has(id)) continue
        unsubscribe()
        sessionSubscriptions.delete(id)
      }
      publish()
    }
    const unsubscribeList = ctx.sessions.list.subscribe(sync)
    sync()
    return () => {
      unsubscribeList()
      for (const unsubscribe of sessionSubscriptions.values()) unsubscribe()
    }
  }, 'accrui-desktop-notifications: lifecycle bridge')
}
