import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { issuePmdPrdReviewReceipt } from '../skills/pmd-prd/scripts/issue-review-receipt.mjs'
import { validateBody, validatePmdBatch } from '../skills/pmd-prd/scripts/validate-deliverables.mjs'

function completePrd({ requirementCell = '研发定位：菜单 客户管理 → 客户状态；页面路由 /customers；接口 PATCH /api/customers/status；文件 packages/customer/src/status.ts' } = {}) {
  return `# PRD: REQ-100 - 客户状态维护

# 需求基本信息
客户状态维护

# 修订记录
V1.0

# 一、术语与缩写
无

# 二、背景与目标
## （一）描述/痛点
用户无法统一维护客户状态。

## （二）目标/价值
用户确认可在客户管理中维护客户状态。

## （三）风险控制
无

# 三、整体流程
## （一）业务/功能流程图
客户管理 → 修改状态 → 保存结果。

# 四、功能性需求
## （一）正常业务场景
### 4.1 客户状态维护
| 需求点 | 阐述 | 原有实现 | 目标改动点 |
|---|---|---|---|
| 【修改】客户状态维护 | 用户在客户管理维护状态。 | 当前只能查看状态。 | 保存后展示最新状态。${requirementCell} |

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
客户状态展示。

## （二）异常场景关注点
保存失败提示。

## （三）性能压测要求
无

## （四）数据准备要求
测试客户数据。

## （五）验收清单
| 对应需求点 | 验证操作 | 预期结果 |
|---|---|---|
| 【修改】客户状态维护 | 在客户管理修改状态并保存。 | 保存成功并展示最新状态。 |

# 九、参考文档
无
`
}

test('mechanical gate rejects incomplete PRD and accepts the complete required structure', () => {
  const incomplete = validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: '# PRD: REQ-100 - 客户状态维护\n\n内容尚未完成。' })
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.errors.join('\n'), /required section/)
  assert.equal(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd() }).ok, true)
})

test('mechanical gate rejects invalid filename, title, unresolved content, terminology identifiers, and placeholders', () => {
  assert.match(validateBody({ prdName: 'draft.md', prdBody: completePrd() }).errors.join('\n'), /filename/)
  assert.match(validateBody({ prdName: 'draft_PRD.md', prdBody: '' }).errors.join('\n'), /non-empty/)
  assert.match(validateBody({ prdName: 'draft_PRD.md', prdBody: '# PRD: REQ-100 - 客户状态维护\n# PRD: REQ-101 - 另一份' }).errors.join('\n'), /exactly one complete title/)
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd().replace('用户无法统一维护客户状态。', '产品经理待补充。') }).errors.join('\n'), /unresolved content/)
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd().replace('无\n\n# 二、背景与目标', '| dispatchStatus | 调度状态 | 接口字段 |\n\n# 二、背景与目标') }).errors.join('\n'), /code identifier in terminology/)
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd().replace('客户状态维护\n\n# 修订记录', '{客户状态维护}\n\n# 修订记录') }).errors.join('\n'), /template placeholders/)
})

test('mechanical gate requires a four-column requirement row, development locator, and acceptance test cases', () => {
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd({ requirementCell: '没有研发位置。' }) }).errors.join('\n'), /target column must include 研发定位/)
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd().replace('| 对应需求点 | 验证操作 | 预期结果 |', '| 验收内容 |') }).errors.join('\n'), /acceptance test-case table header/)
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: completePrd().replace('| 【修改】客户状态维护', '| 客户状态维护') }).errors.join('\n'), /【修改】/)
})

