export default defineContentScript({
  matches: ['https://webedit.midea.com/*'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const requestEvent = 'deepseek-harness-office-read-request/v1'
    const responseEvent = 'deepseek-harness-office-read-response/v1'
    let runtimeReady: Promise<void> | undefined
    let documentRuntimeReady: Promise<void> | undefined

    function loadRuntime(): Promise<void> {
      if (runtimeReady !== undefined) return runtimeReady
      runtimeReady = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = chrome.runtime.getURL('/office-read-runtime.js')
        script.onload = () => { script.remove(); resolve() }
        script.onerror = () => { script.remove(); reject(new Error('unsupported: WebEdit runtime adapter could not load')) }
        ;(document.head ?? document.documentElement).append(script)
      })
      return runtimeReady
    }

    function invokeRuntime(request: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const timeout = setTimeout(() => {
          window.removeEventListener(responseEvent, receive)
          reject({ code: 'timeout', message: 'Timed out waiting for the WebEdit iframe runtime.' })
        }, 8_000)
        const receive = (event: Event): void => {
          const detail = (event as CustomEvent<unknown>).detail
          if (!detail || typeof detail !== 'object' || (detail as { id?: unknown }).id !== id) return
          clearTimeout(timeout)
          window.removeEventListener(responseEvent, receive)
          const payload = detail as { ok?: unknown; result?: unknown; error?: unknown }
          if (payload.ok === true) resolve(payload.result)
          else reject(payload.error ?? { code: 'runtime_error', message: 'WebEdit range read failed' })
        }
        window.addEventListener(responseEvent, receive)
        window.dispatchEvent(new CustomEvent(requestEvent, { detail: { id, ...request } }))
      })
    }

    function loadDocumentRuntime(): Promise<void> {
      if (documentRuntimeReady !== undefined) return documentRuntimeReady
      documentRuntimeReady = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = chrome.runtime.getURL('/office-light-document-runtime.js')
        script.onload = () => { script.remove(); resolve() }
        script.onerror = () => { script.remove(); reject(new Error('unsupported: light-document runtime adapter could not load')) }
        ;(document.head ?? document.documentElement).append(script)
      })
      return documentRuntimeReady
    }

    function invokeDocumentRuntime(request: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        const requestEvent = 'deepseek-harness-office-document-request/v1'
        const responseEvent = 'deepseek-harness-office-document-response/v1'
        const timeout = setTimeout(() => {
          window.removeEventListener(responseEvent, receive)
          reject({ code: 'timeout', message: 'Timed out waiting for the WebEdit light-document runtime.' })
        }, 8_000)
        const receive = (event: Event): void => {
          const detail = (event as CustomEvent<unknown>).detail
          if (!detail || typeof detail !== 'object' || (detail as { id?: unknown }).id !== id) return
          clearTimeout(timeout)
          window.removeEventListener(responseEvent, receive)
          const payload = detail as { ok?: unknown; result?: unknown; error?: unknown }
          if (payload.ok === true) resolve(payload.result)
          else reject(payload.error ?? { code: 'runtime_error', message: 'WebEdit light-document operation failed' })
        }
        window.addEventListener(responseEvent, receive)
        window.dispatchEvent(new CustomEvent(requestEvent, { detail: { id, ...request } }))
      })
    }

    void loadRuntime()
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false
      if ((message as { type?: unknown }).type === 'office-document/v1') {
        const input = message as { action?: unknown; offset?: unknown; limit?: unknown; query?: unknown; operation?: unknown; payload?: unknown; resource?: unknown }
        if (!['read', 'search', 'selection', 'inspect_write', 'write'].includes(String(input.action))) {
          sendResponse({ ok: false, error: { code: 'invalid_range', message: 'a valid light-document action is required' } }); return false
        }
        void loadDocumentRuntime().then(() => invokeDocumentRuntime({
          action: input.action, ...(input.offset === undefined ? {} : { offset: input.offset }), ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.query === undefined ? {} : { query: input.query }), ...(input.operation === undefined ? {} : { operation: input.operation }),
          ...(input.payload === undefined ? {} : { payload: input.payload }), ...(input.resource === undefined ? {} : { resource: input.resource }),
        })).then((result) => sendResponse({ ok: true, result })).catch((error: unknown) => {
          const typed = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? error : { code: 'runtime_error', message: error instanceof Error ? error.message : 'WebEdit light-document operation failed' }
          sendResponse({ ok: false, error: typed })
        })
        return true
      }
      if (!['office-read-range/v1', 'office-write-range/v1'].includes(String((message as { type?: unknown }).type))) return false
      const input = message as { type: string; range?: unknown; values?: unknown; resource?: unknown }
      const range = input.range
      if (typeof range !== 'string') { sendResponse({ ok: false, error: { code: 'invalid_range', message: 'range is required' } }); return false }
      const action = input.type === 'office-write-range/v1' ? 'write' : 'read'
      if (action === 'write' && (!Array.isArray(input.values) || !input.resource || typeof input.resource !== 'object')) { sendResponse({ ok: false, error: { code: 'invalid_range', message: 'values and resource are required for a write' } }); return false }
      void loadRuntime().then(() => invokeRuntime({ action, range, ...(action === 'write' ? { values: input.values, resource: input.resource } : {}) })).then((result) => sendResponse({ ok: true, result })).catch((error: unknown) => {
        const typed = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
          ? error : { code: 'runtime_error', message: error instanceof Error ? error.message : 'WebEdit range read failed' }
        sendResponse({ ok: false, error: typed })
      })
      return true
    })
  },
})
