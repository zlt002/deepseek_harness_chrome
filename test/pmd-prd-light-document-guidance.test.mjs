import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

test('PMD-PRD delegates later document edits to the light-document write authority', async () => {
  const skillPath = new URL('../skills/pmd-prd/SKILL.md', import.meta.url)
  const skill = await readFile(skillPath, 'utf8')

  assert.match(skill, /\[轻文档安全写入规则\]\(\.\.\/webedit-light-document\/SKILL\.md\)/)
  assert.match(skill, /空白文档正文使用 `blocks_insert`，流程图使用 `insert_drawing`/)
  assert.doesNotMatch(skill, /空白文档必须使用 `blocks_insert` 或 `selection_insert`/)
  assert.match(skill, /局部修改只使用刚刚读取到的稳定内容块或稳定选区/)
  assert.match(skill, /全文改写前，必须确认用户选中了完整且可替换的全文/)
  const link = skill.match(/\[轻文档安全写入规则\]\(([^)]+)\)/)
  assert.ok(link, 'skill links to the light-document write authority')
  await access(new URL(link[1], skillPath))
})
