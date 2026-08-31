import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/bridge.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, URL, URLSearchParams })
const { feedbackMessage, respondFeedback, sessionActionMessage, respondSessionAction } = module.exports
const parent = {}
const config = { nonce: 'nonce-1', parentOrigin: 'chrome-extension://test' }
const base = { id: 'annotation-1', selectionId: 'annotation-1', harnessSessionId: 'session-1', reviewId: 'review-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'revision-1', fingerprint: 'fingerprint-1', quote: 'text', comment: 'rewrite' }

test('accepts an exact source feedback envelope including source range keys', () => {
  const feedback = { ...base, anchorKind: 'source', startUtf16: 1, endUtf16: 5, prefix: '# ', suffix: '\n' }
  assert.deepEqual(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback }, source: parent, origin: config.parentOrigin }, parent, config), feedback)
})

test('accepts visual feedback with table context and rejects malformed visual envelopes', () => {
  const feedback = { ...base, anchorKind: 'visual', editorRevision: 2, from: 4, to: 11, blocks: [{ kind: 'code_block', text: 'text' }] }
  const tableFeedback = {
    ...feedback,
    table: {
      from: 3, to: 15, rowCount: 2, columnCount: 2,
      selectedRowStart: 1, selectedRowEnd: 1, selectedColumnStart: 0, selectedColumnEnd: 1,
      isWholeTable: false, header: ['Name', 'Value'], rows: [['Customer', 'Example']],
    },
  }
  assert.deepEqual(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback }, source: parent, origin: config.parentOrigin }, parent, config), feedback)
  assert.deepEqual(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback: tableFeedback }, source: parent, origin: config.parentOrigin }, parent, config), tableFeedback)
  assert.equal(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback: { ...feedback, startUtf16: 0 } }, source: parent, origin: config.parentOrigin }, parent, config), undefined)
  assert.equal(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback: { ...tableFeedback, table: { ...tableFeedback.table, unexpected: true } } }, source: parent, origin: config.parentOrigin }, parent, config), undefined)
  assert.equal(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback: { ...tableFeedback, table: { ...tableFeedback.table, rows: [['Customer']] } } }, source: parent, origin: config.parentOrigin }, parent, config), undefined)
})

test('returns awaited feedback delivery status with a bounded concrete error', () => {
  const messages = []
  const receiver = { postMessage: (message, origin) => { messages.push({ message, origin }) } }
  respondFeedback(receiver, config, 'annotation-1', true, undefined, { targetSessionId: 'session-2', targetSessionTitle: '当前会话', status: 'queued' })
  respondFeedback(receiver, config, 'annotation-2', false, ` ${'x'.repeat(4_100)} `)
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { message: { type: 'markdown-review-feedback-accepted/v1', nonce: 'nonce-1', deliveryId: 'annotation-1', accepted: true, targetSessionId: 'session-2', targetSessionTitle: '当前会话', status: 'queued' }, origin: config.parentOrigin })
  assert.equal(messages[1].message.accepted, false)
  assert.equal(messages[1].message.error.length, 4_000)
  assert.equal(messages[1].origin, config.parentOrigin)
})

test('accepts only a bounded session action and acknowledges its bound session', () => {
  const action = { action: 'rewrite', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'revision-1', fingerprint: 'fingerprint-1' }
  assert.deepEqual(JSON.parse(JSON.stringify(sessionActionMessage({ data: { type: 'markdown-review-session-action/v1', nonce: 'nonce-1', requestId: 'request-1', action }, source: parent, origin: config.parentOrigin }, parent, config))), { requestId: 'request-1', action })
  assert.equal(sessionActionMessage({ data: { type: 'markdown-review-session-action/v1', nonce: 'nonce-1', requestId: 'request-1', action: { ...action, capability: 'must-not-cross' } }, source: parent, origin: config.parentOrigin }, parent, config), undefined)
  const messages = []
  respondSessionAction({ postMessage: (message, origin) => messages.push({ message, origin }) }, config, 'request-1', true, undefined, { action: 'rewrite', targetSessionId: 'session-1', targetSessionTitle: 'PRD 会话', status: 'draft_ready' })
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { message: { type: 'markdown-review-session-action-accepted/v1', nonce: 'nonce-1', requestId: 'request-1', accepted: true, action: 'rewrite', targetSessionId: 'session-1', targetSessionTitle: 'PRD 会话', status: 'draft_ready' }, origin: config.parentOrigin })
})
