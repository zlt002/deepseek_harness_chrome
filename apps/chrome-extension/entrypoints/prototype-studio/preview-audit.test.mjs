import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleUnderTest() {
  const source = await readFile(new URL('./preview-audit.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}

test('summarizes pending, passing, and actionable responsive preview evidence', async () => {
  const { summarizeAllPreviewAudits, summarizePreviewAudit } = await moduleUnderTest()
  assert.equal(summarizePreviewAudit(undefined).tone, 'checking')
  const passedAudit = { viewportWidth: 390, horizontalOverflow: false, smallTargetCount: 0, clippedDialogCount: 0 }
  const passed = summarizePreviewAudit(passedAudit)
  assert.equal(passed.tone, 'pass')
  assert.match(passed.label, /基础布局检查/)
  assert.match(passed.detail, /人工确认长内容、键盘和无障碍/)
  assert.match(passed.detail, /390px/)
  const warningAudit = { viewportWidth: 390, horizontalOverflow: true, smallTargetCount: 2, clippedDialogCount: 1 }
  const warning = summarizePreviewAudit(warningAudit)
  assert.equal(warning.tone, 'warning')
  assert.match(warning.detail, /横向溢出/)
  assert.match(warning.detail, /2 个操作区/)
  assert.match(warning.detail, /1 个弹窗/)
  assert.match(summarizeAllPreviewAudits({ desktop: passedAudit }).label, /2 个尺寸待检查/)
  assert.equal(summarizeAllPreviewAudits({ desktop: passedAudit, tablet: passedAudit, mobile: passedAudit }).tone, 'pass')
  const allWarning = summarizeAllPreviewAudits({ desktop: passedAudit, tablet: passedAudit, mobile: warningAudit })
  assert.equal(allWarning.tone, 'warning')
  assert.match(allWarning.detail, /手机/)
})
