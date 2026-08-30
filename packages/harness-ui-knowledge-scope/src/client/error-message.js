/** Convert remote search failures into concise, user-facing recovery guidance. */
export function friendlySearchError(text) {
  if (text.includes('knowledge_scope_requires_domain') || text.includes('没有选择知识范围')) return '还没选择知识范围，请先点「选择知识范围」'
  if (text.includes('knowledge_scope_requires_repository') || text.includes('没有选择远程代码库')) return '还没选择代码库，请先点「选择代码库」'
  if (text.includes('knowledge_query_disabled') || text.includes('知识查询开关已关闭')) return '知识查询开关已关闭'
  if (text.includes('knowledge_scope_missing') || text.includes('还没有知识/代码范围记录')) return '当前会话还没有选择远程范围'
  if (text.includes('knowledge_login_required')) return '暂时无法访问远程资料，请重新登录后再试'
  if (text.includes('空闲超时') || text.includes('UND_ERR_BODY_TIMEOUT')) return '远程检索流因空闲超时中断，请重试一次'
  if (text.includes('网络传输中断') || text.includes('fetch failed') || text.includes('Failed to fetch')) return '远程检索流中断，请重试一次'
  return text.replace(/^Error:\s*/u, '')
}
