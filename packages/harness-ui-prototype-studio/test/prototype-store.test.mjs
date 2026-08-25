import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import ts from 'typescript'
import { firstPrototypeQualityIssues, PrototypeProjectStore, revisionComparison } from '../src/prototype-store.mjs'

const TEST_BRIEF = { v: 1, audience: '产品经理', coreTask: '查看并操作产品原型', requiredPages: ['首页'], requiredFlows: ['打开说明弹窗'] }

async function contracts() {
  const source = await readFile(new URL('../src/prototype-document.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Date.now()}`)
}

async function writeLocked(store, record) {
  return store.mutate(record.id, fence => store.write(record, fence))
}

test('explicitly rebinds a saved project to another Harness conversation with verified readback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-session-rebind-')); t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'evidence-rebind', source: { url: 'https://example.test/rebind', title: '参考', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-session-rebind'; const capability = 'rebind-capability-abcdefghijklmnopqrstuvwxyz-123456'
  await store.open({ projectId, sessionId: 'session-old', capability, evidence: [evidence] })
  await assert.rejects(() => store.rebindSession({ projectId, capability: 'wrong-capability-abcdefghijklmnopqrstuvwxyz-123456', expectedSessionId: 'session-old', sessionId: 'session-new' }), /capability is invalid/)
  await assert.rejects(() => store.rebindSession({ projectId, capability, expectedSessionId: 'session-stale', sessionId: 'session-new' }), /session changed/)
  const rebound = await store.rebindSession({ projectId, capability, expectedSessionId: 'session-old', sessionId: 'session-new' })
  assert.equal(rebound.status, 'verified_write'); assert.equal(rebound.previousSessionId, 'session-old'); assert.equal(rebound.sessionId, 'session-new'); assert.equal(rebound.snapshot.sessionId, 'session-new')
  assert.equal((await store.authorizedSnapshot(projectId, capability)).sessionId, 'session-new')
  await assert.rejects(() => store.saveBriefSuggestion({ projectId, sessionId: 'session-old', requestId: 'brief-rebind-old', brief: TEST_BRIEF }), /different Harness session/)
})

test('renames and explicitly deletes only the authorized prototype project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-manage-project-')); t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'evidence-manage', source: { url: 'https://example.test/manage', title: '参考标题', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-manage-project'; const capability = 'manage-capability-abcdefghijklmnopqrstuvwxyz-123456'
  assert.equal((await store.open({ projectId, sessionId: 'session-manage', capability, evidence: [evidence] })).projectName, '参考标题')
  await assert.rejects(() => store.renameProject({ projectId, capability, projectName: '   ' }), /Invalid prototype project name/)
  const renamed = await store.renameProject({ projectId, capability, projectName: '  供应商准入方案 A  ' })
  assert.equal(renamed.status, 'verified_write'); assert.equal(renamed.snapshot.projectName, '供应商准入方案 A')
  await assert.rejects(() => store.deleteProject({ projectId, capability, confirmationProjectId: 'prototype-another-project' }), /confirmation is invalid/)
  await assert.rejects(() => store.deleteProject({ projectId, capability: 'wrong-capability-abcdefghijklmnopqrstuvwxyz-123456', confirmationProjectId: projectId }), /capability is invalid/)
  assert.deepEqual(await store.deleteProject({ projectId, capability, confirmationProjectId: projectId }), { status: 'verified_delete', projectId })
  await assert.rejects(() => store.authorizedSnapshot(projectId, capability), error => error?.code === 'ENOENT')
})

test('stores an unconfirmed request-bound product brief suggestion and clears it only on confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-brief-suggestion-')); t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'evidence-suggestion', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-brief-suggestion'; const capability = 'capability-abcdefghijklmnopqrstuvwxyz-1234567890'; const designSpec = { v: 1, id: 'design-suggestion', name: '规范', basedOnEvidenceIds: [evidence.id], summary: '规范', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  await store.open({ projectId, sessionId: 'session-suggestion', capability, evidence: [evidence] }); await store.confirmDesign({ projectId, capability, designSpec })
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-001' })
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-replaced-before-save' })
  await assert.rejects(() => store.saveBriefSuggestion({ projectId, sessionId: 'session-suggestion', requestId: 'brief-suggestion-001', brief: TEST_BRIEF }), /no longer active/)
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-001' })
  await assert.rejects(() => store.saveBriefSuggestion({ projectId, sessionId: 'wrong-session', requestId: 'brief-suggestion-001', brief: TEST_BRIEF }), /different Harness session/)
  await assert.rejects(() => store.saveBriefSuggestion({ projectId, sessionId: 'session-suggestion', requestId: 'brief-suggestion-wrong', brief: TEST_BRIEF }), /no longer active/)
  await store.saveBriefSuggestion({ projectId, sessionId: 'session-suggestion', requestId: 'brief-suggestion-001', brief: TEST_BRIEF })
  const snapshot = await store.authorizedSnapshot(projectId, capability); assert.deepEqual(snapshot.suggestedProductBrief, TEST_BRIEF); assert.equal(snapshot.briefSuggestionAttempt.status, 'saved')
  await assert.rejects(() => store.saveBriefSuggestion({ projectId, sessionId: 'session-suggestion', requestId: 'brief-suggestion-001', brief: TEST_BRIEF }), /no longer active/)
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-002' })
  const replaced = await store.authorizedSnapshot(projectId, capability); assert.equal(replaced.briefSuggestionAttempt.requestId, 'brief-suggestion-002'); assert.equal(replaced.suggestedProductBrief, undefined)
  await store.saveBriefSuggestion({ projectId, sessionId: 'session-suggestion', requestId: 'brief-suggestion-002', brief: TEST_BRIEF })
  await store.confirmProductBrief({ projectId, capability, brief: TEST_BRIEF }); const confirmed = await store.authorizedSnapshot(projectId, capability); assert.equal(confirmed.suggestedProductBrief, undefined); assert.equal(confirmed.briefSuggestionAttempt, undefined)
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-expired' })
  const expired = JSON.parse(await readFile(store.file(projectId), 'utf8')); expired.briefSuggestionAttempt.expiresAt = Date.now() - 1; await writeFile(store.file(projectId), JSON.stringify(expired))
  await store.beginBriefSuggestion({ projectId, capability, requestId: 'brief-suggestion-replacement' })
  assert.equal((await store.authorizedSnapshot(projectId, capability)).briefSuggestionAttempt.requestId, 'brief-suggestion-replacement')
})

