(() => {
  const params = new URLSearchParams(location.search)
  const rawBase = params.get('native')
  if (!rawBase) {
    console.error('[deepseek-harness] missing native server URL')
    return
  }

  let base
  try {
    base = new URL(rawBase)
    if (base.protocol !== 'http:'
      || base.hostname !== '127.0.0.1'
      || base.port === ''
      || base.username !== ''
      || base.password !== ''
      || base.pathname !== '/'
      || base.search !== ''
      || base.hash !== '') {
      throw new Error('native server URL must be an http 127.0.0.1 loopback URL with a port')
    }
  } catch (error) {
    console.error('[deepseek-harness] invalid native server URL:', error)
    return
  }

  const nativeFetch = globalThis.fetch.bind(globalThis)
  const nativeWebSocket = globalThis.WebSocket
  const nativeEventSource = globalThis.EventSource

  function isApiUrl(url) {
    return url.pathname === '/api'
      || url.pathname.startsWith('/api/')
      || url.pathname === '/plugins/events'
  }

  function rewriteHttpUrl(value) {
    const url = new URL(value, location.href)
    if (!isApiUrl(url)) return undefined
    return new URL(`${url.pathname}${url.search}`, base)
  }

  globalThis.fetch = (input, init) => {
    const source = input instanceof Request ? input.url : String(input)
    const rewritten = rewriteHttpUrl(source)
    if (!rewritten) return nativeFetch(input, init)
    const request = input instanceof Request ? new Request(rewritten, input) : rewritten
    return init === undefined ? nativeFetch(request) : nativeFetch(request, init)
  }

  globalThis.WebSocket = class NativeWebSocket extends nativeWebSocket {
    constructor(url, protocols) {
      const parsed = new URL(String(url), location.href)
      if (isApiUrl(parsed)) {
        const target = new URL(`${parsed.pathname}${parsed.search}`, base)
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
        super(target, protocols)
        return
      }
      super(url, protocols)
    }
  }

  if (nativeEventSource !== undefined) {
    globalThis.EventSource = class NativeEventSource extends nativeEventSource {
      constructor(url, options) {
        const parsed = new URL(String(url), location.href)
        if (isApiUrl(parsed)) {
          const target = new URL(`${parsed.pathname}${parsed.search}`, base)
          super(target, options)
          return
        }
        super(url, options)
      }
    }
  }
})()
