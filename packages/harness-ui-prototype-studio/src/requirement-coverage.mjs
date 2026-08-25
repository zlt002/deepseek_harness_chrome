import { productBrief } from './product-brief.mjs'

const GENERIC_PRODUCT_PAIRS = new Set(['页面', '功能', '用户', '操作', '信息', '数据', '进行', '可以', '必须', '真实', '流程', '按钮', '结果', '打开', '查看', '提交', '保存', '新增', '创建', '删除', '编辑', '筛选', '搜索', '审批'])
const GENERIC_REQUIREMENT_TERMS = new Set(['页面', '功能', '模块', '列表', '详情', '管理', '操作', '流程', '结果', '数据', '信息', '打开', '查看', '提交', '保存', '新增', '创建', '删除', '编辑', '筛选', '搜索', '审批'])

function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function compactProductText(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '') }

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
  const wanted = [...compactProductText(requirement)]; const actual = compactProductText(candidate)
  for (let index = 0; index + 1 < wanted.length; index += 1) {
    const pair = `${wanted[index]}${wanted[index + 1]}`
    if (!GENERIC_PRODUCT_PAIRS.has(pair) && actual.includes(pair)) return true
  }
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
      if (seen.has(candidateIndex) || !matches(requirements[requirementIndex], candidates[candidateIndex].label)) continue
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

function candidate({ label, screenId, nodeId, nodeType }) {
  return { label: String(label).slice(0, 2_000), screenId, ...(nodeId === undefined ? {} : { nodeId }), ...(nodeType === undefined ? {} : { nodeType }) }
}

function coverageCandidates(document) {
  const pages = []; const modules = []; const flows = []
  const actionControl = (entity, screenId, nodeId, nodeType) => {
    if (!exactObject(entity?.action)) return
    const label = strings(entity).join(' ').trim()
    if (label !== '') flows.push(candidate({ label, screenId, nodeId, nodeType }))
  }
  const visit = (nodes, screenId) => {
    for (const node of nodes ?? []) {
      if (!exactObject(node) || typeof node.id !== 'string' || typeof node.type !== 'string') continue
      for (const label of strings(node)) modules.push(candidate({ label, screenId, nodeId: node.id, nodeType: node.type }))
      actionControl(node, screenId, node.id, node.type)
      for (const row of node.rows ?? []) {
        for (const label of strings(row)) modules.push(candidate({ label, screenId, nodeId: typeof row?.id === 'string' ? row.id : node.id, nodeType: typeof row?.id === 'string' ? 'table-row' : node.type }))
        actionControl(row, screenId, typeof row?.id === 'string' ? row.id : node.id, typeof row?.id === 'string' ? 'table-row' : node.type)
      }
      for (const item of node.items ?? []) {
        for (const label of strings(item)) modules.push(candidate({ label, screenId, nodeId: typeof item?.id === 'string' ? item.id : node.id, nodeType: typeof item?.id === 'string' ? 'list-item' : node.type }))
        actionControl(item, screenId, typeof item?.id === 'string' ? item.id : node.id, typeof item?.id === 'string' ? 'list-item' : node.type)
      }
      if (Array.isArray(node.children)) visit(node.children, screenId)
      for (const tab of node.tabs ?? []) {
        for (const label of strings(tab)) modules.push(candidate({ label, screenId, nodeId: typeof tab?.id === 'string' ? tab.id : node.id, nodeType: typeof tab?.id === 'string' ? 'tab' : node.type }))
        if (exactObject(tab?.action) || node.type === 'tabs') flows.push(candidate({ label: strings(tab).join(' ').trim(), screenId, nodeId: typeof tab?.id === 'string' ? tab.id : node.id, nodeType: typeof tab?.id === 'string' ? 'tab' : node.type }))
        if (Array.isArray(tab?.children)) visit(tab.children, screenId)
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
    const target = exactObject(item?.action) && typeof item.action.targetScreenId === 'string' ? item.action.targetScreenId : undefined
    flows.push(candidate({ label, ...(target === undefined ? {} : { screenId: target }), ...(typeof item.id === 'string' ? { nodeId: item.id, nodeType: 'navigation-item' } : {}) }))
  }
  return { pages, modules, flows }
}

function entries(kind, requirements, candidates, matcher) {
  const assigned = assignedRequirementMatches(requirements, candidates, matcher)
  return requirements.map((requirement, index) => {
    const match = assigned[index]
    return { id: `${kind}-${index + 1}`, kind, requirement, status: match === undefined ? 'missing' : 'satisfied', matches: match === undefined ? [] : [match] }
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
    if (!exactObject(item) || Object.keys(item).length !== 5 || typeof item.id !== 'string' || !/^(page|module|flow)-[1-9][0-9]{0,2}$/.test(item.id) || ids.has(item.id) || !['page', 'module', 'flow'].includes(item.kind) || typeof item.requirement !== 'string' || item.requirement.trim() === '' || item.requirement.length > 300 || !['satisfied', 'missing'].includes(item.status) || !Array.isArray(item.matches) || item.matches.length > 1) return undefined
    ids.add(item.id)
    const matches = []
    for (const match of item.matches) {
      if (!exactObject(match) || !Object.keys(match).every(key => ['label', 'screenId', 'nodeId', 'nodeType'].includes(key)) || typeof match.label !== 'string' || match.label.trim() === '' || match.label.length > 2_000 || (match.screenId !== undefined && (typeof match.screenId !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(match.screenId))) || (match.nodeId !== undefined && (typeof match.nodeId !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(match.nodeId))) || (match.nodeType !== undefined && typeof match.nodeType !== 'string')) return undefined
      matches.push(match)
    }
    if ((item.status === 'satisfied') !== (matches.length === 1)) return undefined
    items.push({ id: item.id, kind: item.kind, requirement: item.requirement, status: item.status, matches })
  }
  return { v: 1, items }
}
