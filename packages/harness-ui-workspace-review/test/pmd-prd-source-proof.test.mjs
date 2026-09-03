import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { issuePmdPrdReviewReceipt } from '../../../skills/pmd-prd/scripts/issue-review-receipt.mjs'
import { verifyPmdPrdSourceProof } from '../src/pmd-prd-source-proof.mjs'

const projectRoot = resolve(import.meta.dirname, '../../..')
const validatorPath = resolve(projectRoot, 'skills/pmd-prd/scripts/validate-deliverables.mjs')

function validPrd() {
  return `# PRD: REQ-PROOF-1 - 评分凭据

# 需求基本信息

| 业务需求名称 | 评分凭据 | 需求优先级 | P1 |
|---|---|---|---|
| 需求编号及链接 | REQ-PROOF-1：https://example.test/REQ-PROOF-1 |  |  |
| 所属系统 | 客户管理系统 | 所属功能模块 | 客户列表 |
| 产品经理 | 张三 | 预估人天 | 8人天 |

# 修订记录

| 版本 | 日期 | 修订人 | 审核人 | 修订说明 | 变更分类（产品/业务） |
|---|---|---|---|---|---|
| V1.0 | 2026-09-03 | 张三 | 李四 | 首次提交 | 产品 |

# 二、背景与目标

## （一）描述/痛点

客服无法识别停用客户，可能继续发起无效服务。

## （二）目标/价值

客服能识别停用客户，并避免无效服务。

# 四、功能性需求

## （一）正常业务场景

### A功能：客户状态展示

功能点说明：客服在客户列表查看客户时，需要识别是否可以继续服务。

本次处理：修改

原有情况：客户列表只展示名称和等级。

调整后：客户列表展示启用或停用状态，并在发起服务前校验状态。

业务规则：停用客户不能发起服务；无权修改状态的人员只能查看。

##### 输入/输出规则

输入为客户列表查询；输出包含状态。

- 研发定位：src/customer/CustomerList.vue 的 statusColumn；展示客户状态；完成后客服可识别停用客户。

## （二）异常业务场景

- 状态读取失败时提示用户刷新重试，刷新后恢复展示。

# 五、角色权限

| 角色 | 功能/页面 | 权限范围 | 数据范围 | 备注 |
|---|---|---|---|---|
| 客服 | 客户列表 | 查看状态、不可修改 | 本人负责客户 | 不适用（无权限变更）。 |

# 八、测试关注点

## （一）影响范围分析

回归客户列表和服务发起入口。

## （二）异常场景关注点

验证状态读取失败后的提示和恢复结果。

## （五）验收清单

### 正常情况
- [ ] 展示客户状态。

### 异常情况
- [ ] 失败时提示重试。

### 边界情况
- [ ] 无相关边界风险，已确认原因。

### 权限情况
- [ ] 客服只能查看状态。

### 兼容情况
- [ ] 服务发起入口可用。
`
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-proof-'))
  const directory = join(root, 'pmd-workspace', 'spec', 'run-proof-1')
  const relativePath = 'pmd-workspace/spec/run-proof-1/run-proof-1_评分凭据_PRD.md'
  await writeFile(join(root, 'README.md'), '# ordinary markdown')
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, relativePath), validPrd())
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, relativePath }
}

test('ordinary Markdown cannot obtain PMD provenance merely by sending source pmd-prd', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath: 'README.md', validatorPath }),
    /requires pmd-workspace\/spec/,
  )
})

test('requires a current automatic receipt and accepts a valid PRD after it is reissued', async (t) => {
  const { root, relativePath } = await fixture(t)
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /manifest is missing/,
  )
  const receipt = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), now: '2026-09-03T00:00:00.000Z' })
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: receipt.fingerprint })
  await writeFile(join(root, relativePath), validPrd().replace('# PRD: REQ-PROOF-1 -', '# PRD: REQ-PROOF-2 -'))
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt does not match/,
  )
  const refreshed = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), now: '2026-09-03T00:01:00.000Z' })
  assert.notEqual(refreshed.fingerprint, receipt.fingerprint)
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: refreshed.fingerprint })
})

test('source proof accepts identity-valid content without asserting template semantics', async (t) => {
  const { root, relativePath } = await fixture(t)
  await writeFile(join(root, relativePath), '# PRD: REQ-PROOF-1 - 评分凭据\n\n结构尚未完成。')
  await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), now: '2026-09-03T00:02:00.000Z' })
  const result = await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath })
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
})
