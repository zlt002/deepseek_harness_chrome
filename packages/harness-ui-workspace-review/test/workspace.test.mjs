import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CAPABILITY_TTL_MS, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, WorkspaceReviewRuntime, normalizeRelativePath } from '../src/workspace.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-review-')); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'notes')); await writeFile(join(root, 'README.md'), '# Safe\ncontent'); await writeFile(join(root, 'notes', 'todo.markdown'), 'todo')
  await writeFile(join(root, 'plain.txt'), 'not reviewable'); return root
}

test('rejects absolute and traversal UI paths before any workspace file is read', () => {
  assert.throws(() => normalizeRelativePath('../secret.md'), /invalid workspace segment/)
  assert.throws(() => normalizeRelativePath('/tmp/secret.md'), /relative slash-separated/)
  assert.throws(() => normalizeRelativePath('notes\\secret.md'), /relative slash-separated/)
})

test('lists directories lazily and exposes every ordinary file while marking reviewable Markdown', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const listing = await runtime.list(root)
  assert.deepEqual(listing.entries.map(entry => entry.displayPath), ['notes', 'plain.txt', 'README.md'])
  assert.deepEqual(listing.entries.map(entry => entry.kind), ['directory', 'file', 'markdown'])
  const nested = await runtime.list(root, 'notes')
  assert.deepEqual(nested.entries.map(entry => entry.displayPath), ['notes/todo.markdown'])
})

test('keeps oversized Markdown visible as a non-reviewable ordinary file', async (t) => {
  const root = await fixture(t); await writeFile(join(root, 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1))
  const listing = await new WorkspaceReviewRuntime().list(root)
  assert.deepEqual(listing.entries.find(entry => entry.displayPath === 'large.md'), { kind: 'file', name: 'large.md', displayPath: 'large.md' })
})

test('Host review opener rejects absolute, traversal, non-Markdown, symlink, and oversized paths', async (t) => {
  const root = await fixture(t); const outside = await mkdtemp(join(tmpdir(), 'workspace-review-outside-')); t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'outside.md'), 'private'); await symlink(join(outside, 'outside.md'), join(root, 'linked.md'))
  await writeFile(join(root, 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1))
  const runtime = new WorkspaceReviewRuntime()
  await assert.rejects(runtime.open('session', root, '/tmp/secret.md'), /relative slash-separated/)
  await assert.rejects(runtime.open('session', root, '../secret.md'), /invalid workspace segment/)
  await assert.rejects(runtime.open('session', root, 'linked.md'), /symbolic links/)
  await assert.rejects(runtime.open('session', root, 'plain.txt'), /only .md and .markdown/)
  await assert.rejects(runtime.open('session', root, 'large.md'), /exceeds/)
})

test('issues an opaque capability bound to one session/resource and permits constrained rehydration', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  assert.equal(opened.displayPath, 'README.md'); assert.ok(opened.capability.length > 20)
  const snapshot = await runtime.snapshot(opened.reviewId, opened.capability)
  assert.equal(snapshot.content, '# Safe\ncontent'); assert.equal(snapshot.readOnly, true)
  await assert.rejects(runtime.snapshot(opened.reviewId, 'wrong'), /capability is invalid/)
  await assert.rejects(runtime.rehydrate('session-b', root, opened.reviewId, opened.resourceId), /does not belong/)
  const refreshed = await runtime.rehydrate('session-a', root, opened.reviewId, opened.resourceId)
  assert.notEqual(refreshed.capability, opened.capability)
  assert.equal(CAPABILITY_TTL_MS, 5 * 60 * 1000)
})

