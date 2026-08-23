import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { PrototypeProjectStore } from '../src/prototype-store.mjs'

async function contracts() {
  const source = await readFile(new URL('../src/prototype-document.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}#${Date.now()}`)
}

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
  const designSpec = { v: 1, id: 'design-ref', name: '参考规范', basedOnEvidenceIds: ['evidence-ref'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }, { name: '底色', value: '#ffffff', usage: '页面' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = { v: 1, id: 'prototype-doc', title: '产品原型', designSpecId: 'design-ref', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '首页' }] }] }
  const first = await store.save({ projectId, sessionId: 'session-1', designSpec, document, changeSummary: '初始版本' })
  assert.equal(first.status, 'verified_write')
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-other', expectedRevisionId: first.revisionId, designSpec, document, changeSummary: '越权' }), /different Harness session/)
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', designSpec, document, changeSummary: '旧版本覆盖' }), /revision conflict/)
  const second = await store.save({ projectId, sessionId: 'session-1', expectedRevisionId: first.revisionId, designSpec, document: { ...document, title: '产品原型第二版' }, changeSummary: '修改标题' })
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
  await assert.rejects(() => store.save({ projectId, sessionId: 'session-1', expectedRevisionId: second.revisionId, designSpec, document, changeSummary: '旧版本保存' }), /revision conflict/)
  /* Restore keeps the full history; a later save starts from the restored revision. */
  const third = await store.save({ projectId, sessionId: 'session-1', expectedRevisionId: first.revisionId, designSpec, document: { ...document, title: '恢复后第三版' }, changeSummary: '恢复后修改' })
  assert.equal(third.status, 'verified_write')
  const afterSave = await store.authorizedSnapshot(projectId, capability)
  assert.equal(afterSave.currentRevisionId, third.revisionId)
  assert.equal(afterSave.revisions.length, 3)
  await assert.rejects(() => store.authorizedSnapshot(projectId, 'wrong-capability-that-is-long-enough-123456'), /capability is invalid/)
})
