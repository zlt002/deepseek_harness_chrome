import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function load(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}
const { MarkdownReviewDelivery } = await load('../src/markdown-review-delivery.ts')
const { feedbackMessage, sessionActionMessage, respondFeedback, respondSessionAction } = await load('../src/client/bridge.ts')
const { MARKDOWN_AI_ACK_TIMEOUT_MS } = await load('../../../apps/chrome-extension/entrypoints/markdown-review/delivery-timeouts.ts')
const ready = { type: 'workspace-review-bridge-ready/v1' }
const target = { targetSessionId: 'session-1', targetSessionTitle: 'Review', status: 'queued' }
const feedback = { id: 'f1', selectionId: 's1', harnessSessionId: 'session-1', reviewId: 'r1', resourceId: 'res1', displayPath: 'README.md', revision: 'v1', fingerprint: 'fp1', anchorKind: 'source', startUtf16: 0, endUtf16: 4, prefix: '', suffix: '', quote: 'text', comment: 'clarify' }
const action = { action: 'rewrite', reviewId: 'r1', harnessSessionId: 'session-1', resourceId: 'res1', displayPath: 'README.md', revision: 'v1', fingerprint: 'fp1' }
const feedbackAck = (id, extra = {}) => ({ type: 'markdown-review-feedback-accepted/v1', deliveryId: id, accepted: true, ...target, ...extra })
const actionAck = (id, extra = {}) => ({ type: 'markdown-review-session-action-accepted/v1', requestId: id, accepted: true, action: 'rewrite', ...target, status: 'draft_ready', ...extra })

