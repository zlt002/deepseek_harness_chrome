import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const root = new URL('.', import.meta.url)
const source = await readFile(new URL('./review-state-safety.ts', root), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports })
const { beginCommit, isCurrentCommit, settleCommit, shouldProtectLocalReviewWork } = module.exports

test('external target updates only reload an untouched review', () => {
  const untouched = { snapshotContent: '# saved', editorMarkdown: '# saved', annotationCount: 0, candidateReviewActive: false, preparedWrite: false, committing: false }
  assert.equal(shouldProtectLocalReviewWork(untouched), false)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, editorMarkdown: '# typed just now' }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, annotationCount: 1 }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, candidateReviewActive: true }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, preparedWrite: true }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, committing: true }), true)
})

test('a prepared write has one active commit and ignores a stale completion', () => {
  const first = beginCommit(undefined, { token: 'commit-1', idempotencyKey: 'write-1', content: 'draft' })
  assert.equal(first.started, true)
  const second = beginCommit(first.active, { token: 'commit-2', idempotencyKey: 'write-2', content: 'draft' })
  assert.equal(second.started, false)
  assert.equal(second.active.idempotencyKey, 'write-1')
  assert.equal(isCurrentCommit(first.active, 'commit-1'), true)
  assert.equal(isCurrentCommit(first.active, 'commit-2'), false)
  assert.equal(settleCommit(first.active, 'commit-2'), first.active)
  assert.equal(settleCommit(first.active, 'commit-1'), undefined)
})
