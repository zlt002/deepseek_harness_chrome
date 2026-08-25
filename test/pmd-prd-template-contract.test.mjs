import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const authorityPath = resolve(projectRoot, 'skills/pmd-prd/references/templates.md')
const validatorPath = resolve(projectRoot, 'skills/pmd-prd/scripts/validate-deliverables.mjs')

function prdTemplate(authority) {
  return [...authority.matchAll(/```markdown\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((body) => body.includes('# PRD:'))
}

function materialise(body) {
  return body.replaceAll('{编号}', 'REQ-CONTRACT').replaceAll('{编号及链接}', 'REQ-CONTRACT（需求链接待确认）').replaceAll('{主题}', '单一交付').replaceAll('{功能名称}', '客户维护')
    .replace(/\{[^{}\n]+\}/g, '[待确认]')
}

async function runFixture({ body, name = 'req_contract_单一交付_PRD.md' }) {
  const directory = await mkdtemp(join(tmpdir(), 'pmd-prd-contract-'))
  try {
    const prdPath = join(directory, name)
    await writeFile(prdPath, body)
    return await execFileAsync(process.execPath, [validatorPath, '--prd', prdPath], { cwd: projectRoot })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('accepts one complete product-readable PRD that preserves the company template and adds an acceptance checklist', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const template = prdTemplate(authority)
  assert.ok(template, 'authoritative templates must expose one complete PRD body')
  const body = materialise(template)
  const result = await runFixture({ body })
  assert.match(result.stdout, /PASS: PMD frozen PRD contract/)
  assert.doesNotMatch(body, /\[(?:必填|选填|建议填写)\]|【选填】/)
  for (const section of ['## （一）正常业务场景', '#### 现状', '#### 调整方式', '#### 输入/输出规则', '#### 调整后效果', '## 边界场景', '## （二）异常业务场景', '## （二）异常场景关注点', '## （三）验收清单', '### 正常情况', '### 异常情况', '### 边界情况', '### 权限情况', '### 兼容情况']) assert.match(body, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(body, /\| 产品经理 \| \[待确认\] \| 预估人天 \| \[待确认\] \|/)
})

test('rejects missing input/output rules, replaced exception focus, missing required basic information, code identifiers, field labels, and invalid names', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const body = materialise(prdTemplate(authority))
  const fixtures = [
    { body: body.replace('#### 输入/输出规则', '#### 交互说明'), message: /is missing or reorders: #### 输入\/输出规则/ },
    { body: body.replace('## （二）异常场景关注点', '## （二）验收清单').replace('## （三）验收清单', '## （三）补充说明'), message: /PRD test focus is missing or reorders: ## （二）异常场景关注点/ },
    { body: body.replace('| 产品经理 | [待确认] | 预估人天 | [待确认] |', '| 产品经理 | [待确认] | | |'), message: /PRD basic information is missing: 预估人天/ },
    { body: body.replace('#### 调整后效果', '#### 调整后效果\n\n调用 confirmReceivingOrders 完成接单。'), message: /code-style identifier.*confirmReceivingOrders/ },
    { body: body.replace(/### 兼容情况\r?\n- \[ \] \[待确认\]/, '### 兼容情况\n无'), message: /PRD acceptance checklist is empty: 兼容情况/ },
    { body: body.replace('## 修订记录', '## 修订记录 [必填]'), message: /PRD exposes a field label: \[必填\]/ },
    { body, name: 'req_contract_PRD_02.md', message: /PRD filename must end with _PRD/ },
  ]
  for (const fixture of fixtures) {
    await assert.rejects(runFixture(fixture), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, fixture.message)
      return true
    })
  }
})