function setup(postMessage) {
  let now = 0, timerId = 0, requestId = 0
  const timers = new Map(), sent = [], replies = []
  const delivery = new MarkdownReviewDelivery({
    postMessage: message => { sent.push(message); postMessage?.(message) },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id),
    randomUUID: () => `a${++requestId}`,
    timeoutMs: MARKDOWN_AI_ACK_TIMEOUT_MS,
  })
  return {
    delivery, sent, replies, timers, reply: value => replies.push(value),
    tick(ms) {
      now += ms
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

test('waits for ready, replays both channels, and a new request replays only its own channel', () => {
  const h = setup()
  h.delivery.feedback(feedback, h.reply)
  h.delivery.action(action, h.reply)
  assert.equal(h.sent.length, 0)
  h.delivery.accept(ready)
  assert.deepEqual(h.sent, [
    { type: 'markdown-review-feedback/v1', feedback },
    { type: 'markdown-review-session-action/v1', requestId: 'a1', action },
  ])
  h.delivery.feedback({ ...feedback, id: 'f2' }, h.reply)
  assert.deepEqual(h.sent.slice(2).map(message => message.feedback.id), ['f1', 'f2'])
  h.delivery.action(action, h.reply)
  assert.deepEqual(h.sent.slice(4).map(message => message.requestId), ['a1', 'a2'])
  h.delivery.resetReady()
  h.delivery.feedback({ ...feedback, id: 'f3' }, h.reply)
  assert.equal(h.sent.length, 6)
  h.delivery.accept(ready)
  assert.deepEqual(h.sent.slice(6).map(message => message.feedback?.id ?? message.requestId), ['f1', 'f2', 'f3', 'a1', 'a2'])
})

test('ACK completes each request once, clears its timer, and stops replay', () => {
  const h = setup()
  h.delivery.feedback(feedback, h.reply)
  h.delivery.action(action, h.reply)
  assert.equal(h.delivery.accept(feedbackAck('f1')), true)
  assert.equal(h.delivery.accept(actionAck('a1')), true)
  assert.deepEqual(h.replies, [{ ok: true, ...target }, { ok: true, ...target, action: 'rewrite', status: 'draft_ready' }])
  assert.equal(h.timers.size, 0)
  h.delivery.accept(feedbackAck('f1'))
  h.delivery.accept(actionAck('a1'))
  h.delivery.accept(ready)
  h.tick(30_000)
  assert.equal(h.replies.length, 2)
  assert.equal(h.sent.length, 0)
})

test('15 second timeout ends waiting without cancellation and ignores late ACKs', () => {
  const h = setup()
  h.delivery.accept(ready)
  h.delivery.feedback(feedback, h.reply)
  h.delivery.action(action, h.reply)
  h.tick(14_999)
  assert.equal(h.replies.length, 0)
  h.tick(1)
  assert.deepEqual(h.replies, [
    { ok: false, error: 'Harness 未在 15 秒内确认 AI 请求；可以重试，同一批注不会重复发送。' },
    { ok: false, error: 'Harness 未在 15 秒内确认审阅动作。请重试。' },
  ])
  h.delivery.accept(feedbackAck('f1'))
  h.delivery.accept(actionAck('a1'))
  h.delivery.accept(ready)
  h.delivery.close()
  assert.equal(h.replies.length, 2)
  assert.equal(h.sent.length, 2)
})

test('close settles both channels with their concrete errors and clears timers', () => {
  const h = setup()
  h.delivery.feedback(feedback, h.reply)
  h.delivery.action(action, h.reply)
  h.delivery.close()
  assert.deepEqual(h.replies, [
    { ok: false, error: 'The Harness Side Panel closed before accepting Markdown feedback.' },
    { ok: false, error: '侧边栏在确认审阅动作前已关闭。' },
  ])
  assert.equal(h.timers.size, 0)
  h.delivery.close()
  h.delivery.accept(ready)
  h.tick(30_000)
  assert.equal(h.replies.length, 2)
  assert.equal(h.sent.length, 0)
})

test('channel-specific ACK validation preserves statuses, action identity and bounded errors', () => {
  for (const [kind, extra, ok] of [
    ['feedback', { status: 'processing' }, true],
    ['feedback', { status: 'draft_ready' }, false],
    ['feedback', { targetSessionId: '' }, false],
    ['feedback', { targetSessionTitle: 'x'.repeat(2049) }, false],
    ['action', { status: 'queued' }, true],
    ['action', { status: 'processing' }, true],
    ['action', { action: 'accept' }, false],
    ['action', { status: 'done' }, false],
    ['action', { targetSessionId: 'x'.repeat(161) }, false],
    ['action', { accepted: false, error: '具体下游错误' }, false],
    ['feedback', { accepted: false, error: 'x'.repeat(4001) }, false],
  ]) {
    const h = setup()
    if (kind === 'feedback') { h.delivery.feedback(feedback, h.reply); h.delivery.accept(feedbackAck('f1', extra)) }
    else { h.delivery.action(action, h.reply); h.delivery.accept(actionAck('a1', extra)) }
    assert.equal(h.replies[0].ok, ok, `${kind}: ${JSON.stringify(extra)}`)
    if (!ok) assert.equal(h.replies[0].error, extra.error === '具体下游错误' ? extra.error : kind === 'feedback' ? 'Harness rejected the Markdown annotation.' : 'Harness 未接受审阅动作。')
    assert.equal(h.timers.size, 0)
  }
})

test('malformed and unknown correlation IDs do not consume a pending request', () => {
  const h = setup()
  h.delivery.feedback(feedback, h.reply)
  assert.equal(h.delivery.accept({ type: 'other' }), false)
  assert.equal(h.delivery.accept(feedbackAck('')), false)
  assert.equal(h.delivery.accept(feedbackAck('x'.repeat(161))), false)
  assert.equal(h.delivery.accept(feedbackAck('unknown')), true)
  assert.equal(h.replies.length, 0)
  h.delivery.accept(feedbackAck('f1'))
  assert.equal(h.replies.length, 1)
})

test('existing feedback ID replacement keeps the original timeout semantics', () => {
  const h = setup(), originalReplies = []
  h.delivery.feedback(feedback, value => originalReplies.push(value))
  h.tick(1_000)
  h.delivery.feedback({ ...feedback, comment: 'retry' }, h.reply)
  h.tick(14_000)
  assert.equal(originalReplies.length, 0)
  assert.equal(h.replies.length, 1)
  assert.equal(h.replies[0].ok, false)
  h.tick(1_000)
  assert.equal(h.replies.length, 1)
})

test('production bridge parses delivery envelopes and its replies complete the same lifecycle', () => {
  const config = { nonce: 'nonce-1', parentOrigin: 'chrome-extension://test' }
  const parent = { postMessage(message, origin) { assert.equal(origin, config.parentOrigin); h.delivery.accept(message) } }
  const h = setup(message => {
    const event = { source: parent, origin: config.parentOrigin, data: { ...message, nonce: config.nonce } }
    if (message.type === 'markdown-review-feedback/v1') {
      assert.deepEqual(feedbackMessage(event, parent, config), feedback)
      respondFeedback(parent, config, feedback.id, true, undefined, target)
    } else {
      assert.deepEqual(sessionActionMessage(event, parent, config), { requestId: 'a1', action })
      respondSessionAction(parent, config, 'a1', true, undefined, { ...target, action: 'rewrite', status: 'draft_ready' })
    }
  })
  h.delivery.feedback(feedback, h.reply)
  h.delivery.action(action, h.reply)
  h.delivery.accept(ready)
  assert.deepEqual(h.replies, [{ ok: true, ...target }, { ok: true, ...target, action: 'rewrite', status: 'draft_ready' }])
  assert.equal(h.timers.size, 0)
})
