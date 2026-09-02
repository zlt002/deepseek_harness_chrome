import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { issuePmdPrdReviewReceipt } from '../../../skills/pmd-prd/scripts/issue-review-receipt.mjs'
import { verifyPmdPrdSourceProof } from '../src/pmd-prd-source-proof.mjs'

const projectRoot = resolve(import.meta.dirname, '../../..')
const validatorPath = resolve(projectRoot, 'skills/pmd-prd/scripts/validate-deliverables.mjs')

function validPrd() {
  return `# PRD: req-proof-1 - 评分凭据

## 需求基本信息

| 业务需求名称 | 评分凭据 | 所属系统 | 客户管理系统 |
|---|---|---|---|
| 需求编号及链接 | req-proof-1：https://example.test/req-proof-1 | 产品经理 | 张三 |
| 预估人天 | 8人天 | | |

## 修订记录

| 版本 | 日期 | 修订人 | 审核人 | 修订说明 | 变更分类（产品/业务） |
|---|---|---|---|---|---|
| V1.0 | 2026-09-03 | 张三 | 李四 | 首次提交 | 产品/业务 |

# 二、背景与目标

## （一）描述/痛点

客服无法识别停用客户，可能继续发起无效服务。

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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-proof-'))
  const directory = join(root, 'pmd-workspace', 'spec', 'req-proof-1')
  await writeFile(join(root, 'README.md'), '# ordinary markdown')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ requirementId: 'req-proof-1', workflow: 'pmd-prd' }))
  await writeFile(join(directory, 'req-proof-1_评分凭据_PRD.md'), validPrd())
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, relativePath: 'pmd-workspace/spec/req-proof-1/req-proof-1_评分凭据_PRD.md', manifestPath: join(directory, 'manifest.json') }
}

test('ordinary Markdown cannot obtain PMD provenance merely by sending source pmd-prd', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath: 'README.md', validatorPath }),
    /requires pmd-workspace\/spec/,
  )
})

test('accepts only a validator-issued receipt bound to the current frozen PRD', async (t) => {
  const { root, relativePath, manifestPath } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt is missing/,
  )
  const receipt = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), manifestPath, now: '2026-09-01T00:00:00.000Z' })
  assert.equal(receipt.path, 'req-proof-1_评分凭据_PRD.md')
  assert.equal((JSON.parse(await readFile(manifestPath, 'utf8'))).reviewReceipt.prd.fingerprint, receipt.fingerprint)
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: receipt.fingerprint })
  await writeFile(join(root, relativePath), '# replaced')
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt does not match/,
  )
})