test('saves revisions with session binding, compare-and-swap, and verified readback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts()
  const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'evidence-ref', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb', '#ffffff'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-12345678'
  const capability = 'capability-abcdefghijklmnopqrstuvwxyz-1234567890'
  const opened = await store.open({ projectId, sessionId: 'session-1', capability, evidence: [evidence] })
  assert.equal(opened.revisions.length, 0)
  assert.equal(opened.designConfirmed, false)
  const designSpec = { v: 1, id: 'design-ref', name: '参考规范', basedOnEvidenceIds: ['evidence-ref'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }, { name: '底色', value: '#ffffff', usage: '页面' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const staticDocument = { v: 1, id: 'prototype-doc', title: '产品原型', designSpecId: 'design-ref', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '首页' }] }] }
  const document = { ...staticDocument, screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '首页' }, { id: 'summary', type: 'group', layout: 'grid-2', children: [{ id: 'pending', type: 'metric', label: '待处理', value: '8' }, { id: 'risk', type: 'alert', title: '2 项需要关注', tone: 'warning' }, { id: 'status', type: 'badge', text: '处理中', tone: 'primary' }, { id: 'completion', type: 'progress', label: '完成度', value: 62 }] }, { id: 'search', type: 'input', label: '搜索项目', inputType: 'search' }, { id: 'open-help', type: 'button', label: '查看说明', action: { type: 'open-modal', targetId: 'help' } }, { id: 'help', type: 'modal', title: '说明', children: [{ id: 'help-copy', type: 'text', text: '真实交互' }] }] }] }
  await store.beginGeneration({ projectId, capability, requestId: 'request-unconfirmed-001', brief: TEST_BRIEF })
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', requestId: 'request-unconfirmed-001', designSpec, document, changeSummary: '未确认' }), /must be confirmed/)
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-unconfirmed-001', error: '设计规范尚未确认。' })
  await store.cancelGeneration({ projectId, capability, requestId: 'request-unconfirmed-001' })
  const confirmation = await store.confirmDesign({ projectId, capability, designSpec })
  assert.equal(confirmation.status, 'verified_write')
  const confirmedSnapshot = await store.authorizedSnapshot(projectId, capability)
  assert.equal(confirmedSnapshot.designConfirmed, true)
  assert.deepEqual(confirmedSnapshot.confirmedDesignSpec, designSpec)
  assert.equal(confirmedSnapshot.currentRevisionId, undefined)
  const briefConfirmation = await store.confirmProductBrief({ projectId, capability, brief: TEST_BRIEF })
  assert.deepEqual(briefConfirmation, { status: 'verified_write', projectId, productBrief: TEST_BRIEF, productBriefFingerprint: await schema.sha256Fingerprint(TEST_BRIEF) })
  assert.deepEqual((await store.authorizedSnapshot(projectId, capability)).productBrief, TEST_BRIEF)
  await assert.rejects(() => store.reopenDesign({ projectId, capability: 'wrong-capability-that-is-long-enough-123456' }), /capability is invalid/)
  await store.beginGeneration({ projectId, capability, requestId: 'request-reopen-active-0001' })
  await assert.rejects(() => store.reopenDesign({ projectId, capability }), /generation request is still active/)
  await store.cancelGeneration({ projectId, capability, requestId: 'request-reopen-active-0001' })
  assert.deepEqual((await store.authorizedSnapshot(projectId, capability)).productBrief, TEST_BRIEF)
  const reopened = await store.reopenDesign({ projectId, capability })
  assert.deepEqual(reopened, { status: 'verified_write', projectId, designConfirmed: false })
  const reopenedSnapshot = await store.authorizedSnapshot(projectId, capability)
  assert.equal(reopenedSnapshot.designConfirmed, false)
  assert.equal(reopenedSnapshot.confirmedDesignSpec, undefined)
  await store.confirmDesign({ projectId, capability, designSpec })
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-brief-drift-001', brief: { ...TEST_BRIEF, audience: '另一类用户' } }), /已经变化/)
  await store.beginGeneration({ projectId, capability, requestId: 'request-static-0002', brief: TEST_BRIEF })
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', requestId: 'request-static-0002', document: staticDocument, changeSummary: '静态首版' }), /至少需要一条可演示交互流程/)
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-static-0002', error: '缺少交互流程。' })
  await store.cancelGeneration({ projectId, capability, requestId: 'request-static-0002' })
  await store.beginGeneration({ projectId, capability, requestId: 'request-first-save-003', brief: TEST_BRIEF })
  const first = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-first-save-003', document, changeSummary: '初始版本' })
  assert.equal(first.status, 'verified_write')
  await assert.rejects(() => store.reopenDesign({ projectId, capability }), /already has saved history/)
  await store.beginGeneration({ projectId, capability, requestId: 'request-invalid-spec-4', expectedRevisionId: first.revisionId })
  await assert.rejects(
    () => store.save({ projectId, sessionId: 'session-1', requestId: 'request-invalid-spec-4', expectedRevisionId: first.revisionId, designSpec: { ...designSpec, surfaces: { page: 'invalid', surface: '#fff', elevated: '#fff', text: '#111', textMuted: '#666', border: '#ddd' } }, document, changeSummary: '错误规范' }),
    /设计规范的表面颜色无效/,
  )
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-invalid-spec-4', error: '设计规范无效。' })
  await store.cancelGeneration({ projectId, capability, requestId: 'request-invalid-spec-4', expectedRevisionId: first.revisionId })
  await store.beginGeneration({ projectId, capability, requestId: 'request-tampered-spec5', expectedRevisionId: first.revisionId })
  await assert.rejects(
    () => store.save({ projectId, sessionId: 'session-1', requestId: 'request-tampered-spec5', expectedRevisionId: first.revisionId, designSpec: { ...designSpec, colors: [{ name: '主色', value: '#dc2626', usage: '按钮' }] }, document, changeSummary: '篡改规范' }),
    /exact design specification confirmed by the user/,
  )
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-tampered-spec5', error: '设计规范被篡改。' })
  await store.cancelGeneration({ projectId, capability, requestId: 'request-tampered-spec5', expectedRevisionId: first.revisionId })
  await store.beginGeneration({ projectId, capability, requestId: 'request-session-check6', expectedRevisionId: first.revisionId })
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-other', requestId: 'request-session-check6', expectedRevisionId: first.revisionId, designSpec, document, changeSummary: '越权' }), /different Harness session/)
  await store.cancelGeneration({ projectId, capability, requestId: 'request-session-check6', expectedRevisionId: first.revisionId })
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-old-baseline-7', expectedRevisionId: 'rev-old' }), /revision conflict/)
  const legacyRecord = await store.read(projectId)
  delete legacyRecord.confirmedDesignSpec
  delete legacyRecord.confirmedDesignSpecFingerprint
  await writeLocked(store, legacyRecord)
  await store.beginGeneration({ projectId, capability, requestId: 'request-legacy-repair8', expectedRevisionId: first.revisionId })
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-legacy-repair8', error: new Error('设计规范的边框系统无效。') })
  assert.match((await store.authorizedSnapshot(projectId, capability)).lastAttempt.message, /边框系统/)
  await store.cancelGeneration({ projectId, capability, requestId: 'request-legacy-repair8', expectedRevisionId: first.revisionId })
  await store.beginGeneration({ projectId, capability, requestId: 'request-second-save09', expectedRevisionId: first.revisionId })
  const second = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-second-save09', expectedRevisionId: first.revisionId, designSpec, document: { ...document, title: '产品原型第二版' }, changeSummary: '修改标题' })
  const inspected = await store.inspectRevision({ projectId, capability, targetRevisionId: first.revisionId })
  assert.equal(inspected.revisionId, first.revisionId)
  assert.equal(inspected.current, false)
  assert.equal(inspected.document.title, '产品原型')
  assert.equal(inspected.comparedToRevisionId, second.revisionId)
  assert.match(inspected.comparison.details.join(' '), /原型名称/)
  await assert.rejects(() => store.inspectRevision({ projectId, capability, targetRevisionId: 'rev-missing' }), /does not exist/)
  await assert.rejects(() => store.inspectRevision({ projectId, capability: 'wrong-capability-that-is-long-enough-123456', targetRevisionId: first.revisionId }), /capability is invalid/)
  assert.equal(typeof (await store.read(projectId)).confirmedDesignSpecFingerprint, 'string')
  assert.equal((await store.authorizedSnapshot(projectId, capability)).lastAttempt, undefined)
  await store.beginGeneration({ projectId, capability, requestId: 'request-block-restore12', expectedRevisionId: second.revisionId })
  await assert.rejects(() => store.restore({ projectId, capability, targetRevisionId: first.revisionId, expectedCurrentRevisionId: second.revisionId }), /generation request is still active/)
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-block-restore12', error: '等待模型修正。' })
  await assert.rejects(() => store.restore({ projectId, capability, targetRevisionId: first.revisionId, expectedCurrentRevisionId: second.revisionId }), /generation request is still active/)
  await store.cancelGeneration({ projectId, capability, requestId: 'request-block-restore12', expectedRevisionId: second.revisionId })
  await assert.rejects(() => store.restore({ projectId, capability, targetRevisionId: first.revisionId, expectedCurrentRevisionId: first.revisionId }), /revision conflict/)
  await assert.rejects(() => store.restore({ projectId, capability, targetRevisionId: 'rev-does-not-exist', expectedCurrentRevisionId: second.revisionId }), /does not exist/)
  await assert.rejects(() => store.restore({ projectId, capability: 'wrong-capability-that-is-long-enough-123456', targetRevisionId: first.revisionId, expectedCurrentRevisionId: second.revisionId }), /capability is invalid/)
  const restored = await store.restore({ projectId, capability, targetRevisionId: first.revisionId, expectedCurrentRevisionId: second.revisionId })
  assert.equal(restored.status, 'verified_write')
  assert.equal(restored.revisionId, first.revisionId)
  const snapshot = await store.authorizedSnapshot(projectId, capability)
  assert.equal(snapshot.currentRevisionId, first.revisionId)
  assert.equal(snapshot.document.title, '产品原型')
  assert.equal(snapshot.revisions.length, 2)
  assert.equal(snapshot.requirementCoverage.items.every(item => item.status === 'satisfied'), true)
  assert.equal(inspected.requirementCoverage.items.every(item => item.status === 'satisfied'), true)
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-old-save-0010', expectedRevisionId: second.revisionId }), /revision conflict/)
  /* Restore keeps the full history; a later save starts from the restored revision. */
  await store.beginGeneration({ projectId, capability, requestId: 'request-third-save11', expectedRevisionId: first.revisionId })
  const third = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-third-save11', expectedRevisionId: first.revisionId, designSpec, document: { ...document, title: '恢复后第三版' }, changeSummary: '恢复后修改' })
  assert.equal(third.status, 'verified_write')
  const afterSave = await store.authorizedSnapshot(projectId, capability)
  assert.equal(afterSave.currentRevisionId, third.revisionId)
  assert.equal(afterSave.revisions.length, 3)
  await assert.rejects(() => store.authorizedSnapshot(projectId, 'wrong-capability-that-is-long-enough-123456'), /capability is invalid/)
})

