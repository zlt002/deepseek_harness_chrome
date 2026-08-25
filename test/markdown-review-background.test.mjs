import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

async function loadBackground() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  let runtimeListener; let connectListener
  const created = []; const forwarded = []; const fetches = []; const storage = { harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }
  const page = { id: 42, windowId: 7, url: 'https://docs.example.test/source', title: 'Source' }
  const reviewTab = { id: 91, windowId: 7, url: '', title: 'Markdown Review' }
  const nativeListeners = new Set()
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    const pathname = new URL(String(url)).pathname
    const snapshot = {
      v: 1, type: 'markdown-review-snapshot', reviewId: 'review-1',
      resource: { resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1' },
      content: '# Review me', truncated: false, readOnly: true,
    }
    const payload = pathname.endsWith('/proposals')
      ? { v: 1, reviewId: 'review-1', proposals: [{ proposalId: 'proposal-1', selectionId: 'annotation-1', sequence: 1, baseFingerprint: 'fingerprint-1', kind: 'document', candidateMarkdown: '# Better', summary: '更明确' }] }
      : pathname.endsWith('/prepare-write')
        ? { status: 'prepared', approval: 'approval-1', contentHash: 'content-hash-1', expiresAt: Date.now() + 60_000 }
        : pathname.endsWith('/commit-write')
          ? { status: 'verified_write', resource: { resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-2', fingerprint: 'fingerprint-2' }, contentHash: 'fingerprint-2' }
          : pathname.endsWith('/selection')
            ? JSON.parse(init.body).selection
            : snapshot
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
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
    const snapshotFetch = background.fetches.find(({ url }) => new URL(url).pathname.endsWith('/snapshot'))
    assert.equal(snapshotFetch.init.headers.authorization, `Bearer ${openReview.capability}`)

    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'deliver-1', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const delivered = background.responses.find(message => message.requestId === 'deliver-1')
    assert.deepEqual({ ok: delivered.ok, deliveryId: delivered.deliveryId }, { ok: true, deliveryId: 'annotation-1' })
    assert.equal(background.forwarded[0].feedback.harnessSessionId, 'session-1')
    assert.equal(background.forwarded[0].feedback.displayPath, 'README.md')
    assert.equal(background.forwarded[0].feedback.selectionId, 'annotation-1')

    background.portMessage({ v: 1, type: 'markdown-review-proposals-request', requestId: 'proposals-1', reviewId: 'review-1', afterSequence: 0 })
    background.portMessage({
      v: 1, type: 'markdown-review-prepare-write-request', requestId: 'prepare-1', reviewId: 'review-1',
      expected: { resourceId: 'resource-1', revision: 'rev-1', fingerprint: 'fingerprint-1' }, content: '# Better',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'proposals-1').proposals[0].candidateMarkdown, '# Better')
    const preparation = background.responses.find(message => message.requestId === 'prepare-1').preparation
    assert.equal(preparation.status, 'prepared')
    background.portMessage({
      v: 1, type: 'markdown-review-commit-write-request', requestId: 'commit-1', reviewId: 'review-1',
      approval: preparation.approval, idempotencyKey: 'write-1', content: '# Better',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'commit-1').result.status, 'verified_write')
    const reviewFetches = background.fetches.filter(({ url }) => new URL(url).pathname.startsWith('/api/workspace-review/'))
    assert.equal(reviewFetches.length, 6)
    assert.equal(reviewFetches.every(({ init }) => init.signal instanceof AbortSignal), true)
  } finally { background.cleanup() }
})

test('forwards a bounded dirty visual selection with structure rather than fake Markdown offsets', async () => {
  const background = await loadBackground()
  try {
    await background.open(openReview); background.connect()
    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'visual-deliver-1', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'visual-annotation-1',
      annotation: { id: 'visual-annotation-1', anchor: { version: 2, editorRevision: 4, from: 8, to: 31, quote: 'Paragraph\nCell', blocks: [{ kind: 'paragraph', text: 'Paragraph' }, { kind: 'table_cell', text: 'Cell' }], sourceFingerprint: 'fingerprint-1' }, comment: '缩短并更清楚' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const delivered = background.responses.find(message => message.requestId === 'visual-deliver-1')
    assert.equal(delivered.ok, true, JSON.stringify(delivered))
    const feedback = background.forwarded[0].feedback
    assert.equal(feedback.anchorKind, 'visual')
    assert.deepEqual([feedback.editorRevision, feedback.from, feedback.to], [4, 8, 31])
    assert.equal('startUtf16' in feedback, false)
  } finally { background.cleanup() }
})

test('bounds every Host request and reports an aborted commit as uncertain rather than a Verified Write', async () => {
  const background = await loadBackground()
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const abortedPaths = []
  let snapshotCalls = 0
  const snapshot = {
    v: 1, type: 'markdown-review-snapshot', reviewId: 'review-1',
    resource: { resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1' },
    content: '# Review me', truncated: false, readOnly: true,
  }
  const waitForResponse = async requestId => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = background.responses.find(message => message.requestId === requestId)
      if (response !== undefined) return response
      await new Promise(resolve => originalSetTimeout(resolve, 0))
    }
    assert.fail(`timed out waiting for ${requestId}`)
  }
  try {
    await background.open(openReview); background.connect()
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/snapshot') && ++snapshotCalls === 2) {
        return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Promise(() => {
        init.signal.addEventListener('abort', () => abortedPaths.push(pathname), { once: true })
      })
    }

    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'timeout-snapshot', reviewId: 'review-1' })
    const snapshotResponse = await waitForResponse('timeout-snapshot')
    assert.equal(snapshotResponse.ok, false)
    assert.match(snapshotResponse.error.message, /snapshot timed out after 15 seconds/)

    background.portMessage({ v: 1, type: 'markdown-review-proposals-request', requestId: 'timeout-proposals', reviewId: 'review-1', afterSequence: 0 })
    background.portMessage({
      v: 1, type: 'markdown-review-prepare-write-request', requestId: 'timeout-prepare', reviewId: 'review-1',
      expected: { resourceId: 'resource-1', revision: 'rev-1', fingerprint: 'fingerprint-1' }, content: '# Better',
    })
    background.portMessage({
      v: 1, type: 'markdown-review-commit-write-request', requestId: 'timeout-commit', reviewId: 'review-1',
      approval: 'approval-1', idempotencyKey: 'write-1', content: '# Better',
    })
    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'timeout-selection', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })

    const [proposalsResponse, prepareResponse, commitResponse, selectionResponse] = await Promise.all([
      waitForResponse('timeout-proposals'), waitForResponse('timeout-prepare'), waitForResponse('timeout-commit'), waitForResponse('timeout-selection'),
    ])
    for (const response of [proposalsResponse, prepareResponse, selectionResponse]) {
      assert.equal(response.ok, false)
      assert.match(response.error.message, /timed out after 15 seconds/)
    }
    assert.deepEqual({ ok: commitResponse.ok, status: commitResponse.result?.status }, { ok: true, status: 'uncertain' })
    assert.match(commitResponse.result.message, /not a Verified Write/)
    assert.deepEqual([...new Set(abortedPaths)].sort(), [
      '/api/workspace-review/commit-write', '/api/workspace-review/prepare-write', '/api/workspace-review/proposals', '/api/workspace-review/selection', '/api/workspace-review/snapshot',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    background.cleanup()
  }
})
