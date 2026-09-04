import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD validates before review and writes only after explicit target selection', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /### Step4\. 生成 PRD/)
  assert.match(skill, /### Step5\. 检查 PRD/)
  assert.match(skill, /生成完成后先进入检查阶段，不立即签发审核凭据或打开 Markdown Review/)
  assert.match(skill, /章节、字段和写作细节只以 `references\/templates\.md` 为准/)
  assert.match(skill, /第四章目标改动须由用户确认或正式资料明确规定/)
  assert.match(skill, /现状、关联影响和研发定位可结合代码查询、正式资料和用户材料核实/)
  assert.match(skill, /其他章节和字段只填写用户确认的内容，资料只能用于准备候选答案，不能代替确认/)
  assert.match(skill, /信息不足时澄清，确认不涉及时写“无”或“不涉及”/)
  assert.match(skill, /最终 PRD 不得出现 `?\[待确认\]?`?、待补充、占位内容、以后回填/)
  assert.match(skill, /全部检查通过后[\s\S]*issue-review-receipt\.mjs[\s\S]*open_workspace_markdown_review/)
  assert.match(skill, /用户采纳 PRD 不代表允许立即写入在线文档/)
  assert.match(skill, /用户明确选择目标文档并发送执行指令后/)
  assert.match(skill, /light_document_read[\s\S]*light_document_write_preview[\s\S]*light_document_write_commit[\s\S]*light_document_read/)
  assert.doesNotMatch(skill, /team_knowledge_batch_preview|team_knowledge_batch_create|pmdReviewReceipt/)
})
