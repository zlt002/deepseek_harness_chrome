import assert from 'node:assert/strict'
import test from 'node:test'
import { productRequirementCoverage, productRequirementCoverageValue } from '../src/requirement-coverage.mjs'

const brief = { v: 1, audience: '采购经理', coreTask: '筛选供应商并完成审批', requiredPages: ['供应商列表'], requiredModules: ['供应商风险'], requiredFlows: ['打开供应商详情'] }

test('deterministically maps each required page, module, and flow to its actual screen and control', () => {
  const document = {
    screens: [{ id: 'supplier-list', title: '供应商列表', nodes: [
      { id: 'risk-table', type: 'table', label: '供应商风险', columns: [{ label: '供应商' }], rows: [{ id: 'supplier-row', values: ['供应商详情'], action: { type: 'open-modal', targetId: 'supplier-detail' } }] },
    ] }],
  }
  const coverage = productRequirementCoverage(document, brief)
  assert.equal(coverage.items.every(item => item.status === 'satisfied'), true)
  assert.deepEqual(coverage.items.map(item => [item.id, item.matches[0]?.screenId, item.matches[0]?.nodeId]), [
    ['page-1', 'supplier-list', undefined], ['module-1', 'supplier-list', 'risk-table'], ['flow-1', 'supplier-list', 'supplier-row'],
  ])
  assert.deepEqual(productRequirementCoverageValue(coverage), coverage)
})

test('does not let generic labels or a forged status falsely satisfy a requirement', () => {
  const generic = productRequirementCoverage({ screens: [{ id: 'generic-page', title: '页面', nodes: [{ id: 'generic-module', type: 'list', label: '列表', items: [{ id: 'generic-action', title: '操作', action: { type: 'open-modal', targetId: 'detail' } }] }] }] }, brief)
  assert.deepEqual(generic.items.map(item => item.status), ['missing', 'missing', 'missing'])
  const forged = structuredClone(generic)
  forged.items[0].status = 'satisfied'
  forged.items[0].matches = [{ label: '页面', screenId: 'generic-page' }]
  assert.notDeepEqual(productRequirementCoverageValue(forged), productRequirementCoverage({ screens: [{ id: 'generic-page', title: '页面', nodes: [] }] }, brief))
})
