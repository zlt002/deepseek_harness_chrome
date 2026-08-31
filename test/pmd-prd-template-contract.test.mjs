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

test('accepts one complete product-readable PRD with two-level changes, permitted locators, and an acceptance checklist', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const template = prdTemplate(authority)
  assert.ok(template, 'authoritative templates must expose one complete PRD body')
  const body = materialise(template)
  const result = await runFixture({ body })
  assert.match(result.stdout, /PASS: PMD frozen PRD contract/)
  assert.doesNotMatch(body, /\[(?:必填|选填|建议填写)\]|【选填】/)
  for (const section of ['## （一）正常业务场景', '### 4.1 改动点：', '#### 4.1.1 按钮：', '| 定位项 | 位置 |', '##### 原逻辑', '##### 调整后逻辑', '## 边界场景', '| 超时 |', '| 并发 |', '| 数据量极值 |', '## （二）异常业务场景', '### 关联改动与风险', '### 回归范围', '## （二）异常场景关注点', '## （三）验收清单', '### 正常情况', '### 异常情况', '### 边界情况', '### 权限情况', '### 兼容情况']) assert.match(body, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(body, /\| 直接改动 \| 关联影响 \| 可能风险 \| 建议处理 \| 是否需要产品决策 \|/)
  assert.match(body, /\| 产品经理 \| \[待确认\] \| 预估人天 \| \[待确认\] \|/)
})

test('rejects invalid two-level changes, missing locators, incomplete rules, wrong system boundaries, and illegal code locators', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const body = materialise(prdTemplate(authority))
  const fixtures = [
    { body: body.replace('#### 4.1.1 按钮：', '##### 4.1.1 按钮：'), message: /must contain at least one specific child item/ },
    { body: body.replace('#### 4.1.1 按钮：', '#### 4.2.1 按钮：'), message: /must be numbered under ### 4.1 改动点/ },
    { body: body.replace('| PC 页面 URL | [待确认]（未取得已选代码库证据，无法确认页面入口） |', '| 页面 | [待确认]（未取得已选代码库证据，无法确认页面入口） |'), message: /is missing locator: PC 页面 URL/ },
    { body: body.replace('##### 调整后逻辑', '##### 变更说明'), message: /改造 item and must compare 原逻辑 with 调整后逻辑/ },
    { body: body.replace('##### 原逻辑\n\n[待确认]', '##### 原逻辑'), message: /原逻辑 must contain content/ },
    { body: body.replace('**变更类型：** 改造', '**变更类型：** 新增'), message: /新增 item and must not retain 原逻辑 or 调整后逻辑 headings/ },
    { body: body.replace('**变更类型：** 改造', '**变更类型：** 新增').replace('##### 原逻辑\n\n[待确认]\n\n##### 调整后逻辑\n\n[待确认]\n\n', '').replace('##### 交互与规则', '##### 其他说明'), message: /新增 item and must describe applicable rules/ },
    { body: body.replace('| 数据量极值 |', '| 大数据 |'), message: /must define system behaviour for: 数据量极值/ },
    { body: `${body}\n\n实现位于 src/contract/Detail.java。`, message: /PRD contains a code locator: src\/contract\/Detail.java/ },
    { body: body.replace('| 前端代码文件 | [待确认]（未取得已选代码库证据，无法确认实现位置） |', '| 前端代码文件 | src/contract/Detail.java |'), message: null },
    { body: `${body}\n\n## 第八章伪定位\n\n| 定位项 | 位置 |\n|---|---|\n| 前端代码文件 | src/contract/Detail.java |`, message: /PRD contains a code locator: src\/contract\/Detail.java/ },
    { body: body.replace('#### 4.1.1 按钮：', '| 定位项 | 位置 |\n|---|---|\n| 前端代码文件 | src/contract/Detail.java |\n\n#### 4.1.1 按钮：'), message: /PRD contains a code locator: src\/contract\/Detail.java/ },
    { body: body.replace('| 产品经理 | [待确认] | 预估人天 | [待确认] |', '| 产品经理 | [待确认] | 预估人天 | 12人天 |'), message: /must define system behaviour for: 超时/ },
    { body: body.replace('| 产品经理 | [待确认] | 预估人天 | [待确认] |', '| 产品经理 | [待确认] | 预估人天 | 8人天 |').replace('| 超时 | [待确认] |', '| 超时 | 不适用（预估人天不超过10人天） |').replace('| 并发 | [待确认] |', '| 并发 | 不适用（预估人天不超过10人天） |').replace('| 数据量极值 | [待确认] |', '| 数据量极值 | 不适用（预估人天不超过10人天） |'), message: null },
    { body: body.replace('### 关联改动与风险', '### 普通影响说明'), message: /PRD impact analysis is missing: ### 关联改动与风险/ },
    { body: body.replace('| 直接改动 | 关联影响 | 可能风险 | 建议处理 | 是否需要产品决策 |', '| 改动内容 | 影响说明 |'), message: /PRD impact analysis is missing required table/ },
    { body: body.replace('### 回归范围', '### 其他说明'), message: /PRD impact analysis is missing: ### 回归范围/ },
    { body: body.replace('## （二）异常场景关注点', '## （二）验收清单').replace('## （三）验收清单', '## （三）补充说明'), message: /PRD test focus is missing or reorders: ## （二）异常场景关注点/ },
    { body: body.replace('| 产品经理 | [待确认] | 预估人天 | [待确认] |', '| 产品经理 | [待确认] | | |'), message: /PRD basic information is missing: 预估人天/ },
    { body: `${body}\n\n调用 confirmReceivingOrders 完成接单。`, message: /code-style identifier.*confirmReceivingOrders/ },
    { body: body.replace(/### 兼容情况\r?\n- \[ \] \[待确认\]/, '### 兼容情况\n无'), message: /PRD acceptance checklist is empty: 兼容情况/ },
    { body: body.replace('## 修订记录', '## 修订记录 [必填]'), message: /PRD exposes a field label: \[必填\]/ },
    { body, name: 'req_contract_PRD_02.md', message: /PRD filename must end with _PRD/ },
  ]
  for (const fixture of fixtures) {
    if (fixture.message === null) { const result = await runFixture(fixture); assert.match(result.stdout, /PASS: PMD frozen PRD contract/); continue }
    await assert.rejects(runFixture(fixture), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, fixture.message)
      return true
    })
  }
})
