export function selectedNames(ids, entries, fallbackToId = false) {
  const byId = new Map(entries.map(entry => [entry.id, entry.name]))
  const names = ids.flatMap(id => {
    const name = byId.get(id)
    return name === undefined ? fallbackToId ? [id] : [] : [name]
  })
  return names.length === 0 ? undefined : names.join('、')
}

export function scopeLabels(scope, catalog) {
  // A saved scope is authoritative. The catalog is refreshed independently
  // and may temporarily omit an item, but a wide composer should still show
  // which repository key is selected instead of looking unselected.
  const repositories = selectedNames(scope?.repositoryIds ?? [], catalog.repositories, true)
  const knowledge = Object.entries(scope?.domainSystems ?? {}).flatMap(([domainId, systemIds]) => systemIds.flatMap(systemId => {
    const system = catalog.systems.find(item => item.id === systemId && item.domainId === domainId)
    return system === undefined ? [] : [system.name]
  })).join('、') || undefined
  return { repositories, knowledge }
}
