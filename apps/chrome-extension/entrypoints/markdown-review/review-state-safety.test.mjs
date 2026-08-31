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
const { adoptionBlockedReason, beginCommit, canUpdateAnnotationDeliveryStatus, failUnsettledAnnotations, isCurrentCommit, pendingAnnotationCount, reviewSaveBlockedReason, reviewSelectionProposal, settleCommit, shouldProtectLocalReviewWork, updateAnnotationDeliveryStatus, verifiedWriteCleanupAllowed } = module.exports

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
  const saved = { snapshotContent: '# saved', editorMarkdown: '# saved', annotationCount: 0, candidateReviewActive: false, preparedWrite: false, committing: false, externalUpdatePending: false, truncated: false }
  assert.equal(adoptionBlockedReason(saved), undefined)
  assert.match(adoptionBlockedReason({ ...saved, editorMarkdown: '# accepted AI draft' }), /请先保存草稿/)
  assert.match(adoptionBlockedReason({ ...saved, candidateReviewActive: true }), /接受或拒绝 AI 修改/)
  assert.match(adoptionBlockedReason({ ...saved, preparedWrite: true }), /正在保存/)
  assert.match(adoptionBlockedReason({ ...saved, committing: true }), /正在保存/)
  assert.match(adoptionBlockedReason({ ...saved, externalUpdatePending: true }), /外部更新/)
  assert.match(adoptionBlockedReason({ ...saved, annotationCount: 1 }), /局部优化请求/)
  assert.match(adoptionBlockedReason({ ...saved, truncated: true }), /已截断/)
})

test('only explicitly settled annotation history releases the adoption gate', () => {
  assert.equal(pendingAnnotationCount([{ deliveryStatus: 'sending' }, { deliveryStatus: 'queued' }, { deliveryStatus: 'processing' }, { deliveryStatus: 'candidate' }, { deliveryStatus: 'failed' }, { deliveryStatus: 'delivered' }, { deliveryStatus: 'future-status' }]), 7)
  assert.equal(pendingAnnotationCount([{ deliveryStatus: 'settled' }]), 0)
})

test('unsettled review work blocks both draft-save phases while settled history does not', () => {
  for (const deliveryStatus of ['sending', 'processing', 'candidate', 'failed']) {
    const work = { annotationCount: pendingAnnotationCount([{ deliveryStatus }]), candidateReviewActive: false }
    assert.match(reviewSaveBlockedReason(work), /结算|接受或拒绝/)
  }
  assert.match(reviewSaveBlockedReason({ annotationCount: 0, candidateReviewActive: true }), /接受或拒绝/)
  assert.equal(reviewSaveBlockedReason({ annotationCount: pendingAnnotationCount([{ deliveryStatus: 'settled' }]), candidateReviewActive: false }), undefined)
})

test('a commit cannot resurrect settled work and retains abnormal in-flight work for recovery', () => {
  const atCommitStart = [{ id: 'settled-1', deliveryStatus: 'settled' }]
  assert.equal(canUpdateAnnotationDeliveryStatus(atCommitStart, 'settled-1'), false)
  assert.deepEqual(updateAnnotationDeliveryStatus(atCommitStart, 'settled-1', 'candidate'), atCommitStart)
  assert.deepEqual(updateAnnotationDeliveryStatus(atCommitStart, 'missing', 'failed'), atCommitStart)
  assert.equal(verifiedWriteCleanupAllowed({ annotationCount: pendingAnnotationCount(atCommitStart), candidateReviewActive: false }), true)

  const arrivedDuringCommit = [...atCommitStart, { id: 'sending-2', deliveryStatus: 'sending' }]
  assert.equal(verifiedWriteCleanupAllowed({ annotationCount: pendingAnnotationCount(arrivedDuringCommit), candidateReviewActive: false }), false)
  const recoverable = failUnsettledAnnotations(arrivedDuringCommit, 'write completed before review settlement')
  assert.deepEqual(JSON.parse(JSON.stringify(recoverable)), [
    { id: 'settled-1', deliveryStatus: 'settled' },
    { id: 'sending-2', deliveryStatus: 'failed', lastError: 'write completed before review settlement' },
  ])
  assert.equal(verifiedWriteCleanupAllowed({ annotationCount: pendingAnnotationCount(recoverable), candidateReviewActive: false }), false)
})

test('an undo that restores the text but invalidates its revision cannot release PRD adoption', () => {
  const saved = { snapshotContent: '# saved', editorMarkdown: '# saved', candidateReviewActive: false, preparedWrite: false, committing: false, externalUpdatePending: false, truncated: false }
  const submitted = { editorRevision: 7, from: 4, to: 9, markdown: '# saved' }
  const afterInputAndUndo = { editorRevision: 9, from: 4, to: 9, markdown: '# saved' }
  assert.equal(afterInputAndUndo.markdown, submitted.markdown)
  assert.notEqual(afterInputAndUndo.editorRevision, submitted.editorRevision)

  let mountCalls = 0
  const result = reviewSelectionProposal(submitted, submitted, () => {
    mountCalls += 1
    return afterInputAndUndo.editorRevision === submitted.editorRevision
  })
  assert.equal(mountCalls, 1)
  assert.equal(result, 'mount-rejected')
  assert.equal(reviewSelectionProposal(submitted, { ...submitted, editorRevision: 8 }, () => { throw new Error('stale proposal must not mount') }), 'selection-changed')

  const annotation = [{ id: 'annotation-1', deliveryStatus: 'processing' }]
  const staleProposal = updateAnnotationDeliveryStatus(annotation, 'annotation-1', result === 'mount-rejected' ? 'failed' : 'candidate', '编辑版本已变化')
  assert.equal(staleProposal[0].deliveryStatus, 'failed')
  assert.match(adoptionBlockedReason({ ...saved, annotationCount: pendingAnnotationCount(staleProposal) }), /未结算/)

  const retried = updateAnnotationDeliveryStatus(staleProposal, 'annotation-1', 'sending')
  assert.match(adoptionBlockedReason({ ...saved, annotationCount: pendingAnnotationCount(retried) }), /未结算/)

  const settled = updateAnnotationDeliveryStatus(retried, 'annotation-1', 'settled')
  assert.equal(settled[0].deliveryStatus, 'settled')
  assert.equal(adoptionBlockedReason({ ...saved, annotationCount: pendingAnnotationCount(settled) }), undefined)
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