test('returns a bounded read-only snapshot while fingerprinting the admitted file', async (t) => {
  const root = await fixture(t); await writeFile(join(root, 'bounded.md'), Buffer.alloc(MAX_SNAPSHOT_BYTES + 32, 'x'))
  const runtime = new WorkspaceReviewRuntime(); const opened = await runtime.open('session-a', root, 'bounded.md')
  const snapshot = await runtime.snapshot(opened.reviewId, opened.capability)
  assert.equal(snapshot.truncated, true)
  assert.equal(Buffer.byteLength(snapshot.content), MAX_SNAPSHOT_BYTES)
  assert.equal(snapshot.resource.fingerprint.length, 64)
})

test('registers a fingerprint-bound selection and queues a same-workspace visual proposal from the current session', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  const selection = await runtime.registerSelection(opened.reviewId, opened.capability, {
    id: 'selection-1', startUtf16: 7, endUtf16: 14, quote: 'content', prefix: '# Safe\n', suffix: '', sourceFingerprint: opened.fingerprint,
  })
  assert.equal(selection.quote, 'content')
  await assert.rejects(runtime.proposeEdit('session-b', `${root}-other`, opened.reviewId, selection.id, 'better'), /workspace/)
  const queued = await runtime.proposeEdit('session-b', root, opened.reviewId, selection.id, '**better**', 'Improve the sentence')
  assert.equal(queued.status, 'queued')
  const proposals = runtime.proposals(opened.reviewId, opened.capability, 0)
  assert.equal(proposals.proposals.length, 1)
  assert.equal(proposals.proposals[0].kind, 'document')
  assert.equal(proposals.proposals[0].candidateMarkdown, '# Safe\n**better**')
  assert.equal(runtime.proposals(opened.reviewId, opened.capability, proposals.proposals[0].sequence).proposals.length, 0)
})

test('queues visual draft selections without pretending ProseMirror positions are Markdown offsets', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  await runtime.registerSelection(opened.reviewId, opened.capability, {
    id: 'visual-1', version: 2, editorRevision: 3, from: 2, to: 18, quote: 'Safe\ncontent',
    blocks: [{ kind: 'heading', text: 'Safe' }, { kind: 'paragraph', text: 'content' }], sourceFingerprint: opened.fingerprint,
  })
  await runtime.proposeEdit('session-a', root, opened.reviewId, 'visual-1', '# Better\n\nNew paragraph', 'Rewrite selected blocks')
  const proposal = runtime.proposals(opened.reviewId, opened.capability, 0).proposals[0]
  assert.deepEqual({ kind: proposal.kind, editorRevision: proposal.editorRevision, from: proposal.from, to: proposal.to }, { kind: 'selection', editorRevision: 3, from: 2, to: 18 })
  assert.equal(proposal.replacementMarkdown, '# Better\n\nNew paragraph')
  assert.equal('candidateMarkdown' in proposal, false)
})

test('queues a full-table candidate for a partial-table visual selection while rejecting a one-row candidate', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  await runtime.registerSelection(opened.reviewId, opened.capability, {
    id: 'table-partial', version: 2, editorRevision: 3, from: 10, to: 30, quote: '客户系\n客户名称(全称)',
    blocks: [{ kind: 'table_cell', text: '客户系' }, { kind: 'table_cell', text: '客户名称(全称)' }],
    table: { from: 5, to: 50, rowCount: 3, columnCount: 2, selectedRowStart: 1, selectedRowEnd: 2, selectedColumnStart: 0, selectedColumnEnd: 1, isWholeTable: false, header: ['字段', '类型'], rows: [['客户系', '文本输入'], ['客户名称(全称)', '文本输入']] },
    sourceFingerprint: opened.fingerprint,
  })
  await assert.rejects(runtime.proposeEdit('session-a', root, opened.reviewId, 'table-partial', '| 客户名称(全称) | 文本输入 |'), /complete Markdown table/i)
  await runtime.proposeEdit('session-a', root, opened.reviewId, 'table-partial', '| 字段 | 类型 |\n| --- | --- |\n| 客户名称(全称) | 文本输入 |')
  assert.equal(runtime.proposals(opened.reviewId, opened.capability, 0).proposals.length, 1)
})

