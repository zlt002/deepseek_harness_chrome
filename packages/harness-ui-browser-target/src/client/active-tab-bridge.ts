import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser Target selection modes owned by the Chrome extension. */
export type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'
export type HarnessSurface = 'sidepanel' | 'fullscreen-tab'

/** A target identifier safe to persist in the Chrome extension. */
export interface BrowserTarget {
  browser: 'chrome'
  windowId: number
  tabId: number
  url: string
}

/** Read-only Chrome tab metadata shown in the Harness target picker. */
export interface BrowserTargetTab extends BrowserTarget {
  title: string
  favIconUrl?: string
}

/** The extension-owned Browser Target policy. */
export interface BrowserTargetSettings {
  mode: BrowserTargetMode
  pinnedTabs: BrowserTarget[]
  primaryTabId?: number
}

/** State projected from the trusted extension into its loopback Harness iframe. */
export interface BrowserTargetSnapshot {
  settings: BrowserTargetSettings
  tabs: BrowserTargetTab[]
  activeTab?: BrowserTargetTab
  error?: string
}

/** The only settings actions accepted by the extension shell. */
export type BrowserTargetCommand =
  | { command: 'refresh' }
  | { command: 'set-mode'; mode: BrowserTargetMode }
  | { command: 'toggle-pinned-tab'; tabId: number; checked: boolean }
  | { command: 'set-primary'; tabId: number }
  | { command: 'capture-design-reference'; tabId: number; sessionId?: string }

interface BrowserTargetSnapshotMessage extends BrowserTargetSnapshot {
  type: 'browser-target-snapshot/v1'
  nonce: string
  sequence: number
}

function isBrowserTarget(value: unknown): value is BrowserTarget {
  return typeof value === 'object' && value !== null
    && (value as BrowserTarget).browser === 'chrome'
    && Number.isInteger((value as BrowserTarget).windowId)
    && Number.isInteger((value as BrowserTarget).tabId)
    && typeof (value as BrowserTarget).url === 'string'
}

function isBrowserTargetTab(value: unknown): value is BrowserTargetTab {
  return isBrowserTarget(value)
    && typeof (value as BrowserTargetTab).title === 'string'
    && (typeof (value as BrowserTargetTab).favIconUrl === 'string' || (value as BrowserTargetTab).favIconUrl === undefined)
}

function isBrowserTargetMode(value: unknown): value is BrowserTargetMode {
  return value === 'follow-active-tab' || value === 'pinned-tabs' || value === 'none'
}

function isBrowserTargetSettings(value: unknown): value is BrowserTargetSettings {
  return typeof value === 'object' && value !== null
    && isBrowserTargetMode((value as BrowserTargetSettings).mode)
    && Array.isArray((value as BrowserTargetSettings).pinnedTabs)
    && (value as BrowserTargetSettings).pinnedTabs.every(isBrowserTarget)
    && ((value as BrowserTargetSettings).primaryTabId === undefined || Number.isInteger((value as BrowserTargetSettings).primaryTabId))
}

function isBrowserTargetSnapshotMessage(value: unknown): value is BrowserTargetSnapshotMessage {
  return typeof value === 'object' && value !== null
    && (value as BrowserTargetSnapshotMessage).type === 'browser-target-snapshot/v1'
    && typeof (value as BrowserTargetSnapshotMessage).nonce === 'string'
    && Number.isInteger((value as BrowserTargetSnapshotMessage).sequence)
    && isBrowserTargetSettings((value as BrowserTargetSnapshotMessage).settings)
    && Array.isArray((value as BrowserTargetSnapshotMessage).tabs)
    && (value as BrowserTargetSnapshotMessage).tabs.every(isBrowserTargetTab)
    && ((value as BrowserTargetSnapshotMessage).activeTab === undefined || isBrowserTargetTab((value as BrowserTargetSnapshotMessage).activeTab))
    && ((value as BrowserTargetSnapshotMessage).error === undefined || typeof (value as BrowserTargetSnapshotMessage).error === 'string')
}

/** Create the nonce- and origin-bound Browser Target bridge. */
export function createBrowserTargetBridge(nonce: string, parentOrigin: string): {
  source: SnapshotStore<BrowserTargetSnapshot | undefined>
  accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean
  send(command: BrowserTargetCommand, parent: WindowProxy): void
  reconnectHarness(parent: WindowProxy): void
  openFullscreenTab(parent: WindowProxy): void
  returnToSidePanel(parent: WindowProxy): void
} {
  const source = createSnapshotStore<BrowserTargetSnapshot | undefined>(undefined)
  let incomingSequence = 0
  let outgoingSequence = 0
  return {
    source,
    accept(event, parent): boolean {
      if (event.source !== parent || event.origin !== parentOrigin) return false
      if (!isBrowserTargetSnapshotMessage(event.data) || event.data.nonce !== nonce || event.data.sequence <= incomingSequence) return false
      incomingSequence = event.data.sequence
      source.set({ settings: event.data.settings, tabs: event.data.tabs, ...(event.data.activeTab === undefined ? {} : { activeTab: event.data.activeTab }), ...(event.data.error === undefined ? {} : { error: event.data.error }) })
      return true
    },
    send(command, parent): void {
      outgoingSequence += 1
      parent.postMessage({ type: 'browser-target-command/v1', nonce, sequence: outgoingSequence, command }, parentOrigin)
    },
    reconnectHarness(parent): void {
      parent.postMessage({ type: 'harness-reconnect/v1', nonce }, parentOrigin)
    },
    openFullscreenTab(parent): void {
      parent.postMessage({ type: 'open-fullscreen-tab/v1', nonce }, parentOrigin)
    },
    returnToSidePanel(parent): void {
      parent.postMessage({ type: 'return-to-sidepanel/v1', nonce }, parentOrigin)
    },
  }
}

/** Read the opt-in iframe bridge configuration. */
export function activeTabBridgeConfig(location: Location = window.location): { nonce: string; parentOrigin: string; surface: HarnessSurface; sessionId?: string } | undefined {
  const query = new URLSearchParams(location.search)
  if (query.get('dshBrowserTargetBridge') !== '1') return undefined
  const nonce = query.get('dshBrowserTargetNonce')
  const rawParentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (nonce === null || rawParentOrigin === null) return undefined
  try {
    const parentOrigin = new URL(rawParentOrigin)
    const normalizedParentOrigin = `${parentOrigin.protocol}//${parentOrigin.host}`
    if (parentOrigin.protocol !== 'chrome-extension:' || parentOrigin.host === '' || normalizedParentOrigin !== rawParentOrigin) return undefined
    const surface = query.get('dshBrowserTargetSurface')
    const sessionId = query.get('dshHarnessSessionId')
    return { nonce, parentOrigin: rawParentOrigin, surface: surface === 'fullscreen-tab' ? 'fullscreen-tab' : 'sidepanel', ...(sessionId === null || sessionId.trim() === '' ? {} : { sessionId }) }
  } catch {
    return undefined
  }
}
