const modes = new Set(['follow-active-tab', 'pinned-tabs', 'none'])

function target(value) {
  return value !== null && typeof value === 'object'
    && value.browser === 'chrome'
    && Number.isInteger(value.windowId)
    && Number.isInteger(value.tabId)
    && typeof value.url === 'string'
}

function tab(value) {
  return target(value) && typeof value.title === 'string'
    && (value.favIconUrl === undefined || typeof value.favIconUrl === 'string')
}

function snapshotMessage(value) {
  return value !== null && typeof value === 'object'
    && value.type === 'browser-target-snapshot/v1'
    && typeof value.nonce === 'string'
    && Number.isInteger(value.sequence)
    && value.settings !== null && typeof value.settings === 'object'
    && modes.has(value.settings.mode)
    && Array.isArray(value.settings.pinnedTabs) && value.settings.pinnedTabs.every(target)
    && (value.settings.primaryTabId === undefined || Number.isInteger(value.settings.primaryTabId))
    && Array.isArray(value.tabs) && value.tabs.every(tab)
    && (value.activeTab === undefined || tab(value.activeTab))
    && (value.error === undefined || typeof value.error === 'string')
}

export function createBrowserTargetProtocol({ createStore, nonce, parentOrigin }) {
  const source = createStore(undefined)
  let incoming = 0
  let outgoing = 0
  return {
    source,
    accept(event, parent) {
      if (event.source !== parent || event.origin !== parentOrigin || !snapshotMessage(event.data)) return false
      if (event.data.nonce !== nonce || event.data.sequence <= incoming) return false
      incoming = event.data.sequence
      source.set({
        settings: event.data.settings,
        tabs: event.data.tabs,
        ...(event.data.activeTab === undefined ? {} : { activeTab: event.data.activeTab }),
        ...(event.data.error === undefined ? {} : { error: event.data.error }),
      })
      return true
    },
    send(command, parent) {
      outgoing += 1
      parent.postMessage({ type: 'browser-target-command/v1', nonce, sequence: outgoing, command }, parentOrigin)
    },
  }
}

export function browserTargetBridgeConfig(location = window.location) {
  const query = new URLSearchParams(location.search)
  if (query.get('dshBrowserTargetBridge') !== '1') return undefined
  const nonce = query.get('dshBrowserTargetNonce')
  const parentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (nonce === null || parentOrigin === null) return undefined
  try {
    const parsed = new URL(parentOrigin)
    return parsed.protocol === 'chrome-extension:' && parsed.host !== '' && `${parsed.protocol}//${parsed.host}` === parentOrigin
      ? { nonce, parentOrigin, surface: query.get('dshBrowserTargetSurface') === 'fullscreen-tab' ? 'fullscreen-tab' : 'sidepanel', ...(query.get('dshHarnessSessionId') ? { sessionId: query.get('dshHarnessSessionId') } : {}) }
      : undefined
  } catch {
    return undefined
  }
}

/** Post the minimal reconnect request to the already verified extension parent. */
export function requestHarnessReconnect(parent, nonce, parentOrigin) {
  parent.postMessage({ type: 'harness-reconnect/v1', nonce }, parentOrigin)
}

/** Post the open-fullscreen request to the already verified extension parent. */
export function requestOpenFullscreenTab(parent, nonce, parentOrigin, sessionId) {
  parent.postMessage({ type: 'open-fullscreen-tab/v1', nonce, ...(sessionId === undefined ? {} : { sessionId }) }, parentOrigin)
}

/** Post the return-to-sidepanel request to the already verified extension parent. */
export function requestReturnToSidepanel(parent, nonce, parentOrigin) {
  parent.postMessage({ type: 'return-to-sidepanel/v1', nonce }, parentOrigin)
}
