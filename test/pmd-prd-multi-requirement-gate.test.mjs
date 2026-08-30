import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const skillPath = resolve(import.meta.dirname, '../skills/pmd-prd/SKILL.md')
const capabilityMatrixPath = resolve(import.meta.dirname, '../skills/pmd-prd/references/capability-matrix.md')

test('pmd-prd审查需求是否混装，并在资料选择前要求拆分决策', async () => {
  const skill = await readFile(skillPath, 'utf8')
  const capabilityMatrix = await readFile(capabilityMatrixPath, 'utf8')
  const gate = skill.indexOf('### 阶段 1：输入需求')
  const references = skill.indexOf('### 阶段 2：选择参考资料')
  const gateText = skill.slice(gate, references)

  assert.ok(gate >= 0 && references > gate, '阶段1必须位于阶段2之前')
  assert.match(gateText, /同一用户旅程/)
  assert.match(gateText, /优先级或发布单元/)
  assert.match(gateText, /多个功能点不自动等于多个需求/)
  assert.match(gateText, /独立上线、独立排期或独立验收/)
  assert.match(gateText, /“优化需求”“本次迭代”“一起做”“放在同一份 PRD”等说法只代表打包偏好/)
  assert.match(gateText, /即使用户已说“都放进本次优化需求”/)
  assert.match(gateText, /拆成独立 PRD（推荐）.*说明不可拆的共同目标后保留一份/)
  assert.match(gateText, /不进入资料选择|研究/)
  assert.match(gateText, /当前 Run 仍只产一份 PRD/)
  assert.match(gateText, /本轮主需求/)
  assert.match(gateText, /后续独立 Run 候选/)
  assert.match(gateText, /共同目标、范围边界和各子项独立验收/)
  assert.match(capabilityMatrix, /1 输入需求 \| `input` \+ 需求聚合门/)
  assert.match(capabilityMatrix, /只算打包偏好，不能替代共同业务目标/)
  assert.match(capabilityMatrix, /拆分时已选定本轮主需求/)
})
