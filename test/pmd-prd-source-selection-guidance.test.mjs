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
  assert.match(sourceStep, /只有代码库时调用 `search_selected_remote_code`/)
  assert.match(sourceStep, /选了知识库时调用 `search_selected_knowledge`/)
  assert.match(sourceStep, /若同时选了代码库，该检索会把知识范围和代码库一并提交/)
  assert.match(sourceStep, /混合选择不要拆成两轮查询/)
  assert.match(sourceStep, /同一父会话轮次或后续轮次发起聚焦补查/)
  assert.match(sourceStep, /description 必须写清该证据缺口/)
  assert.match(sourceStep, /同一父会话轮次最多进行 3 次检索/)
})
