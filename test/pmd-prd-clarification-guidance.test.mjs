import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pmd-prd clarifies dependent product decisions in rounds', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### 3\. 分轮澄清需求/)
  assert.match(skill, /内部建立需求决策树/)
  assert.match(skill, /依赖本轮其他答案的问题留到下一轮/)
  assert.match(skill, /事实由你负责查询，决策由用户确认/)
  assert.match(skill, /frontier 为空[\s\S]*用户确认双方理解一致[\s\S]*确认前不能生成 PRD 草稿或最终 PRD/)
  assert.match(skill, /当前可问问题（frontier）/)
  assert.match(skill, /前置决定已经明确、不需要猜测答案的全部产品问题/)
  assert.match(skill, /连续编号/)
  assert.match(skill, /❓ \*\*Q<n>\*\* - \*\*<问题标题>\*\*: <问题正文；需要选择时列出互斥选项>/)
  assert.match(skill, /➡️ <推荐答案，以及推荐理由或选择影响>/)
  assert.match(skill, /问题之间用 `---` 分隔/)
  assert.match(skill, /“全部按建议”只确认本轮已展示的建议/)
  assert.doesNotMatch(skill, /authoring\.md/)
})
