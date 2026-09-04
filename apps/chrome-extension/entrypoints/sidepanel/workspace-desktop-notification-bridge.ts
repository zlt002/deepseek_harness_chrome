import type { WorkspaceDesktopNotification } from '../background/workspace-desktop-notifications'
import { validWorkspaceDesktopNotification } from '../background/workspace-desktop-notifications'

export interface FrameWorkspaceNotification extends Omit<WorkspaceDesktopNotification, 'foreground' | 'surface' | 'windowId' | 'tabId'> {}

const MAX_ACTIVE_NOTIFICATIONS = 256

function eventKey(event: FrameWorkspaceNotification): string {
  return `${event.sessionId}\u0000${event.kind}\u0000${event.eventId}`
}

function validFrameWorkspaceNotification(value: unknown): value is FrameWorkspaceNotification {
  return validWorkspaceDesktopNotification({ ...(value as object), foreground: false, surface: 'sidepanel', windowId: 0 })
}

/** Accepts a complete active-event snapshot so resolved foreground requests can be discarded before blur. */
export function acceptWorkspaceDesktopNotificationSnapshot(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frame: WindowProxy | null | undefined,
  frameOrigin: string | undefined,
  nonce: string,
): FrameWorkspaceNotification[] | undefined {
  if (event.source !== frame || event.origin !== frameOrigin || event.data === null || typeof event.data !== 'object') return undefined
  const value = event.data as Record<string, unknown>
  if (value.type !== 'workspace-desktop-notification-snapshot/v1' || value.nonce !== nonce || !Array.isArray(value.events) || value.events.length > MAX_ACTIVE_NOTIFICATIONS) return undefined
  if (!value.events.every(validFrameWorkspaceNotification)) return undefined
  return value.events.map(item => ({ sessionId: item.sessionId, eventId: item.eventId, kind: item.kind }))
}

/** Keeps foreground events pending; only a successful background acknowledgement consumes them. */
export class WorkspaceDesktopNotificationDelivery {
  #active = new Map<string, FrameWorkspaceNotification>()
  #delivered = new Set<string>()
  #inFlight = new Set<string>()

  constructor(private readonly deliver: (event: FrameWorkspaceNotification) => boolean | Promise<boolean>) {}

  async reconcile(events: readonly FrameWorkspaceNotification[], foreground: boolean): Promise<void> {
    this.#active = new Map(events.map(event => [eventKey(event), event]))
    await this.flush(foreground)
  }

  async flush(foreground: boolean): Promise<void> {
    if (foreground) return
    await Promise.all([...this.#active].map(async ([key, event]) => {
      if (this.#delivered.has(key) || this.#inFlight.has(key)) return
      this.#inFlight.add(key)
      try {
        if (await this.deliver(event)) this.#delivered.add(key)
      } finally {
        this.#inFlight.delete(key)
      }
    }))
  }
}

interface NotificationVisibilityTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** Retries pending delivery when the user leaves the Harness Workspace, without waiting for session activity. */
export function listenForWorkspaceNotificationVisibility(
  delivery: WorkspaceDesktopNotificationDelivery,
  windowLike: NotificationVisibilityTarget = window,
  documentLike: NotificationVisibilityTarget & Pick<Document, 'visibilityState' | 'hasFocus'> = document,
): () => void {
  const onBlur = (): void => { void delivery.flush(false).catch(() => {}) }
  const onVisibilityChange = (): void => { void delivery.flush(workspaceIsForeground(documentLike)).catch(() => {}) }
  windowLike.addEventListener('blur', onBlur)
  documentLike.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    windowLike.removeEventListener('blur', onBlur)
    documentLike.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

/** A focused full-screen Tab and a focused side panel both already show the relevant conversation. */
export function workspaceIsForeground(documentLike: Pick<Document, 'visibilityState' | 'hasFocus'> = document): boolean {
  return documentLike.visibilityState === 'visible' && documentLike.hasFocus()
}
