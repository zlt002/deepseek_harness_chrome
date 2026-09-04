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
评分凭据

# 修订记录

V1.0

# 一、术语与缩写

无

# 二、背景与目标

## （一）描述/痛点

客服无法识别停用客户，可能继续发起无效服务。

## （二）目标/价值

客服能识别停用客户，并避免无效服务。

## （三）风险控制

无

# 三、整体流程

## （一）业务/功能流程图

客户列表 → 查看状态 → 发起服务。

# 四、功能性需求

## （一）正常业务场景

### 4.1 客户状态展示

| 需求点 | 阐述 | 原有实现 | 目标改动点 |
|---|---|---|---|
| 【修改】客户状态展示 | 客服需要识别是否可以继续服务。 | 客户列表只展示名称和等级。 | 展示启用或停用状态，发起服务前校验状态。研发定位：客户管理 → 客户列表；页面路由 /customers；文件 src/customer/CustomerList.vue。 |

### 边界场景

无

## （二）异常业务场景

无

# 五、角色权限

无

# 六、非功能性需求

## （一）用户与业务规模

无

## （二）性能指标要求

无

## （三）安全要求

无

## （四）高可用要求

无

## （五）监控告警要求

无

# 七、配置与开关

无

# 八、测试关注点

## （一）影响范围分析

回归客户列表和服务发起入口。

## （二）异常场景关注点

验证状态读取失败后的提示和恢复结果。

## （三）性能压测要求

无

## （四）数据准备要求

测试客户数据。

## （五）验收清单

| 对应需求点 | 验证操作 | 预期结果 |
|---|---|---|
| 【修改】客户状态展示 | 在客户列表查看停用客户并发起服务。 | 可见停用状态，发起服务前被拦截。 |

# 九、参考文档

无
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
  const receipt = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), workspaceRoot: root, now: '2026-09-03T00:00:00.000Z' })
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: receipt.fingerprint })
  await writeFile(join(root, relativePath), validPrd().replace('# PRD: REQ-PROOF-1 -', '# PRD: REQ-PROOF-2 -'))
  await assert.rejects(
    verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }),
    /receipt does not match/,
  )
  const refreshed = await issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), workspaceRoot: root, now: '2026-09-03T00:01:00.000Z' })
  assert.notEqual(refreshed.fingerprint, receipt.fingerprint)
  assert.deepEqual(await verifyPmdPrdSourceProof({ cwd: root, relativePath, validatorPath }), { fingerprint: refreshed.fingerprint })
})

test('source proof refuses an incomplete PRD before it can obtain a receipt', async (t) => {
  const { root, relativePath } = await fixture(t)
  await writeFile(join(root, relativePath), '# PRD: REQ-PROOF-1 - 评分凭据\n\n结构尚未完成。')
  await assert.rejects(
    issuePmdPrdReviewReceipt({ prdPath: join(root, relativePath), workspaceRoot: root, now: '2026-09-03T00:02:00.000Z' }),
    /PMD frozen PRD check failed: PRD is missing or misorders required section/,
  )
})
