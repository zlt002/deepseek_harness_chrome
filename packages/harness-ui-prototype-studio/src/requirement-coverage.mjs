import { productBrief } from './product-brief.mjs'

const GENERIC_PRODUCT_PAIRS = new Set(['页面', '功能', '用户', '操作', '信息', '数据', '进行', '可以', '必须', '真实', '流程', '按钮', '结果', '打开', '查看', '提交', '保存', '新增', '创建', '删除', '编辑', '筛选', '搜索', '审批'])
const GENERIC_REQUIREMENT_TERMS = new Set(['页面', '功能', '模块', '列表', '详情', '管理', '操作', '流程', '结果', '数据', '信息', '打开', '查看', '提交', '保存', '新增', '创建', '删除', '编辑', '筛选', '搜索', '审批'])
const FLOW_INTENT_TERMS = ['筛选', '搜索', '排序', '分页', '新增', '创建', '编辑', '删除', '提交', '保存', '关闭', '打开']

function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function compactProductText(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '').replaceAll('查看', '打开').replaceAll('进入', '打开') }

export function directRequirementMatch(requirement, candidate) {
  const wanted = compactProductText(requirement); const actual = compactProductText(candidate)
  if (wanted.length < 2 || actual.length < 2) return false
  if (wanted === actual) return true
  const shorter = wanted.length <= actual.length ? wanted : actual
  if (GENERIC_REQUIREMENT_TERMS.has(shorter)) return false
  return wanted.includes(actual) || actual.includes(wanted)
}

export function meaningfulRequirementMatch(requirement, candidate) {
  if (directRequirementMatch(requirement, candidate)) return true
  const wantedText = compactProductText(requirement); const wanted = [...wantedText]; const actual = compactProductText(candidate)
  const requiredIntents = FLOW_INTENT_TERMS.filter(term => wantedText.includes(term))
  if (requiredIntents.length > 0 && !requiredIntents.some(term => actual.includes(term))) return false
  let sharedPairs = 0
  for (let index = 0; index + 1 < wanted.length; index += 1) {
    const pair = `${wanted[index]}${wanted[index + 1]}`
    if (!GENERIC_PRODUCT_PAIRS.has(pair) && actual.includes(pair)) sharedPairs += 1
  }
  // A single shared noun (for example “项目”) is not proof that a distinct
  // business action such as “新增项目” was replayed.  Two pairs still allow
  // concise Chinese flows while preventing edit/delete controls cross-matching.
  if (sharedPairs >= 2) return true
  const words = String(requirement).normalize('NFKC').toLocaleLowerCase('zh-CN').split(/[^\p{L}\p{N}]+/gu).filter(item => item.length >= 3)
  return words.some(word => actual.includes(word))
}

/**
 * The same one-to-one matching used by the save gate.  A generic control may
 * not make several separate requirements look satisfied.
 */
export function assignedRequirementMatches(requirements, candidates, matches) {
  const candidateOwner = new Array(candidates.length).fill(-1)
  const assign = (requirementIndex, seen) => {
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (seen.has(candidateIndex) || !matches(requirements[requirementIndex], candidates[candidateIndex].matchLabel ?? candidates[candidateIndex].label)) continue
      seen.add(candidateIndex)
      if (candidateOwner[candidateIndex] === -1 || assign(candidateOwner[candidateIndex], seen)) {
        candidateOwner[candidateIndex] = requirementIndex
        return true
      }
    }
    return false
  }
  for (let index = 0; index < requirements.length; index += 1) assign(index, new Set())
  return requirements.map((_, index) => {
    const candidateIndex = candidateOwner.indexOf(index)
    return candidateIndex === -1 ? undefined : candidates[candidateIndex]
  })
}

export function unmatchedRequirements(requirements, candidates, matches) {
  const assigned = assignedRequirementMatches(requirements, candidates.map(label => ({ label })), matches)
  return requirements.filter((_, index) => assigned[index] === undefined)
}

