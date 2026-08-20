#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REFERENCE_PATH = resolve(SCRIPT_DIR, '../references/templates.md')
const ANALYSIS_SUFFIX = '_01_需求分析与研发交付'
const PRD_SUFFIX = '_02_PRD'
const ALLOWED_MISSING_MARKERS = ['[待确认]', '不适用（原因）']

function normaliseText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function fenceToken(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})/)
  return match === null ? null : { character: match[1][0], length: match[1].length }
}

function closesFence(token, fence) {
  return token !== null && token.character === fence.character && token.length >= fence.length
}

function markdownOutsideFences(markdown) {
  const visible = []
  let fence = null
  for (const line of normaliseText(markdown).split('\n')) {
    const token = fenceToken(line)
    if (token !== null) {
      if (fence === null) fence = token
      else if (closesFence(token, fence)) fence = null
      continue
    }
    if (fence === null) visible.push(line)
  }
  return visible.join('\n')
}

function fencedBlocks(markdown) {
  const blocks = []
  let fence = null
  let block = []
  for (const line of normaliseText(markdown).split('\n')) {
    const token = fenceToken(line)
    if (token !== null) {
      if (fence === null) {
        fence = token
        block = []
      } else if (closesFence(token, fence)) {
        blocks.push(block.join('\n'))
        fence = null
      }
      continue
    }
    if (fence !== null) block.push(line)
  }
  return blocks
}

function blockContaining(markdown, marker) {
  return fencedBlocks(markdown).find((block) => block.includes(marker)) ?? null
}

function headingLines(markdown) {
  return markdownOutsideFences(markdown).split('\n').flatMap((line) => {
    const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match === null) return []
    return [{ level: match[1].length, text: match[2], raw: `${match[1]} ${match[2]}` }]
  })
}

function tableRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\s+/g, ' '))
}

