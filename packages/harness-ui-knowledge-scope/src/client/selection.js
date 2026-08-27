/** Checking a child system also selects its domain without discarding another category. */
export function selectKnowledgeSystem(scope, domainId, systemId, checked, domainSystemIds = []) {
  const current = scope.domainSystems[domainId] ?? []
  if (checked) {
    return { ...scope, domainSystems: { ...scope.domainSystems, [domainId]: [...new Set([...current, systemId])] } }
  }
  const systemIds = current.filter(id => id !== systemId)
  const domainSystems = { ...scope.domainSystems }
  if (systemIds.some(id => domainSystemIds.includes(id))) domainSystems[domainId] = systemIds
  else delete domainSystems[domainId]
  return { ...scope, domainSystems }
}

/** Checking a domain selects every child system; unchecking clears only that category. */
export function selectKnowledgeDomain(scope, domainId, systemIds, checked) {
  const domainSystems = { ...scope.domainSystems }
  if (checked) domainSystems[domainId] = [...new Set(systemIds)]
  else delete domainSystems[domainId]
  return { ...scope, domainSystems }
}
