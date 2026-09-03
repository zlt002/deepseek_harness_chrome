import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { issuePmdPrdReviewReceipt } from '../skills/pmd-prd/scripts/issue-review-receipt.mjs'
import { validateBody, validatePmdBatch } from '../skills/pmd-prd/scripts/validate-deliverables.mjs'

test('mechanical gate accepts structurally incomplete identity-valid PRD', () => {
  assert.equal(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: '# PRD: REQ-100 - 客户状态维护\n\n内容尚未完成。' }).ok, true)
})

test('mechanical gate rejects invalid filename, empty body, and duplicate/incomplete title', () => {
  assert.match(validateBody({ prdName: 'draft.md', prdBody: '# PRD: REQ-100 - 客户状态维护' }).errors.join('\n'), /filename/)
  assert.match(validateBody({ prdName: 'draft_PRD.md', prdBody: '' }).errors.join('\n'), /non-empty/)
  assert.match(validateBody({ prdName: 'draft_PRD.md', prdBody: '# PRD: REQ-100 - 客户状态维护\n# PRD: REQ-101 - 另一份' }).errors.join('\n'), /exactly one complete title/)
  assert.match(validateBody({ prdName: 'draft_PRD.md', prdBody: '# PRD: REQ-100 - 客户状态维护\n# PRD: incomplete' }).errors.join('\n'), /exactly one complete title/)
})

test('mechanical gate rejects unresolved content and code identifiers in terminology', () => {
  const unresolved = '# PRD: REQ-100 - 客户状态维护\n\n产品经理：待补充，链接为占位，后续回填。'
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: unresolved }).errors.join('\n'), /unresolved content/)

  const technicalTerms = `# PRD: REQ-100 - 客户状态维护

# 一、术语与缩写

| 术语/缩写 | 全称 | 定义说明 |
|---|---|---|
| dispatchStatus | 调度状态 | 接口字段 |
| 虚拟列表 | DynamicScroller | 页面组件 |
| 原因字典 | REFUSAL_CAUSE | 原因字段 |`
  assert.match(validateBody({ prdName: 'run-prd-100_客户状态维护_PRD.md', prdBody: technicalTerms }).errors.join('\n'), /code identifier in terminology/)
})

test('skill makes concise product content and terminology provenance explicit', async () => {
  const [skill, template] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8'),
  ])
  for (const text of [
    '反复纠正',
    '明确表示不理解',
    '代码字段、变量、类名和组件名',
    '最少必要信息',
    '描述/痛点最多简要概括一两句',
    '目标/价值只有用户已确认且输入资料明确有依据时才具体写',
    '流程图优先用“入口→关键操作→结果”一句话',
    '非功能性需求：只有用户确认，并且其输入或提供/选定资料有明确要求时才填写',
    '只有第四章功能改动点可综合用户输入、用户提供/选定资料和代码查询',
    '其他章节和字段不能从代码库或模型推断直接填充',
    '模板标为必填的内容缺失时，先在澄清阶段向用户确认',
  ]) {
    assert.ok(`${skill}\n${template}`.includes(text), text)
  }
  assert.match(template, /## （一）描述\/痛点\n\n<!-- 最多用一两句话/)
  assert.match(template, /## （二）目标\/价值\n\n<!-- 只有用户已确认，并且用户提供\/选定资料也明确写出/)
  assert.match(template, /流程优先用“入口→关键操作→结果”一句话/)
  const nonFunctionalStart = template.lastIndexOf('<!--', template.indexOf('# 六、非功能性需求'))
  const nonFunctionalSection = template.slice(nonFunctionalStart, template.indexOf('# 七、配置与开关'))
  assert.match(nonFunctionalSection, /各小节全部保留，没有相关要求时写“无”/)
  assert.doesNotMatch(nonFunctionalSection, /超过 10 人天/)
  assert.match(template, /只写用户确认的异常；输入资料只能帮助准备候选内容，不能代替确认.*不从代码查询自动扩写/)
  assert.match(template, /只写用户确认的权限.*输入资料只能帮助准备候选内容，不能代替确认.*不从代码查询推断角色、范围或权限/)
})

test('normal business scenarios group large changes and render every change point as a four-column table', async () => {
  const template = await readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8')

  assert.match(template, /功能分组 → 改动点/)
  assert.match(template, /改动点较多时，先按同一业务功能或用户流程分组/)
  assert.match(template, /\| 需求点 \| 阐述 \| 原有实现 \| 目标改动点 \|/)
  assert.match(template, /新增项统一写“\/”/)
  assert.match(template, /类型”只写修改、新增或删除/)
  assert.doesNotMatch(template, /^功能点说明：/m)
  assert.doesNotMatch(template, /^本次处理：/m)
  assert.doesNotMatch(template, /^原有情况：/m)
  assert.doesNotMatch(template, /^调整后：/m)
})

test('keeps every PRD section and writes 无 when the section has no content', async () => {
  const [skill, template] = await Promise.all([
    readFile(new URL('../skills/pmd-prd/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8'),
  ])

  assert.match(skill, /模板中的章节和小节全部保留.*没有内容时写“无”/)
  assert.match(skill, /需求基本信息的未知字段仍按模板留空/)
  assert.match(template, /模板章节和小节全部保留，没有内容时写“无”/)
  assert.match(template, /无内容的章节、小节或表格位置用“无”表示/)
  assert.match(template, /没有权限内容时保留本章并写“无”/)
  assert.match(template, /各小节全部保留，没有相关要求时写“无”/)
  assert.doesNotMatch(`${skill}\n${template}`, /非必填内容默认删除|其他情况删除整章|选填内容直接删除/)
})

test('basic information requires confirmation while unsupported optional fields stay blank', async () => {
  const template = await readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8')

  assert.match(template, /必填：业务需求名称、需求编号及链接、所属系统、产品经理、预估人天/)
  assert.match(template, /缺失时必须向用户确认，确认前不能生成最终 PRD/)
  assert.match(template, /选填：优先级、评审纪要、所属功能模块/)
  assert.match(template, /对应单元格留空/)
  assert.match(template, /不猜测、不编造需求编号、链接、姓名、系统、模块和估算值/)
  assert.match(template, /不要在表格下增加.*解释性备注/)
})

test('batch gate maps the public name and body fields into the identity check', () => {
  assert.equal(validatePmdBatch({ batchId: 'pmd:run-1', items: [{ name: '客户状态维护_PRD', body: '# PRD: REQ-100 - 客户状态维护' }] }), null)
  assert.match(validatePmdBatch({ batchId: 'pmd:run-1', items: [{ name: '草稿', body: '# PRD: REQ-100 - 客户状态维护' }] }), /filename/)
})

test('review receipt binds the frozen file and refreshes its fingerprint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pmd-prd-review-')); t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'pmd-workspace', 'spec', 'run-prd-100'); const prdPath = join(directory, 'run-prd-100_客户状态维护_PRD.md')
  await mkdir(directory, { recursive: true }); await writeFile(prdPath, '# PRD: REQ-100 - 客户状态维护\n\n不完整内容。')
  const receipt = await issuePmdPrdReviewReceipt({ prdPath, now: '2026-09-03T00:00:00.000Z' })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.businessRequirementId, 'REQ-100'); assert.equal(manifest.reviewReceipt.prd.fingerprint, receipt.fingerprint)
  await writeFile(prdPath, '# PRD: REQ-OTHER - 另一需求\n\n仍不完整。')
  const refreshed = await issuePmdPrdReviewReceipt({ prdPath, now: '2026-09-03T00:01:00.000Z' })
  assert.notEqual(refreshed.fingerprint, receipt.fingerprint)
})
