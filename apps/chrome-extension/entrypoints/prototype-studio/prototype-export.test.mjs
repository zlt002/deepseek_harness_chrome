import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from '../../../../.generated/harness-product/node_modules/jsdom/lib/api.js'

test('offline export stays on the validated trusted runtime and carries revision fingerprints', async () => {
  const source = await readFile(new URL('./prototype-export.ts', import.meta.url), 'utf8')
  assert.match(source, /validatePrototypeBundle/)
  assert.match(source, /sandboxPreviewSrcDoc\(checked\.value\.document, checked\.value\.designSpec, checked\.value\.evidence, nonce, 'interact'\)/)
  assert.match(source, /prototype-document-sha256/)
  assert.match(source, /documentFingerprint/)
  assert.match(source, /designSpecFingerprint/)
  assert.match(source, /references: checked\.value\.evidence\.map/)
  assert.doesNotMatch(source, /screenshotDataUrl/)
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket/)
})

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

test('exported HTML opens offline and keeps the fixed trusted interaction runtime', async () => {
  const built = await build({ entryPoints: [new URL('./prototype-export.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false })
  const module = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${Date.now()}`)
  const source = { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-25T00:00:00.000Z' }
  const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 }; const observations = ['蓝色主按钮']; const designTokens = { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ v: 1, source: { url: source.url, title: source.title }, viewport, observations, designTokens }))).digest('hex')
  const evidence = { v: 1, id: 'evidence-export', source, viewport, observations, designTokens, fingerprint }
  const designSpec = { v: 1, id: 'design-export', name: '导出规范', basedOnEvidenceIds: [evidence.id], summary: '安全规范', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = { v: 1, id: 'offline-product', title: '离线产品原型', designSpecId: designSpec.id, initialScreenId: 'home', shell: { productName: '离线产品', placement: 'top', items: [{ id: 'nav-home', label: '首页', targetScreenId: 'home' }, { id: 'nav-detail', label: '详情', targetScreenId: 'detail' }] }, screens: [{ id: 'home', title: '首页', nodes: [{ id: 'home-title', type: 'text', text: '首页', tone: 'heading' }, { id: 'metrics', type: 'group', layout: 'grid-2', children: [{ id: 'metric-a', type: 'metric', label: '进行中', value: '12' }, { id: 'metric-b', type: 'metric', label: '待处理', value: '3' }] }, { id: 'risk-alert', type: 'alert', title: '风险提醒', detail: '有一项需要处理。', tone: 'warning' }] }, { id: 'detail', title: '详情', nodes: [{ id: 'detail-title', type: 'text', text: '离线详情', tone: 'heading' }, { id: 'detail-list', type: 'list', label: '处理记录', items: [{ id: 'record-one', title: '记录一', detail: '已完成' }] }] }] }
  const artifact = await module.createPrototypeExportArtifacts({ projectId: 'prototype-export-test', revisionId: 'rev-export-test', document, designSpec, evidence: [evidence] })
  assert.match(artifact.html, /default-src 'none'/)
  assert.match(artifact.html, new RegExp(artifact.documentFingerprint))
  const payload = JSON.parse(artifact.json); assert.equal(payload.documentFingerprint, artifact.documentFingerprint); assert.equal(payload.revisionId, 'rev-export-test')
  const dom = new JSDOM(artifact.html, { runScripts: 'dangerously', pretendToBeVisual: true })
  try {
    assert.equal(dom.window.document.querySelectorAll('script[src], link[href], iframe[src], form[action], img[src^="http:"] , img[src^="https:"]').length, 0)
    assert.equal(dom.window.document.querySelector('main')?.getAttribute('aria-label'), '首页')
    const detail = [...dom.window.document.querySelectorAll('nav button')].find(button => button.textContent === '详情'); assert.ok(detail); detail.click()
    assert.equal(dom.window.document.querySelector('main')?.getAttribute('aria-label'), '详情')
    assert.match(dom.window.document.body.textContent, /离线详情/)
  } finally { dom.window.close() }
})
