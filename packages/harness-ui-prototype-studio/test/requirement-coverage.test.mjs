import assert from 'node:assert/strict'
import test from 'node:test'
import { productRequirementCoverage, productRequirementCoverageValue } from '../src/requirement-coverage.mjs'

const brief = { v: 1, audience: '采购经理', coreTask: '筛选供应商并完成审批', requiredPages: ['供应商列表'], requiredModules: ['供应商风险'], requiredFlows: ['打开供应商详情'] }

test('deterministically maps each required page, module, and flow to its actual screen and control', () => {
  const document = {
    screens: [{ id: 'supplier-list', title: '供应商列表', nodes: [
      { id: 'risk-table', type: 'table', label: '供应商风险', columns: [{ label: '供应商' }], rows: [{ id: 'supplier-row', values: ['供应商详情'], action: { type: 'open-modal', targetId: 'supplier-detail' } }] },
      { id: 'supplier-detail', type: 'modal', title: '供应商详情', children: [] },
    ] }],
  }
  const coverage = productRequirementCoverage(document, brief)
  assert.equal(coverage.items.every(item => item.status === 'satisfied'), true)
  assert.deepEqual(coverage.items.map(item => [item.id, item.matches[0]?.screenId, item.matches[0]?.nodeId]), [
    ['page-1', 'supplier-list', undefined], ['module-1', 'supplier-list', 'risk-table'], ['flow-1', 'supplier-list', 'supplier-row'],
  ])
  assert.deepEqual(productRequirementCoverageValue(coverage), coverage)
})

test('requires the fixed action outcome to match the flow instead of trusting its button text', () => {
  const wrong = productRequirementCoverage({ screens: [{ id: 'supplier-list', title: '供应商列表', nodes: [
    { id: 'risk-card', type: 'card', label: '供应商风险', children: [] },
    { id: 'fake-detail', type: 'button', label: '打开供应商详情', action: { type: 'open-modal', targetId: 'help-modal' } },
    { id: 'help-modal', type: 'modal', title: '帮助说明', children: [] },
  ] }] }, brief)
  assert.deepEqual(wrong.items.map(item => item.status), ['satisfied', 'satisfied', 'missing'])

  const filterBrief = { ...brief, requiredFlows: ['按名称筛选供应商'] }
  const filter = productRequirementCoverage({ screens: [{ id: 'supplier-list', title: '供应商列表', nodes: [
    { id: 'supplier-name', type: 'input', label: '供应商名称', inputType: 'search' },
    { id: 'risk-table', type: 'table', label: '供应商风险', columns: [{ key: 'name', label: '供应商名称' }], rows: [], filters: [{ inputId: 'supplier-name', columnKey: 'name', operator: 'contains' }] },
  ] }] }, filterBrief)
  assert.equal(filter.items.find(item => item.kind === 'flow').status, 'missing')
})

test('does not let generic labels or a forged status falsely satisfy a requirement', () => {
  const generic = productRequirementCoverage({ screens: [{ id: 'generic-page', title: '页面', nodes: [{ id: 'generic-module', type: 'list', label: '列表', items: [{ id: 'generic-action', title: '操作', action: { type: 'open-modal', targetId: 'detail' } }] }] }] }, brief)
  assert.deepEqual(generic.items.map(item => item.status), ['missing', 'missing', 'missing'])
  const forged = structuredClone(generic)
  forged.items[0].status = 'satisfied'
  forged.items[0].matches = [{ label: '页面', screenId: 'generic-page' }]
  assert.notDeepEqual(productRequirementCoverageValue(forged), productRequirementCoverage({ screens: [{ id: 'generic-page', title: '页面', nodes: [] }] }, brief))
})

function flow(document, requirement) {
  return productRequirementCoverage(document, { v: 1, audience: '产品经理', coreTask: '验证真实交互结果', requiredPages: ['业务页面'], requiredFlows: [requirement] }).items.find(item => item.kind === 'flow')
}

