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
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-proposals-request', requestId: 'request-1', reviewId: 'review-1', afterSequence: 0 }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-proposals-response', requestId: 'request-1', ok: true, reviewId: 'review-1', proposals: [{ proposalId: 'proposal-1', selectionId: 'selection-1', sequence: 1, baseFingerprint: 'fingerprint-1', kind: 'document', candidateMarkdown: '# Revised', summary: 'Revise title' }] }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-proposals-response', requestId: 'request-1', ok: true, reviewId: 'review-1', proposals: [{ proposalId: 'proposal-1', selectionId: 'selection-1', sequence: 0, baseFingerprint: 'fingerprint-1', kind: 'document', candidateMarkdown: '# Revised', summary: 'Revise title' }] }), false)
  const visualAnchor = { version: 2, editorRevision: 3, from: 5, to: 17, quote: 'first\nsecond', blocks: [{ kind: 'paragraph', text: 'first' }, { kind: 'table_cell', text: 'second' }], table: { from: 4, to: 20, rowCount: 2, columnCount: 2, selectedRowStart: 1, selectedRowEnd: 1, selectedColumnStart: 0, selectedColumnEnd: 1, isWholeTable: false, header: ['head 1', 'head 2'], rows: [['first', 'second']] }, sourceFingerprint: 'fingerprint-1' }
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-deliver-request', requestId: 'request-2', reviewId: 'review-1', harnessSessionId: 'session-1', deliveryId: 'selection-1', annotation: { id: 'selection-1', anchor: visualAnchor, comment: 'rewrite' } }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-proposals-response', requestId: 'request-2', ok: true, reviewId: 'review-1', proposals: [{ proposalId: 'proposal-2', selectionId: 'selection-1', sequence: 2, baseFingerprint: 'fingerprint-1', kind: 'selection', replacementMarkdown: 'revised', editorRevision: 3, from: 5, to: 17, summary: 'rewrite' }] }), true)
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-prepare-write-request', requestId: 'request-3', reviewId: 'review-1', expected: { resourceId: 'resource-1', revision: 'revision-1', fingerprint: 'fingerprint-1', displayPath: 'must-reject.md' }, content: 'next' }), false)
  assert.equal(protocol.isMarkdownReviewPortRequest({ v: 1, type: 'markdown-review-prepare-write-request', requestId: 'request-3', reviewId: 'review-1', expected: { resourceId: 'resource-1', revision: 'revision-1', fingerprint: 'fingerprint-1' }, content: 'next' }), true)
  const latest = { v: 1, type: 'markdown-review-snapshot', reviewId: 'review-1', resource: snapshot.resource, content: 'external edit', truncated: false, readOnly: true }
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-prepare-write-response', requestId: 'request-4', ok: true, preparation: { status: 'prepared', approval: 'approval-1', contentHash: 'hash-1', expiresAt: Date.now() + 1_000 } }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-commit-write-response', requestId: 'request-5', ok: true, result: { status: 'conflict', latest } }), true)
  assert.equal(protocol.isMarkdownReviewPortResponse({ v: 1, type: 'markdown-review-commit-write-response', requestId: 'request-6', ok: true, result: { status: 'uncertain', message: 'readback failed' } }), true)
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
