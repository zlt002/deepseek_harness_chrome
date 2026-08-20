import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

async function loadModule(name) {
  const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports })
  return module.exports
}

const protocol = await loadModule('protocol')
const state = await loadModule('review-state')
const snapshot = {
  v: protocol.MARKDOWN_REVIEW_PROTOCOL_VERSION,
  type: 'markdown-review-snapshot',
  reviewId: 'review-1',
  harnessSessionId: 'session-1',
  resource: { resourceId: 'resource-1', displayPath: 'docs/a.md', revision: 'revision-1', fingerprint: 'fingerprint-1' },
  content: 'hello',
  truncated: false,
  readOnly: true,
}

test('review port accepts only exact versioned request and response shapes', () => {
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'request-1', reviewId: 'review-1' }), true)
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-snapshot-request', requestId: 'request-1', reviewId: 'review-1', capability: 'must-not-cross-tab' }), false)
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 2, type: 'markdown-review-snapshot-request', requestId: 'request-1', reviewId: 'review-1' }), false)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-snapshot-response', requestId: 'request-1', ok: true, snapshot }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-snapshot-response', requestId: 'request-1', ok: true, snapshot, error: { code: 'internal_error', message: 'no' } }), false)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-target-updated', requestId: 'request-2', reviewId: 'review-1' }), true)
})

test('selection anchors keep UTF-16 offsets and bounded surrounding evidence', () => {
  const source = 'A😀BC'
  const anchor = protocol.selectionAnchorFor(source, 1, 3, 'fingerprint-1')
  assert.deepEqual(JSON.parse(JSON.stringify(anchor)), { version: 1, startUtf16: 1, endUtf16: 3, quote: '😀', prefix: 'A', suffix: 'BC', sourceFingerprint: 'fingerprint-1' })
  assert.equal(protocol.selectionAnchorFor(source, 3, 1, 'fingerprint-1'), undefined)
  assert.equal(protocol.selectionAnchorFor(source, 1, 7, 'fingerprint-1'), undefined)
})

test('state machine fails closed when its runtime port disconnects', () => {
  const ready = state.reduceReviewState({ status: 'loading' }, { type: 'snapshot-loaded', snapshot })
  assert.equal(ready.status, 'ready')
  const disconnected = state.reduceReviewState(ready, { type: 'port-disconnected' })
  assert.equal(disconnected.status, 'reopen-required')
  assert.equal(disconnected.snapshot, snapshot)
  assert.equal(disconnected.error?.reopenRequired, true)
  const rejected = state.reduceReviewState(ready, { type: 'request-failed', error: { code: 'review_not_found', message: 'gone', reopenRequired: true } })
  assert.equal(rejected.status, 'reopen-required')
})
