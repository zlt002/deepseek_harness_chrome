#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REFERENCE_PATH = resolve(SCRIPT_DIR, '../references/templates.md')
const PRD_SUFFIX = '_PRD'
const ALLOWED_MISSING_MARKERS = ['[待确认]', '不适用（原因）']
const FINAL_FIELD_LABEL = /\[(?:必填|选填|建议填写|涉及多系统交互时必填)\]|【选填】/
const ACCEPTANCE_CATEGORIES = ['正常情况', '异常情况', '边界情况', '权限情况', '兼容情况']
const IMPACT_RISK_HEADER = ['直接改动', '关联影响', '可能风险', '建议处理', '是否需要产品决策']

function normaliseText(value) { return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') }

function fencedBlocks(markdown) {
  const blocks = []
  let fence = null
  let block = []
  for (const line of normaliseText(markdown).split('\n')) {
    const token = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (token) {
      if (fence === null) { fence = token[0]; block = [] }
      else if (fence === token[0]) { blocks.push(block.join('\n')); fence = null }
      continue
    }
    if (fence !== null) block.push(line)
  }
  return blocks
}

function markdownOutsideFences(markdown) {
  const visible = []
  let fence = null
  for (const line of normaliseText(markdown).split('\n')) {
    const token = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (token) { fence = fence === null ? token[0] : fence === token[0] ? null : fence; continue }
    if (fence === null) visible.push(line)
  }
  return visible.join('\n')
}

function blockContaining(markdown, marker) { return fencedBlocks(markdown).find((block) => block.includes(marker)) ?? null }

function headingLines(markdown) {
  return markdownOutsideFences(markdown).split('\n').flatMap((line) => {
    const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*$/)
    return match === null ? [] : [{ level: match[1].length, raw: `${match[1]} ${match[2]}` }]
  })
}

function tableRow(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\s+/g, ' ')) : null
}

function tableHeaders(markdown) {
  const lines = markdownOutsideFences(markdown).split('\n')
  const headers = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = tableRow(lines[index]); const separator = tableRow(lines[index + 1])
    if (header && separator && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) headers.push(header)
  }
  return headers
}

function tableDataRows(markdown, expectedHeader) {
  const lines = markdownOutsideFences(markdown).split('\n')
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = tableRow(lines[index]); const separator = tableRow(lines[index + 1])
    if (!header || !equalRows(header, expectedHeader) || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    const rows = []
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = tableRow(lines[rowIndex])
      if (!row) break
      rows.push(row)
    }
    return rows
  }
  return []
}

function equalRows(left, right) { return left.length === right.length && left.every((cell, index) => cell === right[index]) }

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function headingPattern(templateHeading) {
  return new RegExp(`^${templateHeading.split(/(\{[^{}]+\})/).map((part) => part.startsWith('{') && part.endsWith('}') ? '.+?' : escapeRegex(part)).join('')}$`)
}

