import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadBackground() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener; let connectListener
  const created = []; const forwarded = []; const fetches = []; const storage = { harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }
  const page = { id: 42, windowId: 7, url: 'https://docs.example.test/source', title: 'Source' }
  const reviewTab = { id: 91, windowId: 7, url: '', title: 'Markdown Review' }
  const nativeListeners = new Set()
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    return new Response(JSON.stringify({
      v: 1, type: 'markdown-review-snapshot', reviewId: 'review-1',
      resource: { resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1' },
      content: '# Review me', truncated: false, readOnly: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      id: 'test', lastError: undefined,
      getURL: path => `chrome-extension://test/${path.replace(/^\//, '')}`,
      onMessage: { addListener: listener => { runtimeListener = listener } },
      onConnect: { addListener: listener => { connectListener = listener } },
      sendMessage: async message => { if (message.type === 'markdown-review-feedback-forward/v1') { forwarded.push(message); return { ok: true } } },
      connectNative: () => ({
        onDisconnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: listener => nativeListeners.add(listener), removeListener: listener => nativeListeners.delete(listener) },
        postMessage: message => { if (message.type === 'start') queueMicrotask(() => { for (const listener of nativeListeners) listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-review' } }) }) },
        disconnect: () => {},
      }),
    },
    storage: { session: { get: async key => typeof key === 'string' ? { [key]: storage[key] } : storage, set: async value => Object.assign(storage, value) } },
    windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async query => query.active ? [page] : [page],
      get: async id => id === 42 ? page : id === 91 ? reviewTab : undefined,
      create: async options => { reviewTab.url = options.url; created.push(options); return reviewTab },
      update: async () => reviewTab,
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    sidePanel: { open: async () => {}, close: async () => {}, setOptions: async () => {} },
    scripting: { executeScript: async () => [] },
    webNavigation: { getAllFrames: async () => [] },
  }
  globalThis.defineBackground = setup => setup()
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)

  const runtimeMessage = (message, sender = {}) => new Promise(resolve => {
    const keep = runtimeListener(message, sender, resolve)
    if (keep !== true) queueMicrotask(() => resolve(undefined))
  })
  const responses = []
  const portMessageListeners = new Set(); const disconnectListeners = new Set()
  const port = {
    name: 'markdown-review/v1', sender: { url: 'chrome-extension://test/markdown-review.html?reviewId=review-1', tab: reviewTab },
    onMessage: { addListener: listener => portMessageListeners.add(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.add(listener) },
    postMessage: message => responses.push(message), disconnect: () => { for (const listener of disconnectListeners) listener() },
  }
  return {
    created, fetches, forwarded, responses,
    open: review => runtimeMessage({ type: 'open-markdown-review/v1', review }, { url: 'chrome-extension://test/sidepanel.html' }),
    connect: () => connectListener(port),
    portMessage: message => { for (const listener of portMessageListeners) listener(message) },
    cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.fetch },
  }
}

const openReview = { v: 1, reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', capability: 'opaque-capability-that-never-enters-the-url' }

test('opens a capability-free review URL, proxies a bounded snapshot, and delivers to the fixed session', async () => {
  const background = await loadBackground()
  try {
    assert.equal((await background.open(openReview)).ok, true)
    assert.equal(background.created.length, 1)
    assert.match(background.created[0].url, /markdown-review\.html\?reviewId=review-1$/)
    assert.doesNotMatch(background.created[0].url, /capability|session-1|resource-1/)
    background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'snapshot-1', reviewId: 'review-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const snapshot = background.responses.find(message => message.requestId === 'snapshot-1')
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
    assert.equal(snapshot.snapshot.harnessSessionId, 'session-1')
    assert.equal(background.fetches[0].init.headers.authorization, `Bearer ${openReview.capability}`)

    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'deliver-1', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const delivered = background.responses.find(message => message.requestId === 'deliver-1')
    assert.deepEqual({ ok: delivered.ok, deliveryId: delivered.deliveryId }, { ok: true, deliveryId: 'annotation-1' })
    assert.equal(background.forwarded[0].feedback.harnessSessionId, 'session-1')
    assert.equal(background.forwarded[0].feedback.displayPath, 'README.md')
  } finally { background.cleanup() }
})
