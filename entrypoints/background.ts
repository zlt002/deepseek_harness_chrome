const NATIVE_HOST_NAME = 'com.deepseek.harness.chrome'
const START_TIMEOUT_MS = 30_000

interface NativeMessage {
  type?: unknown
  payload?: unknown
  error?: unknown
  requestId?: unknown
  runId?: unknown
  generation?: unknown
  browserTarget?: unknown
  tool?: unknown
}

interface NativeStartPayload {
  url?: unknown
  runId?: unknown
}

let nativePort: chrome.runtime.Port | undefined
let nativeUrl: string | undefined
let startPromise: Promise<string> | undefined
const boundBrowserTargets = new Map<string, BrowserTarget>()

function asError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

interface BrowserTarget {
  browser: 'chrome'
  windowId: number
  tabId: number
  url: string
}

interface ConnectorRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  browserTarget: BrowserTarget
  tool: 'office_get_context'
}

function isConnectorRequest(message: NativeMessage): message is ConnectorRequest {
  const target = message.browserTarget
  return message.type === 'connector_request'
    && typeof message.requestId === 'string'
    && typeof message.runId === 'string'
    && typeof message.generation === 'string'
    && message.tool === 'office_get_context'
    && typeof target === 'object' && target !== null
    && (target as BrowserTarget).browser === 'chrome'
    && Number.isInteger((target as BrowserTarget).windowId) && (target as BrowserTarget).windowId >= 0
    && Number.isInteger((target as BrowserTarget).tabId) && (target as BrowserTarget).tabId >= 0
    && typeof (target as BrowserTarget).url === 'string'
}

function sameBrowserTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.browser === right.browser
    && left.windowId === right.windowId
    && left.tabId === right.tabId
    && left.url === right.url
}

function targetFromActionTab(tab: chrome.tabs.Tab): BrowserTarget | undefined {
  if (tab.id === undefined || tab.windowId === undefined || typeof tab.url !== 'string' || tab.url.length === 0) return undefined
  return { browser: 'chrome', windowId: tab.windowId, tabId: tab.id, url: tab.url }
}

async function readOfficeContext(request: ConnectorRequest): Promise<Record<string, unknown>> {
  const target = boundBrowserTargets.get(request.runId)
  if (target === undefined) throw new Error('No Browser Target is bound to this Run by the Extension.')
  if (!sameBrowserTarget(request.browserTarget, target)) {
    throw new Error('Connector Browser Target does not match the Extension binding.')
  }
  const tab = await chrome.tabs.get(target.tabId)
  if (tab.windowId !== target.windowId || tab.url !== target.url) {
    throw new Error('Browser Target changed before Office context could be read.')
  }
  // Office DOM/range adapters deliberately begin in Issue #3. This tracer
  // bullet proves the trusted target identity path without exposing cookies.
  return {
    status: 'browser_target_verified',
    pageIdentity: { title: tab.title ?? '', url: target.url },
    documentIdentity: null,
  }
}

function respondToConnector(port: chrome.runtime.Port, request: ConnectorRequest): void {
  void readOfficeContext(request)
    .then((result) => {
      port.postMessage({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result,
      })
    })
    .catch((error: unknown) => {
      port.postMessage({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        error: asError(error),
      })
    })
}

function disconnectNativePort(port: chrome.runtime.Port): void {
  if (nativePort !== port) return
  const runtimeError = chrome.runtime.lastError
  const error = runtimeError?.message ?? 'Native server disconnected.'
  console.error('[deepseek-harness] Native Messaging disconnected:', error)
  nativeUrl = undefined
  nativePort = undefined
  boundBrowserTargets.clear()
  void chrome.runtime.sendMessage({
    type: 'harness-disconnected',
    error,
  }).catch(() => {})
}

function connectNativePort(): chrome.runtime.Port {
  if (nativePort !== undefined) return nativePort
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  port.onDisconnect.addListener(() => disconnectNativePort(port))
  port.onMessage.addListener((message: NativeMessage) => {
    if (isConnectorRequest(message)) {
      respondToConnector(port, message)
      return
    }
    if (message.type !== 'server_started') return
    const payload = message.payload as NativeStartPayload | undefined
    if (typeof payload?.url !== 'string') return
    nativeUrl = payload.url
    void chrome.runtime.sendMessage({ type: 'harness-ready', url: nativeUrl }).catch(() => {})
  })
  nativePort = port
  return port
}

function startHarness(browserTarget?: BrowserTarget): Promise<string> {
  if (nativeUrl !== undefined && browserTarget === undefined) return Promise.resolve(nativeUrl)
  if (startPromise !== undefined) return startPromise
  if (browserTarget === undefined) return Promise.reject(new Error('Open the Harness Workspace from a Chrome tab to bind its Browser Target.'))
  startPromise = new Promise<string>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const port = connectNativePort()
    const cleanup = (): void => {
      port.onDisconnect.removeListener(onDisconnect)
      port.onMessage.removeListener(onMessage)
      if (timeout !== undefined) clearTimeout(timeout)
    }
    const onDisconnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      const runtimeError = chrome.runtime.lastError
      reject(new Error(runtimeError?.message ?? 'Native Messaging disconnected before native-server was ready.'))
    }
    const onMessage = (message: NativeMessage): void => {
      if (message.type === 'server_started') {
        const payload = message.payload as NativeStartPayload | undefined
        if (typeof payload?.url === 'string') {
          if (typeof payload.runId !== 'string' || payload.runId.length === 0) {
            settled = true
            cleanup()
            reject(new Error('Native server did not confirm a trusted Harness Run.'))
            return
          }
          nativeUrl = payload.url
          boundBrowserTargets.set(payload.runId, browserTarget)
          settled = true
          cleanup()
          resolve(payload.url)
        }
        return
      }
      if (message.type === 'error') {
        settled = true
        cleanup()
        reject(new Error(typeof message.error === 'string' ? message.error : 'Native server failed to start.'))
      }
    }
    port.onDisconnect.addListener(onDisconnect)
    port.onMessage.addListener(onMessage)
    try {
      port.postMessage({ type: 'start', browserTarget })
    } catch (error) {
      settled = true
      cleanup()
      reject(new Error(asError(error)))
    }
    timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      port.onMessage.removeListener(onMessage)
      reject(new Error('Timed out waiting for native-server.'))
    }, START_TIMEOUT_MS)
  }).finally(() => {
    startPromise = undefined
  })
  return startPromise
}

export default defineBackground(() => {
  const sidePanel = chrome.sidePanel
  if (sidePanel?.setPanelBehavior !== undefined) {
    void sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
      console.error('[deepseek-harness] Failed to configure side panel action:', error)
    })
  }

  chrome.action?.onClicked.addListener((tab) => {
    const browserTarget = targetFromActionTab(tab)
    if (browserTarget === undefined) {
      console.error('[deepseek-harness] Action click had no explicit Browser Target.')
      return
    }
    if (sidePanel?.open === undefined) return
    void startHarness(browserTarget).catch((error: unknown) => {
      console.error('[deepseek-harness] Failed to bind Browser Target and start Harness:', error)
    })
    void sidePanel.open({ windowId: browserTarget.windowId }).catch((error: unknown) => {
      console.error('[deepseek-harness] Failed to open side panel:', error)
    })
  })

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'ensure-harness') {
      return false
    }
    void startHarness()
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
    return true
  })
})