test('explicit recovery rotates an expired capability only for the exact stored reference', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts()
  const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'ref-recovery', source: { url: 'https://example.test/recovery', title: '恢复参考', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['恢复测试参考。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-recovery1'
  const oldCapability = 'old-capability-abcdefghijklmnopqrstuvwxyz-123456'
  const newCapability = 'new-capability-abcdefghijklmnopqrstuvwxyz-123456'
  await store.open({ projectId, sessionId: 'session-recovery', capability: oldCapability, evidence: [evidence] })

  const recovery = { projectId, expectedSessionId: 'session-recovery', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, capability: newCapability, expectedRecoveryEpoch: 0, nonce: '00000000-0000-4000-8000-000000000001', expiresAt: Date.now() + 60_000, runId: 'run-recovery-a' }
  const recovered = await store.recoverCapability(recovery)
  assert.equal(recovered.status, 'verified_write')
  assert.equal(recovered.sessionId, 'session-recovery')
  assert.equal(recovered.recoveryEpoch, 1)
  await assert.rejects(() => store.authorizedSnapshot(projectId, oldCapability), /capability is invalid/)
  assert.equal((await store.authorizedSnapshot(projectId, newCapability)).projectId, projectId)

  assert.deepEqual(await store.recoverCapability(recovery), recovered)
  await assert.rejects(() => store.recoverCapability({ ...recovery, capability: 'third-capability-abcdefghijklmnopqrstuvwxyz-1234' }), /already used/)
  await assert.rejects(() => store.recoverCapability({ ...recovery, expectedRecoveryEpoch: 1 }), /already used/)
  await assert.rejects(() => store.recoverCapability({ ...recovery, nonce: '00000000-0000-4000-8000-000000000002', expectedRecoveryEpoch: 0 }), /does not match/)
  await assert.rejects(() => store.recoverCapability({ ...recovery, nonce: '00000000-0000-4000-8000-000000000003', expectedRecoveryEpoch: 1, expectedSessionId: 'session-wrong' }), /does not match/)
  assert.equal((await store.authorizedSnapshot(projectId, newCapability)).projectId, projectId)

  const concurrentProjectId = 'prototype-recovery-parallel'
  await store.open({ projectId: concurrentProjectId, sessionId: 'session-recovery', capability: oldCapability, evidence: [evidence] })
  const concurrent = await Promise.allSettled([
    store.recoverCapability({ ...recovery, projectId: concurrentProjectId, capability: 'parallel-capability-one-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000004', expectedRecoveryEpoch: 0 }),
    store.recoverCapability({ ...recovery, projectId: concurrentProjectId, capability: 'parallel-capability-two-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000005', expectedRecoveryEpoch: 0 }),
  ])
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(item => item.status === 'rejected').length, 1)
})

