import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pmd-prd keeps the source picker flow in its main skill', async () => {
  const sourceStep = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(sourceStep, /ask_user_question/)
  assert.match(sourceStep, /pmd_prd_reference_sources/)
  assert.match(sourceStep, /选择资料（推荐）/)
  assert.match(sourceStep, /本轮不使用远程资料/)
  assert.match(sourceStep, /页面下方的选择器/)
  assert.match(sourceStep, /立即重新读取选择结果/)
  assert.match(sourceStep, /不要求用户再回复仓库名/)
})
