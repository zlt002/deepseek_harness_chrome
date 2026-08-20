import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

test('lists directories lazily but exposes only bounded Markdown files', async (t) => {
  const root = await fixture(t); const runtime = new WorkspaceReviewRuntime()
  const listing = await runtime.list(root)
  assert.deepEqual(listing.entries.map(entry => entry.displayPath), ['notes', 'README.md'])
  const nested = await runtime.list(root, 'notes')
  assert.deepEqual(nested.entries.map(entry => entry.displayPath), ['notes/todo.markdown'])
})

test('rejects symlinks, non-Markdown resources, and oversized Markdown', async (t) => {
  const root = await fixture(t); const outside = await mkdtemp(join(tmpdir(), 'workspace-review-outside-')); t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'outside.md'), 'private'); await symlink(join(outside, 'outside.md'), join(root, 'linked.md'))
  await writeFile(join(root, 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1))
  const runtime = new WorkspaceReviewRuntime()
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
