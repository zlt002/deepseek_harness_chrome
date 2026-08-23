import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

const uuid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`
const authorization = (n, openedAt = Date.now() - n) => ({
  projectId: `prototype-${uuid(n)}`,
  referenceId: `ref-${uuid(n)}`,
  sessionId: `session-${n}`,
  capability: `${uuid(n)}${uuid(n)}`,
  openedAt,
})

async function loadBackground(sessionStore) {
  const sourceUrl = new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const compiled = await bundleTypescript(source, sourceUrl)
  let listener
  const fetches = []; const nativeListeners = new Set()
  const activeTab = { id: 2, windowId: 1, url: 'https://example.test/reference', title: 'Reference', status: 'complete' }
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    return new Response(JSON.stringify({ evidence: [], revisions: [], currentRevisionId: undefined }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      id: 'test', lastError: undefined,
      getURL: path => `chrome-extension://test/${path.replace(/^\//, '')}`,
      onMessage: { addListener: value => { listener = value } },
      onConnect: { addListener: () => {} },
      sendMessage: async () => ({ ok: true }),
      connectNative: () => ({
        onDisconnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: value => nativeListeners.add(value), removeListener: value => nativeListeners.delete(value) },
        postMessage: message => { if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach(value => value({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-prototype' } }))) },
        disconnect: () => {},
      }),
    },
    storage: {
      session: {
        get: async key => typeof key === 'string' ? { [key]: sessionStore[key] } : sessionStore,
        set: async value => Object.assign(sessionStore, value),
      },
      local: { get: async () => ({}), set: async () => {} },
    },
    windows: { getLastFocused: async () => ({ id: 1 }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async () => [activeTab], get: async () => activeTab, update: async () => activeTab, create: async () => activeTab,
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    sidePanel: { open: async () => {}, close: async () => {}, setOptions: async () => {} },
    scripting: { executeScript: async () => [] }, webNavigation: { getAllFrames: async () => [] },
  }
  globalThis.defineBackground = setup => setup()
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#prototype-auth-${Date.now()}-${Math.random()}`)
  const snapshot = projectId => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-snapshot/v1', projectId }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  return { fetches, snapshot, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.fetch } }
}

test('restores a valid Prototype Studio authorization from session storage after a Service Worker restart', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore)
  try {
    const response = await background.snapshot(item.projectId)
    assert.equal(response.ok, true, JSON.stringify(response))
    const request = background.fetches.find(item => new URL(item.url).pathname.endsWith('/api/prototype-studio/snapshot'))
    assert.notEqual(request, undefined)
    assert.equal(request.init.headers.authorization, `Bearer ${item.capability}`)
  } finally { background.cleanup() }
})

test('does not restore malformed, expired, or surplus Prototype Studio authorizations', async () => {
  const legal = Array.from({ length: 9 }, (_, index) => authorization(index + 1, Date.now() - index - 1))
  const expired = authorization(10, Date.now() - 13 * 60 * 60_000)
  const sessionStore = {
    harnessPrototypeStudioAuthorizationsV1: {
      v: 1,
      authorizations: {
        ...Object.fromEntries(legal.map(item => [item.projectId, item])),
        [expired.projectId]: expired,
        injected: { projectId: legal[0].projectId, referenceId: legal[0].referenceId, sessionId: legal[0].sessionId, capability: 'not-a-capability', openedAt: Date.now() },
      },
    },
  }
  const background = await loadBackground(sessionStore)
  try {
    const response = await background.snapshot(legal[8].projectId)
    assert.equal(response.ok, false)
    assert.match(response.error, /authorization expired/)
    assert.equal(background.fetches.length, 0)
    const persisted = sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations
    assert.equal(Object.keys(persisted).length, 8)
    assert.equal(persisted[legal[8].projectId], undefined)
    assert.equal(persisted[expired.projectId], undefined)
    assert.equal(persisted.injected, undefined)
  } finally { background.cleanup() }
})
