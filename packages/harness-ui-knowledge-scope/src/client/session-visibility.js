/**
 * The conversation snapshot uses null for the root session and a subagent
 * descriptor for every child session, including historical children whose
 * parent is no longer available.
 */
export function isChildConversation(subagent) {
  return subagent !== null
}

export function shouldShowKnowledgeScope(subagent) {
  return !isChildConversation(subagent)
}