function separatorRow(row) {
  return row !== null && row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableHeaders(markdown) {
  const lines = markdownOutsideFences(markdown).split('\n')
  const headers = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = tableRow(lines[index])
    const separator = tableRow(lines[index + 1])
    if (header !== null && separatorRow(separator)) headers.push(header)
  }
  return headers
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headingPattern(templateHeading) {
  const parts = templateHeading.split(/(\{[^{}]+\})/)
  return new RegExp(`^${parts.map((part) => part.startsWith('{') && part.endsWith('}') ? '.+?' : escapeRegex(part)).join('')}$`)
}

function headingMatches(actual, expected) {
  return actual.level === expected.level && headingPattern(expected.raw).test(actual.raw)
}

function equalRows(left, right) {
  return left.length === right.length && left.every((cell, index) => cell === right[index])
}

function findSection(markdown, headingPatternText, nextHeadingPatternText) {
  const lines = normaliseText(markdown).split('\n')
  const start = lines.findIndex((line) => headingPatternText.test(line.trim()))
  if (start < 0) return ''
  const end = nextHeadingPatternText === undefined
    ? lines.length
    : lines.findIndex((line, index) => index > start && nextHeadingPatternText.test(line.trim()))
  return lines.slice(start, end < 0 ? lines.length : end).join('\n')
}

function buildTemplateContract(authority) {
  const analysisTemplate = blockContaining(authority, '# 需求分析与研发交付')
  const prdTemplate = blockContaining(authority, '# PRD:')
  if (analysisTemplate === null || prdTemplate === null) {
    throw new Error('references/templates.md must contain complete analysis.md and prd.md fenced templates')
  }

  const analysisHeadings = headingLines(analysisTemplate)
  const prdHeadings = headingLines(prdTemplate).filter((heading) => (
    heading.level === 1 || (heading.level === 2 && /^(需求基本信息|修订记录)/.test(heading.text))
  ))
  const analysisHeaders = tableHeaders(analysisTemplate)
  const basicInfoHeaders = tableHeaders(findSection(prdTemplate, /^##\s+需求基本信息$/, /^##\s+修订记录/)).at(0)
  const revisionHeaders = tableHeaders(findSection(prdTemplate, /^##\s+修订记录/, /^#\s+一、/)).at(0)

  if (analysisHeadings.length !== 12 || prdHeadings.length !== 12 || analysisHeaders.length !== 1 || basicInfoHeaders === undefined || revisionHeaders === undefined) {
    throw new Error('references/templates.md does not expose the expected PMD template contract')
  }

  return { analysisHeadings, prdHeadings, analysisHeaders, prdHeaders: [basicInfoHeaders, revisionHeaders] }
}

function stripMarkdownExtension(name) {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function validateFilename(name, suffix, label) {
  const stem = stripMarkdownExtension(name)
  if (stem.length <= suffix.length || !stem.endsWith(suffix)) {
    return `${label} filename must end with ${suffix} (optionally followed by .md): ${name}`
  }
  return null
}

function validateFilenamePair(analysisName, prdName) {
  const errors = []
  const analysisError = validateFilename(analysisName, ANALYSIS_SUFFIX, 'analysis')
  const prdError = validateFilename(prdName, PRD_SUFFIX, 'PRD')
  if (analysisError !== null) errors.push(analysisError)
  if (prdError !== null) errors.push(prdError)
  const analysisPrefix = stripMarkdownExtension(analysisName).slice(0, -ANALYSIS_SUFFIX.length)
  const prdPrefix = stripMarkdownExtension(prdName).slice(0, -PRD_SUFFIX.length)
  if (analysisError === null && prdError === null && analysisPrefix !== prdPrefix) {
    errors.push(`analysis and PRD filenames must share the same requirement/topic prefix: ${analysisName} / ${prdName}`)
  }
  return errors
}

function validateHeadingSequence(body, expected, label, { requireStart = true } = {}) {
  const actual = headingLines(body)
  const errors = []
  if (requireStart && (actual.length === 0 || !headingMatches(actual[0], expected[0]))) {
    errors.push(`${label} must start with ${expected[0].raw}`)
  }
  let cursor = -1
  for (const expectedHeading of expected) {
    const matches = actual.flatMap((heading, index) => headingMatches(heading, expectedHeading) ? [index] : [])
    if (matches.length === 0) {
      errors.push(`${label} is missing or reorders: ${expectedHeading.raw}`)
      return errors
    }
    if (matches.length > 1) errors.push(`${label} repeats: ${expectedHeading.raw}`)
    const next = matches.find((index) => index > cursor)
    if (next === undefined) {
      errors.push(`${label} reorders: ${expectedHeading.raw}`)
      return errors
    }
    cursor = next
  }
  return errors
}

function validateTableHeaders(body, expected, label) {
  const actual = tableHeaders(body)
  return expected.flatMap((header) => equalRows(actual.find((candidate) => equalRows(candidate, header)) ?? [], header)
    ? []
    : [`${label} is missing required table header: | ${header.join(' | ')} |`])
}

function validateMissingInformation(body, label) {
  const visible = markdownOutsideFences(body)
  const errors = []
  const unresolvedLine = visible.split('\n').find((line) => /^\s*\{[^{}\n]+\}\s*$/.test(line))
  if (unresolvedLine !== undefined) {
    errors.push(`${label} leaves a template placeholder; use ${ALLOWED_MISSING_MARKERS.join(' or ')}: ${unresolvedLine.trim()}`)
  }
  const unresolvedToken = visible.match(/\{(?:编号|主题|功能名称|requirementId|CWD)\}/)
  if (unresolvedToken !== null) {
    errors.push(`${label} leaves an unresolved template token: ${unresolvedToken[0]}`)
  }
  const informalMarker = visible.match(/(?:TODO|TBD|待补充|待填写|待定)/i)
  if (informalMarker !== null) {
    errors.push(`${label} must mark missing information with ${ALLOWED_MISSING_MARKERS.join(' or ')}, not ${informalMarker[0]}`)
  }
  if (visible.includes('\\n')) errors.push(`${label} contains a literal \\n outside a fenced code block`)
  return errors
}

function validateHandoffLanguage(body) {
  const visible = markdownOutsideFences(body)
  const errors = []
  const internalTerm = visible.match(/\b(?:Evidence|Impact|Task|AC)\b|测试\s*seam|证据分类|代码影响地图|纵向任务|验收合同/)
  if (internalTerm !== null) errors.push(`analysis exposes an internal delivery term: ${internalTerm[0]}`)
  const quantifiedClaim = visible.match(/(?:预计|预估)\s*\d+(?:\.\d+)?\s*(?:人天|天)|(?:页面响应时间|接口响应时间|并发用户数|吞吐量)\s*\|[^\n|]*\d/)
  if (quantifiedClaim !== null && !quantifiedClaim[0].includes('[待确认]')) errors.push(`analysis contains an unsupported quantified claim: ${quantifiedClaim[0]}`)
  return errors
}

function validateAcceptanceChecklist(body) {
  const lines = markdownOutsideFences(body).split('\n')
  const errors = []
  for (const category of ['正常情况', '异常情况', '边界情况', '权限情况', '兼容情况']) {
    const start = lines.findIndex((line) => line.trim() === `### ${category}`)
    const end = lines.findIndex((line, index) => index > start && /^#{1,3}\s+/.test(line.trim()))
    const section = start < 0 ? [] : lines.slice(start + 1, end < 0 ? lines.length : end)
    if (!section.some((line) => /^\s*-\s*\[[ xX]\]\s+\S/.test(line))) {
      errors.push(`analysis acceptance checklist is empty: ${category}`)
    }
  }
  return errors
}

function validatePrdLanguage(body) {
  const visible = markdownOutsideFences(body)
  const errors = []
  const internalTerm = visible.match(/\b(?:Evidence|Impact|Task|AC)\b|测试\s*seam|证据分类|代码影响地图|纵向任务|验收合同/)
  if (internalTerm !== null) errors.push(`PRD exposes an internal delivery term: ${internalTerm[0]}`)
  const codeLocator = visible.match(/(?:^|[\s`])(?:[\w.-]+\/)*[\w.-]+\.(?:vue|tsx?|jsx?|mjs|cjs)\b/m)
  if (codeLocator !== null) errors.push(`PRD contains a code locator that belongs in the handoff: ${codeLocator[0].trim()}`)
  return errors
}

export function validateBodies({ analysisName, analysisBody, prdName, prdBody, authority }) {
  const errors = []
  let contract
  try {
    contract = buildTemplateContract(authority)
  } catch (error) {
    return { ok: false, errors: [error.message] }
  }

  errors.push(...validateFilenamePair(analysisName, prdName))
  for (const [label, body] of [['analysis', analysisBody], ['PRD', prdBody]]) {
    if (typeof body !== 'string' || body.trim().length === 0) errors.push(`${label} body must be non-empty`)
    else errors.push(...validateMissingInformation(body, label))
  }
  if (typeof analysisBody === 'string' && analysisBody.trim().length > 0) {
    errors.push(...validateHeadingSequence(analysisBody, contract.analysisHeadings, 'analysis'))
    errors.push(...validateTableHeaders(analysisBody, contract.analysisHeaders, 'analysis'))
    errors.push(...validateHandoffLanguage(analysisBody))
    errors.push(...validateAcceptanceChecklist(analysisBody))
  }
  if (typeof prdBody === 'string' && prdBody.trim().length > 0) {
    errors.push(...validateHeadingSequence(prdBody, contract.prdHeadings, 'PRD'))
    errors.push(...validateTableHeaders(prdBody, contract.prdHeaders, 'PRD'))
    errors.push(...validatePrdLanguage(prdBody))
  }
  return { ok: errors.length === 0, errors }
}

export async function validateDeliverables({ analysisPath, prdPath, referencePath = DEFAULT_REFERENCE_PATH }) {
  const [analysisBody, prdBody, authority] = await Promise.all([
    readFile(analysisPath, 'utf8'),
    readFile(prdPath, 'utf8'),
    readFile(referencePath, 'utf8'),
  ])
  return validateBodies({
    analysisName: basename(analysisPath),
    analysisBody,
    prdName: basename(prdPath),
    prdBody,
    authority,
  })
}

function parseArguments(argv) {
  const values = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--analysis' || argument === '--prd' || argument === '--reference') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a path`)
      values[argument.slice(2)] = value
      index += 1
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`)
    } else {
      values.positional.push(argument)
    }
  }
  if (values.analysis === undefined && values.prd === undefined && values.positional.length === 2) {
    values.analysis = values.positional[0]
    values.prd = values.positional[1]
  }
  if (values.analysis === undefined || values.prd === undefined || values.positional.length > 0 && values.analysis !== values.positional[0] && values.prd !== values.positional[1]) {
    throw new Error('usage: validate-deliverables.mjs --analysis <analysis-file> --prd <prd-file> [--reference <templates-file>]')
  }
  return values
}

function usage() {
  return 'Usage: node validate-deliverables.mjs --analysis <analysis-file> --prd <prd-file> [--reference <templates-file>]'
}

async function main() {
  let argumentsValue
  try {
    argumentsValue = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`ERROR: ${error.message}\n${usage()}`)
    process.exitCode = 2
    return
  }
  if (argumentsValue.help) {
    console.log(usage())
    return
  }
  try {
    const result = await validateDeliverables({
      analysisPath: argumentsValue.analysis,
      prdPath: argumentsValue.prd,
      referencePath: argumentsValue.reference ?? DEFAULT_REFERENCE_PATH,
    })
    if (!result.ok) {
      console.error(`FAIL: PMD frozen deliverable contract\n${result.errors.map((error) => `- ${error}`).join('\n')}`)
      process.exitCode = 1
      return
    }
    console.log(`PASS: PMD frozen deliverable contract (${basename(argumentsValue.analysis)}, ${basename(argumentsValue.prd)})`)
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = 2
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main()
