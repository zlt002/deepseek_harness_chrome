export type WorkspaceNotificationKind = 'completed' | 'approval' | 'question' | 'plan-review'

export interface WorkspaceDesktopNotification {
  sessionId: string
  eventId: string
  kind: WorkspaceNotificationKind
  foreground: boolean
  surface: 'sidepanel' | 'fullscreen-tab'
  windowId: number
  tabId?: number
}

export interface WorkspaceNotificationChrome {
  notifications?: { create(id: string, options: { type: 'basic'; iconUrl: string; title: string; message: string }): Promise<string> }
  tabs?: { get(tabId: number): Promise<{ id?: number; windowId?: number; url?: string }>; update(tabId: number, update: { active: boolean }): Promise<unknown> }
  windows?: { update(windowId: number, update: { focused: boolean }): Promise<unknown> }
  sidePanel?: { setOptions(options: { path: string }): Promise<void>; open(options: { windowId: number }): Promise<void> }
}

const VALID_ID = /^[A-Za-z0-9._:-]{1,240}$/
const STORAGE_KEY = 'harnessWorkspaceDesktopNotificationsV1'
const MAX_RECORDS = 256

type StoredState = { seen?: string[]; routes?: Record<string, Omit<WorkspaceDesktopNotification, 'foreground'>> }

export function validWorkspaceDesktopNotification(value: unknown): value is WorkspaceDesktopNotification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.sessionId === 'string' && VALID_ID.test(item.sessionId)
    && typeof item.eventId === 'string' && VALID_ID.test(item.eventId)
    && (item.kind === 'completed' || item.kind === 'approval' || item.kind === 'question' || item.kind === 'plan-review')
    && typeof item.foreground === 'boolean'
    && (item.surface === 'sidepanel' || item.surface === 'fullscreen-tab')
    && Number.isInteger(item.windowId) && (item.windowId as number) >= 0
    && (item.tabId === undefined || (Number.isInteger(item.tabId) && (item.tabId as number) >= 0))
}

export function notificationMessage(kind: WorkspaceNotificationKind): string {
  if (kind === 'completed') return '任务已完成'
  if (kind === 'approval') return '需要你确认操作'
  return '需要你补充信息'
}

export function workspaceNotificationId(event: Pick<WorkspaceDesktopNotification, 'sessionId' | 'eventId' | 'kind'>): string {
  return `workspace:${encodeURIComponent(event.sessionId)}:${event.kind}:${encodeURIComponent(event.eventId)}`
}

export function notificationSidePanelPath(sessionId: string): string {
  const query = new URLSearchParams({ dshHarnessSessionId: sessionId, dshHarnessNotificationRestore: '1' })
  return `sidepanel.html?${query.toString()}`
}

/** One small extension boundary: dedupe, quiet foregrounds, and route notification clicks back to a session. */
export class WorkspaceDesktopNotifications {
  #seen = new Set<string>()
  #routes = new Map<string, Omit<WorkspaceDesktopNotification, 'foreground'>>()
  #loaded: Promise<void> | undefined

  constructor(
    private readonly chromeApi: WorkspaceNotificationChrome,
    private readonly storage?: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> },
  ) {}

  async notify(event: WorkspaceDesktopNotification): Promise<boolean> {
    if (!validWorkspaceDesktopNotification(event) || event.foreground || this.chromeApi.notifications === undefined) return false
    await this.load()
    const id = workspaceNotificationId(event)
    if (this.#seen.has(id)) return false
    try {
      await this.chromeApi.notifications.create(id, {
        type: 'basic', iconUrl: 'favicon.svg', title: 'Harness Workspace', message: notificationMessage(event.kind),
      })
    } catch {
      return false // User/system notification settings are allowed to reject this silently.
    }
    this.#seen.add(id)
    this.#routes.set(id, { sessionId: event.sessionId, eventId: event.eventId, kind: event.kind, surface: event.surface, windowId: event.windowId, ...(event.tabId === undefined ? {} : { tabId: event.tabId }) })
    await this.persist()
    return true
  }

  async click(id: string): Promise<boolean> {
    await this.load()
    const route = this.#routes.get(id)
    if (route === undefined) return false
    if (route.surface === 'fullscreen-tab' && route.tabId !== undefined && await this.#activateFullscreen(route)) return true
    try {
      if (this.chromeApi.sidePanel === undefined) return false
      await this.chromeApi.sidePanel.setOptions({ path: notificationSidePanelPath(route.sessionId) })
      await this.chromeApi.sidePanel.open({ windowId: route.windowId })
      return true
    } catch {
      return false
    }
  }

  async #activateFullscreen(route: Omit<WorkspaceDesktopNotification, 'foreground'>): Promise<boolean> {
    try {
      const tabs = this.chromeApi.tabs
      if (tabs === undefined) return false
      const tab = await tabs.get(route.tabId!)
      if (tab.id !== route.tabId || tab.windowId !== route.windowId || tab.url === undefined) return false
      const url = new URL(tab.url)
      if (url.searchParams.get('dshHarnessSurface') !== 'fullscreen-tab' || url.searchParams.get('dshHarnessSessionId') !== route.sessionId) return false
      await this.chromeApi.windows?.update(route.windowId, { focused: true })
      await this.chromeApi.tabs?.update(route.tabId!, { active: true })
      return true
    } catch {
      return false
    }
  }

  async load(): Promise<void> {
    this.#loaded ??= (async () => {
      if (this.storage === undefined) return
      try {
        const raw = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY] as StoredState | undefined
        for (const id of raw?.seen ?? []) if (typeof id === 'string' && id.length <= 600) this.#seen.add(id)
        for (const [id, route] of Object.entries(raw?.routes ?? {})) {
          if (validWorkspaceDesktopNotification({ ...route, foreground: false })) this.#routes.set(id, route)
        }
      } catch { /* persistence loss may duplicate only after the browser discards session storage */ }
    })()
    await this.#loaded
  }

  async persist(): Promise<void> {
    if (this.storage === undefined) return
    const seen = [...this.#seen].slice(-MAX_RECORDS)
    const retained = new Set(seen)
    const routes = Object.fromEntries([...this.#routes].filter(([id]) => retained.has(id)).slice(-MAX_RECORDS))
    try { await this.storage.set({ [STORAGE_KEY]: { seen, routes } satisfies StoredState }) } catch { /* silent, as above */ }
  }
}
