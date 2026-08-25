const ID = /^[a-z][a-z0-9_-]{0,79}$/
const SELECTION_TYPES = new Set(['text', 'icon', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal', 'table-row', 'list-item', 'tab', 'navigation-item', 'breadcrumb-item'])

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
function same(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)) }

/** The Host accepts only a selection emitted by its fixed renderer. */
export function localEditSelection(value) {
  if (!object(value) || Object.keys(value).length !== 3 || typeof value.elementId !== 'string' || !ID.test(value.elementId) || typeof value.type !== 'string' || !SELECTION_TYPES.has(value.type) || typeof value.label !== 'string' || value.label.length > 2_000) return undefined
  return { elementId: value.elementId, type: value.type, label: value.label }
}

function actionTargets(action, targets) {
  if (!object(action) || typeof action.type !== 'string') return
  if (action.type === 'sequence' && Array.isArray(action.actions)) {
    action.actions.forEach(item => actionTargets(item, targets))
    return
  }
  if ((action.type === 'open-modal' || action.type === 'close-modal') && typeof action.targetId === 'string') targets.push({ id: action.targetId, kind: 'modal' })
  if ((action.type === 'navigate' || action.type === 'submit-success') && typeof action.targetScreenId === 'string') targets.push({ id: action.targetScreenId, kind: 'screen' })
  if ((action.type === 'set-value' || action.type === 'toggle') && typeof action.targetId === 'string') targets.push({ id: action.targetId, kind: 'input' })
  if (action.type === 'set-state' && typeof action.targetId === 'string') targets.push({ id: action.targetId, kind: 'state' })
  if (action.type === 'set-tab' && typeof action.targetId === 'string') targets.push({ id: action.targetId, kind: 'tabs' })
}

function removeStructuralFields(value, fields) {
  const result = clone(value)
  for (const field of fields) delete result[field]
  return result
}

function documentIndex(document) {
  const entities = new Map()
  const children = new Map()
  const screenByEntity = new Map()
  const add = (id, kind, data, parent, screenId) => {
    if (typeof id !== 'string') return
    entities.set(id, { id, kind, data, parent, screenId })
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(id)
    screenByEntity.set(id, screenId)
  }
  const visit = (node, parent, screenId) => {
    if (!object(node) || typeof node.id !== 'string' || typeof node.type !== 'string') return
    add(node.id, node.type, removeStructuralFields(node, ['children', 'tabs', 'rows', 'items']), parent, screenId)
    if (Array.isArray(node.children)) node.children.forEach(child => visit(child, node.id, screenId))
    if (Array.isArray(node.tabs)) for (const tab of node.tabs) {
      if (!object(tab) || typeof tab.id !== 'string') continue
      add(tab.id, 'tab', removeStructuralFields(tab, ['children']), node.id, screenId)
      if (Array.isArray(tab.children)) tab.children.forEach(child => visit(child, tab.id, screenId))
    }
    if (Array.isArray(node.rows)) for (const row of node.rows) {
      if (object(row) && typeof row.id === 'string') add(row.id, 'table-row', clone(row), node.id, screenId)
    }
    if (Array.isArray(node.items)) for (const item of node.items) {
      if (object(item) && typeof item.id === 'string') add(item.id, node.type === 'list' ? 'list-item' : 'breadcrumb-item', clone(item), node.id, screenId)
    }
  }
  const screens = Array.isArray(document?.screens) ? document.screens : []
  for (const screen of screens) {
    if (!object(screen) || typeof screen.id !== 'string') continue
    const root = `screen:${screen.id}`
    add(root, 'screen', {}, 'screen-root', screen.id)
    if (Array.isArray(screen.nodes)) screen.nodes.forEach(node => visit(node, root, screen.id))
  }
  if (object(document?.shell) && Array.isArray(document.shell.items)) {
    document.shell.items.forEach(item => {
      if (object(item) && typeof item.id === 'string') add(item.id, 'navigation-item', clone(item), 'shell', undefined)
    })
  }
  if (Array.isArray(document?.stateVariables)) {
    document.stateVariables.forEach(state => {
      if (object(state) && typeof state.id === 'string') add(`state:${state.id}`, 'state', clone(state), 'state-root', undefined)
    })
  }
  const meta = {
    v: document?.v,
    id: document?.id,
    title: document?.title,
    designSpecId: document?.designSpecId,
    initialScreenId: document?.initialScreenId,
    shell: object(document?.shell) ? { productName: document.shell.productName, placement: document.shell.placement } : undefined,
    screens: screens.map(screen => object(screen) ? { id: screen.id, title: screen.title } : screen),
  }
  return { entities, children, screenByEntity, meta }
}

function descendants(index, id, result) {
  if (result.has(id)) return
  result.add(id)
  for (const child of index.children.get(id) ?? []) descendants(index, child, result)
}

