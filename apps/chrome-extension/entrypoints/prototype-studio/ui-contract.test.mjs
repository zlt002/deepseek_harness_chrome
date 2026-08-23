import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('prototype studio exposes three product-manager columns and a sandboxed preview', async () => {
  const [main, styles] = await Promise.all([readFile(new URL('./main.tsx', import.meta.url), 'utf8'), readFile(new URL('./style.css', import.meta.url), 'utf8')])
  assert.match(main, /参考与规范/)
  assert.match(main, /选中元素与版本/)
  assert.match(main, /TrustedPrototypeRuntime/)
  assert.match(main, /sandbox="allow-scripts"/)
  assert.match(main, /referrerPolicy="no-referrer"/)
  assert.match(main, /event\.source !== frameRef\.current\?\.contentWindow/)
  assert.match(main, /isSandboxSelectionMessage/)
  assert.match(main, /PROTOTYPE_REFERENCE_STORAGE_KEY/)
  assert.match(main, /validateReferenceEvidence/)
  assert.match(main, /verifyReferenceEvidenceFingerprint/)
  assert.match(main, /referenceId/)
  assert.match(main, /prototype-studio-snapshot\/v1/)
  assert.match(main, /prototype-studio-prompt\/v1/)
  assert.match(main, /prototype-studio-restore\/v1/)
  assert.match(main, /expectedCurrentRevisionId/)
  assert.match(main, /正在恢复…/)
  assert.match(main, /让 AI 生成原型/)
  assert.match(styles, /grid-template-columns:\s*minmax\(220px, \.8fr\) minmax\(420px, 1\.6fr\) minmax\(240px, \.9fr\)/)
})
