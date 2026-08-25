function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clean(value, max) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '' }
function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return undefined
  const items = value.map(item => clean(item, maxLength))
  if (items.some(item => item.length < 2) || new Set(items).size !== items.length) return undefined
  return items
}

export function productBrief(value) {
  if (!exactObject(value) || !Object.keys(value).every(key => ['v', 'audience', 'coreTask', 'requiredPages', 'requiredModules', 'requiredFlows', 'notes'].includes(key)) || value.v !== 1) return undefined
  const audience = clean(value.audience, 120); const coreTask = clean(value.coreTask, 300)
  const requiredPages = cleanList(value.requiredPages, 8, 80); const requiredFlows = cleanList(value.requiredFlows, 8, 160)
  const requiredModules = value.requiredModules === undefined ? undefined : cleanList(value.requiredModules, 12, 100)
  const notes = clean(value.notes, 1_200)
  if (audience.length < 2 || coreTask.length < 6 || requiredPages === undefined || requiredFlows === undefined || (value.requiredModules !== undefined && requiredModules === undefined)) return undefined
  const brief = { v: 1, audience, coreTask, requiredPages, ...(requiredModules === undefined ? {} : { requiredModules }), requiredFlows, ...(notes === '' ? {} : { notes }) }
  return JSON.stringify(brief).length <= 4_800 ? brief : undefined
}

export function productBriefFromFields({ audience, coreTask, pages, modules = '', flows, notes = '' }) {
  const split = value => String(value).split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean)
  const requiredModules = split(modules)
  return productBrief({ v: 1, audience, coreTask, requiredPages: split(pages), ...(requiredModules.length === 0 ? {} : { requiredModules }), requiredFlows: split(flows), notes })
}

export function productBriefPrompt(value) {
  const brief = productBrief(value)
  if (brief === undefined) return undefined
  return [
    '请严格按照以下已确认的产品需求验收清单生成原型：',
    `使用者：${brief.audience}`,
    `核心任务：${brief.coreTask}`,
    `必须包含的页面：${brief.requiredPages.join('、')}`,
    ...(brief.requiredModules === undefined ? [] : [`页面内必须包含的关键模块：${brief.requiredModules.join('、')}`]),
    `必须可以演示的流程：\n${brief.requiredFlows.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    ...(brief.notes === undefined ? [] : [`补充说明：${brief.notes}`]),
    '不要省略清单项目；每条流程都必须有可以实际点击或填写的交互结果。',
  ].join('\n')
}
