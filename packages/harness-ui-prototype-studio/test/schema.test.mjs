import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function schema() {
  const source = await readFile(new URL('../src/prototype-document.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(output)}#${Date.now()}`)
}

function documentFixture() {
  return { v: 1, id: 'signup-prototype', title: '注册', designSpecId: 'design-main', initialScreenId: 'welcome', screens: [{ id: 'welcome', title: '欢迎', nodes: [{ id: 'heading', type: 'text', text: '欢迎', tone: 'heading' }, { id: 'go-signup', type: 'button', label: '开始', action: { type: 'navigate', targetScreenId: 'signup' } }, { id: 'signup-modal', type: 'modal', title: '说明', children: [{ id: 'modal-copy', type: 'text', text: '安全演示' }] }] }, { id: 'signup', title: '注册', nodes: [{ id: 'email', type: 'input', label: '邮箱', inputType: 'email' }, { id: 'submit', type: 'button', label: '提交', action: { type: 'submit-success', targetScreenId: 'welcome' } }, { id: 'tabs', type: 'tabs', tabs: [{ id: 'basic', label: '基础', children: [{ id: 'card', type: 'card', children: [{ id: 'list', type: 'list', items: [{ id: 'item-one', title: '第一项' }] }] }] }] }] }] }
}

test('accepts the bounded V1 component and action language', async () => {
  const { validatePrototypeDocument } = await schema()
  const result = validatePrototypeDocument(documentFixture())
  assert.equal(result.ok, true)
  assert.equal(result.value.screens.length, 2)
})

test('rejects executable-code-shaped fields and unsupported components', async () => {
  const { validatePrototypeDocument } = await schema()
  const evil = documentFixture(); evil.screens[0].nodes[0].script = 'alert(1)'
  assert.equal(validatePrototypeDocument(evil).ok, false)
  const unsupported = documentFixture(); unsupported.screens[0].nodes[0].type = 'iframe'
  assert.equal(validatePrototypeDocument(unsupported).ok, false)
})

test('requires real targets for state transitions and unique stable ids', async () => {
  const { validatePrototypeDocument } = await schema()
  const missingTarget = documentFixture(); missingTarget.screens[0].nodes[1].action = { type: 'navigate' }
  assert.equal(validatePrototypeDocument(missingTarget).ok, false)
  const duplicate = documentFixture(); duplicate.screens[1].nodes[0].id = 'heading'
  assert.equal(validatePrototypeDocument(duplicate).ok, false)
  const booleanSetValue = documentFixture(); booleanSetValue.screens[0].nodes[1].action = { type: 'set-value', targetId: 'email', value: true }
  assert.equal(validatePrototypeDocument(booleanSetValue).ok, false)
})

test('binds design specs only to authorized reference evidence', async () => {
  const { validateReferenceEvidence, validateDesignSpec } = await schema()
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: 'a'.repeat(64) }
  assert.equal(validateReferenceEvidence(evidence).ok, true)
  const spec = { v: 1, id: 'design-main', name: '参考风格', basedOnEvidenceIds: ['ref-one'], summary: '简洁', colors: [{ name: '蓝', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 12 }, principles: ['清晰'] }
  assert.equal(validateDesignSpec(spec, ['ref-one']).ok, true)
  spec.basedOnEvidenceIds = ['unapproved']; assert.equal(validateDesignSpec(spec, ['ref-one']).ok, false)
})

test('resolves references after the full tree and rejects wrong target types, duplicate tab/list ids, and large payloads', async () => {
  const { validatePrototypeDocument, MAX_DOCUMENT_TEXT_BYTES } = await schema()
  const wrongModal = documentFixture(); wrongModal.screens[0].nodes[1].action = { type: 'open-modal', targetId: 'email' }
  assert.equal(validatePrototypeDocument(wrongModal).ok, false)
  const duplicateTab = documentFixture(); duplicateTab.screens[1].nodes[2].tabs[0].id = 'heading'
  assert.equal(validatePrototypeDocument(duplicateTab).ok, false)
  const huge = documentFixture(); huge.screens[0].nodes[0].text = 'x'.repeat(MAX_DOCUMENT_TEXT_BYTES + 1)
  assert.equal(validatePrototypeDocument(huge).ok, false)
})

test('requires matching design bundle and computes rather than trusting revision fingerprints', async () => {
  const { computeReferenceEvidenceFingerprint, createTrustedRevision, verifyTrustedRevision, validatePrototypeBundle } = await schema()
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] } }
  evidence.fingerprint = await computeReferenceEvidenceFingerprint(evidence)
  const spec = { v: 1, id: 'design-main', name: '参考风格', basedOnEvidenceIds: ['ref-one'], summary: '简洁', colors: [{ name: '蓝', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 12 }, principles: ['清晰'] }
  const doc = documentFixture()
  assert.equal(validatePrototypeBundle({ evidence: [evidence], designSpec: spec, document: doc }).ok, true)
  assert.equal(validatePrototypeBundle({ evidence: [evidence], designSpec: { ...spec, id: 'other-design' }, document: doc }).ok, false)
  const revision = await createTrustedRevision({ id: 'rev-one', author: 'agent', evidence: [evidence], designSpec: spec, document: doc, changeSummary: '初始版本', createdAt: '2026-08-23T00:00:00.000Z' })
  assert.equal(revision.ok, true)
  assert.equal(await verifyTrustedRevision(revision.value, spec, [evidence]), true)
  revision.value.documentFingerprint = '0'.repeat(64)
  assert.equal(await verifyTrustedRevision(revision.value, spec, [evidence]), false)
})
