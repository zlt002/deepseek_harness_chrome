import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(new URL('..', import.meta.url).pathname)
const authorityPath = resolve(projectRoot, 'skills/pmd-prd/references/templates.md')
const validatorPath = resolve(projectRoot, 'skills/pmd-prd/scripts/validate-deliverables.mjs')

function fenceToken(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})/)
  return match === null ? null : { character: match[1][0], length: match[1].length }
}

function extractBlock(markdown, marker) {
  const blocks = []
  let fence = null
  let block = []
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const token = fenceToken(line)
    if (token !== null) {
      if (fence === null) {
        fence = token
        block = []
      } else if (token.character === fence.character && token.length >= fence.length) {
        blocks.push(block.join('\n'))
        fence = null
      }
      continue
    }
    if (fence !== null) block.push(line)
  }
  return blocks.find((blockValue) => blockValue.includes(marker))
}

function materialiseTemplate(body) {
  const filled = body
    .replaceAll('{编号}', 'REQ-CONTRACT')
    .replaceAll('{主题}', '模板完整性')
    .replaceAll('{功能名称}', '合同校验')
    .replaceAll('{requirementId}', 'req_contract')
    .replace(/\{[^{}\n]+\}/g, '[待确认]')
  return filled.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed === '- [ ]') return '- [ ] [待确认]'
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(trimmed)) return line
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim() || '[待确认]')
    return `| ${cells.join(' | ')} |`
  }).join('\n')
}

async function completeBodies() {
  const authority = await readFile(authorityPath, 'utf8')
  const analysis = extractBlock(authority, '# 需求分析与研发交付')
  const prd = extractBlock(authority, '# PRD:')
  assert.ok(analysis && prd, 'authoritative templates must expose both complete bodies')
  return {
    analysis: materialiseTemplate(analysis),
    prd: materialiseTemplate(prd),
  }
}

function runValidator(args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [validatorPath, ...args], { cwd: projectRoot }, (error, stdout, stderr) => {
      resolveResult({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

async function runFixture({ analysis, prd, analysisName = 'req_contract_模板完整性_01_需求分析与研发交付.md', prdName = 'req_contract_模板完整性_02_PRD.md' }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pmd-template-contract-'))
  try {
    const analysisPath = join(directory, analysisName)
    const prdPath = join(directory, prdName)
    await Promise.all([writeFile(analysisPath, analysis), writeFile(prdPath, prd)])
    return await runValidator(['--analysis', analysisPath, '--prd', prdPath])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('accepts complete frozen analysis and PRD bodies from the authoritative templates', async () => {
  const bodies = await completeBodies()
  const result = await runFixture(bodies)
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PASS: PMD frozen deliverable contract/)
})

test('rejects summary, old complex analysis, missing six parts, unsupported numbers, filename, and literal backslash-n violations', async () => {
  const bodies = await completeBodies()
  const cases = [
    {
      name: 'summary',
      fixture: { ...bodies, analysis: '# 需求分析与研发交付：REQ-CONTRACT - 模板完整性\n\n仅有摘要。' },
      message: /analysis is missing or reorders/,
    },
    {
      name: 'old complex analysis',
      fixture: { ...bodies, analysis: bodies.analysis.replace('## 2. 产品纠正', '## 2. 证据分类\n| Evidence ID | 类型 |\n|---|---|') },
      message: /analysis is missing or reorders|internal delivery term/,
    },
    {
      name: 'missing six-part section',
      fixture: { ...bodies, analysis: bodies.analysis.replace('## 6. 验收清单', '## 7. 验收清单') },
      message: /analysis is missing or reorders/,
    },
    {
      name: 'missing-information marker',
      fixture: { ...bodies, analysis: bodies.analysis.replace('[待确认]', '待补充') },
      message: /must mark missing information/,
    },
    {
      name: 'filename suffix',
      fixture: { ...bodies, analysisName: 'req_contract_模板完整性_analysis.md' },
      message: /filename must end with/,
    },
    {
      name: 'unsupported number',
      fixture: { ...bodies, analysis: `${bodies.analysis}\n\n预计 12 人天完成。` },
      message: /unsupported quantified claim/,
    },
    {
      name: 'empty acceptance category',
      fixture: { ...bodies, analysis: bodies.analysis.replace('- [ ] [待确认]', '- [ ]') },
      message: /acceptance checklist is empty/,
    },
    {
      name: 'technical PRD locator',
      fixture: { ...bodies, prd: `${bodies.prd}\n\n实现位于 src/views/Home.vue。` },
      message: /code locator that belongs in the handoff/,
    },
    {
      name: 'literal backslash-n',
      fixture: { ...bodies, analysis: `${bodies.analysis}\n字面量 \\n` },
      message: /literal \\n outside a fenced code block/,
    },
  ]
  for (const { name, fixture, message } of cases) {
    const result = await runFixture(fixture)
    assert.notEqual(result.code, 0, `${name} unexpectedly passed`)
    assert.match(result.stderr, message, `${name}: ${result.stderr}`)
  }
})

test('allows a literal backslash-n only inside a fenced code block', async () => {
  const bodies = await completeBodies()
  const result = await runFixture({
    ...bodies,
    analysis: `${bodies.analysis}\n\n` + '```text\nliteral \\n\n```',
  })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
})
