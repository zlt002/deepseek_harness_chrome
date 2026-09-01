import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

async function loadBackground() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  let runtimeListener; let connectListener
  const created = []; const updates = []; const forwarded = []; const rehydrates = []; const fetches = []; const nativeMessages = []; const storage = { harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }
  const page = { id: 42, windowId: 7, url: 'https://docs.example.test/source', title: 'Source' }
  const reviewTab = { id: 91, windowId: 7, url: '', title: 'Markdown Review' }
  const nativeListeners = new Set()
  let prdEventResponse = 'recorded'
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
      sendMessage: async message => {
        if (message.type === 'markdown-review-feedback-forward/v1') { forwarded.push(message); return { ok: true, status: 'queued', targetSessionId: 'session-2', targetSessionTitle: '当前会话' } }
        if (message.type === 'markdown-review-session-action-forward/v1') { forwarded.push(message); return { ok: true, action: message.action, status: 'draft_ready', targetSessionId: 'session-current', targetSessionTitle: '当前会话' } }
        if (message.type === 'markdown-review-rehydrate-forward/v1') { rehydrates.push(message); return { ok: true, review: { ...openReview, capability: 'fresh-capability' } } }
      },
      connectNative: () => ({
        onDisconnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: listener => nativeListeners.add(listener), removeListener: listener => nativeListeners.delete(listener) },
        postMessage: message => {
          nativeMessages.push(message)
          if (message.type === 'start') queueMicrotask(() => { for (const listener of nativeListeners) listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-review' } }) })
          if (message.type === 'report-prd-event') queueMicrotask(() => {
            for (const listener of nativeListeners) listener(prdEventResponse === 'recorded'
              ? { type: 'prd_event_recorded', requestId: message.requestId }
              : { type: 'prd_event_failed', requestId: message.requestId, error: 'outbox unavailable' })
          })
          if (message.type === 'record-pmd-prd-review-adoption') queueMicrotask(() => {
            for (const listener of nativeListeners) listener({ type: 'pmd_prd_review_adoption_recorded', requestId: message.requestId })
          })
        },
        disconnect: () => {},
      }),
    },
    storage: { session: { get: async key => typeof key === 'string' ? { [key]: storage[key] } : storage, set: async value => Object.assign(storage, value) } },
    windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async query => query.active ? [page] : [page],
      get: async id => id === 42 ? page : id === 91 ? reviewTab : undefined,
      create: async options => { reviewTab.url = options.url; created.push(options); return reviewTab },
      update: async (id, options) => { updates.push({ id, options }); return id === 42 ? { ...page, ...options } : { ...reviewTab, ...options } },
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
    created, updates, fetches, forwarded, rehydrates, responses, nativeMessages,
    setPrdEventResponse: value => { prdEventResponse = value },
    open: review => runtimeMessage({ type: 'open-markdown-review/v1', review }, { url: 'chrome-extension://test/sidepanel.html' }),
    connect: () => connectListener(port),
    portMessage: message => { for (const listener of portMessageListeners) listener(message) },
    cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.fetch },
  }
}

