import assert from 'node:assert/strict'
import test from 'node:test'
import { productBrief, productBriefFromFields, productBriefPrompt } from '../src/product-brief.mjs'

test('product brief normalizes a bounded PM acceptance checklist', () => {
  const brief = productBriefFromFields({ audience: ' 采购经理 ', coreTask: '审核供应商准入申请', pages: '工作台，供应商列表\n审批详情', modules: '关键指标\n风险记录', flows: '筛选供应商；打开详情\n通过或驳回申请', notes: '保留审批记录' })
  assert.deepEqual(brief, { v: 1, audience: '采购经理', coreTask: '审核供应商准入申请', requiredPages: ['工作台', '供应商列表', '审批详情'], requiredModules: ['关键指标', '风险记录'], requiredFlows: ['筛选供应商', '打开详情', '通过或驳回申请'], notes: '保留审批记录' })
  assert.match(productBriefPrompt(brief), /必须可以演示的流程/)
  assert.match(productBriefPrompt(brief), /3\. 通过或驳回申请/)
  assert.match(productBriefPrompt(brief), /关键模块：关键指标、风险记录/)
})

test('product brief rejects missing, duplicate, oversized, and surplus fields', () => {
  assert.equal(productBrief({ v: 1, audience: '', coreTask: '审核供应商', requiredPages: ['列表'], requiredFlows: ['审批'] }), undefined)
  assert.equal(productBrief({ v: 1, audience: '采购', coreTask: '审核供应商', requiredPages: ['列表', '列表'], requiredFlows: ['审批'] }), undefined)
  assert.equal(productBrief({ v: 1, audience: '采购', coreTask: '审核供应商', requiredPages: Array.from({ length: 9 }, (_, index) => `页面${index}`), requiredFlows: ['审批'] }), undefined)
  assert.equal(productBrief({ v: 1, audience: '采购', coreTask: '审核供应商', requiredPages: ['列表'], requiredFlows: ['审批'], executable: true }), undefined)
  assert.equal(productBrief({ v: 1, audience: '采购', coreTask: '审核供应商', requiredPages: ['列表'], requiredModules: [], requiredFlows: ['审批'] }), undefined)
})
