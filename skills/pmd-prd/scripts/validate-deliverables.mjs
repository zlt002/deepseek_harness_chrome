#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNRESOLVED_CONTENT = /\[待确认\]|待补充|占位|后续回填|以后回填|稍后确认|最终以(?:设计稿|业务确认|评审结果)为准/
const CODE_IDENTIFIER = /\b(?:[a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/

function terminologyRows(body) {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '# 一、术语与缩写')
  if (start < 0) return []
  const section = lines.slice(start + 1)
  const end = section.findIndex((line) => /^#\s/.test(line.trim()))
  return section.slice(0, end < 0 ? section.length : end).map((line) => line.trim()).filter((line) => /^\|.*\|$/.test(line)).map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim())).filter((cells) => cells.length >= 2 && cells[0] !== '术语/缩写' && !/^:?-{3,}:?$/.test(cells[0]))
}

function validationErrors({ prdName, prdBody }) {
  const errors = []
  if (typeof prdName !== 'string' || !prdName.replace(/\.md$/, '').endsWith('_PRD')) errors.push('PRD filename must end with _PRD')
  if (typeof prdBody !== 'string' || prdBody.trim() === '') return [...errors, 'PRD body must be non-empty']
  const titleLines = prdBody.split(/\r?\n/).filter((line) => line.startsWith('# PRD:'))
  if (titleLines.length !== 1 || !/^# PRD: \S.* - \S.*$/.test(titleLines[0])) errors.push('PRD must contain exactly one complete title')
  if (UNRESOLVED_CONTENT.test(prdBody)) errors.push('PRD contains unresolved content')
  if (terminologyRows(prdBody).some((cells) => CODE_IDENTIFIER.test(`${cells[0]} ${cells[1]}`))) errors.push('PRD contains a code identifier in terminology')
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