const openReview = { v: 1, reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', capability: 'opaque-capability-that-never-enters-the-url' }
const pmdPrdReview = { ...openReview, pmdPrd: true }

test('opens a capability-free review URL, proxies a bounded snapshot, and delivers to the fixed session', async () => {
  const background = await loadBackground()
  try {
    assert.equal((await background.open(openReview)).ok, true)
    assert.equal(background.created.length, 1)
    assert.deepEqual(background.nativeMessages.filter(message => message.type === 'report-prd-event'), [])
    assert.match(background.created[0].url, /markdown-review\.html\?reviewId=review-1$/)
    assert.doesNotMatch(background.created[0].url, /capability|session-1|resource-1/)
    background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'snapshot-1', reviewId: 'review-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const snapshot = background.responses.find(message => message.requestId === 'snapshot-1')
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
    assert.equal(snapshot.snapshot.harnessSessionId, 'session-1')
    assert.equal(snapshot.snapshot.sidePanelTabId, 42)
    assert.equal(snapshot.snapshot.pmdPrd, undefined)
    const snapshotFetch = background.fetches.find(({ url }) => new URL(url).pathname.endsWith('/snapshot'))
    assert.equal(snapshotFetch.init.headers.authorization, `Bearer ${openReview.capability}`)
    background.portMessage({ v: 1, type: 'markdown-review-rating-request', requestId: 'ordinary-rating', reviewId: 'review-1', rating: 4 })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'ordinary-rating') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'ordinary-rating')?.ok, false)
    assert.equal(background.nativeMessages.some(message => message.type === 'report-prd-event' && message.payload.eventType === 'prd_rating'), false)

    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'deliver-1', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const delivered = background.responses.find(message => message.requestId === 'deliver-1')
    assert.deepEqual({ ok: delivered.ok, deliveryId: delivered.deliveryId }, { ok: true, deliveryId: 'annotation-1' })
    assert.deepEqual({ targetSessionId: delivered.targetSessionId, status: delivered.status }, { targetSessionId: 'session-2', status: 'queued' })
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

test('forwards rewrite and accept only to the review-bound session', async () => {
  const background = await loadBackground()
  try {
    await background.open(openReview); background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-session-action-request', requestId: 'rewrite-1', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', action: 'rewrite' })
    background.portMessage({ v: 1, type: 'markdown-review-session-action-request', requestId: 'accept-1', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', action: 'accept' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'accept-1') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(background.responses.find(message => message.requestId === 'rewrite-1').status, 'draft_ready')
    assert.deepEqual(background.responses.find(message => message.requestId === 'accept-1').status, 'draft_ready')
    const actions = background.forwarded.filter(message => message.type === 'markdown-review-session-action-forward/v1')
    assert.deepEqual(actions.map(message => [message.action, message.review.harnessSessionId, message.review.resourceId, message.review.revision, message.review.fingerprint]), [['rewrite', 'session-1', 'resource-1', 'rev-1', 'fingerprint-1'], ['accept', 'session-1', 'resource-1', 'rev-1', 'fingerprint-1']])
    assert.equal('pmdReviewReceipt' in actions[0].review, false)
    assert.equal('pmdReviewReceipt' in actions[1].review, false)
    const adoption = background.nativeMessages.find(message => message.type === 'record-pmd-prd-review-adoption')
    assert.equal(adoption.payload.harnessSessionId, 'session-current')
    assert.match(adoption.payload.contentHash, /^[a-f0-9]{64}$/)
  } finally { background.cleanup() }
})

test('only explicit pmd-prd Reviews report generated/rating telemetry and restore ratings', async () => {
  const background = await loadBackground()
  try {
    await background.open(pmdPrdReview); background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-rating-request', requestId: 'rating-1', reviewId: 'review-1', rating: 0.5 })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'rating-1') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(background.responses.find(message => message.requestId === 'rating-1'), { v: 1, type: 'markdown-review-rating-response', requestId: 'rating-1', ok: true, rating: 0.5 })
    const generated = background.nativeMessages.find(message => message.type === 'report-prd-event' && message.payload.eventType === 'review_generated')
    assert.equal(generated?.payload.eventId, 'review:review-1:generated')
    assert.equal(generated?.payload.name, 'README.md')
    const rating = background.nativeMessages.find(message => message.type === 'report-prd-event' && message.payload.eventType === 'prd_rating')
    assert.deepEqual({ eventId: rating.payload.eventId, eventType: rating.payload.eventType, outcome: rating.payload.outcome, sessionId: rating.payload.sessionId, generationEventId: rating.payload.generationEventId, rating: rating.payload.rating }, {
      eventId: 'review:review-1:rating:rating-1', eventType: 'prd_rating', outcome: 'succeeded', sessionId: 'session-1', generationEventId: 'review:review-1:generated', rating: 0.5,
    })
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'rating-readback-1', reviewId: 'review-1' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'rating-readback-1') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'rating-readback-1')?.snapshot?.rating, 0.5)
    assert.equal(background.responses.find(message => message.requestId === 'rating-readback-1')?.snapshot?.pmdPrd, true)
  } finally { background.cleanup() }
})

test('generated PRD telemetry reports only the basename of an absolute Markdown path', async () => {
  const background = await loadBackground()
  try {
    await background.open({ ...pmdPrdReview, reviewId: 'review-absolute', displayPath: '/Users/zhanglt21/Documents/需求_PRD.md' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const generated = background.nativeMessages.find(message => message.type === 'report-prd-event' && message.payload.eventType === 'review_generated')
    assert.equal(generated?.payload.name, '需求_PRD.md')
    assert.doesNotMatch(generated?.payload.name ?? '', /Users|Documents|\//)
  } finally { background.cleanup() }
})

test('does not retain a rating when Native rejects its durable PRD event', async () => {
  const background = await loadBackground()
  try {
    background.setPrdEventResponse('failed')
    await background.open(pmdPrdReview); background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-rating-request', requestId: 'rating-failed', reviewId: 'review-1', rating: 2 })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'rating-failed') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'rating-failed')
    assert.equal(response?.ok, false)
    assert.match(response?.error?.message ?? '', /outbox unavailable/)
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'rating-failed-readback', reviewId: 'review-1' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'rating-failed-readback') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'rating-failed-readback')?.snapshot?.rating, undefined)
  } finally { background.cleanup() }
})

