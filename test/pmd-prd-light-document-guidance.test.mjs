import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD stage 8 delegates every post-delivery document edit to the light-document write authority', async () => {
  const skillPath = new URL('../skills/pmd-prd/SKILL.md', import.meta.url)
  const matrixPath = new URL('../skills/pmd-prd/references/capability-matrix.md', import.meta.url)
  const skill = await readFile(skillPath, 'utf8')
  const matrix = await readFile(matrixPath, 'utf8')
  assert.match(skill, /读取并执行 \[轻文档 Verified Write\]\(\.\.\/webedit-light-document\/SKILL\.md\)/)
  assert.match(skill, /唯一的写入规则来源/)
  assert.match(skill, /全文重写[\s\S]*精确稳定的全文[\s\S]*选区能力检查/)
  assert.match(skill, /编辑器未就绪[\s\S]*刷新并重新绑定 Browser Target/)
  assert.doesNotMatch(skill, /不对时，请他在当前轻文档里选中要改的那段，再改这段，不要整篇重写/)
  assert.match(matrix, /读取并执行 \[`webedit-light-document` Skill\]/)
  for (const [source, sourcePath, label] of [[skill, skillPath, '轻文档 Verified Write'], [matrix, matrixPath, '`webedit-light-document` Skill']]) {
    const match = source.match(new RegExp(`\\[${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\]\\(([^)]+)\\)`))
    assert.ok(match, `${label} link is present`)
    await access(new URL(match[1], sourcePath))
  }
})
