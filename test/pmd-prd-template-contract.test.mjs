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
  const normalized = authority.replaceAll('\r\n', '\n')
  return [...normalized.matchAll(/```markdown\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]).find((body) => body.includes('# PRD:'))
}

function materialise(body) {
  return body.replaceAll('{编号}', 'REQ-CONTRACT').replaceAll('{编号及链接}', 'REQ-CONTRACT（需求链接待确认）').replaceAll('{主题}', '单一交付').replaceAll('{功能名称}', '客户维护')
    .replace(/\{[^{}\n]+\}/g, '[待确认]')
}

function replaceFirstTarget(body, target) {
  return body.replace(/^(\| \[待确认\] \| 修改 \| \[待确认\]（未取得已选代码库证据，无法确认当前实现及改动影响） \| ).* \|$/m, `$1${target} |`)
}

async function runFixture({ body, name = 'req_contract_单一交付_PRD.md' }) {
  const directory = await mkdtemp(join(tmpdir(), 'pmd-prd-contract-'))
  try {
    const prdPath = join(directory, name)
    await writeFile(prdPath, body)
    return await execFileAsync(process.execPath, [validatorPath, '--prd', prdPath], { cwd: projectRoot })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('accepts one complete product-readable PRD with target-bound implementation details and an acceptance checklist', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const template = prdTemplate(authority)
  assert.ok(template, 'authoritative templates must expose one complete PRD body')
  const body = materialise(template)
  const result = await runFixture({ body })
  assert.match(result.stdout, /PASS: PMD frozen PRD contract/)
  assert.doesNotMatch(body, /\[(?:必填|选填|建议填写)\]|【选填】/)
  assert.doesNotMatch(body, /^#{5,}\s+/m)
  for (const section of ['## （一）正常业务场景', '### 4.1 改动点：', '#### 4.1.1 按钮：', '适用页面：', '| 需求点 | 类型 | 原有实现 | 目标修改点 |', '**实现约束与验收规则**', '## 边界场景', '| 超时 |', '| 并发 |', '| 数据量极值 |', '## （二）异常业务场景', '### 关联改动与风险', '### 回归范围', '## （二）异常场景关注点', '## （三）验收清单', '### 正常情况', '### 异常情况', '### 边界情况', '### 兼容情况']) assert.match(body, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(body, /\| 定位项 \| 位置 \|/)
  assert.match(authority, /完整相对代码路径/)
  assert.match(authority, /按实际复杂度选择最清楚的方式/)
  assert.doesNotMatch(authority, /序号\.【新增\/修改\/删除\/复用】定位：/)
  assert.equal(authority.includes(['“目标修改点”', '的“定位”字段'].join('')), false)
  assert.match(body, /\| 直接改动 \| 关联影响 \| 可能风险 \| 建议处理 \| 是否需要产品决策 \|/)
  assert.match(body, /\| 产品经理 \| \[待确认\] \| 预估人天 \| \[待确认\] \|/)
})

test('accepts flexible development-facing target changes and rejects empty or vague targets', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const body = materialise(prdTemplate(authority))
  const flexibleTargets = [
    '查询区初始化模块：[待确认]（未取得代码证据，无法确认稳定位置；影响研发需先检索入口）；首次渲染时仅展示客户编码、客户名称、客户状态、客户等级和归属人，低频条件仍随请求提交。',
    '① src/modules/mdm/customer/customerManage.js 的 columnConfig 配置：保留合法字段的相对顺序。<br>② src/modules/mdm/customer/columnPreferences.js 的回退逻辑：缺失、重复或无法解析时恢复默认列，并提示用户。',
  ]
  for (const target of flexibleTargets) {
    const result = await runFixture({ body: replaceFirstTarget(body, target) })
    assert.match(result.stdout, /PASS: PMD frozen PRD contract/)
  }
  for (const target of ['', '[待确认]', '优化客户列表展示。']) {
    await assert.rejects(runFixture({ body: replaceFirstTarget(body, target) }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /目标修改点/)
      return true
    })
  }
})

test('rejects invalid two-level changes, legacy locators, invalid code paths, incomplete rules, and wrong system boundaries', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const body = materialise(prdTemplate(authority))
  const fixtures = [
    { body: body.replace('#### 4.1.1 按钮：', '##### 4.1.1 按钮：'), message: /must contain at least one specific child item/ },
    { body: body.replace('#### 4.1.1 按钮：', '#### 4.2.1 按钮：'), message: /must be numbered under ### 4.1 改动点/ },
    { body: body.replace(/(#### 4\.1\.1 [^\n]+\n\n)(适用页面：)/, '$1| 定位项 | 位置 |\n|---|---|\n| 前端代码文件 | src/contract/Detail.java |\n\n$2'), message: /must not contain legacy locator table/ },
    { body: body.replace('| 需求点 | 类型 | 原有实现 | 目标修改点 |', '| 需求点 | 类型 | 目标修改点 |'), message: /missing required development change table/ },
    { body: body.replace('**实现约束与验收规则**', '##### 实现约束与验收规则'), message: /must not contain Markdown headings below the specific-item level/ },
    { body: body.replace('| [待确认] | 修改 |', '| [待确认] | 改造 |'), message: /类型 must be one of: 新增、修改、删除、修复/ },
    { body: body.replace('| [待确认] | 修改 | [待确认]（未取得已选代码库证据，无法确认当前实现及改动影响） |', '| [待确认] | 修改 | 不适用（新增） |'), message: /修改 item 原有实现 must be confirmed or explain \[待确认\] impact/ },
    { body: body.replace('| [待确认] | 修改 |', '| [待确认] | 新增 |'), message: /新增 item 原有实现 must be 不适用（新增）/ },
    { body: body.replace('| 数据量极值 |', '| 大数据 |'), message: /must define system behaviour for: 数据量极值/ },
    { body: `${body}\n\n实现位于 src/contract/Detail.java。`, message: /PRD contains a code locator: src\/contract\/Detail.java/ },
    { body: replaceFirstTarget(body, 'src/contract/Detail.java > CustomerSearchForm > visibleFields：首次渲染时仅保留高频条件，低频条件继续参与查询。'), message: null },
    { body: replaceFirstTarget(body, 'customerManage.js 的列配置：首次渲染时仅保留高频条件，低频条件继续参与查询。'), message: /代码文件必须使用带目录的代码库相对路径/ },
    { body: replaceFirstTarget(body, '/Users/example/workspace/customerManage.js 的列配置：首次渲染时仅保留高频条件，低频条件继续参与查询。'), message: /不得使用开发者本机绝对路径/ },
    { body: replaceFirstTarget(body, 'C:\\workspace\\customerManage.js 的列配置：首次渲染时仅保留高频条件，低频条件继续参与查询。'), message: /不得使用开发者本机绝对路径/ },
    { body: `${body}\n\n## 第八章伪定位\n\n| 定位项 | 位置 |\n|---|---|\n| 前端代码文件 | src/contract/Detail.java |`, message: /PRD contains a code locator: src\/contract\/Detail.java/ },
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
