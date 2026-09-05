import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('./markdown-feedback-validator.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports })
const { validateWorkspaceMarkdownFeedback, validateWorkspaceMarkdownReviewAction } = module.exports

const base = {
  id: 'annotation-1', selectionId: 'annotation-1', harnessSessionId: 'session-1', reviewId: 'review-1',
  resourceId: 'resource-1', displayPath: 'docs/spec.md', revision: 'revision-1', fingerprint: 'fingerprint-1',
  quote: 'selected paragraph', comment: 'Make this clearer.',
}
const sourceFeedback = { ...base, anchorKind: 'source', startUtf16: 4, endUtf16: 22, prefix: 'before', suffix: 'after' }
const visualFeedback = { ...base, anchorKind: 'visual', editorRevision: 3, from: 4, to: 22, blocks: [{ kind: 'paragraph', text: 'selected paragraph' }, { kind: 'table_cell', text: 'context' }] }
const visualTableFeedback = {
  ...visualFeedback,
  table: {
    from: 3, to: 25, rowCount: 2, columnCount: 2,
    selectedRowStart: 1, selectedRowEnd: 1, selectedColumnStart: 0, selectedColumnEnd: 1,
    isWholeTable: false, header: ['Name', 'Value'], rows: [['Customer', 'Example']],
  },
}

test('Markdown feedback accepts exact source and visual anchor variants, including table context', () => {
  const sourceResult = validateWorkspaceMarkdownFeedback(sourceFeedback)
  const visualResult = validateWorkspaceMarkdownFeedback(visualFeedback)
  const visualTableResult = validateWorkspaceMarkdownFeedback(visualTableFeedback)
  assert.equal(sourceResult.ok, true)
  assert.equal(visualResult.ok, true)
  assert.equal(visualTableResult.ok, true)
  if (sourceResult.ok) assert.equal(sourceResult.feedback.anchorKind, 'source')
  if (visualResult.ok) assert.equal(visualResult.feedback.anchorKind, 'visual')
  if (visualTableResult.ok) assert.equal(visualTableResult.feedback.anchorKind, 'visual')
})

test('Markdown feedback rejects mixed fields, missing fields, and unknown keys', () => {
  for (const malformed of [
    { ...visualFeedback, startUtf16: 1 },
    (() => { const { blocks: _blocks, ...rest } = visualFeedback; return rest })(),
    { ...sourceFeedback, unexpected: true },
  ]) {
    const result = validateWorkspaceMarkdownFeedback(malformed)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /Invalid Markdown review feedback: unexpected, missing, or mixed/)
  }

  const invalidTable = validateWorkspaceMarkdownFeedback({ ...visualTableFeedback, table: { ...visualTableFeedback.table, unexpected: true } })
  assert.equal(invalidTable.ok, false)
  if (!invalidTable.ok) assert.match(invalidTable.error, /visual table context/)
})

test('Markdown feedback rejects invalid ranges and bounded visual block data with a specific error', () => {
  for (const malformed of [
    { ...sourceFeedback, endUtf16: 4 },
    { ...visualFeedback, editorRevision: -1 },
    { ...visualFeedback, blocks: Array.from({ length: 25 }, () => ({ kind: 'paragraph', text: '' })) },
    { ...visualFeedback, blocks: [{ kind: 'paragraph', text: 'ok', extra: 'reject' }] },
    { ...visualFeedback, blocks: [{ kind: 'x'.repeat(33), text: '' }] },
    { ...visualFeedback, blocks: [{ kind: 'paragraph', text: 'x'.repeat(2_001) }] },
    { ...visualTableFeedback, table: { ...visualTableFeedback.table, rows: [['Customer']] } },
  ]) assert.equal(validateWorkspaceMarkdownFeedback(malformed).ok, false)

  const range = validateWorkspaceMarkdownFeedback({ ...visualFeedback, from: 22, to: 22 })
  assert.equal(range.ok, false)
  if (!range.ok) assert.match(range.error, /visual positions and editorRevision/)
})

test('review actions bind a complete resource version and reject mixed fields', () => {
  const action = { action: 'rewrite', reviewId: 'review-1', harnessSessionId: 'session-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'revision-1', fingerprint: 'fingerprint-1' }
  assert.equal(validateWorkspaceMarkdownReviewAction(action).ok, true)
  const { fingerprint: _fingerprint, ...missingFingerprint } = action
  assert.equal(validateWorkspaceMarkdownReviewAction(missingFingerprint).ok, false)
  assert.equal(validateWorkspaceMarkdownReviewAction({ ...action, capability: 'must-not-forward' }).ok, false)
  assert.equal(validateWorkspaceMarkdownReviewAction({ ...action, action: 'send' }).ok, false)
  assert.equal(validateWorkspaceMarkdownReviewAction({ ...action, action: 'accept' }).ok, true)
  assert.equal(validateWorkspaceMarkdownReviewAction({ ...action, action: 'accept', pmdReviewReceipt: 'a'.repeat(32) }).ok, false)
})

test('side panel delegates review delivery and keeps the outer timeout longer than ACK waiting', async () => {
  const [shell, review, workspaceReview, timeouts] = await Promise.all([
    readFile(new URL('./main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../markdown-review/main.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../../packages/harness-ui-workspace-review/src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../markdown-review/delivery-timeouts.ts', import.meta.url), 'utf8'),
  ])
  assert.match(shell, /reviewDelivery\.feedback\(validation\.feedback, sendResponse\)/)
  assert.match(shell, /reviewDelivery\.action\(validation\.action, sendResponse\)/)
  assert.match(shell, /reviewDelivery\.accept\(value\)/)
  assert.match(shell, /MARKDOWN_AI_ACK_TIMEOUT_MS/)
  assert.match(review, /MARKDOWN_REVIEW_DELIVERY_TIMEOUT_MS/)
  assert.match(timeouts, /MARKDOWN_AI_ACK_TIMEOUT_MS = 15_000/)
  assert.match(timeouts, /MARKDOWN_REVIEW_DELIVERY_TIMEOUT_MS = 20_000/)
  assert.match(workspaceReview, /type: 'workspace-review-bridge-ready\/v1'/)
})
