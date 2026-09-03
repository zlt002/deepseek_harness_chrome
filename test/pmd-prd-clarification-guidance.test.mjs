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
  assert.match(skill, /前置决定已经明确、不需要猜测答案的产品问题/)
  assert.match(skill, /每轮通常只问 1–3 个最关键的问题/)
  assert.match(skill, /❓ \*\*Q<n>\*\* - \*\*<问题标题>\*\*: <问题正文；需要选择时列出互斥选项>/)
  assert.match(skill, /➡️ <推荐答案，以及推荐理由或选择影响>/)
  assert.match(skill, /问题之间用 `---` 分隔/)
  assert.match(skill, /“全部按建议”只确认本轮已展示的建议/)
  assert.match(skill, /澄清对象是产品经理，默认其不懂代码/)
  assert.match(skill, /不能把代码检索结果原样抛给用户/)
  assert.match(skill, /把已确认的业务规则整理成面向代码检索的技术问题/)
  assert.match(skill, /没有新的代码影响或证据缺口时不为走流程重复查询/)
  assert.match(skill, /代码证据 → 产品语言澄清 → 业务答案 → 技术语言复查/)
  assert.match(skill, /本轮业务答案涉及的代码影响已经复查/)
  assert.doesNotMatch(skill, /authoring\.md/)
})

test('pmd-prd confirms an adaptive structured understanding before any source lookup', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### 1\. 结构化理解并确认需求/)
  assert.match(skill, /表格、PPT、文档、图片等附件/)
  assert.match(skill, /区分用户当前请求与附件中的资料内容/)
  assert.match(skill, /围绕用户自己的表达顺序和重点/)
  assert.match(skill, /结构按内容自适应，不使用固定字段清单/)
  assert.match(skill, /一句简单需求可以只归纳问题与期望/)
  assert.match(skill, /复杂输入可按目标、对象、场景、现状、问题、范围、流程、规则、约束或用户建议等实际主题分组/)
  assert.match(skill, /优先沿用其结构/)
  assert.doesNotMatch(skill, /- 使用对象：/)
  assert.match(skill, /pmd_prd_requirement_understanding/)
  assert.match(skill, /确认，开始资料查询（推荐）/)
  assert.match(skill, /确认前禁止调用 `mcp__chrome__selected_source_scope`、`search_selected_remote_code` 或 `search_selected_knowledge`/)
  assert.match(skill, /用户补充或纠正，按用户思路更新当前结构，重新展示并再次确认/)
  assert.match(skill, /只有 Step1 的结构化理解获得用户确认后，才调用 `mcp__chrome__selected_source_scope`/)
  assert.match(skill, /首次检索 prompt 必须明确写出“需求理解、现状或问题、相关功能、代码位置、影响范围”/)
})
