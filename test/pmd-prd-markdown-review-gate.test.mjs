import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD validates before opening left-side review, then synchronizes directly after adoption', async () => {
  const [skill, matrix, state] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8'),
  ])
  assert.match(skill, /open_workspace_markdown_review/)
  assert.match(skill, /只复用其中已有的“采纳、重写、局部优化、接受\/拒绝修改”/)
  assert.match(skill, /在此之前不得进入阶段 6、绑定父节点或写远程/)
  assert.match(skill, /重写或局部优化始终回到同一 `\/pmd-prd` 会话/)
  assert.match(skill, /不再要求用户二次确认或操作采纳凭据/)
  assert.match(skill, /后台把采纳绑定到当前 Run、当前会话、文件身份、revision、fingerprint 和正文 hash/)
  assert.match(skill, /不得传采纳凭据/)
  assert.match(skill, /Preview 成功后不得再询问创建确认，立即进入阶段 7/)
  assert.match(matrix, /预览后立即创建，不再二次确认/)
  assert.match(skill, /打开目标在线文档所在的目录标签，并在顶部选中该标签；选好后继续当前对话，我会自动同步，无需再次采纳/)
  assert.match(skill, /相对当前 Harness 会话 cwd 的冻结产物[\s\S]*\.md[\s\S]*路径/)
  assert.match(matrix, /左侧“采纳”即直接进入远程同步/)
  assert.match(state, /prd_review_accepted/)
  assert.match(state, /prd_sync_pending/)
  assert.match(state, /Markdown Review“采纳”/)
  assert.doesNotMatch(skill, /accepted_revision|accepted_fingerprint|pmdReviewReceipt/)
})
