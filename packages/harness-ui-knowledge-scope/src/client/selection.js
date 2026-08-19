/** Checking a child system also selects its domain; switching domains replaces the previous systems. */
export function selectKnowledgeSystem(scope, domainId, systemId, checked) {
  if (checked) {
    const systemIds = scope.domainId === domainId ? [...new Set([...scope.systemIds, systemId])] : [systemId]
    return { ...scope, domainId, systemIds }
  }
  if (scope.domainId !== domainId) return scope
  const systemIds = scope.systemIds.filter(id => id !== systemId)
  return { ...scope, domainId: systemIds.length === 0 ? '' : domainId, systemIds }
}

/** Checking a domain selects every system under it; unchecking clears that domain. */
export function selectKnowledgeDomain(scope, domainId, systemIds, checked) {
  if (checked) return { ...scope, domainId, systemIds: [...new Set(systemIds)] }
  if (scope.domainId !== domainId) return scope
  return { ...scope, domainId: '', systemIds: [] }
}