function strings(entity) {
  if (!exactObject(entity)) return []
  const values = []
  for (const key of ['label', 'title', 'text', 'value', 'detail', 'placeholder', 'description', 'name']) if (typeof entity[key] === 'string' && entity[key].trim() !== '') values.push(entity[key])
  if (Array.isArray(entity.values)) for (const value of entity.values) if (typeof value === 'string' && value.trim() !== '') values.push(value)
  if (exactObject(entity.cells)) for (const value of Object.values(entity.cells)) if (typeof value === 'string' && value.trim() !== '') values.push(value)
  if (Array.isArray(entity.columns)) for (const column of entity.columns) values.push(...strings(column))
  return values
}

function candidate({ label, matchLabel, screenId, nodeId, nodeType, verification }) {
  return { label: String(label).slice(0, 2_000), ...(matchLabel === undefined ? {} : { matchLabel: String(matchLabel).slice(0, 2_000) }), screenId, ...(nodeId === undefined ? {} : { nodeId }), ...(nodeType === undefined ? {} : { nodeType }), ...(verification === undefined ? {} : { verification }) }
}

function coverageCandidates(document) {
  const pages = []; const modules = []; const flows = []
  const screens = new Map((document?.screens ?? []).filter(exactObject).map(screen => [screen.id, screen]))
  const nodeById = new Map(); const nodeScreens = new Map(); const tabs = new Map(); const conditionalText = new Map()
  const indexNodes = (values, screenId) => {
    for (const node of values ?? []) {
      if (!exactObject(node) || typeof node.id !== 'string') continue
      nodeById.set(node.id, node); nodeScreens.set(node.id, screenId)
      if (exactObject(node.visibleWhen)) {
        const key = `${node.visibleWhen.stateId}\u0000${node.visibleWhen.equals}`; const current = conditionalText.get(key) ?? []
        conditionalText.set(key, [...current, ...strings(node)])
      }
      if (Array.isArray(node.children)) indexNodes(node.children, screenId)
      for (const tab of node.tabs ?? []) { if (exactObject(tab) && typeof tab.id === 'string') { tabs.set(`${node.id}\u0000${tab.id}`, tab); nodeScreens.set(tab.id, screenId) }; if (Array.isArray(tab?.children)) indexNodes(tab.children, screenId) }
    }
  }
  for (const screen of screens.values()) indexNodes(screen.nodes, screen.id)
  const visible = (node, stateValues) => !exactObject(node?.visibleWhen) || stateValues[node.visibleWhen.stateId] === node.visibleWhen.equals
  const visibleStrings = (nodes, state) => {
    const result = []
    for (const node of nodes ?? []) {
      if (!exactObject(node) || !visible(node, state.stateValues) || (node.type === 'modal' && !state.openModalIds.includes(node.id))) continue
      result.push(...strings(node))
      if (node.type === 'table') for (const row of state.tableVisibleRows.get(node.id) ?? state.tables.get(node.id) ?? node.rows ?? []) result.push(...strings(row))
      if (Array.isArray(node.children)) result.push(...visibleStrings(node.children, state))
      if (node.type === 'tabs') {
        const selected = state.tabs[node.id] ?? node.tabs?.[0]?.id
        const tab = (node.tabs ?? []).find(item => item.id === selected)
        if (tab !== undefined) result.push(...strings(tab), ...visibleStrings(tab.children, state))
      }
    }
    return result
  }
  const initialState = screenId => ({ screenId, openModalIds: [], values: {}, stateValues: Object.fromEntries((document.stateVariables ?? []).filter(exactObject).map(item => [item.id, item.initialValue])), tabs: {}, tables: new Map([...nodeById].filter(([, node]) => node.type === 'table').map(([id, node]) => [id, structuredClone(node.rows ?? [])])), tableVisibleRows: new Map() })
  const screenText = state => {
    const screen = screens.get(state.screenId)
    return [...strings(screen), ...visibleStrings(screen?.nodes, state)].join(' ').trim().slice(0, 500)
  }
  const valueFor = (input, state) => input.bindStateId === undefined ? state.values[input.id] ?? input.value ?? '' : state.stateValues[input.bindStateId] ?? input.value ?? ''
  const validationError = (input, state) => {
    const value = valueFor(input, state)
    if (input.inputType === 'checkbox') return input.required === true && value !== true
    const text = String(value).trim()
    if (text === '') return input.required === true
    if (input.inputType === 'email') return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
    if (input.inputType === 'number') return !Number.isFinite(Number(text))
    return false
  }
  const safeInputValue = input => {
    if (input.inputType === 'checkbox') return true
    if (input.inputType === 'email') return 'pm@example.test'
    if (input.inputType === 'number') return '1'
    if (input.inputType === 'select') return input.options?.[0]?.value
    if (input.inputType === 'date') return '2026-01-01'
    return '示例值'
  }
  const visibleInputs = (nodes, state) => {
    const result = []
    for (const node of nodes ?? []) {
      if (!exactObject(node) || !visible(node, state.stateValues)) continue
      if (node.type === 'input') result.push(node)
      if (node.type === 'modal') { if (state.openModalIds.includes(node.id)) result.push(...visibleInputs(node.children, state)); continue }
      if (Array.isArray(node.children)) result.push(...visibleInputs(node.children, state))
      if (node.type === 'tabs') { const tab = (node.tabs ?? []).find(item => item.id === (state.tabs[node.id] ?? node.tabs?.[0]?.id)); if (tab !== undefined) result.push(...visibleInputs(tab.children, state)) }
    }
    return result
  }
  const verification = (steps, state) => ({ status: 'replayed', steps: steps.slice(0, 12), final: screenText(state) })
  const replayAction = (action, screenId, owner = {}) => {
    const state = initialState(screenId)
    const allowedStates = new Map((document.stateVariables ?? []).filter(exactObject).map(item => [item.id, item.allowedValues ?? []]))
    const steps = []
    const sameScreen = id => nodeScreens.get(id) === state.screenId
    if (owner.modalId !== undefined) {
      const modal = nodeById.get(owner.modalId)
      if (modal?.type !== 'modal' || !sameScreen(owner.modalId) || !visible(modal, state.stateValues)) return { ok: false, verification: { status: 'replayed', steps: [], final: '' }, matchLabel: '' }
      state.openModalIds.push(owner.modalId); steps.push(`打开「${strings(modal).join(' ') || owner.modalId}」`)
    }
    if (owner.tabParentId !== undefined && owner.tabId !== undefined) {
      const tab = tabs.get(`${owner.tabParentId}\u0000${owner.tabId}`)
      if (tab === undefined || !sameScreen(owner.tabParentId)) return { ok: false, verification: { status: 'replayed', steps: [], final: '' }, matchLabel: '' }
      state.tabs[owner.tabParentId] = owner.tabId; steps.push(`切换到「${strings(tab).join(' ') || owner.tabId}」`)
    }
    const mappedFields = (current, table) => {
      if (!Array.isArray(current.fieldMap) || current.fieldMap.length === 0) return undefined
      const columns = new Set((table.columns ?? []).map(column => column.key)); const usedFields = new Set(); const usedColumns = new Set(); const fields = []
      for (const mapping of current.fieldMap) {
        const input = nodeById.get(mapping?.fieldId)
        if (!exactObject(mapping) || !columns.has(mapping.columnKey) || usedFields.has(mapping.fieldId) || usedColumns.has(mapping.columnKey) || input?.type !== 'input' || input.inputType === 'checkbox' || !sameScreen(mapping.fieldId) || !visible(input, state.stateValues)) return undefined
        usedFields.add(mapping.fieldId); usedColumns.add(mapping.columnKey); fields.push({ mapping, input })
      }
      return fields
    }
    const apply = current => {
      if (!exactObject(current) || steps.length >= 12) return false
      if (current.type === 'sequence') return Array.isArray(current.actions) && current.actions.length > 0 && current.actions.every(apply)
      if (current.type === 'navigate' || current.type === 'submit-success') {
        const target = screens.get(current.targetScreenId)
        if (target === undefined) return false
        if (current.type === 'submit-success') {
          const inputs = visibleInputs(screens.get(state.screenId)?.nodes, state).filter(input => input.required === true || input.inputType === 'email' || input.inputType === 'number')
          const invalid = inputs.filter(input => validationError(input, state))
          if (invalid.length === 0) return false
          steps.push(`空提交显示 ${invalid.length} 个校验提示`)
          for (const input of inputs) {
            const value = safeInputValue(input)
            if (value === undefined) return false
            if (input.bindStateId === undefined) state.values[input.id] = value
            else if (allowedStates.get(input.bindStateId)?.includes(String(value))) state.stateValues[input.bindStateId] = String(value)
            else return false
          }
          if (inputs.some(input => validationError(input, state))) return false
          steps.push(`填写 ${inputs.length} 个字段后提交`)
        }
        if (current.type === 'navigate' && state.screenId === current.targetScreenId) return false
        state.screenId = current.targetScreenId; state.openModalIds = []; steps.push(`${current.type === 'submit-success' ? '提交成功并进入' : '进入'}「${String(target.title ?? target.id)}」`); return true
      }
      if (current.type === 'open-modal') { const modal = nodeById.get(current.targetId); if (modal?.type !== 'modal' || !sameScreen(current.targetId) || !visible(modal, state.stateValues) || state.openModalIds.includes(current.targetId)) return false; state.openModalIds.push(current.targetId); steps.push(`打开「${strings(modal).join(' ') || current.targetId}」`); return true }
      if (current.type === 'close-modal') { if (current.targetId === undefined) { if (state.openModalIds.length === 0) return false; state.openModalIds = []; steps.push('关闭弹窗'); return true }; if (!state.openModalIds.includes(current.targetId)) return false; state.openModalIds = state.openModalIds.filter(id => id !== current.targetId); steps.push(`关闭「${current.targetId}」`); return true }
      if (current.type === 'set-state') { if (!allowedStates.get(current.targetId)?.includes(current.value) || state.stateValues[current.targetId] === current.value) return false; state.stateValues[current.targetId] = current.value; steps.push(`状态「${current.targetId}」变为「${current.value}」`); return true }
      if (current.type === 'set-value') { const input = nodeById.get(current.targetId); if (input?.type !== 'input' || input.inputType === 'checkbox' || !sameScreen(current.targetId) || !visible(input, state.stateValues) || typeof current.value !== 'string' || valueFor(input, state) === current.value) return false; if (input.bindStateId === undefined) state.values[current.targetId] = current.value; else if (allowedStates.get(input.bindStateId)?.includes(current.value)) state.stateValues[input.bindStateId] = current.value; else return false; steps.push(`填写「${strings(input).join(' ') || current.targetId}」`); return true }
      if (current.type === 'toggle') { const input = nodeById.get(current.targetId); if (input?.type !== 'input' || input.inputType !== 'checkbox' || !sameScreen(current.targetId) || !visible(input, state.stateValues)) return false; state.values[current.targetId] = !Boolean(state.values[current.targetId]); steps.push(`切换「${strings(input).join(' ') || current.targetId}」`); return true }
      if (current.type === 'set-tab') { const tab = tabs.get(`${current.targetId}\u0000${current.value}`); const previous = state.tabs[current.targetId] ?? nodeById.get(current.targetId)?.tabs?.[0]?.id; if (tab === undefined || !sameScreen(current.targetId) || previous === current.value || visibleStrings(tab.children, state).length === 0) return false; state.tabs[current.targetId] = current.value; steps.push(`切换到「${strings(tab).join(' ') || current.value}」`); return true }
      if (['add-row', 'edit-row', 'delete-row'].includes(current.type)) {
        const table = nodeById.get(current.tableId); const rows = state.tables.get(current.tableId); if (table?.type !== 'table' || rows === undefined || !sameScreen(current.tableId)) return false
        if (current.type === 'add-row') { const fields = mappedFields(current, table); if (fields === undefined || rows.length >= 50) return false; const before = rows.length; for (const { input } of fields) { const value = safeInputValue(input); if (value === undefined) return false; if (input.bindStateId === undefined) state.values[input.id] = value; else if (allowedStates.get(input.bindStateId)?.includes(String(value))) state.stateValues[input.bindStateId] = String(value); else return false }; const id = `replay-added-${before + 1}`; if (rows.some(row => row.id === id)) return false; rows.push({ id, values: table.columns.map(column => String(valueFor(fields.find(item => item.mapping.columnKey === column.key)?.input ?? {}, state) ?? '')) }); steps.push(`新增 1 条${current.businessName ?? '记录'}并回读表格`); return rows.length === before + 1 }
        const rowId = owner.rowId; const index = rows.findIndex(row => row.id === rowId); if (index < 0) return false
        if (current.type === 'edit-row') { const fields = mappedFields(current, table); if (fields === undefined) return false; const before = [...rows[index].values]; for (const { input } of fields) { const value = safeInputValue(input); if (value === undefined) return false; if (input.bindStateId === undefined) state.values[input.id] = value; else if (allowedStates.get(input.bindStateId)?.includes(String(value))) state.stateValues[input.bindStateId] = String(value); else return false }; rows[index] = { ...rows[index], values: table.columns.map((column, columnIndex) => { const field = fields.find(item => item.mapping.columnKey === column.key); return field === undefined ? before[columnIndex] : String(valueFor(field.input, state)) }) }; if (rows[index].values.every((value, columnIndex) => value === before[columnIndex])) return false; steps.push(`编辑${current.businessName ?? '记录'}并回读表格`); return true }
        const before = rows.length; rows.splice(index, 1); steps.push(`确认删除${current.businessName ?? '记录'}并回读表格`); return rows.length === before - 1
      }
      return false
    }
    const ok = apply(action)
    const final = screenText(state)
    return { ok: ok && steps.length > 0 && final !== '', verification: verification(steps, state), matchLabel: final }
  }
  const actionOutcome = action => {
    if (!exactObject(action)) return ''
    if (action.type === 'sequence') return (action.actions ?? []).map(actionOutcome).filter(Boolean).join(' ')
    if (action.type === 'navigate') return `进入 ${strings(screens.get(action.targetScreenId)).join(' ')}`
    if (action.type === 'submit-success') return `提交成功 ${strings(screens.get(action.targetScreenId)).join(' ')}`
    if (action.type === 'open-modal') return `打开 ${strings(nodeById.get(action.targetId)).join(' ')}`
    if (action.type === 'close-modal') return `关闭 ${strings(nodeById.get(action.targetId)).join(' ')}`
    if (action.type === 'set-state') return [String(action.value ?? ''), ...(conditionalText.get(`${action.targetId}\u0000${action.value}`) ?? [])].join(' ')
    if (action.type === 'set-value') return [...strings(nodeById.get(action.targetId)), String(action.value ?? '')].join(' ')
    if (action.type === 'toggle') return `切换 ${strings(nodeById.get(action.targetId)).join(' ')}`
    if (action.type === 'set-tab') return strings(tabs.get(`${action.targetId}\u0000${action.value}`)).join(' ')
    if (action.type === 'add-row' || action.type === 'edit-row' || action.type === 'delete-row') return `${action.type === 'add-row' ? '新增' : action.type === 'edit-row' ? '编辑' : '删除'} ${String(action.businessName ?? '')} ${strings(nodeById.get(action.tableId)).join(' ')}`
    return ''
  }
  const actionControl = (entity, screenId, nodeId, nodeType, owner = {}) => {
    if (!exactObject(entity?.action)) return
    const label = strings(entity).join(' ').trim()
    const outcome = actionOutcome(entity.action).trim()
    const replay = replayAction(entity.action, screenId, owner)
    if (label !== '' && outcome !== '' && replay.ok) flows.push(candidate({ label, matchLabel: outcome, screenId, nodeId, nodeType, verification: replay.verification }))
  }
  const visit = (nodes, screenId, context = {}) => {
    for (const node of nodes ?? []) {
      if (!exactObject(node) || typeof node.id !== 'string' || typeof node.type !== 'string') continue
      for (const label of strings(node)) modules.push(candidate({ label, screenId, nodeId: node.id, nodeType: node.type }))
      actionControl(node, screenId, node.id, node.type, context)
      for (const row of node.rows ?? []) {
        for (const label of strings(row)) modules.push(candidate({ label, screenId, nodeId: typeof row?.id === 'string' ? row.id : node.id, nodeType: typeof row?.id === 'string' ? 'table-row' : node.type }))
        actionControl(row, screenId, typeof row?.id === 'string' ? row.id : node.id, typeof row?.id === 'string' ? 'table-row' : node.type, { ...context, rowId: row?.id })
      }
      for (const item of node.items ?? []) {
        for (const label of strings(item)) modules.push(candidate({ label, screenId, nodeId: typeof item?.id === 'string' ? item.id : node.id, nodeType: typeof item?.id === 'string' ? 'list-item' : node.type }))
        actionControl(item, screenId, typeof item?.id === 'string' ? item.id : node.id, typeof item?.id === 'string' ? 'list-item' : node.type, context)
      }
      if (Array.isArray(node.children)) visit(node.children, screenId, node.type === 'modal' ? { ...context, modalId: node.id } : context)
      for (const tab of node.tabs ?? []) {
        for (const label of strings(tab)) modules.push(candidate({ label, screenId, nodeId: typeof tab?.id === 'string' ? tab.id : node.id, nodeType: typeof tab?.id === 'string' ? 'tab' : node.type }))
        if (exactObject(tab?.action) || node.type === 'tabs') { const action = exactObject(tab?.action) ? tab.action : { type: 'set-tab', targetId: node.id, value: tab?.id }; const label = strings(tab).join(' ').trim(); const outcome = actionOutcome(action); const replay = replayAction(action, screenId); if (label !== '' && outcome !== '' && replay.ok) flows.push(candidate({ label, matchLabel: outcome, screenId, nodeId: typeof tab?.id === 'string' ? tab.id : node.id, nodeType: typeof tab?.id === 'string' ? 'tab' : node.type, verification: replay.verification })) }
        if (Array.isArray(tab?.children)) visit(tab.children, screenId, { ...context, tabParentId: node.id, tabId: tab.id })
      }
      if (node.type === 'table') {
        for (const filter of node.filters ?? []) {
          const input = nodeById.get(filter.inputId); const column = (node.columns ?? []).find(item => item.key === filter.columnKey)
          const label = strings(input).join(' ').trim()
          const state = initialState(screenId); const rows = state.tables.get(node.id) ?? []; const columnIndex = (node.columns ?? []).findIndex(item => item.key === filter.columnKey)
          const filterValue = rows.map(row => String(row.values?.[columnIndex] ?? '').trim()).find(value => value !== '' && rows.some(row => String(row.values?.[columnIndex] ?? '').toLocaleLowerCase().includes(value.toLocaleLowerCase())) && rows.some(row => !String(row.values?.[columnIndex] ?? '').toLocaleLowerCase().includes(value.toLocaleLowerCase())))
          const filtered = filterValue === undefined ? [] : rows.filter(row => { const actual = String(row.values?.[columnIndex] ?? '').toLocaleLowerCase(); const expected = filterValue.toLocaleLowerCase(); return filter.operator === 'equals' ? actual === expected : actual.includes(expected) })
          if (input?.type === 'input' && input.inputType !== 'checkbox' && nodeScreens.get(input.id) === screenId && label !== '' && column !== undefined && filtered.length > 0 && filtered.length < rows.length) {
            state.values[filter.inputId] = filterValue; state.tableVisibleRows.set(node.id, filtered)
            const steps = [`按「${label}」筛选出 ${filtered.length} 条结果`]
            flows.push(candidate({ label, matchLabel: `筛选 ${label} ${strings(node).join(' ')} ${strings(column).join(' ')} ${filtered.flatMap(strings).join(' ')}`, screenId, nodeId: filter.inputId, nodeType: 'input', verification: verification(steps, state) }))
          }
        }
        if (exactObject(node.sort)) { const state = initialState(screenId); const rows = state.tables.get(node.id) ?? []; const column = (node.columns ?? []).find(item => item.key === node.sort.columnKey); const columnIndex = (node.columns ?? []).findIndex(item => item.key === node.sort.columnKey); const direction = node.sort.direction === 'asc' ? 'desc' : 'asc'; const sorted = [...rows].sort((left, right) => direction === 'asc' ? String(left.values?.[columnIndex] ?? '').localeCompare(String(right.values?.[columnIndex] ?? ''), undefined, { sensitivity: 'base' }) : String(right.values?.[columnIndex] ?? '').localeCompare(String(left.values?.[columnIndex] ?? ''), undefined, { sensitivity: 'base' })); if (column !== undefined && rows.length >= 2 && new Set(rows.map(row => String(row.values?.[columnIndex] ?? ''))).size >= 2 && sorted.some((row, index) => row.id !== rows[index]?.id)) { state.tables.set(node.id, sorted); const steps = [`按「${strings(column).join(' ') || node.sort.columnKey}」${direction === 'asc' ? '升序' : '降序'}排序并回读顺序`]; flows.push(candidate({ label: String(node.label ?? '表格排序'), matchLabel: `排序 ${strings(node).join(' ')} ${strings(column).join(' ')} ${sorted.flatMap(strings).join(' ')}`, screenId, nodeId: node.id, nodeType: 'table', verification: verification(steps, state) })) } }
        if (exactObject(node.pagination)) { const state = initialState(screenId); const rows = state.tables.get(node.id) ?? []; const first = rows.slice(0, node.pagination.pageSize); const second = rows.slice(node.pagination.pageSize, node.pagination.pageSize * 2); if (first.length > 0 && second.length > 0 && second.some((row, index) => row.id !== first[index]?.id)) { state.tableVisibleRows.set(node.id, second); const steps = [`切换「${String(node.label ?? '表格')}」到第 2 页并回读不同记录`]; flows.push(candidate({ label: String(node.label ?? '表格分页'), matchLabel: `分页 ${strings(node).join(' ')} ${second.flatMap(strings).join(' ')}`, screenId, nodeId: node.id, nodeType: 'table', verification: verification(steps, state) })) }
      }
      }
      if (node.type === 'pagination') { const state = initialState(screenId); const before = screenText(state); const allowed = (document.stateVariables ?? []).find(item => item?.id === node.bindStateId)?.allowedValues ?? []; if (node.pageCount >= 2 && allowed.includes('2') && state.stateValues[node.bindStateId] !== '2') { state.stateValues[node.bindStateId] = '2'; const after = screenText(state); if (after !== before) { const steps = [`切换「${String(node.label ?? '分页')}」到第 2 页并回读内容`]; flows.push(candidate({ label: String(node.label ?? '分页'), matchLabel: `分页 ${String(node.label ?? '')} 第2页 ${after}`, screenId, nodeId: node.id, nodeType: 'pagination', verification: verification(steps, state) })) } }
      }
    }
  }
  for (const screen of document?.screens ?? []) {
    if (!exactObject(screen) || typeof screen.id !== 'string') continue
    pages.push(candidate({ label: String(screen.title ?? screen.id), screenId: screen.id }))
    visit(screen.nodes, screen.id)
  }
  for (const item of document?.shell?.items ?? []) {
    const label = strings(item).join(' ').trim()
    if (label === '') continue
    const target = typeof item?.targetScreenId === 'string' ? item.targetScreenId : exactObject(item?.action) && typeof item.action.targetScreenId === 'string' ? item.action.targetScreenId : undefined
    const action = target === undefined ? undefined : { type: 'navigate', targetScreenId: target }; const outcome = action === undefined ? '' : actionOutcome(action); const replay = action === undefined ? { ok: false } : replayAction(action, document?.initialScreenId ?? [...screens.keys()][0])
    if (outcome !== '' && replay.ok) flows.push(candidate({ label, matchLabel: outcome, screenId: target, ...(typeof item.id === 'string' ? { nodeId: item.id, nodeType: 'navigation-item' } : {}), verification: replay.verification }))
  }
  return { pages, modules, flows }
}

