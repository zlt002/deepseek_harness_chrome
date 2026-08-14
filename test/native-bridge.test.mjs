import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const bridgeSource = await readFile(new URL('../public/native-bridge.js', import.meta.url), 'utf8')

function loadBridge(query) {
  const calls = { fetch: [], sockets: [], events: [], errors: [] }
  class FakeWebSocket {
    constructor(url, protocols) {
      calls.sockets.push({ url: String(url), protocols })
    }
  }
  class FakeEventSource {
    constructor(url, options) {
      calls.events.push({ url: String(url), options })
    }
  }
  const nativeFetch = (...args) => {
    calls.fetch.push(args)
    return Promise.resolve({ ok: true })
  }
  const context = {
    URL,
    URLSearchParams,
    Request,
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
    fetch: nativeFetch,
    location: {
      href: `chrome-extension://test/harness/index.html${query}`,
      search: query,
    },
    console: { error: (...args) => calls.errors.push(args) },
  }
  context.globalThis = context
  vm.runInNewContext(bridgeSource, context)
  return { calls, context }
}

test('rewrites API, WebSocket, and HMR EventSource URLs to the native loopback', async () => {
  const { calls, context } = loadBridge('?native=http%3A%2F%2F127.0.0.1%3A43123')

  await context.fetch('/api/session.list')
  new context.WebSocket('/api/events.mux', ['dsh'])
  new context.EventSource('/plugins/events', { withCredentials: false })

  assert.equal(String(calls.fetch[0][0]), 'http://127.0.0.1:43123/api/session.list')
  assert.deepEqual(calls.sockets, [{ url: 'ws://127.0.0.1:43123/api/events.mux', protocols: ['dsh'] }])
  assert.deepEqual(calls.events, [{ url: 'http://127.0.0.1:43123/plugins/events', options: { withCredentials: false } }])
  assert.deepEqual(calls.errors, [])
})

test('does not install a bridge for a non-loopback native URL', async () => {
  const { calls, context } = loadBridge('?native=https%3A%2F%2Fevil.example%2F')

  await context.fetch('/api/session.list')
  assert.equal(String(calls.fetch[0][0]), '/api/session.list')
  assert.equal(calls.sockets.length, 0)
  assert.equal(calls.events.length, 0)
  assert.equal(calls.errors.length, 1)
})
