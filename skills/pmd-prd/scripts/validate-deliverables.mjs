#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNRESOLVED_CONTENT = /\[待确认\]|待补充|占位|后续回填|以后回填|稍后确认|最终以(?:设计稿|业务确认|评审结果)为准/
const CODE_IDENTIFIER = /\b(?:[a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/
const REQUIRED_HEADINGS = [
  '# 需求基本信息', '# 修订记录', '# 一、术语与缩写', '# 二、背景与目标',
  '## （一）描述/痛点', '## （二）目标/价值', '## （三）风险控制',
  '# 三、整体流程', '## （一）业务/功能流程图', '# 四、功能性需求',
  '## （一）正常业务场景', '### 边界场景', '## （二）异常业务场景',
  '# 五、角色权限', '# 六、非功能性需求', '## （一）用户与业务规模',
  '## （二）性能指标要求', '## （三）安全要求', '## （四）高可用要求', '## （五）监控告警要求',
  '# 七、配置与开关', '# 八、测试关注点', '## （一）影响范围分析',
  '## （二）异常场景关注点', '## （三）性能压测要求', '## （四）数据准备要求',
  '## （五）验收清单', '# 九、参考文档',
]
const REQUIREMENT_TABLE_HEADER = ['需求点', '阐述', '原有实现', '目标改动点']
const ACCEPTANCE_TABLE_HEADER = ['对应需求点', '验证操作', '预期结果']

function cells(line) {
  if (!/^\|.*\|\s*$/.test(line.trim())) return null
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
}

function terminologyRows(body) {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '# 一、术语与缩写')
  if (start < 0) return []
  const section = lines.slice(start + 1)
  const end = section.findIndex((line) => /^#\s/.test(line.trim()))
  return section.slice(0, end < 0 ? section.length : end).map((line) => line.trim()).filter((line) => /^\|.*\|$/.test(line)).map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim())).filter((row) => row.length >= 2 && row[0] !== '术语/缩写' && !/^:?-{3,}:?$/.test(row[0]))
}

function orderedHeadings(lines, errors) {
  let after = -1
  for (const heading of REQUIRED_HEADINGS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex > after && line.trim() === heading)
    if (index < 0) errors.push(`PRD is missing or misorders required section: ${heading}`)
    else after = index
  }
}

function requirementRows(lines, errors) {
  const rows = []
  let foundHeader = false
  for (let index = 0; index < lines.length; index += 1) {
    if (JSON.stringify(cells(lines[index])) !== JSON.stringify(REQUIREMENT_TABLE_HEADER)) continue
    foundHeader = true
    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex].trim()
      if (line === '' || /^#{1,6}\s/.test(line)) break
      const row = cells(line)
      if (row === null || /^:?-{3,}:?$/.test(row[0] ?? '')) continue
      if (row.length !== 4) { errors.push('PRD requirement table row must have four columns'); continue }
      rows.push(row)
    }
  }
  if (!foundHeader) errors.push('PRD must contain the four-column requirement table header')
  if (rows.length === 0) errors.push('PRD must contain at least one requirement row')
  for (const row of rows) {
    if (!/【(?:修改|新增|删除)】/.test(row[0])) errors.push('PRD requirement row must start with 【修改】, 【新增】, or 【删除】')
    if (!/研发定位[：:]/.test(row[3])) errors.push('PRD requirement target column must include 研发定位')
  }
}

function acceptanceRows(lines, errors) {
  const headerIndex = lines.findIndex((line) => JSON.stringify(cells(line)) === JSON.stringify(ACCEPTANCE_TABLE_HEADER))
  if (headerIndex < 0) { errors.push('PRD must contain the acceptance test-case table header'); return }
  const rows = []
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || /^#{1,6}\s/.test(line)) break
    const row = cells(line)
    if (row === null || /^:?-{3,}:?$/.test(row[0] ?? '')) continue
    if (row.length !== 3) { errors.push('PRD acceptance test-case row must have three columns'); continue }
    rows.push(row)
  }
  if (rows.length === 0) errors.push('PRD must contain at least one acceptance test case')
}

function validationErrors({ prdName, prdBody }) {
  const errors = []
  if (typeof prdName !== 'string' || !prdName.replace(/\.md$/, '').endsWith('_PRD')) errors.push('PRD filename must end with _PRD')
  if (typeof prdBody !== 'string' || prdBody.trim() === '') return [...errors, 'PRD body must be non-empty']
  const lines = prdBody.split(/\r?\n/)
  const titleLines = lines.filter((line) => line.startsWith('# PRD:'))
  if (titleLines.length !== 1 || !/^# PRD: \S.* - \S.*$/.test(titleLines[0])) errors.push('PRD must contain exactly one complete title')
  orderedHeadings(lines, errors)
  requirementRows(lines, errors)
  acceptanceRows(lines, errors)
  if (/\{[^}\r\n]*\}/.test(prdBody)) errors.push('PRD contains template placeholders')
  if (UNRESOLVED_CONTENT.test(prdBody)) errors.push('PRD contains unresolved content')
  if (terminologyRows(prdBody).some((row) => CODE_IDENTIFIER.test(`${row[0]} ${row[1]}`))) errors.push('PRD contains a code identifier in terminology')
  return errors
}

export function validateBody(input) { const errors = validationErrors(input); return { ok: errors.length === 0, errors } }

export function validatePmdBatch({ batchId, items }) {
  if (!batchId.startsWith('pmd:')) return null
  if (items.length !== 1) return 'PMD delivery requires exactly one PRD document'
  const [prd] = items
  const result = validateBody({ prdName: prd.name, prdBody: prd.body }); return result.ok ? null : result.errors[0]
}

export async function validateDeliverable({ prdPath }) {
  return validateBody({ prdName: basename(prdPath), prdBody: await readFile(prdPath, 'utf8') })
}

function usage() { return 'Usage: node validate-deliverables.mjs --prd <prd-file>' }
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage()); return }
  if (args.length !== 2 || args[0] !== '--prd' || !args[1] || args[1].startsWith('-')) throw new Error(usage())
  const result = await validateDeliverable({ prdPath: args[1] })
  if (!result.ok) throw new Error(result.errors.join('; '))
  console.log(`PASS: PMD frozen PRD check (${basename(args[1])})`)
}
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1 })
