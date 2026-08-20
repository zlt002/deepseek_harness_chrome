/**
 * Opt the loopback Harness page into the Browser Target bridge. The nonce is
 * per iframe instance and is checked by both ends before any command is used.
 */
export interface HarnessFrameBridge {
  nonce: string
  parentOrigin: string
  surface: HarnessSurface
  sessionId?: string
}

/** The two extension-owned containers for one Harness Workspace. */
export type HarnessSurface = 'sidepanel' | 'fullscreen-tab'

const SURFACE_QUERY_KEY = 'dshHarnessSurface'
const SESSION_QUERY_KEY = 'dshHarnessSessionId'
const HANDOFF_TAB_QUERY_KEY = 'dshHarnessHandoffTabId'

/** Treat unmarked extension pages as the normal side panel for compatibility. */
export function HarnessSurfaceFromLocation(location: Pick<Location, 'search'> = window.location): HarnessSurface {
  return new URLSearchParams(location.search).get(SURFACE_QUERY_KEY) === 'fullscreen-tab'
    ? 'fullscreen-tab'
    : 'sidepanel'
}

/** Build the extension-owned Tab URL used for the full-screen Workspace surface. */
export function FullscreenHarnessTabUrl(extensionUrl: string): string {
  const source = new URL(extensionUrl)
  source.searchParams.set(SURFACE_QUERY_KEY, 'fullscreen-tab')
  return source.toString()
}

/** Preserve the selected Harness session while the extension container changes. */
export function FullscreenHarnessTabUrlForSession(extensionUrl: string, sessionId?: string): string {
  const source = new URL(FullscreenHarnessTabUrl(extensionUrl))
  if (sessionId !== undefined && sessionId.trim() !== '') source.searchParams.set(SESSION_QUERY_KEY, sessionId)
  return source.toString()
}

/** Only an explicit handoff carries a session; ordinary side-panel boots retain the normal selection flow. */
export function HarnessHandoffSessionFromLocation(location: Pick<Location, 'search'> = window.location): string | undefined {
  const sessionId = new URLSearchParams(location.search).get(SESSION_QUERY_KEY)
  return sessionId === null || sessionId.trim() === '' ? undefined : sessionId
}

/** The source Tab is carried only by a side-panel handoff URL. */
export function HarnessHandoffTabFromLocation(location: Pick<Location, 'search'> = window.location): number | undefined {
  const raw = new URLSearchParams(location.search).get(HANDOFF_TAB_QUERY_KEY)
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const tabId = Number(raw)
  return Number.isSafeInteger(tabId) ? tabId : undefined
}

/** Read-only tab fields supplied by the extension's active-tab notification. */
export interface ActiveTabBridgeMetadata {
  windowId: number
  tabId: number
  title: string
  url: string
  favIconUrl?: string
}

/**
 * Stamp the browser identity required by the iframe's trusted snapshot schema.
 * The background event deliberately carries only Chrome's native tab metadata;
 * this is the boundary where it becomes a Browser Target payload.
 */
export function NormalizeActiveTabForBrowserTarget(tab: ActiveTabBridgeMetadata): ActiveTabBridgeMetadata & { browser: 'chrome' } {
  return { browser: 'chrome', ...tab }
}

export function HarnessFrameSource(nativeUrl: string, bridge?: HarnessFrameBridge): string {
  if (bridge === undefined) return nativeUrl
  const source = new URL(nativeUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) {
    throw new Error('Harness Browser Target bridge is limited to loopback origins.')
  }
  const parentOrigin = new URL(bridge.parentOrigin)
  const normalizedParentOrigin = `${parentOrigin.protocol}//${parentOrigin.host}`
  if (parentOrigin.protocol !== 'chrome-extension:' || parentOrigin.host === '' || normalizedParentOrigin !== bridge.parentOrigin) {
    throw new Error('Harness Browser Target bridge requires an exact Chrome extension origin.')
  }
  source.searchParams.set('dshBrowserTargetBridge', '1')
  source.searchParams.set('dshBrowserTargetNonce', bridge.nonce)
  source.searchParams.set('dshBrowserTargetParentOrigin', bridge.parentOrigin)
  source.searchParams.set('dshBrowserTargetSurface', bridge.surface)
  // Workspace review shares the already verified iframe boundary, but keeps a
  // distinct protocol namespace from Browser Target commands.
  source.searchParams.set('dshWorkspaceReviewNonce', bridge.nonce)
  source.searchParams.set('dshWorkspaceReviewParentOrigin', bridge.parentOrigin)
  if (bridge.sessionId !== undefined) source.searchParams.set(SESSION_QUERY_KEY, bridge.sessionId)
  return source.toString()
}