function entries(kind, requirements, candidates, matcher) {
  const eligible = kind === 'flow' ? candidates.filter(item => exactObject(item.verification) && item.verification.status === 'replayed' && Array.isArray(item.verification.steps) && item.verification.steps.length > 0 && typeof item.verification.final === 'string' && item.verification.final.trim() !== '') : candidates
  const assigned = assignedRequirementMatches(requirements, eligible, matcher)
  return requirements.map((requirement, index) => {
    const match = assigned[index]
    if (match === undefined) return { id: `${kind}-${index + 1}`, kind, requirement, status: 'missing', matches: [] }
    const { matchLabel: _matchLabel, ...publicMatch } = match
    return { id: `${kind}-${index + 1}`, kind, requirement, status: 'satisfied', matches: [publicMatch] }
  })
}

/** A deterministic audit derived solely from the validated document and saved checklist. */
export function productRequirementCoverage(document, briefValue) {
  const brief = productBrief(briefValue)
  if (brief === undefined) return undefined
  const candidates = coverageCandidates(document)
  return {
    v: 1,
    items: [
      ...entries('page', brief.requiredPages, candidates.pages, directRequirementMatch),
      ...entries('module', brief.requiredModules ?? [], candidates.modules, directRequirementMatch),
      ...entries('flow', brief.requiredFlows, candidates.flows, meaningfulRequirementMatch),
    ],
  }
}

