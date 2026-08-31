import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD validates before opening left-side review, then writes only after the user chooses an empty light document', async () => {
  const [skill, matrix, state] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8'),
  ])
  assert.match(skill, /open_workspace_markdown_review/)
  assert.match(skill, /只复用其中已有的“采纳、重写、局部优化、接受\/拒绝修改”/)
  assert.match(skill, /在此之前不得进入阶段 6 或写远程/)
  assert.match(skill, /重写或局部优化始终回到同一 `\/pmd-prd` 来源会话/)
  assert.match(skill, /确认以当前编辑器看到的完整正文为准/)
  assert.match(skill, /https:\/\/doc\.midea\.com\/docs/)
  assert.match(skill, /当前会话最后一次采纳只保留这一条待执行指令/)
  assert.match(skill, /直接替换右侧当前会话输入框中的草稿，不切换到来源会话/)
  assert.match(skill, /用户自己在当前 Browser Target 选择或新建空白轻文档/)
  assert.match(skill, /light_document_read → light_document_write_preview → light_document_write_commit → light_document_read/)
  assert.match(skill, /第二次用户手动发送执行指令是对当下 Browser Target 的明确写入确认/)
  assert.match(skill, /请选择或新建空白轻文档后再发送执行。/)
  assert.match(matrix, /空白轻文档/)
  assert.match(skill, /相对当前 Harness 会话 cwd 的冻结产物[\s\S]*\.md[\s\S]*路径/)
  assert.match(matrix, /左侧“采纳”只准备执行/)
  assert.match(state, /prd_review_accepted/)
  assert.match(state, /prd_sync_pending/)
  assert.match(state, /Markdown Review“采纳”/)
  assert.doesNotMatch(skill, /team_knowledge_batch_preview|team_knowledge_batch_create|pmdReviewReceipt/)
})