function buildTemplateContract(authority) {
  const prdTemplate = blockContaining(authority, '# PRD:')
  if (prdTemplate === null) throw new Error('references/templates.md must contain a complete prd.md fenced template')
  const headings = headingLines(prdTemplate).filter((heading) => heading.level === 1 || (heading.level === 2 && /^(## 需求基本信息|## 修订记录)/.test(heading.raw)))
  const headers = tableHeaders(prdTemplate)
  if (headings.length !== 12 || headers.length < 5) throw new Error('references/templates.md does not expose the expected single-PRD template contract')
  return { headings, headerStarts: headers.filter((header) => ['业务需求名称', '版本', '角色', '指标项'].includes(header[0])).map((header) => header[0]) }
}

function validateFilename(name) {
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name
  return stem.length > PRD_SUFFIX.length && stem.endsWith(PRD_SUFFIX) ? null : `PRD filename must end with ${PRD_SUFFIX} (optionally followed by .md): ${name}`
}

function validateHeadingSequence(body, expected) {
  const actual = headingLines(body); const errors = []
  if (actual.length === 0 || !headingPattern(expected[0].raw).test(actual[0].raw)) errors.push(`PRD must start with ${expected[0].raw}`)
  let cursor = -1
  for (const expectedHeading of expected) {
    const matches = actual.flatMap((heading, index) => heading.level === expectedHeading.level && headingPattern(expectedHeading.raw).test(heading.raw) ? [index] : [])
    if (matches.length === 0) return [...errors, `PRD is missing or reorders: ${expectedHeading.raw}`]
    if (matches.length > 1) errors.push(`PRD repeats: ${expectedHeading.raw}`)
    const next = matches.find((index) => index > cursor)
    if (next === undefined) return [...errors, `PRD reorders: ${expectedHeading.raw}`]
    cursor = next
  }
  return errors
}

function validateAcceptanceChecklist(body) {
  const lines = markdownOutsideFences(body).split('\n'); const errors = []
  for (const category of ACCEPTANCE_CATEGORIES) {
    const start = lines.findIndex((line) => line.trim() === `### ${category}`)
    const end = lines.findIndex((line, index) => index > start && /^#{1,3}\s+/.test(line.trim()))
    if (start < 0 || !lines.slice(start + 1, end < 0 ? lines.length : end).some((line) => /^\s*-\s*\[[ xX]\]\s+\S/.test(line))) errors.push(`PRD acceptance checklist is empty: ${category}`)
  }
  return errors
}

function exactHeadingIndex(lines, heading, after = -1) {
  return lines.findIndex((line, index) => index > after && line.trim() === heading)
}

function validateBasicInformation(body) {
  const visible = markdownOutsideFences(body)
  const errors = []
  if (!/^\|\s*需求编号及链接\s*\|/m.test(visible)) errors.push('PRD basic information is missing: 需求编号及链接')
  if (!/^\|\s*产品经理\s*\|[^\n]*\|\s*预估人天\s*\|/m.test(visible)) errors.push('PRD basic information is missing: 预估人天')
  return errors
}

function validateFunctionalRequirements(body) {
  const lines = markdownOutsideFences(body).split('\n')
  const errors = []
  const chapterStart = exactHeadingIndex(lines, '# 四、功能性需求')
  const chapterEnd = exactHeadingIndex(lines, '# 五、角色权限', chapterStart)
  const normalStart = exactHeadingIndex(lines, '## （一）正常业务场景', chapterStart)
  const boundaryStart = exactHeadingIndex(lines, '## 边界场景', normalStart)
  const abnormalStart = exactHeadingIndex(lines, '## （二）异常业务场景', boundaryStart)
  if (chapterStart < 0 || chapterEnd < 0 || normalStart < 0 || boundaryStart < 0 || abnormalStart < 0 || abnormalStart > chapterEnd) {
    return ['PRD functional requirements must keep 正常业务场景 → 边界场景 → 异常业务场景']
  }

  const functionStarts = lines.flatMap((line, index) => index > normalStart && index < boundaryStart && /^###\s+功能[:：]\s*\S/.test(line.trim()) ? [index] : [])
  if (functionStarts.length === 0) return ['PRD normal business scenarios must contain at least one ### 功能： heading']
  const required = ['#### 现状', '#### 调整方式', '#### 输入/输出规则', '#### 调整后效果']
  for (let functionIndex = 0; functionIndex < functionStarts.length; functionIndex += 1) {
    const start = functionStarts[functionIndex]
    const end = functionStarts[functionIndex + 1] ?? boundaryStart
    const blockLines = lines.slice(start, end)
    const functionName = lines[start].trim()
    let cursor = -1
    for (const heading of required) {
      const index = exactHeadingIndex(blockLines, heading, cursor)
      if (index < 0) {
        errors.push(`${functionName} is missing or reorders: ${heading}`)
        break
      }
      cursor = index
    }
    const block = blockLines.join('\n')
    const headers = tableHeaders(block)
    if (!headers.some((header) => equalRows(header, ['输入字段或操作', '类型/触发方式', '是否必填', '长度/格式/取值范围', '校验或操作条件']))) errors.push(`${functionName} is missing the complete input rules table`)
    if (!headers.some((header) => equalRows(header, ['输出结果', '展示/数据格式', '触发条件']))) errors.push(`${functionName} is missing the complete output rules table`)
  }
  return errors
}

function validateTestFocus(body) {
  const lines = markdownOutsideFences(body).split('\n')
  const chapterStart = exactHeadingIndex(lines, '# 八、测试关注点')
  const chapterEnd = exactHeadingIndex(lines, '# 九、参考文档', chapterStart)
  const required = ['## （一）影响范围分析', '## （二）异常场景关注点', '## （三）验收清单', '## （四）性能压测要求', '## （五）数据准备要求']
  let cursor = chapterStart
  const errors = []
  for (const heading of required) {
    const index = exactHeadingIndex(lines, heading, cursor)
    if (index < 0 || index > chapterEnd) return [`PRD test focus is missing or reorders: ${heading}`]
    cursor = index
  }
  const impactStart = exactHeadingIndex(lines, '## （一）影响范围分析', chapterStart)
  const exceptionStart = exactHeadingIndex(lines, '## （二）异常场景关注点', chapterStart)
  const riskStart = exactHeadingIndex(lines, '### 关联改动与风险', impactStart)
  const regressionStart = exactHeadingIndex(lines, '### 回归范围', riskStart)
  if (riskStart < 0 || riskStart > exceptionStart) errors.push('PRD impact analysis is missing: ### 关联改动与风险')
  if (regressionStart < 0 || regressionStart > exceptionStart) errors.push('PRD impact analysis is missing: ### 回归范围')
  const impactSection = lines.slice(impactStart, exceptionStart).join('\n')
  if (!tableHeaders(impactSection).some((header) => equalRows(header, IMPACT_RISK_HEADER))) errors.push(`PRD impact analysis is missing required table: ${IMPACT_RISK_HEADER.join(' / ')}`)
  const impactRows = tableDataRows(impactSection, IMPACT_RISK_HEADER)
  if (!impactRows.some((row) => row.length === IMPACT_RISK_HEADER.length && row.every((cell) => cell.length > 0))) errors.push('PRD impact analysis must contain at least one complete change-risk row')
  if (regressionStart >= 0 && !lines.slice(regressionStart + 1, exceptionStart).some((line) => line.trim() && !line.trim().startsWith('#'))) errors.push('PRD 回归范围 is empty')
  const checklistStart = exactHeadingIndex(lines, '## （三）验收清单', exceptionStart)
  if (!lines.slice(exceptionStart + 1, checklistStart).some((line) => line.trim() && !line.trim().startsWith('#'))) errors.push('PRD 异常场景关注点 is empty')
  return errors
}

function validatePrdLanguage(body) {
  const visible = markdownOutsideFences(body); const errors = []
  const unresolvedLine = visible.split('\n').find((line) => /^\s*\{[^{}\n]+\}\s*$/.test(line))
  if (unresolvedLine) errors.push(`PRD leaves a template placeholder; use ${ALLOWED_MISSING_MARKERS.join(' or ')}: ${unresolvedLine.trim()}`)
  const unresolvedToken = visible.match(/\{[^{}\n]+\}/)
  if (unresolvedToken) errors.push(`PRD leaves an unresolved template token: ${unresolvedToken[0]}`)
  const label = visible.match(FINAL_FIELD_LABEL)
  if (label) errors.push(`PRD exposes a field label: ${label[0]}`)
  if (visible.includes('\\n')) errors.push('PRD contains a literal \\n outside a fenced code block')
  const internalTerm = visible.match(/\b(?:Evidence|Impact|Task|AC)\b|测试\s*seam|证据分类|代码影响地图|纵向任务|验收合同/)
  if (internalTerm) errors.push(`PRD exposes an internal delivery term: ${internalTerm[0]}`)
  const codeLocator = visible.match(/(?:^|[\s`])(?:[\w.-]+\/)*[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs)\b/m)
  if (codeLocator) errors.push(`PRD contains a code locator: ${codeLocator[0].trim()}`)
  const codeIdentifier = visible.match(/\b[a-z]{2,}[A-Z][A-Za-z0-9]*\b/)
  if (codeIdentifier) errors.push(`PRD contains a code-style identifier that belongs in the implementation handoff: ${codeIdentifier[0]}`)
  return errors
}

export function validateBody({ prdName, prdBody, authority }) {
  const errors = []
  let contract
  try { contract = buildTemplateContract(authority) } catch (error) { return { ok: false, errors: [error.message] } }
  const filenameError = validateFilename(prdName); if (filenameError) errors.push(filenameError)
  if (typeof prdBody !== 'string' || prdBody.trim().length === 0) errors.push('PRD body must be non-empty')
  else {
    errors.push(...validateHeadingSequence(prdBody, contract.headings))
    for (const headerStart of contract.headerStarts) if (!tableHeaders(prdBody).some((candidate) => candidate[0] === headerStart)) errors.push(`PRD is missing required table header starting with: ${headerStart}`)
    errors.push(...validatePrdLanguage(prdBody), ...validateBasicInformation(prdBody), ...validateFunctionalRequirements(prdBody), ...validateTestFocus(prdBody), ...validateAcceptanceChecklist(prdBody))
  }
  return { ok: errors.length === 0, errors }
}

export async function validateDeliverable({ prdPath, referencePath = DEFAULT_REFERENCE_PATH }) {
  const [prdBody, authority] = await Promise.all([readFile(prdPath, 'utf8'), readFile(referencePath, 'utf8')])
  return validateBody({ prdName: basename(prdPath), prdBody, authority })
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--prd' || argument === '--reference') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a path`)
      values[argument.slice(2)] = value; index += 1
    } else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    else if (values.prd === undefined) values.prd = argument
    else throw new Error('usage: validate-deliverables.mjs --prd <prd-file> [--reference <templates-file>]')
  }
  if (values.prd === undefined) throw new Error('usage: validate-deliverables.mjs --prd <prd-file> [--reference <templates-file>]')
  return values
}

function usage() { return 'Usage: node validate-deliverables.mjs --prd <prd-file> [--reference <templates-file>]' }

async function main() {
  let argumentsValue
  try { argumentsValue = parseArguments(process.argv.slice(2)) } catch (error) { console.error(`ERROR: ${error.message}\n${usage()}`); process.exitCode = 2; return }
  if (argumentsValue.help) { console.log(usage()); return }
  try {
    const result = await validateDeliverable({ prdPath: argumentsValue.prd, referencePath: argumentsValue.reference ?? DEFAULT_REFERENCE_PATH })
    if (!result.ok) { console.error(`FAIL: PMD frozen PRD contract\n${result.errors.map((error) => `- ${error}`).join('\n')}`); process.exitCode = 1; return }
    console.log(`PASS: PMD frozen PRD contract (${basename(argumentsValue.prd)})`)
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 2 }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main()