test('skill and template keep evidence, locator, boundary, and review rules aligned', async () => {
  const [skill, template] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8'),
  ])
  const combined = `${skill}\n${template}`
  for (const text of [
    '用户当前对话直接提供或确认的内容均视为用户确认',
    '其他章节和字段不从代码库、资料或模型推断直接填充',
    '资料只能作为候选依据，不能代替确认',
    '可写菜单路径、页面路由、接口和仓库相对文件级研发定位',
    '不写变量、代码行号、列号、代码片段、算法或详细实现方案',
    '研发定位必须经代码查询确认',
    '本轮不使用远程资料',
    '执行基础机械检查格式',
  ]) assert.ok(combined.includes(text), text)
  assert.match(template, /本小节保留。涉及资金、计费、结算、监管、审计、隐私或舆情等真实业务风险时填写/)
  assert.match(template, /### 边界场景/)
  assert.doesNotMatch(template, /超过 10 人天/)
  assert.match(template, /类或函数名仅在消除歧义时补充；不写变量、代码行号、列号、代码片段、算法或详细实现方案/)
  assert.match(template, /“目标改动点”同时保留产品视角和研发视角/)
  assert.match(template, /从研发视角描述改哪里（具体说清楚功能位置，如：“订单管理→某某页面→某某按钮→双击时候”）、怎么改、要实现什么，可以附带要改动的大概编码路径/)
  assert.match(template, /“阐述”面向产品经理，按实际内容用“使用场景、当前问题、目标结果”概括/)
  assert.match(template, /“原有实现”按实际内容用“功能入口、现有流程\/规则、现有结果”说明改造前情况/)
  assert.match(template, /可按实际内容使用 \*\*改哪个功能：\*\*、\*\*当前问题：\*\*、\*\*目标结果：\*\* 等小标题/)
  assert.match(template, /结构化输出.*要改的功能位置.*流程.*规则和逻辑/)
  assert.match(template, /先写“产品视角”，再写“研发视角”/)
  assert.match(template, /研发视角按实际改动标注 `【前端】`、`【后端】`/)
  assert.match(template, /有两项及以上改动时，使用 `\s*<br>1\. \.\.\.\s*<br>2\. \.\.\.` 编号列表逐项展示/)
  assert.match(template, /每项分别写改动内容和研发定位，不能堆成一段/)
  assert.match(template, /\*\*产品视角：\*\*\s*<br>[\s\S]*<br>\s*<br>\*\*研发视角：\*\*\s*<br>/)
  assert.match(template, /\*\*研发视角：\*\*\s*<br>\{从研发视角描述改哪里[\s\S]*<br>\s*<br>\*\*【前端】\*\*\s*<br>/)
  assert.match(template, /\*\*【前端】\*\*\s*<br>[\s\S]*\*\*改动内容：\*\*、\*\*功能位置：\*\* 和必要的 \*\*大概的编码路径：\*\*[\s\S]*\*\*【后端】\*\*\s*<br>/)
  assert.match(template, /根据第四章的需求点编写验收用例/)
  assert.match(template, /每个需求点至少一条，名称与第四章一致/)
  assert.match(template, /写清怎么操作、应该看到什么结果；一条规则写一行/)
  assert.match(template, /\| 对应需求点 \| 验证操作 \| 预期结果 \|/)
  assert.doesNotMatch(template, /### 正常情况|### 异常情况|### 边界情况|### 权限情况|### 兼容情况/)
  assert.match(template, /代码变量名和组件名不进入 PRD；类名或函数名仅在文件定位仍无法消除歧义时补充/)
  assert.match(template, /需求基本信息只有选填字段未知时可以留空/)
  assert.match(template, /澄清交互中.*不展示内部文件名.*最终 PRD 第四章可在必要时展示页面路由、接口和仓库相对文件定位/)
})

test('batch gate applies the complete PRD validation', () => {
  assert.equal(validatePmdBatch({ batchId: 'pmd:run-1', items: [{ name: '客户状态维护_PRD', body: completePrd() }] }), null)
  assert.match(validatePmdBatch({ batchId: 'pmd:run-1', items: [{ name: '客户状态维护_PRD', body: '# PRD: REQ-100 - 客户状态维护' }] }), /required section/)
  assert.match(validatePmdBatch({ batchId: 'pmd:run-1', items: [{ name: '草稿', body: completePrd() }] }), /filename/)
})

test('review receipt accepts only a complete PRD in the exact project workspace structure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-review-')); t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'pmd-workspace', 'spec', 'run-prd-100'); const prdPath = join(directory, 'run-prd-100_客户状态维护_PRD.md')
  await mkdir(directory, { recursive: true }); await writeFile(prdPath, completePrd())
  const receipt = await issuePmdPrdReviewReceipt({ prdPath, workspaceRoot: root, now: '2026-09-03T00:00:00.000Z' })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.businessRequirementId, 'REQ-100'); assert.equal(manifest.reviewReceipt.prd.fingerprint, receipt.fingerprint)
  await writeFile(prdPath, completePrd().replace('REQ-100', 'REQ-OTHER'))
  const refreshed = await issuePmdPrdReviewReceipt({ prdPath, workspaceRoot: root, now: '2026-09-03T00:01:00.000Z' })
  assert.notEqual(refreshed.fingerprint, receipt.fingerprint)
})

test('review receipt rejects an unrelated root, a missing workspace segment, and an incomplete PRD', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-review-')); t.after(() => rm(root, { recursive: true, force: true }))
  const validDirectory = join(root, 'pmd-workspace', 'spec', 'run-prd-100'); const validPath = join(validDirectory, 'run-prd-100_客户状态维护_PRD.md')
  await mkdir(validDirectory, { recursive: true }); await writeFile(validPath, completePrd())
  await assert.rejects(() => issuePmdPrdReviewReceipt({ prdPath: validPath, workspaceRoot: join(root, 'other-root') }), /pmd-workspace\/spec/)
  const invalidDirectory = join(root, 'similar-pmd-workspace', 'spec', 'run-prd-100'); const invalidPath = join(invalidDirectory, 'run-prd-100_客户状态维护_PRD.md')
  await mkdir(invalidDirectory, { recursive: true }); await writeFile(invalidPath, completePrd())
  await assert.rejects(() => issuePmdPrdReviewReceipt({ prdPath: invalidPath, workspaceRoot: root }), /pmd-workspace\/spec/)
  await writeFile(validPath, '# PRD: REQ-100 - 客户状态维护\n\n不完整内容。')
  await assert.rejects(() => issuePmdPrdReviewReceipt({ prdPath: validPath, workspaceRoot: root }), /required section/)
})