test('confirmed adoption prepares the bound draft before navigating only its captured Browser Target', async () => {
  const background = await loadBackground()
  try {
    await background.open(openReview); background.connect()
    background.portMessage({ v: 1, type: 'markdown-review-session-action-request', requestId: 'accept-navigate', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', action: 'accept' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'accept-navigate') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.responses.find(message => message.requestId === 'accept-navigate')?.ok, true)
    assert.equal(background.forwarded.filter(message => message.type === 'markdown-review-session-action-forward/v1' && message.action === 'accept').length, 1)
    assert.deepEqual(background.updates.filter(update => update.id === 42 && update.options.url !== undefined), [{ id: 42, options: { url: 'https://doc.midea.com/docs', active: true } }])
    assert.equal(background.updates.some(update => update.id === 91 && update.options.url === 'https://doc.midea.com/docs'), false)
  } finally { background.cleanup() }
})

test('does not navigate when preparing the adoption draft fails', async () => {
  const background = await loadBackground()
  const originalSendMessage = globalThis.chrome.runtime.sendMessage
  try {
    await background.open(openReview); background.connect()
    globalThis.chrome.runtime.sendMessage = async message => message.type === 'markdown-review-session-action-forward/v1'
      ? { ok: false, error: '绑定侧边栏会话不可用' }
      : originalSendMessage(message)
    background.portMessage({ v: 1, type: 'markdown-review-session-action-request', requestId: 'accept-forward-fails', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', action: 'accept' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'accept-forward-fails') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'accept-forward-fails')
    assert.equal(response?.ok, false, JSON.stringify(response))
    assert.match(response?.error?.message ?? '', /绑定侧边栏会话不可用/)
    assert.equal(background.updates.some(update => update.options.url === 'https://doc.midea.com/docs'), false)
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage
    background.cleanup()
  }
})

test('does not forward adoption when the saved file version changed after the review snapshot', async () => {
  const background = await loadBackground()
  const originalFetch = globalThis.fetch
  try {
    await background.open(openReview); background.connect()
    globalThis.fetch = async (url, init) => new URL(String(url)).pathname.endsWith('/snapshot')
      ? new Response(JSON.stringify({
        v: 1, type: 'markdown-review-snapshot', reviewId: 'review-1',
        resource: { resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-2', fingerprint: 'fingerprint-2' },
        content: '# Changed', truncated: false, readOnly: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      : originalFetch(url, init)
    background.portMessage({ v: 1, type: 'markdown-review-session-action-request', requestId: 'stale-accept', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'rev-1', fingerprint: 'fingerprint-1', action: 'accept' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'stale-accept')
    assert.equal(response?.ok, false, JSON.stringify(response))
    assert.match(response?.error?.message ?? '', /changed since this review/)
    assert.equal(background.forwarded.some(message => message.type === 'markdown-review-session-action-forward\/v1'), false)
  } finally {
    globalThis.fetch = originalFetch
    background.cleanup()
  }
})

test('rehydrates one expired capability then retries the original request once', async () => {
  const background = await loadBackground()
  const originalFetch = globalThis.fetch
  let snapshots = 0
  try {
    await background.open(openReview); background.connect()
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/snapshot') && ++snapshots === 1) return new Response(JSON.stringify({ error: 'review capability is expired; reopen from the file tree' }), { status: 401, headers: { 'content-type': 'application/json' } })
      return originalFetch(url, init)
    }
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'expired-snapshot', reviewId: 'review-1' })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'expired-snapshot') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'expired-snapshot')
    assert.equal(response?.ok, true, JSON.stringify(response))
    assert.equal(background.rehydrates.length, 1)
    assert.equal(snapshots, 2)
  } finally {
    globalThis.fetch = originalFetch
    background.cleanup()
  }
})

test('rehydrates one invalid capability then retries prepare-write with the fresh capability', async () => {
  const background = await loadBackground()
  const originalFetch = globalThis.fetch
  let prepareWrites = 0
  try {
    await background.open(openReview); background.connect()
    globalThis.fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/prepare-write') && ++prepareWrites === 1) {
        assert.equal(init.headers.authorization, `Bearer ${openReview.capability}`)
        return new Response(JSON.stringify({ error: 'review capability is invalid' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      if (new URL(String(url)).pathname.endsWith('/prepare-write')) assert.equal(init.headers.authorization, 'Bearer fresh-capability')
      return originalFetch(url, init)
    }
    background.portMessage({
      v: 1, type: 'markdown-review-prepare-write-request', requestId: 'invalid-prepare', reviewId: 'review-1',
      expected: { resourceId: 'resource-1', revision: 'rev-1', fingerprint: 'fingerprint-1' }, content: '# Better',
    })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'invalid-prepare') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'invalid-prepare')
    assert.equal(response?.ok, true, JSON.stringify(response))
    assert.equal(response?.preparation?.status, 'prepared')
    assert.equal(background.rehydrates.length, 1)
    assert.equal(prepareWrites, 2)
  } finally {
    globalThis.fetch = originalFetch
    background.cleanup()
  }
})

test('shares one rehydrate while concurrent expired review requests retry with the fresh capability', async () => {
  const background = await loadBackground()
  const originalFetch = globalThis.fetch
  const originalSendMessage = globalThis.chrome.runtime.sendMessage
  let rehydrateCalls = 0
  try {
    await background.open(openReview); background.connect()
    globalThis.chrome.runtime.sendMessage = async message => {
      if (message.type === 'markdown-review-rehydrate-forward/v1') {
        rehydrateCalls += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return { ok: true, review: { ...openReview, capability: 'fresh-capability' } }
      }
      return originalSendMessage(message)
    }
    globalThis.fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/snapshot') && init.headers.authorization === `Bearer ${openReview.capability}`) {
        return new Response(JSON.stringify({ error: 'review capability is expired; reopen from the file tree' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(url, init)
    }
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'expired-a', reviewId: 'review-1' })
    background.portMessage({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'expired-b', reviewId: 'review-1' })
    for (let attempt = 0; attempt < 30 && background.responses.filter(message => message.requestId === 'expired-a' || message.requestId === 'expired-b').length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2))
    assert.deepEqual(background.responses.filter(message => message.requestId === 'expired-a' || message.requestId === 'expired-b').map(message => message.ok), [true, true])
    assert.equal(rehydrateCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome.runtime.sendMessage = originalSendMessage
    background.cleanup()
  }
})

test('reports a closed Side Panel as a retryable delivery error without requiring the file to reopen', async () => {
  const background = await loadBackground()
  const originalSendMessage = globalThis.chrome.runtime.sendMessage
  try {
    await background.open(openReview); background.connect()
    globalThis.chrome.runtime.sendMessage = async message => message.type === 'markdown-review-feedback-forward/v1'
      ? { ok: false, error: '侧边栏未打开或尚未准备好。请打开侧边栏后重新发送。' }
      : originalSendMessage(message)
    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'closed-sidepanel', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'closed-sidepanel') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'closed-sidepanel')
    assert.deepEqual({ ok: response?.ok, code: response?.error?.code, reopenRequired: response?.error?.reopenRequired }, { ok: false, code: 'sidepanel_unavailable', reopenRequired: undefined })
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage
    background.cleanup()
  }
})

test('turns a missing Side Panel receiver into a retryable delivery error', async () => {
  const background = await loadBackground()
  const originalSendMessage = globalThis.chrome.runtime.sendMessage
  try {
    await background.open(openReview); background.connect()
    globalThis.chrome.runtime.sendMessage = async message => {
      if (message.type === 'markdown-review-feedback-forward/v1') throw new Error('Could not establish connection. Receiving end does not exist.')
      return originalSendMessage(message)
    }
    background.portMessage({
      v: 1, type: 'markdown-review-deliver-request', requestId: 'missing-sidepanel-receiver', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'annotation-1',
      annotation: { id: 'annotation-1', anchor: { version: 1, startUtf16: 2, endUtf16: 8, quote: 'Review', prefix: '# ', suffix: ' me', sourceFingerprint: 'fingerprint-1' }, comment: '更明确一些' },
    })
    for (let attempt = 0; attempt < 20 && background.responses.find(message => message.requestId === 'missing-sidepanel-receiver') === undefined; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.responses.find(message => message.requestId === 'missing-sidepanel-receiver')
    assert.deepEqual({ ok: response?.ok, code: response?.error?.code, message: response?.error?.message, reopenRequired: response?.error?.reopenRequired }, {
      ok: false, code: 'sidepanel_unavailable', message: '侧边栏未打开或尚未准备好。请打开侧边栏后重新发送。', reopenRequired: undefined,
    })
  } finally {
    globalThis.chrome.runtime.sendMessage = originalSendMessage
    background.cleanup()
  }
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