test('replays an invalid form submission before safely filling every required field', () => {
  const result = flow({ screens: [
    { id: 'form', title: '注册表单', nodes: [
      { id: 'email', type: 'input', label: '邮箱', inputType: 'email', required: true },
      { id: 'amount', type: 'input', label: '金额', inputType: 'number', required: true },
      { id: 'owner', type: 'input', label: '负责人', inputType: 'select', options: [{ label: '张三', value: 'zhang-san' }], required: true },
      { id: 'terms', type: 'input', label: '同意条款', inputType: 'checkbox', required: true },
      { id: 'submit', type: 'button', label: '提交注册', action: { type: 'submit-success', targetScreenId: 'done' } },
    ] },
    { id: 'done', title: '注册完成', nodes: [{ id: 'done-copy', type: 'text', text: '已创建账号' }] },
  ] }, '注册完成')
  assert.equal(result.status, 'satisfied')
  assert.match(result.matches[0].verification.steps.join(' '), /空提交显示 4 个校验提示/)
  assert.match(result.matches[0].verification.steps.join(' '), /填写 4 个字段后提交/)
  assert.match(result.matches[0].verification.final, /注册完成/)
})

test('replays filters, sorting, and table pagination only when the visible rows actually change', () => {
  const rows = [
    { id: 'supplier-1', values: ['贝塔供应商'] }, { id: 'supplier-2', values: ['阿尔法供应商'] },
    { id: 'supplier-3', values: ['长城供应商'] }, { id: 'supplier-4', values: ['东方供应商'] },
    { id: 'supplier-5', values: ['飞跃供应商'] }, { id: 'supplier-6', values: ['光明供应商'] },
  ]
  const document = { screens: [{ id: 'suppliers', title: '供应商管理', nodes: [
    { id: 'supplier-filter', type: 'input', label: '供应商名称', inputType: 'search' },
    { id: 'supplier-table', type: 'table', label: '供应商列表', columns: [{ key: 'name', label: '供应商' }], rows, filters: [{ inputId: 'supplier-filter', columnKey: 'name', operator: 'contains' }], sort: { columnKey: 'name', direction: 'desc' }, pagination: { pageSize: 5 } },
  ] }] }
  for (const requirement of ['按供应商名称筛选', '按供应商排序', '供应商列表分页']) {
    const result = flow(document, requirement)
    assert.equal(result.status, 'satisfied', requirement)
    assert.equal(result.matches[0].verification.status, 'replayed')
  }
  const filtered = flow(document, '按供应商名称筛选').matches[0].verification.final
  assert.match(filtered, /贝塔供应商/)
  assert.doesNotMatch(filtered, /阿尔法供应商/)
  const pageTwo = flow(document, '供应商列表分页').matches[0].verification.final
  assert.match(pageTwo, /光明供应商/)
  assert.doesNotMatch(pageTwo, /贝塔供应商/)
  const single = structuredClone(document); single.screens[0].nodes[1].rows = [rows[0]]
  assert.equal(flow(single, '按供应商排序').status, 'missing')
  assert.equal(flow(single, '供应商列表分页').status, 'missing')
  const empty = structuredClone(document); empty.screens[0].nodes[1].rows = []
  assert.equal(flow(empty, '按供应商名称筛选').status, 'missing')
})

test('replays tabs and standalone pagination through changed state and changed visible content', () => {
  const document = { stateVariables: [{ id: 'member-page', initialValue: '1', allowedValues: ['1', '2', '3'] }], screens: [{ id: 'members', title: '成员管理', nodes: [
    { id: 'member-tabs', type: 'tabs', tabs: [
      { id: 'overview', label: '概览', children: [{ id: 'overview-copy', type: 'text', text: '成员概览' }] },
      { id: 'records', label: '审批记录', children: [{ id: 'record-copy', type: 'text', text: '审批记录内容' }] },
    ] },
    { id: 'page-one', type: 'text', text: '第 1 页成员', visibleWhen: { stateId: 'member-page', equals: '1' } },
    { id: 'page-two', type: 'text', text: '第 2 页成员', visibleWhen: { stateId: 'member-page', equals: '2' } },
    { id: 'member-pagination', type: 'pagination', label: '成员列表分页', pageCount: 3, bindStateId: 'member-page' },
  ] }] }
  assert.equal(flow(document, '查看审批记录').status, 'satisfied')
  const pagination = flow(document, '成员列表第2页')
  assert.equal(pagination.status, 'satisfied')
  assert.match(pagination.matches[0].verification.final, /第 2 页成员/)
  const staticPagination = structuredClone(document); staticPagination.screens[0].nodes = staticPagination.screens[0].nodes.filter(node => !['page-one', 'page-two'].includes(node.id))
  assert.equal(flow(staticPagination, '成员列表第2页').status, 'missing')
})

