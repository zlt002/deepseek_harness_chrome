import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pmd-prd keeps the source picker flow in its main skill', async () => {
  const sourceStep = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(sourceStep, /ask_user_question/)
  assert.match(sourceStep, /pmd_prd_reference_sources/)
  assert.match(sourceStep, /选择资料（推荐）/)
  assert.match(sourceStep, /本轮不使用远程资料/)
  assert.match(sourceStep, /请手动勾选/)
  assert.match(sourceStep, /重新读取选择结果继续后续流程/)
  assert.match(sourceStep, /knowledgeSelected 为 true时 .*调用`search_selected_knowledge`/)
  assert.match(sourceStep, /knowledgeSelected为 true，且codeSelected 为 true时[\s\S]*忽略‘代码仓库进行检索’/)
  assert.match(sourceStep, /knowledgeSelected为 false，且codeSelected 为 true时[\s\S]*search_selected_remote_code/)
})
