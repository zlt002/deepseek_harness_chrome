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

function validPrd() {
  return `# PRD: REQ-100 - 客户状态维护

## 需求基本信息

| 业务需求名称 | 客户状态维护 | 所属系统 | 客户管理系统 |
|---|---|---|---|
| 需求编号及链接 | REQ-100：https://example.test/REQ-100 | 产品经理 | 张三 |
| 预估人天 | 8人天 | | |

## 修订记录

| 版本 | 日期 | 修订人 | 审核人 | 修订说明 | 变更分类（产品/业务） |
|---|---|---|---|---|---|
| V1.0 | 2026-09-03 | 张三 | 李四 | 首次提交 | 产品/业务 |

# 二、背景与目标

## （一）描述/痛点

客服无法区分已停用客户，容易继续发起无效服务。

## （二）目标/价值

| 量化维度 | 现状/基线 | 目标值 | 业务收益 | 度量口径 |
|---|---|---|---|---|
| 停用客户误服务 | 每周10次 | 上线后为0次 | 减少无效服务 | 每周从工单系统统计并由客服主管验收 |

# 四、功能性需求

## （一）正常业务场景

### 4.1 改动点：客户资料

#### 4.1.1 字段与表格：展示客户状态

| 需求点 | 类型 | 原有实现 | 目标修改点 |
|---|---|---|---|
| 客户状态展示 | 修改 | 客户列表只展示名称和等级 | src/customer/CustomerList.vue 的 statusColumn：展示启用、停用状态；停用客户禁止发起服务并显示原因。 |

**实现约束与验收规则**

停用状态由客户资料中的状态字段决定；无权修改状态的人员只能查看。

## （二）异常业务场景

状态读取失败时提示“暂无法获取客户状态”，用户刷新后重试。

# 五、角色权限

| 角色 | 功能/页面 | 权限范围 | 数据范围 | 备注 |
|---|---|---|---|---|
| 客服 | 客户列表 | 查看状态、不可修改 | 本人负责客户 | 无权限变化（已确认依据） |

# 八、测试关注点

## （一）影响范围分析

### 关联改动与风险

| 直接改动 | 关联影响 | 可能风险 | 建议处理 | 是否需要产品决策 |
|---|---|---|---|---|
| 客户列表展示状态 | 服务发起入口 | 状态不同步导致误服务 | 发起前再次校验状态 | 否 |

### 回归范围

回归客户列表、服务发起入口及客服角色的数据权限。

## （二）异常场景关注点

验证状态接口失败后的提示、刷新和恢复结果。

## （三）验收清单

### 正常情况
- [ ] 启用和停用客户均展示正确状态。

### 异常情况
- [ ] 状态读取失败时展示提示，刷新后可恢复。

### 边界情况
- [ ] 无相关边界风险（已确认原因）。

### 权限情况
- [ ] 客服只能查看状态，不能修改状态。

### 兼容情况
- [ ] 服务发起入口仍可正常使用。`
}

async function runFixture({ body, name = 'REQ_100_客户状态维护_PRD.md' }) {
  const directory = await mkdtemp(join(tmpdir(), 'pmd-prd-contract-'))
  try {
    const prdPath = join(directory, name)
    await writeFile(prdPath, body)
    return await execFileAsync(process.execPath, [validatorPath, '--prd', prdPath], { cwd: projectRoot })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('accepts a certain PRD while optional chapters are omitted', async () => {
  const authority = await readFile(authorityPath, 'utf8')
  const body = validPrd()
  const result = await runFixture({ body })
  assert.match(result.stdout, /PASS: PMD frozen PRD contract/)
  assert.doesNotMatch(body, /# (?:一、术语与缩写|三、整体流程|六、非功能性需求|七、配置与开关|九、参考文档)/)
  assert.doesNotMatch(body, /需求优先级|所属功能模块|## 边界场景/)
  assert.match(authority, /最终 PRD 禁止出现 `\[待确认\]`/)
  assert.match(authority, /多系统交互必须输出时序图/)
})

test('rejects unresolved facts, missing required sections, and ambiguous implementation entry points', async () => {
  const body = validPrd()
  const fixtures = [
    { body: body.replace('客户管理系统', '[待确认]'), message: /contains \[待确认\]/ },
    { body: body.replace('| 需求编号及链接 | REQ-100：https://example.test/REQ-100 | 产品经理 | 张三 |', '| 需求编号及链接 | REQ-100：https://example.test/REQ-100 | 产品经理 |  |'), message: /basic information is missing: 产品经理/ },
    { body: body.replace('REQ-100：https://example.test/REQ-100', 'REQ-100'), message: /must include a confirmed requirement link/ },
    { body: body.replace('| 预估人天 | 8人天 |', '| 预估人天 | 大约一周 |'), message: /must be a confirmed numeric person-day value/ },
    { body: body.replace('| 预估人天 | 8人天 |', '| 预估人天 | 12人天 |'), message: /boundary scenarios are required/ },
    { body: body.replace('| V1.0 | 2026-09-03 | 张三 | 李四 | 首次提交 | 产品\/业务 |', '| V1.0 | 2026-09-03 | 张三 |  | 首次提交 | 产品\/业务 |'), message: /revision record must be complete/ },
    { body: body.replace('# 五、角色权限', '# 五、权限说明'), message: /missing or reorders: # 五、角色权限/ },
    { body: body.replace('src/customer/CustomerList.vue 的 statusColumn', '客户列表模块'), message: /必须包含完整相对路径/ },
    { body: body.replace('## （二）异常业务场景', '## （二）其他说明'), message: /正常业务场景 → optional 边界场景 → 异常业务场景/ },
    { body: body.replace('### 兼容情况\n- [ ] 服务发起入口仍可正常使用。', '### 兼容情况\n无'), message: /acceptance checklist is empty: 兼容情况/ },
  ]
  for (const fixture of fixtures) {
    await assert.rejects(runFixture(fixture), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, fixture.message)
      return true
    })
  }
})
