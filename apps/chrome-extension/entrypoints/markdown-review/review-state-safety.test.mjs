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
const { adoptionBlockedReason, beginCommit, isCurrentCommit, settleCommit, shouldProtectLocalReviewWork } = module.exports

test('external target updates only reload an untouched review', () => {
  const untouched = { snapshotContent: '# saved', editorMarkdown: '# saved', annotationCount: 0, candidateReviewActive: false, preparedWrite: false, committing: false }
  assert.equal(shouldProtectLocalReviewWork(untouched), false)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, editorMarkdown: '# typed just now' }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, annotationCount: 1 }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, candidateReviewActive: true }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, preparedWrite: true }), true)
  assert.equal(shouldProtectLocalReviewWork({ ...untouched, committing: true }), true)
})

test('PRD adoption requires the currently saved, conflict-free review version', () => {
  const saved = { snapshotContent: '# saved', editorMarkdown: '# saved', annotationCount: 0, candidateReviewActive: false, preparedWrite: false, committing: false, externalUpdatePending: false }
  assert.equal(adoptionBlockedReason(saved), undefined)
  assert.match(adoptionBlockedReason({ ...saved, editorMarkdown: '# accepted AI draft' }), /请先保存草稿/)
  assert.match(adoptionBlockedReason({ ...saved, candidateReviewActive: true }), /接受或拒绝 AI 修改/)
  assert.match(adoptionBlockedReason({ ...saved, preparedWrite: true }), /正在保存/)
  assert.match(adoptionBlockedReason({ ...saved, committing: true }), /正在保存/)
  assert.match(adoptionBlockedReason({ ...saved, externalUpdatePending: true }), /外部更新/)
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
