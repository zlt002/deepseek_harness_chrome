/**
 * Opt the loopback Harness page into the Browser Target bridge. The nonce is
 * per iframe instance and is checked by both ends before any command is used.
 */
export interface HarnessFrameBridge {
  nonce: string
  parentOrigin: string
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
  return source.toString()
}