function actionTargetsOf(entity) {
  const targets = []
  actionTargets(entity.data?.action, targets)
  return targets
}

function targetKey(target) { return target.kind === 'state' ? `state:${target.id}` : target.kind === 'screen' ? `screen:${target.id}` : target.id }

function selectionMatches(entity, selection) {
  return entity !== undefined && entity.kind === selection.type
}

/**
 * Returns user-facing reasons when a local AI edit changes anything outside the
 * element selected in the fixed preview or an action target explicitly reached
 * from that element.  This is deliberately data-only and runs in the Host.
 */
export function localEditScopeIssues({ baseline, candidate, selection }) {
  const checked = localEditSelection(selection)
  if (checked === undefined) return ['局部修改缺少可信的选中元素，请重新在原型中点选后再试。']
  const before = documentIndex(baseline)
  const after = documentIndex(candidate)
  const selectedBefore = before.entities.get(checked.elementId)
  const selectedAfter = after.entities.get(checked.elementId)
  if (!selectionMatches(selectedBefore, checked) || !selectionMatches(selectedAfter, checked)) return ['选中的元素已不存在或类型发生变化，请刷新原型后重新选择。']
  if (!same(before.meta, after.meta)) return ['局部修改不能改动原型标题、页面结构或全局导航。请切换为“调整整个原型”。']

  const allowed = new Set()
  descendants(before, checked.elementId, allowed)
  descendants(after, checked.elementId, allowed)
  const targetRoots = new Set()
  const selectedScreenId = before.screenByEntity.get(checked.elementId)

  let changed = true
  while (changed) {
    changed = false
    const add = id => {
      const beforeSize = allowed.size
      if (before.entities.has(id)) descendants(before, id, allowed)
      if (after.entities.has(id)) descendants(after, id, allowed)
      if (allowed.size !== beforeSize) changed = true
    }
    for (const index of [before, after]) {
      for (const id of [...allowed]) {
        const entity = index.entities.get(id)
        if (entity === undefined) continue
        for (const target of actionTargetsOf(entity)) {
          // A local edit may create a directly linked modal, but it must not
          // widen itself by retargeting navigation to a different page.
          if (target.kind === 'screen' && index !== before) continue
          const key = targetKey(target)
          const found = after.entities.get(key) ?? before.entities.get(key)
          if (found === undefined) return [`选中区域引用了不存在的${target.kind === 'modal' ? '弹窗' : target.kind === 'input' ? '输入项' : target.kind === 'state' ? '业务状态' : target.kind === 'screen' ? '页面' : '标签页组'}“${target.id}”。`]
          if (found.kind !== target.kind) return [`选中区域引用的“${target.id}”不是可关联的${target.kind === 'modal' ? '弹窗' : target.kind === 'input' ? '输入项' : target.kind === 'state' ? '业务状态' : target.kind === 'screen' ? '页面' : '标签页组'}。`]
          if (target.kind === 'modal' && !before.entities.has(key) && after.entities.has(key)) targetRoots.add(key)
          add(key)
        }
      }
    }
  }

  for (const [id, beforeEntity] of before.entities) {
    const afterEntity = after.entities.get(id)
    if (afterEntity === undefined) {
      if (!allowed.has(id)) return [`局部修改删除了未选中的元素“${id}”。请只修改当前选中区域。`]
      continue
    }
    if (beforeEntity.kind !== afterEntity.kind) return [`元素“${id}”的类型被改变，局部修改不能替换既有组件。`]
    if (!allowed.has(id) && (!same(beforeEntity.data, afterEntity.data) || beforeEntity.parent !== afterEntity.parent)) return [`局部修改改动了未选中的元素“${id}”。请切换为“调整整个原型”。`]
  }
  for (const [id, afterEntity] of after.entities) {
    if (before.entities.has(id)) continue
    const parentAllowed = allowed.has(afterEntity.parent)
    const isNewLinkedModal = targetRoots.has(id) && afterEntity.kind === 'modal' && afterEntity.parent === `screen:${selectedScreenId}`
    if (!parentAllowed && !isNewLinkedModal) return [`局部修改新增了无关联元素“${id}”。新增内容只能放在选中区域或其关联弹窗中。`]
  }
  const parents = new Set([...before.children.keys(), ...after.children.keys()])
  for (const parent of parents) {
    if (allowed.has(parent)) continue
    const beforeChildren = (before.children.get(parent) ?? []).filter(id => !allowed.has(id))
    const afterChildren = (after.children.get(parent) ?? []).filter(id => !allowed.has(id))
    if (!same(beforeChildren, afterChildren)) return ['局部修改改变了未选中区域的页面结构或顺序。请切换为“调整整个原型”。']
  }
  return []
}
