const NATIVE_HOST_NAME = 'com.deepseek.harness.chrome'
const START_TIMEOUT_MS = 30_000

interface NativeMessage {
  type?: unknown
  payload?: unknown
  error?: unknown
  requestId?: unknown
}

interface NativeStartPayload {
  url?: unknown
}

let nativePort: chrome.runtime.Port | undefined
let nativeUrl: string | undefined
let startPromise: Promise<string> | undefined

function asError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function disconnectNativePort(port: chrome.runtime.Port): void {
  if (nativePort !== port) return
  const runtimeError = chrome.runtime.lastError
  const error = runtimeError?.message ?? 'Native server disconnected.'
  console.error('[deepseek-harness] Native Messaging disconnected:', error)
  nativeUrl = undefined
  nativePort = undefined
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
    if (message.type !== 'server_started') return
    const payload = message.payload as NativeStartPayload | undefined
    if (typeof payload?.url !== 'string') return
    nativeUrl = payload.url
    void chrome.runtime.sendMessage({ type: 'harness-ready', url: nativeUrl }).catch(() => {})
  })
  nativePort = port
  return port
}

function startHarness(): Promise<string> {
  if (nativeUrl !== undefined) return Promise.resolve(nativeUrl)
  if (startPromise !== undefined) return startPromise
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
          nativeUrl = payload.url
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
      port.postMessage({ type: 'start' })
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
    if (tab.windowId === undefined) return
    if (sidePanel?.open === undefined) return
    void sidePanel.open({ windowId: tab.windowId }).catch((error: unknown) => {
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
