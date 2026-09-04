import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pmd-prd clarifies dependent product decisions in rounds', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### Step3\. 分轮澄清需求/)
  assert.match(skill, /盘问方法论（决策树 \+ 轮次）/)
  assert.match(skill, /frontier\*\* = 前置已解决、现在就能问的决策/)
  assert.match(skill, /用户回答后重算下一轮 frontier/)
  assert.match(skill, /查事实是你的职责，不是用户的/)
  assert.match(skill, /❓ \*\*Q1\*\* - \{问题\}：\{正文\} → ➡️ \{推荐答案\}/)
  assert.match(skill, /结束：frontier 为空——无沉默假设/)
  assert.match(skill, /按照盘问方法论逐轮澄清，直到所有理解一致并由用户确认/)
  assert.match(skill, /未全部理解并确认前，不得开始下一步/)
  assert.match(skill, /简单任务豁免：直接反述，需求无歧义即视为确认/)
})

test('pmd-prd confirms an adaptive structured understanding before any source lookup', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### Step1\. 结构化理解并确认需求/)
  assert.match(skill, /表格、PPT、文档、图片等附件/)
  assert.match(skill, /区分用户当前请求与附件中的资料内容/)
  assert.match(skill, /围绕用户自己的表达顺序和重点/)
  assert.match(skill, /结构按内容自适应，不使用固定字段清单/)
  assert.match(skill, /一句简单需求可以只归纳问题与期望/)
  assert.match(skill, /复杂输入可按目标、对象、场景、现状、问题、范围、流程、规则、约束或用户建议等实际主题分组/)
  assert.doesNotMatch(skill, /- 使用对象：/)
  assert.match(skill, /pmd_prd_requirement_understanding/)
  assert.match(skill, /确认，开始资料查询（推荐）/)
  assert.match(skill, /确认前禁止调用 `mcp__chrome__selected_source_scope`、`search_selected_remote_code` 或 `search_selected_knowledge`/)
  assert.match(skill, /用户补充或纠正，按用户思路更新当前结构，重新展示并再次确认/)
  assert.match(skill, /用户选择后，按结果重新展示完整的结构化理解并取得确认，再进入资料查询/)
  assert.match(skill, /检索知识，深度理解用户的原始需求及意图，核实改动点/)
})
