import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function modules() {
  const schemaSource = await readFile(new URL('../../../../packages/harness-ui-prototype-studio/src/prototype-document.ts', import.meta.url), 'utf8')
  const schemaJs = ts.transpileModule(schemaSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const schemaUrl = `data:text/javascript;base64,${Buffer.from(schemaJs).toString('base64')}`
  const briefSource = await readFile(new URL('../../../../packages/harness-ui-prototype-studio/src/product-brief.mjs', import.meta.url), 'utf8')
  const briefUrl = `data:text/javascript;base64,${Buffer.from(briefSource).toString('base64')}`
  const coverageSource = await readFile(new URL('../../../../packages/harness-ui-prototype-studio/src/requirement-coverage.mjs', import.meta.url), 'utf8')
  const coverageUrl = `data:text/javascript;base64,${Buffer.from(coverageSource.replace("from './product-brief.mjs'", `from '${briefUrl}'`)).toString('base64')}`
  const source = await readFile(new URL('./revision-preview.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'", `from '${schemaUrl}'`)
    .replace("from '../../../../packages/harness-ui-prototype-studio/src/product-brief.mjs'", `from '${briefUrl}'`)
    .replace("from '../../../../packages/harness-ui-prototype-studio/src/requirement-coverage.mjs'", `from '${coverageUrl}'`)
  return { schema: await import(`${schemaUrl}#${Date.now()}`), preview: await import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}`) }
}

function fixtures() {
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: 'a'.repeat(64) }
  const designSpec = { v: 1, id: 'design-main', name: '规范', basedOnEvidenceIds: ['ref-one'], summary: '规范', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = {
    v: 1, id: 'product-prototype', title: '原型', designSpecId: 'design-main', initialScreenId: 'home',
    screens: [{
      id: 'home', title: '首页', nodes: [
        { id: 'title', type: 'text', text: '首页' },
        { id: 'open', type: 'button', label: '打开', action: { type: 'open-modal', targetId: 'detail' } },
        { id: 'detail', type: 'modal', title: '详情', children: [{ id: 'copy', type: 'text', text: '详情' }, { id: 'card', type: 'card', children: [{ id: 'metric', type: 'metric', label: '数量', value: '12' }] }] },
      ],
    }],
  }
  return { evidence, designSpec, document }
}

test('parses only the requested trusted revision compared with the actual current revision', async () => {
  const { preview } = await modules(); const { evidence, designSpec, document } = fixtures()
  const productBrief = { v: 1, audience: '产品经理', coreTask: '查看项目风险详情', requiredPages: ['项目列表'], requiredFlows: ['打开风险详情'] }
  const raw = { v: 1, projectId: 'prototype-12345678', revisionId: 'rev-old', current: false, createdAt: '2026-08-24T00:00:00.000Z', changeSummary: '旧版', document, designSpec, productBriefKnown: true, productBrief, comparison: { screenCountBefore: 2, screenCountAfter: 1, componentCountBefore: 20, componentCountAfter: 6, details: ['移除设置页'] }, comparedToRevisionId: 'rev-current' }
  const context = { projectId: 'prototype-12345678', targetRevisionId: 'rev-old', currentRevisionId: 'rev-current', evidence: [evidence] }
  const result = preview.parseRevisionPreview(raw, context)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.comparison.details[0], '移除设置页')
  assert.deepEqual(result.value.productBrief, productBrief)
  assert.equal(preview.parseRevisionPreview({ ...raw, revisionId: 'rev-other' }, context).ok, false)
  assert.equal(preview.parseRevisionPreview({ ...raw, comparedToRevisionId: 'rev-other' }, context).ok, false)
  assert.equal(preview.parseRevisionPreview({ ...raw, projectId: 'prototype-87654321' }, context).ok, false)
  assert.equal(preview.parseRevisionPreview({ ...raw, requirementCoverage: { v: 1, items: [] } }, context).ok, false)
})

test('rejects forged counts, extra fields, and unsafe prototype content', async () => {
  const { preview } = await modules(); const { evidence, designSpec, document } = fixtures()
  const context = { projectId: 'prototype-12345678', targetRevisionId: 'rev-old', currentRevisionId: 'rev-current', evidence: [evidence] }
  const base = { v: 1, projectId: context.projectId, revisionId: context.targetRevisionId, current: false, createdAt: '2026-08-24T00:00:00.000Z', changeSummary: '旧版', document, designSpec, productBriefKnown: false, comparison: { screenCountBefore: 2, screenCountAfter: 1, componentCountBefore: 20, componentCountAfter: 6, details: ['变化'] }, comparedToRevisionId: context.currentRevisionId }
  assert.equal(preview.parseRevisionPreview({ ...base, comparison: { ...base.comparison, componentCountAfter: 241 } }, context).ok, false)
  assert.equal(preview.parseRevisionPreview({ ...base, executable: 'alert(1)' }, context).ok, false)
  assert.equal(preview.parseRevisionPreview({ ...base, productBrief: { v: 1 } }, context).ok, false)
  const unsafe = structuredClone(base); unsafe.document.screens[0].nodes[0].html = '<script>'
  assert.equal(preview.parseRevisionPreview(unsafe, context).ok, false)
})

test('summarizes current versus historical structure and requirement coverage without mutating either document', async () => {
  const { preview } = await modules(); const { document } = fixtures()
  const current = structuredClone(document)
  current.screens.push({ id: 'settings', title: '设置', nodes: [{ id: 'save-settings', type: 'button', label: '保存设置' }] })
  current.screens[0].nodes.push({ id: 'new-card', type: 'card', children: [] })
  const historicalCoverage = { v: 1, items: [{ id: 'page-1', kind: 'page', requirement: '项目列表', status: 'satisfied', matches: [{ label: '首页', screenId: 'home' }] }, { id: 'flow-1', kind: 'flow', requirement: '打开风险详情', status: 'missing', matches: [] }] }
  const currentCoverage = { v: 1, items: [{ id: 'page-1', kind: 'page', requirement: '项目列表', status: 'satisfied', matches: [{ label: '首页', screenId: 'home' }] }, { id: 'flow-1', kind: 'flow', requirement: '打开风险详情', status: 'satisfied', matches: [{ label: '打开', screenId: 'home', nodeId: 'open', nodeType: 'button' }] }] }
  const result = preview.visualRevisionDiff(current, document, currentCoverage, historicalCoverage)
  assert.ok(result.structure.includes('当前新增页面：设置'))
  assert.ok(result.structure.includes('当前新增组件：new-card'))
  assert.ok(result.coverage.includes('需求覆盖：当前 2/2，历史 1/2'))
  assert.ok(result.coverage.includes('当前补齐：打开风险详情'))
  assert.equal(document.screens.length, 1)
  assert.equal(current.screens.length, 2)
})
