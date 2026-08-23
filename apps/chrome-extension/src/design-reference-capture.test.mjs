import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function captureModule() {
  const schemaSource = await readFile(new URL('../../../packages/harness-ui-prototype-studio/src/prototype-document.ts', import.meta.url), 'utf8')
  const schemaJs = ts.transpileModule(schemaSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const schemaUrl = `data:text/javascript;base64,${Buffer.from(schemaJs).toString('base64')}`
  const captureSource = await readFile(new URL('./design-reference-capture.ts', import.meta.url), 'utf8')
  const captureJs = ts.transpileModule(captureSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("from '../../../packages/harness-ui-prototype-studio/src/prototype-document'", `from '${schemaUrl}'`)
  return import(`data:text/javascript,${encodeURIComponent(captureJs)}#${Date.now()}`)
}

test('turns bounded computed styles and one screenshot into fingerprinted evidence', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const raw = {
    v: 1,
    source: { url: 'https://example.test/product', title: '产品页' },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    samples: [{
      tag: 'button', text: '开始', rect: { x: 20, y: 30, width: 120, height: 40 },
      color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(37, 99, 235)', borderColor: 'rgb(37, 99, 235)',
      fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', borderRadius: '8px',
      padding: '8px 16px', margin: '0px', gap: '8px', boxShadow: 'none',
    }],
  }
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj', new Date('2026-08-23T00:00:00Z'))
  assert.match(result.id, /^ref-/)
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/)
  assert.match(result.screenshotFingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.designTokens.fonts, ['Inter'])
  assert.equal(result.viewport.width, 1280)
})

test('rejects non-http pages and oversized screenshots', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const raw = { v: 1, source: { url: 'chrome://settings', title: '设置' }, viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, samples: [{}] }
  await assert.rejects(() => buildReferenceEvidence(raw, 'data:image/jpeg;base64,YQ=='), /visual evidence/)
  const valid = { ...raw, source: { url: 'https://example.test', title: '参考' } }
  await assert.rejects(() => buildReferenceEvidence(valid, `data:image/jpeg;base64,${'a'.repeat(2_000_000)}`), /too large/)
})