test('replays modal sequences and bounded CRUD mutations, while rejecting wrong row or table ids', () => {
  const document = { stateVariables: [{ id: 'approval-status', initialValue: 'pending', allowedValues: ['pending', 'approved'] }], screens: [{ id: 'projects', title: '项目管理', nodes: [
    { id: 'project-name', type: 'input', label: '项目名称', required: true },
    { id: 'add-project', type: 'button', label: '新增项目', action: { type: 'add-row', tableId: 'project-table', fieldMap: [{ fieldId: 'project-name', columnKey: 'name' }] } },
    { id: 'project-table', type: 'table', label: '项目列表', columns: [{ key: 'name', label: '项目名称' }], rows: [
      { id: 'edit-row', values: ['旧项目'], action: { type: 'edit-row', tableId: 'project-table', fieldMap: [{ fieldId: 'project-name', columnKey: 'name' }] } },
      { id: 'delete-row', values: ['待删除项目'], action: { type: 'delete-row', tableId: 'project-table', businessName: '项目' } },
    ] },
    { id: 'approval-modal', type: 'modal', title: '审批确认', children: [{ id: 'approve', type: 'button', label: '确认审批', action: { type: 'sequence', actions: [{ type: 'set-state', targetId: 'approval-status', value: 'approved' }, { type: 'close-modal', targetId: 'approval-modal' }] } }] },
    { id: 'approved-copy', type: 'text', text: '审批通过', visibleWhen: { stateId: 'approval-status', equals: 'approved' } },
  ] }] }
  for (const requirement of ['新增项目', '编辑项目', '删除项目', '审批通过']) assert.equal(flow(document, requirement).status, 'satisfied', requirement)
  const badTable = structuredClone(document); badTable.screens[0].nodes.find(node => node.id === 'add-project').action.tableId = 'missing-table'
  assert.equal(flow(badTable, '新增项目').status, 'missing')
  const badRow = structuredClone(document); badRow.screens[0].nodes.find(node => node.id === 'project-table').rows[0].action.tableId = 'missing-table'
  assert.equal(flow(badRow, '编辑项目').status, 'missing')
})

test('only accepts replay proof on satisfied flows and never trusts a saved or forged proof', () => {
  const document = { screens: [{ id: 'home', title: '首页', nodes: [{ id: 'open', type: 'button', label: '打开详情', action: { type: 'open-modal', targetId: 'detail' } }, { id: 'detail', type: 'modal', title: '详情', children: [] }] }] }
  const briefValue = { v: 1, audience: '产品经理', coreTask: '查看详情并验证结果', requiredPages: ['首页'], requiredFlows: ['打开详情'] }
  const coverage = productRequirementCoverage(document, briefValue)
  assert.deepEqual(productRequirementCoverageValue(coverage), coverage)
  const missingProof = structuredClone(coverage); delete missingProof.items.find(item => item.kind === 'flow').matches[0].verification
  assert.equal(productRequirementCoverageValue(missingProof), undefined)
  const malformedProof = structuredClone(coverage); malformedProof.items.find(item => item.kind === 'flow').matches[0].verification.steps = []
  assert.equal(productRequirementCoverageValue(malformedProof), undefined)
  const forgedProof = structuredClone(coverage); forgedProof.items.find(item => item.kind === 'flow').matches[0].verification.final = '伪造结果'
  assert.notDeepEqual(productRequirementCoverageValue(forgedProof), productRequirementCoverage(document, briefValue))
  assert.equal(flow(document, '查看详情').status, 'satisfied')
  const help = structuredClone(document); help.screens[0].nodes[1].title = '帮助说明'
  assert.equal(flow(help, '查看详情').status, 'missing')
})
