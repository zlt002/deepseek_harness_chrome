import assert from 'node:assert/strict'
import test from 'node:test'
import { localEditScopeIssues } from '../src/local-edit-scope.mjs'

const selection = { elementId: 'open-details', type: 'button', label: '查看详情' }
const baseline = {
  v: 1, id: 'prototype', title: '供应商准入', designSpecId: 'design-one', initialScreenId: 'overview',
  stateVariables: [{ id: 'approval', initialValue: 'pending', allowedValues: ['pending', 'approved'] }],
  screens: [
    { id: 'overview', title: '概览', nodes: [
      { id: 'open-details', type: 'button', label: '查看详情', action: { type: 'open-modal', targetId: 'details' } },
      { id: 'open-settings', type: 'button', label: '查看设置', action: { type: 'navigate', targetScreenId: 'settings' } },
      { id: 'submit-approval', type: 'button', label: '提交审批', action: { type: 'submit-success', targetScreenId: 'complete' } },
      { id: 'details', type: 'modal', title: '供应商详情', children: [{ id: 'details-copy', type: 'text', text: '待审批' }] },
      { id: 'search', type: 'input', label: '搜索供应商' },
    ] },
    { id: 'settings', title: '设置', nodes: [{ id: 'settings-title', type: 'text', text: '设置中心' }] },
    { id: 'complete', title: '完成', nodes: [{ id: 'complete-title', type: 'text', text: '审批已提交' }] },
  ],
}

function updated(change) {
  return change(structuredClone(baseline))
}

test('local scope permits the selected button and its existing modal', () => {
  const candidate = updated(document => {
    document.screens[0].nodes[0].label = '打开审批详情'
    document.screens[0].nodes[3].title = '审批详情'
    document.screens[0].nodes[3].children[0].text = '等待负责人确认'
    return document
  })
  assert.deepEqual(localEditScopeIssues({ baseline, candidate, selection }), [])
})

test('local scope permits a selected icon and still rejects unrelated changes', () => {
  const iconBaseline = updated(document => {
    document.screens[0].nodes.unshift({ id: 'overview-icon', type: 'icon', name: 'dashboard', label: '概览' })
    return document
  })
  const iconSelection = { elementId: 'overview-icon', type: 'icon', label: '概览' }
  const iconCandidate = structuredClone(iconBaseline)
  iconCandidate.screens[0].nodes[0].name = 'home'
  iconCandidate.screens[0].nodes[0].label = '首页'
  assert.deepEqual(localEditScopeIssues({ baseline: iconBaseline, candidate: iconCandidate, selection: iconSelection }), [])

  const unrelatedCandidate = structuredClone(iconBaseline)
  unrelatedCandidate.screens[0].nodes.find(node => node.id === 'search').label = '搜索项目'
  assert.match(localEditScopeIssues({ baseline: iconBaseline, candidate: unrelatedCandidate, selection: iconSelection })[0], /未选中的元素“search”/)
})

test('local scope permits a new modal directly opened by the selected button', () => {
  const candidate = updated(document => {
    document.screens[0].nodes[0].action = { type: 'open-modal', targetId: 'approval-modal' }
    document.screens[0].nodes.push({ id: 'approval-modal', type: 'modal', title: '审批确认', children: [{ id: 'approval-copy', type: 'text', text: '确认通过该供应商吗？' }] })
    return document
  })
  assert.deepEqual(localEditScopeIssues({ baseline, candidate, selection }), [])
})

test('local scope rejects unrelated elements and pages', () => {
  const otherElement = updated(document => {
    document.screens[0].nodes[4].label = '搜索项目'
    return document
  })
  assert.match(localEditScopeIssues({ baseline, candidate: otherElement, selection })[0], /未选中的元素“search”/)
  const otherPage = updated(document => {
    document.screens[1].nodes[0].text = '安全设置'
    return document
  })
  assert.match(localEditScopeIssues({ baseline, candidate: otherPage, selection })[0], /未选中的元素“settings-title”/)
})

test('local scope permits only the screen explicitly reached by navigate', () => {
  const navigateSelection = { elementId: 'open-settings', type: 'button', label: '查看设置' }
  const candidate = updated(document => {
    document.screens[1].nodes[0].text = '账户设置'
    return document
  })
  assert.deepEqual(localEditScopeIssues({ baseline, candidate, selection: navigateSelection }), [])
  const otherScreen = updated(document => {
    document.screens[2].nodes[0].text = '审批完成'
    return document
  })
  assert.match(localEditScopeIssues({ baseline, candidate: otherScreen, selection: navigateSelection })[0], /未选中的元素“complete-title”/)
})

test('local scope permits the screen explicitly reached by submit-success', () => {
  const submitSelection = { elementId: 'submit-approval', type: 'button', label: '提交审批' }
  const candidate = updated(document => {
    document.screens[2].nodes[0].text = '审批提交成功'
    return document
  })
  assert.deepEqual(localEditScopeIssues({ baseline, candidate, selection: submitSelection }), [])
  const otherScreen = updated(document => {
    document.screens[1].nodes[0].text = '安全设置'
    return document
  })
  assert.match(localEditScopeIssues({ baseline, candidate: otherScreen, selection: submitSelection })[0], /未选中的元素“settings-title”/)
})