export function productRequirementCoverageValue(value) {
  if (!exactObject(value) || Object.keys(value).length !== 2 || value.v !== 1 || !Array.isArray(value.items) || value.items.length > 80) return undefined
  const ids = new Set()
  const items = []
  for (const item of value.items) {
    if (!exactObject(item) || Object.keys(item).length !== 5 || typeof item.id !== 'string' || !/^(page|module|flow)-[1-9][0-9]{0,2}$/.test(item.id) || ids.has(item.id) || !['page', 'module', 'flow'].includes(item.kind) || !item.id.startsWith(`${item.kind}-`) || typeof item.requirement !== 'string' || item.requirement.trim() === '' || item.requirement.length > 300 || !['satisfied', 'missing'].includes(item.status) || !Array.isArray(item.matches) || item.matches.length > 1) return undefined
    ids.add(item.id)
    const matches = []
    for (const match of item.matches) {
      if (!exactObject(match) || !Object.keys(match).every(key => ['label', 'screenId', 'nodeId', 'nodeType', 'verification'].includes(key)) || typeof match.label !== 'string' || match.label.trim() === '' || match.label.length > 2_000 || (match.screenId !== undefined && (typeof match.screenId !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(match.screenId))) || (match.nodeId !== undefined && (typeof match.nodeId !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(match.nodeId))) || (match.nodeType !== undefined && typeof match.nodeType !== 'string')) return undefined
      const verification = match.verification
      if (item.kind !== 'flow' && verification !== undefined) return undefined
      if (item.kind === 'flow' && (!exactObject(verification) || Object.keys(verification).length !== 3 || verification.status !== 'replayed' || !Array.isArray(verification.steps) || verification.steps.length === 0 || verification.steps.length > 12 || !verification.steps.every(step => typeof step === 'string' && step.trim() !== '' && step.length <= 200) || typeof verification.final !== 'string' || verification.final.trim() === '' || verification.final.length > 500)) return undefined
      matches.push({ label: match.label, ...(match.screenId === undefined ? {} : { screenId: match.screenId }), ...(match.nodeId === undefined ? {} : { nodeId: match.nodeId }), ...(match.nodeType === undefined ? {} : { nodeType: match.nodeType }), ...(verification === undefined ? {} : { verification: { status: 'replayed', steps: [...verification.steps], final: verification.final } }) })
    }
    if ((item.status === 'satisfied') !== (matches.length === 1)) return undefined
    items.push({ id: item.id, kind: item.kind, requirement: item.requirement, status: item.status, matches })
  }
  return { v: 1, items }
}
