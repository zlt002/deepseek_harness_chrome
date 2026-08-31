import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD validates the frozen Markdown before opening left-side review and blocks delivery until adoption', async () => {
  const [skill, matrix, state] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/process-state.md', import.meta.url), 'utf8'),
  ])
  assert.match(skill, /open_workspace_markdown_review/)
  assert.match(skill, /只复用其中已有的“采纳、重写、局部优化、接受\/拒绝修改”/)
  assert.match(skill, /在此之前不得进入阶段 6、绑定父节点或写远程/)
  assert.match(skill, /重写或局部优化始终回到同一 `\/pmd-prd` 会话/)
  assert.match(skill, /任一正文、fingerprint 或 hash 变化都会使旧采纳失效/)
  assert.match(skill, /相对当前 Harness 会话 cwd 的冻结产物[\s\S]*\.md[\s\S]*路径/)
  assert.match(matrix, /只有左侧审核的采纳才可进入阶段 6/)
  assert.match(state, /prd_review_accepted/)
  assert.match(state, /Markdown Review“采纳”/)
})
