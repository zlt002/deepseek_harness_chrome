import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleUnderTest() {
  const source = await readFile(new URL('./preview-stage.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(output)}#${Date.now()}`)
}

test('measures exact desktop, tablet, and mobile iframe widths while only scaling their display', async () => {
  const { PREVIEW_VIEWPORT_WIDTHS, previewStageLayout } = await moduleUnderTest()
  assert.deepEqual(PREVIEW_VIEWPORT_WIDTHS, { desktop: 1440, tablet: 768, mobile: 390 })
  const desktop = previewStageLayout(600, 700, 'desktop')
  assert.equal(desktop.viewportWidth, 1440)
  assert.ok(desktop.scale < 1)
  assert.ok(desktop.displayWidth <= 576)
  const tablet = previewStageLayout(1_000, 700, 'tablet')
  assert.equal(tablet.viewportWidth, 768)
  assert.equal(tablet.scale, 1)
  const mobile = previewStageLayout(340, 700, 'mobile')
  assert.equal(mobile.viewportWidth, 390)
  assert.ok(mobile.scale < 1)
  assert.equal(desktop.viewportHeight * desktop.scale >= 676, true)
})