test('requires a complete, column-consistent Markdown table before queuing a whole-table visual proposal', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  await runtime.registerSelection(opened.reviewId, opened.capability, {
    id: 'table-whole', version: 2, editorRevision: 3, from: 5, to: 50, quote: '表头\n客户系\n客户名称(全称)',
    blocks: [{ kind: 'table_cell', text: '表头' }, { kind: 'table_cell', text: '客户名称(全称)' }],
    table: { from: 5, to: 50, rowCount: 3, columnCount: 2, selectedRowStart: 0, selectedRowEnd: 2, selectedColumnStart: 0, selectedColumnEnd: 1, isWholeTable: true, header: ['字段', '类型'], rows: [['客户系', '文本输入'], ['客户名称(全称)', '文本输入']] },
    sourceFingerprint: opened.fingerprint,
  })
  await assert.rejects(runtime.proposeEdit('session-a', root, opened.reviewId, 'table-whole', '| 客户名称(全称) | 文本输入 |'), /complete Markdown table/i)
  await runtime.proposeEdit('session-a', root, opened.reviewId, 'table-whole', '| 字段 | 类型 |\n| --- | --- |\n| 客户名称(全称) | 文本输入 |')
  assert.equal(runtime.proposals(opened.reviewId, opened.capability, 0).proposals.length, 1)
})

test('refuses stale selection proposals after the workspace file changes', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  await runtime.registerSelection(opened.reviewId, opened.capability, {
    id: 'selection-1', startUtf16: 7, endUtf16: 14, quote: 'content', prefix: '# Safe\n', suffix: '', sourceFingerprint: opened.fingerprint,
  })
  await writeFile(join(root, 'README.md'), '# Safe\nexternal')
  await assert.rejects(runtime.proposeEdit('session-a', root, opened.reviewId, 'selection-1', 'better'), /changed after the selection/)
})

test('writes only through a one-time approval and verifies same-resource readback', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  const prepared = await runtime.prepareWrite(opened.reviewId, opened.capability, {
    resourceId: opened.resourceId, revision: opened.revision, fingerprint: opened.fingerprint,
  }, '# Safe\nbetter')
  assert.equal(prepared.status, 'prepared')
  const result = await runtime.commitWrite(opened.reviewId, opened.capability, prepared.approval, 'write-1', '# Safe\nbetter')
  assert.equal(result.status, 'verified_write')
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Safe\nbetter')
  const replay = await runtime.commitWrite(opened.reviewId, opened.capability, prepared.approval, 'write-1', '# Safe\nbetter')
  assert.deepEqual(replay, result)
  await assert.rejects(runtime.commitWrite(opened.reviewId, opened.capability, prepared.approval, 'write-2', '# Safe\nother'), /approval/)
})

test('prepare and commit report conflicts instead of overwriting external changes', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  await writeFile(join(root, 'README.md'), '# Safe\nexternal')
  const conflict = await runtime.prepareWrite(opened.reviewId, opened.capability, {
    resourceId: opened.resourceId, revision: opened.revision, fingerprint: opened.fingerprint,
  }, '# Safe\nours')
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.latest.content, '# Safe\nexternal')
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Safe\nexternal')
})

test('concurrent retries with one idempotency key share one verified result', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const opened = await runtime.open('session-a', root, 'README.md')
  const prepared = await runtime.prepareWrite(opened.reviewId, opened.capability, {
    resourceId: opened.resourceId, revision: opened.revision, fingerprint: opened.fingerprint,
  }, '# Safe\nconcurrent')
  const [first, second] = await Promise.all([
    runtime.commitWrite(opened.reviewId, opened.capability, prepared.approval, 'same-write', '# Safe\nconcurrent'),
    runtime.commitWrite(opened.reviewId, opened.capability, prepared.approval, 'same-write', '# Safe\nconcurrent'),
  ])
  assert.deepEqual(second, first)
  assert.equal(first.status, 'verified_write')
})
