import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('pmd-prd splits independently deliverable requirements before researching', async () => {
  const skill = await readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8')

  assert.match(skill, /可以分别上线、排期或验收/)
  assert.match(skill, /拆成独立 PRD（推荐）/)
  assert.match(skill, /必须一起完成同一目标时才合并/)
  assert.match(skill, /内部编号/)
})