test('a fresh Native Host run can rotate from the real disk epoch while old-run assertions stay strict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-recovery-new-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-recovery-new-run'
  const evidence = { v: 1, id: 'ref-recovery-new-run', source: { url: 'https://example.test/recovery-new-run', title: '新运行恢复', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['浏览器重启后保留无密钥绑定。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  await store.open({ projectId, sessionId: 'session-new-run', capability: 'new-run-old-capability-abcdefghijklmnopqrstuvwxyz', evidence: [evidence] })
  const base = { projectId, expectedSessionId: 'session-new-run', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, expectedRecoveryEpoch: 0, expiresAt: Date.now() + 60_000 }
  const first = await store.recoverCapability({ ...base, runId: 'native-run-a', capability: 'new-run-capability-a-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000071' })
  assert.equal(first.recoveryEpoch, 1)
  await assert.rejects(() => store.recoverCapability({ ...base, runId: 'native-run-a', capability: 'new-run-capability-old-run-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000072' }), /does not match/)
  const second = await store.recoverCapability({ ...base, runId: 'native-run-b', capability: 'new-run-capability-b-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000073' })
  assert.equal(second.recoveryEpoch, 2)
  await assert.rejects(() => store.recoverCapability({ ...base, runId: 'native-run-a', capability: 'new-run-capability-old-replay-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000074' }), /earlier Native Host run/)

  const parallel = await Promise.all([
    store.recoverCapability({ ...base, runId: 'native-run-c', capability: 'new-run-capability-c-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000075' }),
    store.recoverCapability({ ...base, runId: 'native-run-d', capability: 'new-run-capability-d-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000076' }),
  ])
  assert.deepEqual(parallel.map(item => item.recoveryEpoch).sort((left, right) => left - right), [3, 4])
  assert.equal((await store.read(projectId)).lastRecoveryRunId === 'native-run-c' || (await store.read(projectId)).lastRecoveryRunId === 'native-run-d', true)
})

test('two independent stores sharing one project directory atomically serialize recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-recovery-cross-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts()
  const left = new PrototypeProjectStore(root, schema)
  const right = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'ref-cross-store', source: { url: 'https://example.test/cross-store', title: '跨实例恢复', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['跨实例恢复测试。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  for (let index = 1; index <= 12; index += 1) {
    const projectId = `prototype-cross-store-${String(index).padStart(2, '0')}`
    const oldCapability = `cross-old-capability-${String(index).padStart(2, '0')}-abcdefghijklmnopqrstuvwxyz`
    await left.open({ projectId, sessionId: 'session-cross-store', capability: oldCapability, evidence: [evidence] })
    const base = { projectId, expectedSessionId: 'session-cross-store', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, expectedRecoveryEpoch: 0, expiresAt: Date.now() + 60_000, runId: 'run-cross-store' }
    const outcomes = await Promise.allSettled([
      left.recoverCapability({ ...base, capability: `cross-new-left-${String(index).padStart(2, '0')}-abcdefghijklmnopqrstuvwxyz`, nonce: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }),
      right.recoverCapability({ ...base, capability: `cross-new-right-${String(index).padStart(2, '0')}-abcdefghijklmnopqrstuvwxyz`, nonce: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}` }),
    ])
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, `iteration ${index}`)
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1, `iteration ${index}`)
    const verified = outcomes.find(outcome => outcome.status === 'fulfilled')
    assert.equal(verified.value.recoveryEpoch, 1)
  }
})

test('two stores ignore a legacy dead-pid lock file and serialize the same recovered project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-recovery-stale-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const left = new PrototypeProjectStore(root, schema); const right = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-stale-lock'
  const evidence = { v: 1, id: 'ref-stale-lock', source: { url: 'https://example.test/stale-lock', title: '遗留锁', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['遗留锁测试。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const oldCapability = 'stale-old-capability-abcdefghijklmnopqrstuvwxyz'
  await left.open({ projectId, sessionId: 'session-stale-lock', capability: oldCapability, evidence: [evidence] })
  // This is the file format left by the retired lock implementation.  It is
  // deliberately ignored, rather than reclaimed with a racy read+unlink.
  await writeFile(join(root, `.${projectId}.recover.lock`), JSON.stringify({ v: 1, owner: '00000000-0000-4000-8000-000000000099', pid: 2_147_483_647, createdAt: Date.now() - 60_000 }), { mode: 0o600 })
  let active = 0; let maxActive = 0
  let releaseLeft; const leftPaused = new Promise(resolve => { releaseLeft = resolve })
  let leftEntered; const leftReady = new Promise(resolve => { leftEntered = resolve })
  const originalLeftWrite = left.write.bind(left)
  const originalRightWrite = right.write.bind(right)
  left.write = async (...args) => {
    active += 1; maxActive = Math.max(maxActive, active); leftEntered()
    await leftPaused
    try { return await originalLeftWrite(...args) } finally { active -= 1 }
  }
  right.write = async (...args) => {
    active += 1; maxActive = Math.max(maxActive, active)
    try { return await originalRightWrite(...args) } finally { active -= 1 }
  }
  const base = { projectId, expectedSessionId: 'session-stale-lock', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, expectedRecoveryEpoch: 0, expiresAt: Date.now() + 60_000, runId: 'run-stale-lock' }
  const first = left.recoverCapability({ ...base, capability: 'stale-new-left-capability-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000098' })
  await leftReady
  const second = right.recoverCapability({ ...base, capability: 'stale-new-right-capability-abcdefghijklmnopqrstuvwxyz', nonce: '00000000-0000-4000-8000-000000000097' })
  await new Promise(resolve => setTimeout(resolve, 25))
  releaseLeft()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(maxActive, 1)
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1)
})

test('a live paused owner is never reclaimed by time, and a cross-store write cannot roll back recovery state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-project-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const oldStore = new PrototypeProjectStore(root, schema); const successorStore = new PrototypeProjectStore(root, schema)
  successorStore.projectLockWaitMs = () => 70
  successorStore.projectLockRetryMs = () => 5
  const projectId = 'prototype-project-lock'
  const evidence = { v: 1, id: 'ref-project-lock', source: { url: 'https://example.test/project-lock', title: '项目写入栅栏', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['项目级跨实例锁测试。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const oldCapability = 'project-lock-old-capability-abcdefghijklmnopqrstuvwxyz'
  const newCapability = 'project-lock-new-capability-abcdefghijklmnopqrstuvwxyz'
  await oldStore.open({ projectId, sessionId: 'session-project-lock', capability: oldCapability, evidence: [evidence] })
  const designSpec = { v: 1, id: 'design-project-lock', name: '项目锁规范', basedOnEvidenceIds: [evidence.id], summary: '用于确认跨进程写入不会回滚。', colors: [{ name: '主要色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  let releaseOldWrite; const oldWritePaused = new Promise(resolve => { releaseOldWrite = resolve })
  let oldWriteEntered; const oldWriteReady = new Promise(resolve => { oldWriteEntered = resolve })
  const originalWrite = oldStore.write.bind(oldStore)
  oldStore.write = async (...args) => { oldWriteEntered(); await oldWritePaused; return originalWrite(...args) }
  const oldAttempt = oldStore.confirmDesign({ projectId, capability: oldCapability, designSpec })
  await oldWriteReady
  await assert.rejects(() => successorStore.recoverCapability({ projectId, expectedSessionId: 'session-project-lock', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, capability: newCapability, expectedRecoveryEpoch: 0, nonce: '00000000-0000-4000-8000-000000000078', expiresAt: Date.now() + 60_000, runId: 'run-project-lock' }), /recovery is busy/)
  releaseOldWrite()
  await oldAttempt
  const successor = await successorStore.recoverCapability({ projectId, expectedSessionId: 'session-project-lock', referenceId: evidence.id, evidenceFingerprint: evidence.fingerprint, capability: newCapability, expectedRecoveryEpoch: 0, nonce: '00000000-0000-4000-8000-000000000079', expiresAt: Date.now() + 60_000, runId: 'run-project-lock' })
  assert.equal(successor.status, 'verified_write')
  const snapshot = await successorStore.authorizedSnapshot(projectId, newCapability)
  assert.equal(snapshot.recoveryEpoch, 1)
  assert.deepEqual(snapshot.confirmedDesignSpec, designSpec)
  await assert.rejects(() => successorStore.authorizedSnapshot(projectId, oldCapability), /capability is invalid/)
})

test('an abandoned SQLite coordinator transaction releases on close and a later mutation continues', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-project-lock-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-project-release'
  const coordinator = await store.openProjectLockCoordinator()
  coordinator.exec('BEGIN IMMEDIATE')
  // Closing an SQLite connection rolls back its active transaction. This is
  // the same release mechanism SQLite uses when a process terminates.
  coordinator.close()
  let entered = false
  await store.withProjectLock(projectId, async () => { entered = true })
  assert.equal(entered, true)
})

test('a rejected project fence removes its unique temporary write file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-project-temp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-project-temp'
  const evidence = { v: 1, id: 'ref-project-temp', source: { url: 'https://example.test/project-temp', title: '临时文件', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['写入栅栏失败时必须清理临时文件。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  await store.open({ projectId, sessionId: 'session-project-temp', capability: 'project-temp-capability-abcdefghijklmnopqrstuvwxyz', evidence: [evidence] })
  const record = await store.read(projectId)
  await assert.rejects(() => store.mutate(projectId, () => store.write({ ...record, updatedAt: new Date().toISOString() }, { assertOwnership: async () => { throw new Error('lost project fence') } })), /lost project fence/)
  assert.equal((await readdir(root)).some(name => name.includes('.tmp')), false)
})

test('revision comparison reports bounded page and component changes', () => {
  const before = { title: '旧版', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '旧标题' }, { id: 'remove', type: 'badge', text: '旧状态' }] }] }
  const after = { title: '新版', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '新标题' }, { id: 'add', type: 'button', label: '新操作' }] }, { id: 'detail', title: '详情页', nodes: [] }] }
  const comparison = revisionComparison(before, after)
  assert.deepEqual([comparison.screenCountBefore, comparison.screenCountAfter], [1, 2])
  assert.deepEqual([comparison.componentCountBefore, comparison.componentCountAfter], [2, 2])
  assert.match(comparison.details.join(' '), /新版/)
  assert.match(comparison.details.join(' '), /详情页/)
  assert.match(comparison.details.join(' '), /新操作/)
  assert.match(comparison.details.join(' '), /旧状态/)
  assert.match(comparison.details.join(' '), /新标题/)
})

test('requires explicit confirmation before replacing the oldest of twenty revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-capacity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const evidence = { v: 1, id: 'evidence-capacity', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] } }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-capacity'; const capability = 'capability-capacity-abcdefghijklmnopqrstuvwxyz'
  const designSpec = { v: 1, id: 'design-capacity', name: '参考规范', basedOnEvidenceIds: ['evidence-capacity'], summary: '参考规范。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = { v: 1, id: 'prototype-capacity-doc', title: '容量原型', designSpecId: 'design-capacity', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '首页' }, { id: 'summary', type: 'group', layout: 'grid-2', children: [{ id: 'pending', type: 'metric', label: '待处理', value: '8' }, { id: 'risk', type: 'alert', title: '需要关注', tone: 'warning' }, { id: 'status', type: 'badge', text: '处理中', tone: 'primary' }, { id: 'completion', type: 'progress', label: '完成度', value: 62 }] }, { id: 'search', type: 'input', label: '搜索项目', inputType: 'search' }, { id: 'open', type: 'button', label: '打开说明', action: { type: 'open-modal', targetId: 'help' } }, { id: 'help', type: 'modal', title: '说明', children: [{ id: 'copy', type: 'text', text: '说明' }] }] }] }
  await store.open({ projectId, sessionId: 'session-capacity', capability, evidence: [evidence] })
  await store.confirmDesign({ projectId, capability, designSpec })
  const revisions = []; let parentRevisionId
  for (let index = 0; index < 20; index += 1) {
    const created = await schema.createTrustedRevision({ id: `rev-capacity-${index}`, ...(parentRevisionId === undefined ? {} : { parentRevisionId }), author: 'agent', document: { ...document, title: `容量原型 ${index}` }, designSpec, evidence: [evidence], changeSummary: `版本 ${index}` })
    assert.equal(created.ok, true, created.ok ? '' : created.errors.join(' '))
    revisions.push({ revision: created.value, designSpec }); parentRevisionId = created.value.id
  }
  const record = await store.read(projectId)
  await writeLocked(store, { ...record, revisions, currentRevisionId: parentRevisionId })
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-capacity-denied', expectedRevisionId: parentRevisionId }), /明确确认替换最旧版本/)
  await store.beginGeneration({ projectId, capability, requestId: 'request-capacity-allowed', expectedRevisionId: parentRevisionId, allowRevisionEviction: true })
  assert.equal((await store.authorizedSnapshot(projectId, capability)).generationAttempt.allowRevisionEviction, true)
  await store.recordFailure({ projectId, sessionId: 'session-capacity', requestId: 'request-capacity-allowed', error: '等待修正' })
  assert.equal((await store.authorizedSnapshot(projectId, capability)).generationAttempt.allowRevisionEviction, true)
  const saved = await store.save({ projectId, sessionId: 'session-capacity', requestId: 'request-capacity-allowed', expectedRevisionId: parentRevisionId, document: { ...document, title: '容量原型 21' }, changeSummary: '第 21 版' })
  const snapshot = await store.authorizedSnapshot(projectId, capability)
  assert.equal(snapshot.revisions.length, 20)
  assert.equal(snapshot.revisions.some(item => item.id === 'rev-capacity-0'), false)
  assert.equal(snapshot.currentRevisionId, saved.revisionId)
})

test('generation lifecycle serializes begins and rejects cancelled or stale saves', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-generation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-87654321'; const capability = 'capability-abcdefghijklmnopqrstuvwxyz-0987654321'
  const evidence = { v: 1, id: 'evidence-generation', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb', '#ffffff'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  await store.open({ projectId, sessionId: 'session-1', capability, evidence: [evidence] })
  const designSpec = { v: 1, id: 'design-generation', name: '参考规范', basedOnEvidenceIds: ['evidence-generation'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  await store.confirmDesign({ projectId, capability, designSpec })
  const document = { v: 1, id: 'prototype-generation', title: '可交互原型', designSpecId: 'design-generation', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '首页' }, { id: 'summary', type: 'group', layout: 'grid-2', children: [{ id: 'pending', type: 'metric', label: '待处理', value: '8' }, { id: 'risk', type: 'alert', title: '2 项需要关注', tone: 'warning' }, { id: 'status', type: 'badge', text: '处理中', tone: 'primary' }, { id: 'completion', type: 'progress', label: '完成度', value: 62 }] }, { id: 'search', type: 'input', label: '搜索项目', inputType: 'search' }, { id: 'open', type: 'button', label: '打开说明弹窗', action: { type: 'open-modal', targetId: 'modal' } }, { id: 'modal', type: 'modal', title: '说明弹窗', children: [{ id: 'modal-copy', type: 'text', text: '真实业务详情' }] }] }] }
  await store.beginGeneration({ projectId, capability, requestId: 'request-pending-0001', brief: TEST_BRIEF })
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-parallel-002' }), /already active/)
  await store.cancelGeneration({ projectId, capability, requestId: 'request-pending-0001' })
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', requestId: 'request-pending-0001', document, changeSummary: '晚到保存' }), /no longer active/)
  const cancelled = await store.authorizedSnapshot(projectId, capability)
  assert.equal(cancelled.generationAttempt, undefined)
  assert.match(cancelled.lastAttempt.message, /取消/)
  assert.equal(cancelled.lastAttempt.requestId, 'request-pending-0001')
  await store.beginGeneration({ projectId, capability, requestId: 'request-failure-003', prompt: '请保留这条失败后可重试的要求', brief: TEST_BRIEF })
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-failure-003', error: '字段不合法' })
  const failed = await store.authorizedSnapshot(projectId, capability)
  assert.equal(failed.generationAttempt.requestId, 'request-failure-003')
  assert.equal(failed.generationAttempt.prompt, '请保留这条失败后可重试的要求')
  assert.match(failed.generationAttempt.message, /字段不合法/)
  await assert.rejects(() => store.beginGeneration({ projectId, capability, requestId: 'request-race-after-error4' }), /already active/)
  const repaired = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-failure-003', document, changeSummary: '修正后首版' })
  assert.equal(repaired.status, 'verified_write')
  await store.beginGeneration({ projectId, capability, requestId: 'request-success-004', expectedRevisionId: repaired.revisionId, prompt: '增加风险筛选和详情弹窗' })
  assert.equal((await store.authorizedSnapshot(projectId, capability)).generationAttempt.prompt, '增加风险筛选和详情弹窗')
  const saved = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-success-004', expectedRevisionId: repaired.revisionId, document: { ...document, title: '第二版' }, changeSummary: '完成第二版' })
  assert.equal(saved.status, 'verified_write')
  const complete = await store.authorizedSnapshot(projectId, capability)
  assert.equal(complete.generationAttempt, undefined)
  assert.equal(complete.lastAttempt, undefined)
})

test('first-version quality gate rejects skeletons, fake multi-page navigation, and forms without required feedback', () => {
  const skeleton = { screens: [{ nodes: [{ type: 'text' }, { type: 'group' }, { type: 'metric' }, { type: 'metric' }, { type: 'alert' }, { type: 'button', action: { type: 'open-modal' } }, { type: 'modal', children: [{ type: 'text' }] }] }] }
  assert.match(firstPrototypeQualityIssues(skeleton).join('\n'), /10 个真实组件/)
  assert.match(firstPrototypeQualityIssues(skeleton).join('\n'), /表单、表格、列表、图表或空状态/)
  const form = { screens: [{ nodes: Array.from({ length: 8 }, (_, index) => ({ type: index === 0 ? 'input' : 'text', ...(index === 0 ? {} : { text: String(index) }) })).concat([{ type: 'button', action: { type: 'submit-success' } }, { type: 'alert' }]) }] }
  assert.match(firstPrototypeQualityIssues(form).join('\n'), /required 必填字段/)
  const vagueForm = { screens: [{ nodes: [{ type: 'input', required: true }, ...Array.from({ length: 7 }, () => ({ type: 'text' })), { type: 'button', action: { type: 'submit-success' } }, { type: 'alert' }] }] }
  assert.match(firstPrototypeQualityIssues(vagueForm).join('\n'), /具体 errorText/)
  const fakeForm = { screens: [{ nodes: Array.from({ length: 9 }, (_, index) => ({ type: index === 0 ? 'alert' : 'text', text: String(index) })).concat([{ type: 'button', action: { type: 'submit-success' } }]) }] }
  assert.match(firstPrototypeQualityIssues(fakeForm).join('\n'), /真实输入字段/)
  const threePages = { screens: [{ nodes: [] }, { nodes: [] }, { nodes: [] }] }
  assert.match(firstPrototypeQualityIssues(threePages).join('\n'), /shell 产品导航/)
  const checklist = { ...TEST_BRIEF, requiredPages: ['工作台', '列表', '详情'], requiredFlows: ['筛选', '打开详情', '审批'] }
  assert.match(firstPrototypeQualityIssues(skeleton, checklist).join('\n'), /至少需要 3 个可导航页面/)
  assert.match(firstPrototypeQualityIssues(skeleton, checklist).join('\n'), /可信运行器逐步骤回放/)

  const unrelated = {
    shell: { productName: '无关产品', placement: 'sidebar' },
    screens: [
      { title: '新闻', nodes: [{ type: 'list', label: '消息' }, { type: 'alert', title: '提醒' }, { type: 'button', label: '收藏', action: { type: 'open-modal' } }, { type: 'text', text: 'A' }] },
      { title: '日历', nodes: [{ type: 'input', label: '日期' }, { type: 'button', label: '保存日程', action: { type: 'navigate' } }, { type: 'text', text: 'B' }] },
      { title: '设置', nodes: [{ type: 'button', label: '切换主题', action: { type: 'toggle' } }, { type: 'text', text: 'C' }, { type: 'badge', text: '完成' }] },
    ],
  }
  const explicitChecklist = { ...checklist, requiredModules: ['风险记录'] }
  const unrelatedIssues = firstPrototypeQualityIssues(unrelated, explicitChecklist).join('\n')
  assert.match(unrelatedIssues, /页面尚未真正出现：工作台、列表、详情/)
  assert.match(unrelatedIssues, /关键模块尚未在页面中可见：风险记录/)
  assert.match(unrelatedIssues, /必须演示流程还没有通过可信运行器逐步骤回放：筛选、打开详情、审批/)

  const genericLabels = {
    shell: { productName: '空壳产品', placement: 'sidebar' },
    screens: [
      { title: '页面', nodes: [{ type: 'list', label: '列表' }, { type: 'alert', title: '信息' }, { type: 'button', label: '操作', action: { type: 'open-modal' } }, ...Array.from({ length: 7 }, (_, index) => ({ type: 'text', text: `占位${index}` }))] },
      { title: '详情', nodes: [{ type: 'button', label: '流程', action: { type: 'navigate' } }] },
      { title: '管理', nodes: [{ type: 'button', label: '结果', action: { type: 'toggle' } }] },
    ],
  }
  const genericIssues = firstPrototypeQualityIssues(genericLabels, { ...TEST_BRIEF, requiredPages: ['供应商列表页面', '供应商详情页面', '审批管理页面'], requiredModules: ['供应商风险列表'], requiredFlows: ['筛选供应商', '打开供应商详情', '审批供应商'] }).join('\n')
  assert.match(genericIssues, /页面尚未真正出现：供应商列表页面、供应商详情页面、审批管理页面/)
  assert.match(genericIssues, /关键模块尚未在页面中可见：供应商风险列表/)
  assert.match(genericIssues, /必须演示流程还没有通过可信运行器逐步骤回放：筛选供应商、打开供应商详情、审批供应商/)

  const visibleInRows = structuredClone(genericLabels)
  visibleInRows.screens[0].nodes[0] = { type: 'table', label: '风险记录', columns: [{ key: 'name', label: '名称' }], rows: [{ values: ['供应商风险列表'] }] }
  const rowIssues = firstPrototypeQualityIssues(visibleInRows, { ...TEST_BRIEF, requiredPages: ['页面', '详情', '管理'], requiredModules: ['供应商风险列表'], requiredFlows: ['操作', '流程', '结果'] }).join('\n')
  assert.doesNotMatch(rowIssues, /关键模块尚未在页面中可见/)

  const genericFlowVerbs = structuredClone(genericLabels)
  genericFlowVerbs.screens[0].nodes[2].label = '筛选'
  genericFlowVerbs.screens[1].nodes[0].label = '打开'
  genericFlowVerbs.screens[2].nodes[0].label = '审批'
  const verbIssues = firstPrototypeQualityIssues(genericFlowVerbs, { ...TEST_BRIEF, requiredPages: ['页面', '详情', '管理'], requiredFlows: ['筛选风险供应商', '打开供应商档案', '审批供应商准入'] }).join('\n')
  assert.match(verbIssues, /必须演示流程还没有通过可信运行器逐步骤回放：筛选风险供应商、打开供应商档案、审批供应商准入/)

  const nativeTabs = { screens: [{ id: 'home', title: '首页', nodes: [{ id: 'supplier-tabs', type: 'tabs', tabs: [{ id: 'pending-tab', label: '待审批供应商', children: [{ id: 'pending-list', type: 'list', label: '待审批列表' }] }, { id: 'approved-tab', label: '已审批供应商', children: [{ id: 'approved-alert', type: 'alert', title: '审批完成' }] }] }, ...Array.from({ length: 7 }, (_, index) => ({ id: `business-${index}`, type: 'text', text: `业务内容${index}` }))] }] }
  const tabIssues = firstPrototypeQualityIssues(nativeTabs, { ...TEST_BRIEF, requiredFlows: ['切换到已审批供应商'] }).join('\n')
  assert.doesNotMatch(tabIssues, /独立交互入口/)
  assert.doesNotMatch(tabIssues, /可信运行器逐步骤回放/)

  const shellNavigation = { shell: { items: [{ id: 'nav-home', label: '工作台', targetScreenId: 'home' }, { id: 'nav-detail', label: '供应商详情', targetScreenId: 'detail' }] }, screens: [{ id: 'home', title: '工作台', nodes: [{ id: 'supplier-list', type: 'list', label: '供应商列表' }, { id: 'risk-alert', type: 'alert', title: '风险提醒' }, ...Array.from({ length: 8 }, (_, index) => ({ id: `content-${index}`, type: 'text', text: `内容${index}` }))] }, { id: 'detail', title: '供应商详情', nodes: [] }] }
  const shellIssues = firstPrototypeQualityIssues(shellNavigation, { ...TEST_BRIEF, requiredPages: ['工作台', '供应商详情'], requiredFlows: ['进入供应商详情'] }).join('\n')
  assert.doesNotMatch(shellIssues, /独立交互入口/)
  assert.doesNotMatch(shellIssues, /可信运行器逐步骤回放/)

  const oneSequence = {
    screens: [{ title: '工作台', nodes: [{ type: 'list', label: '供应商列表' }, { type: 'alert', title: '风险记录' }, ...Array.from({ length: 7 }, (_, index) => ({ type: 'text', text: `内容${index}` })), { type: 'button', label: '处理全部', action: { type: 'sequence', actions: [{ type: 'set-state' }, { type: 'open-modal' }, { type: 'navigate' }] } }] }],
  }
  assert.match(firstPrototypeQualityIssues(oneSequence, { ...TEST_BRIEF, requiredFlows: ['筛选供应商', '打开详情', '审批'] }).join('\n'), /可信运行器逐步骤回放/)
})

test('full revisions keep the confirmed checklist and accept a compact valid prototype', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-revision-checklist-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-55667788'; const capability = 'capability-revision-checklist-abcdefghijklmnopqrstuvwxyz'
  const evidence = { v: 1, id: 'evidence-revision-checklist', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const designSpec = { v: 1, id: 'design-revision-checklist', name: '参考规范', basedOnEvidenceIds: ['evidence-revision-checklist'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const brief = { v: 1, audience: '产品经理', coreTask: '查看供应商风险并打开详情', requiredPages: ['工作台', '供应商详情'], requiredModules: ['供应商风险列表'], requiredFlows: ['打开供应商详情'] }
  const initial = { v: 1, id: 'prototype-revision-checklist', title: '供应商准入', designSpecId: 'design-revision-checklist', initialScreenId: 'workspace', screens: [
    { id: 'workspace', title: '工作台', nodes: [{ id: 'risk-list', type: 'table', label: '供应商风险列表', columns: [{ key: 'name', label: '供应商' }], rows: [{ id: 'risk-row', values: ['高风险供应商'] }] }, { id: 'risk-alert', type: 'alert', title: '存在风险', tone: 'warning' }, ...Array.from({ length: 7 }, (_, index) => ({ id: `copy-${index}`, type: 'text', text: `业务说明${index}` })), { id: 'open-detail', type: 'button', label: '打开供应商详情', action: { type: 'navigate', targetScreenId: 'detail' } }] },
    { id: 'detail', title: '供应商详情', nodes: [{ id: 'detail-copy', type: 'text', text: '供应商详情内容' }] },
  ] }
  await store.open({ projectId, sessionId: 'session-revision-checklist', capability, evidence: [evidence] })
  await store.confirmDesign({ projectId, capability, designSpec })
  await store.confirmProductBrief({ projectId, capability, brief })
  await store.beginGeneration({ projectId, capability, requestId: 'request-revision-first-001' })
  const first = await store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-revision-first-001', document: initial, changeSummary: '首版完整原型' })

  const degraded = { ...initial, title: '错误降级版本', screens: [{ id: 'workspace', title: '工作台', nodes: [{ id: 'general-list', type: 'list', label: '一般信息', items: [{ id: 'general-item', title: '普通提醒' }] }, { id: 'general-alert', type: 'alert', title: '提示', tone: 'info' }, { id: 'copy', type: 'text', text: '只剩工作台标题' }, { id: 'open-help', type: 'button', label: '打开帮助', action: { type: 'open-modal', targetId: 'help' } }, { id: 'help', type: 'modal', title: '帮助', children: [{ id: 'help-copy', type: 'text', text: '帮助内容' }] }] }] }
  await store.beginGeneration({ projectId, capability, requestId: 'request-revision-reject-002', expectedRevisionId: first.revisionId })
  await assert.rejects(
    () => store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-revision-reject-002', expectedRevisionId: first.revisionId, document: degraded, changeSummary: '错误删除需求内容' }),
    /页面尚未真正出现：供应商详情/,
  )
  assert.equal((await store.authorizedSnapshot(projectId, capability)).currentRevisionId, first.revisionId)

  // A complete re-generation may be more compact than the initial draft. It
  // still passes because it retains each confirmed page, module, and flow.
  const compact = { ...initial, title: '精简但完整的第二版', screens: [
    { id: 'workspace', title: '工作台', nodes: [{ id: 'risk-list', type: 'table', label: '供应商风险列表', columns: [{ key: 'name', label: '供应商' }], rows: [{ id: 'risk-row', values: ['高风险供应商'] }] }, { id: 'risk-alert', type: 'alert', title: '仍有风险', tone: 'warning' }, { id: 'copy', type: 'text', text: '风险说明' }, { id: 'open-detail', type: 'button', label: '打开供应商详情', action: { type: 'navigate', targetScreenId: 'detail' } }, { id: 'help', type: 'modal', title: '使用说明', children: [{ id: 'help-copy', type: 'text', text: '查看风险详情' }] }] },
    { id: 'detail', title: '供应商详情', nodes: [{ id: 'detail-copy', type: 'text', text: '供应商详情内容' }] },
  ] }
  const second = await store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-revision-reject-002', expectedRevisionId: first.revisionId, document: compact, changeSummary: '精简完整原型' })
  assert.equal(second.status, 'verified_write')

  const updatedBrief = { ...brief, requiredPages: [...brief.requiredPages, '风险报表'], requiredModules: [...brief.requiredModules, '风险趋势图'], requiredFlows: [...brief.requiredFlows, '打开风险报表'] }
  await store.beginGeneration({ projectId, capability, requestId: 'request-requirements-update-003', expectedRevisionId: second.revisionId, brief: updatedBrief })
  await assert.rejects(
    () => store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-requirements-update-003', expectedRevisionId: second.revisionId, document: compact, changeSummary: '遗漏新增需求' }),
    /页面尚未真正出现：风险报表/,
  )
  const expanded = structuredClone(compact)
  expanded.screens[0].nodes.push({ id: 'open-report', type: 'button', label: '打开风险报表', action: { type: 'navigate', targetScreenId: 'report' } })
  expanded.screens.push({ id: 'report', title: '风险报表', nodes: [{ id: 'risk-trend', type: 'chart', label: '风险趋势图', bars: [{ label: '本周', value: 8 }] }] })
  const third = await store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-requirements-update-003', expectedRevisionId: second.revisionId, document: expanded, changeSummary: '加入风险报表' })
  assert.deepEqual((await store.authorizedSnapshot(projectId, capability)).productBrief, updatedBrief)

  const oldPreview = await store.inspectRevision({ projectId, capability, targetRevisionId: second.revisionId })
  assert.equal(oldPreview.productBriefKnown, true)
  assert.deepEqual(oldPreview.productBrief, brief)
  await store.restore({ projectId, capability, targetRevisionId: second.revisionId, expectedCurrentRevisionId: third.revisionId })
  assert.deepEqual((await store.authorizedSnapshot(projectId, capability)).productBrief, brief)
  await store.restore({ projectId, capability, targetRevisionId: third.revisionId, expectedCurrentRevisionId: second.revisionId })
  assert.deepEqual((await store.authorizedSnapshot(projectId, capability)).productBrief, updatedBrief)

  const legacy = await store.read(projectId)
  await writeLocked(store, { ...legacy, revisions: legacy.revisions.map(item => item.revision.id === second.revisionId ? { revision: item.revision, designSpec: item.designSpec } : item) })
  await assert.rejects(
    () => store.restore({ projectId, capability, targetRevisionId: second.revisionId, expectedCurrentRevisionId: third.revisionId }),
    /没有保存当时的产品需求，并且不满足当前需求/,
  )
  assert.equal((await store.authorizedSnapshot(projectId, capability)).currentRevisionId, third.revisionId)

  await store.beginGeneration({ projectId, capability, requestId: 'request-preserve-updated-004', expectedRevisionId: third.revisionId })
  await assert.rejects(
    () => store.save({ projectId, sessionId: 'session-revision-checklist', requestId: 'request-preserve-updated-004', expectedRevisionId: third.revisionId, document: compact, changeSummary: '错误删除新增需求' }),
    /页面尚未真正出现：风险报表/,
  )
})

test('Host persists and enforces local edit scope through failure, refresh, cancellation, and save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-local-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = await contracts(); const store = new PrototypeProjectStore(root, schema)
  const projectId = 'prototype-11223344'; const capability = 'capability-local-edit-abcdefghijklmnopqrstuvwxyz'
  const evidence = { v: 1, id: 'evidence-local-edit', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb', '#ffffff'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await schema.computeReferenceEvidenceFingerprint(evidence)
  const designSpec = { v: 1, id: 'design-local-edit', name: '参考规范', basedOnEvidenceIds: ['evidence-local-edit'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = { v: 1, id: 'prototype-local-edit', title: '供应商准入', designSpecId: 'design-local-edit', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [
    { id: 'title', type: 'text', text: '供应商准入' },
    { id: 'overview', type: 'group', layout: 'grid-2', children: [{ id: 'pending', type: 'metric', label: '待处理', value: '8' }, { id: 'risk', type: 'alert', title: '风险供应商', tone: 'warning' }, { id: 'status', type: 'badge', text: '处理中', tone: 'primary' }, { id: 'progress', type: 'progress', label: '审批完成度', value: 62 }] },
    { id: 'search', type: 'input', label: '搜索供应商', inputType: 'search' },
    { id: 'open-details', type: 'button', label: '查看详情', action: { type: 'open-modal', targetId: 'details' } },
    { id: 'details', type: 'modal', title: '供应商详情', children: [{ id: 'details-copy', type: 'text', text: '等待审批' }] },
  ] }] }
  const selection = { elementId: 'open-details', type: 'button', label: '查看详情' }
  await store.open({ projectId, sessionId: 'session-1', capability, evidence: [evidence] })
  await store.confirmDesign({ projectId, capability, designSpec })
  await store.beginGeneration({ projectId, capability, requestId: 'request-local-initial-001', brief: { ...TEST_BRIEF, requiredFlows: ['查看供应商详情'] } })
  const first = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-local-initial-001', document, changeSummary: '初始原型' })

  await store.beginGeneration({ projectId, capability, requestId: 'request-local-failure-002', expectedRevisionId: first.revisionId, selection })
  const started = await store.authorizedSnapshot(projectId, capability)
  assert.equal(started.generationAttempt.localEditScope.selection.elementId, 'open-details')
  assert.match(started.generationAttempt.localEditScope.baselineDocumentFingerprint, /^[a-f0-9]{64}$/)
  await store.recordFailure({ projectId, sessionId: 'session-1', requestId: 'request-local-failure-002', error: '请修正局部文案。' })
  const refreshed = await store.authorizedSnapshot(projectId, capability)
  assert.equal(refreshed.generationAttempt.localEditScope.selection.elementId, 'open-details')
  await store.cancelGeneration({ projectId, capability, requestId: 'request-local-failure-002', expectedRevisionId: first.revisionId })
  assert.equal((await store.authorizedSnapshot(projectId, capability)).generationAttempt, undefined)

  await store.beginGeneration({ projectId, capability, requestId: 'request-local-accept-003', expectedRevisionId: first.revisionId, selection })
  const linkedModal = structuredClone(document)
  linkedModal.screens[0].nodes[3].label = '打开审批详情'
  linkedModal.screens[0].nodes[4].title = '审批详情'
  linkedModal.screens[0].nodes[4].children[0].text = '请确认审批结果'
  const accepted = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-local-accept-003', expectedRevisionId: first.revisionId, document: linkedModal, changeSummary: '修改详情按钮和弹窗' })
  assert.equal(accepted.status, 'verified_write')

  await store.beginGeneration({ projectId, capability, requestId: 'request-local-new-modal-004', expectedRevisionId: accepted.revisionId, selection })
  const newModal = structuredClone(linkedModal)
  newModal.screens[0].nodes[3].action = { type: 'open-modal', targetId: 'approval-modal' }
  newModal.screens[0].nodes.push({ id: 'approval-modal', type: 'modal', title: '审批确认', children: [{ id: 'approval-copy', type: 'text', text: '确认通过此供应商吗？' }] })
  const newModalSaved = await store.save({ projectId, sessionId: 'session-1', requestId: 'request-local-new-modal-004', expectedRevisionId: accepted.revisionId, document: newModal, changeSummary: '增加审批确认弹窗' })
  assert.equal(newModalSaved.status, 'verified_write')

  await store.beginGeneration({ projectId, capability, requestId: 'request-local-reject-005', expectedRevisionId: newModalSaved.revisionId, selection })
  const unrelated = structuredClone(newModal)
  unrelated.screens[0].nodes[2].label = '搜索项目'
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', requestId: 'request-local-reject-005', expectedRevisionId: newModalSaved.revisionId, document: unrelated, changeSummary: '错误地改动搜索框' }), /未选中的元素“search”/)
})
