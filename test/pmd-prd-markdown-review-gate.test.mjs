import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD validates before review and writes only after explicit target selection', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### 4\. 生成 PRD/)
  assert.match(skill, /### 5\. 检查 PRD/)
  assert.match(skill, /生成完成后先进入检查阶段，不立即签发审核凭据或打开 Markdown Review/)
  assert.match(skill, /只有第四章功能改动点可综合用户输入、用户提供\/选定资料和代码查询/)
  assert.match(skill, /代码只证明现状、关联影响和研发定位/)
  assert.match(skill, /其他章节和字段不能从代码库或模型推断直接填充/)
  assert.match(skill, /修改或删除项：写清改造前后对比及影响。[\s\S]*改造前情况及关联影响必须有[\s\S]*改造后的行为必须由用户[\s\S]*知识库、用户材料中的正式规则/)
  assert.match(skill, /新增项：写清功能、入口、流程、规则和结果。[\s\S]*上述内容必须由用户[\s\S]*知识库、用户材料中的正式规则[\s\S]*研发定位必须来自代码库查询结果/)
  assert.match(skill, /没有内容的章节或小节写“无”，需求基本信息未知字段留空/)
  assert.match(skill, /禁止猜测、拼接不同信息得出未经确认的结论，或把建议写成事实/)
  assert.match(skill, /检查通过[\s\S]*issue-review-receipt\.mjs[\s\S]*凭据签发成功后，才调用[\s\S]*open_workspace_markdown_review/)
  assert.match(skill, /用户修改 PRD 后，必须重新执行本阶段的完整内容检查/)
  assert.match(skill, /用户采纳 PRD 不代表允许立即写入在线文档/)
  assert.match(skill, /用户明确选择目标文档并发送执行指令后/)
  assert.match(skill, /light_document_read[\s\S]*light_document_write_preview[\s\S]*light_document_write_commit[\s\S]*light_document_read/)
  assert.doesNotMatch(skill, /team_knowledge_batch_preview|team_knowledge_batch_create|pmdReviewReceipt/)
})
