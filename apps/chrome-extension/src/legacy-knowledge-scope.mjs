const LEGACY_SCOPE_PREFIX = 'knowledge-query:scope:session:'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function unique(values) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function legacyScope(value) {
  if (!record(value) || typeof value.hasCommon !== 'boolean' || !record(value.domains)) return undefined
  if (value.repoKeys !== undefined && !strings(value.repoKeys)) return undefined
  for (const selection of Object.values(value.domains)) {
    if (!record(selection) || typeof selection.self !== 'boolean' || !strings(selection.systems)) return undefined
  }
  return value
}

export function legacyKnowledgeScopeKey(sessionId) {
  return `${LEGACY_SCOPE_PREFIX}${sessionId}`
}

/** Convert the old AccrUI per-session shape without silently losing selections. */
export function migrateLegacyKnowledgeScope(value) {
  const state = record(value) && 'scope' in value ? value : { enabled: true, scope: value }
  const scope = legacyScope(state.scope)
  if (scope === undefined || (state.enabled !== undefined && typeof state.enabled !== 'boolean')) return undefined
  const selectedDomains = Object.entries(scope.domains)
    .filter(([, selection]) => selection.self || selection.systems.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
  const repositoryIds = unique(scope.repoKeys ?? [])
  if (selectedDomains.length > 1) {
    return {
      enabled: state.enabled ?? true,
      scope: { domainId: '', systemIds: [], repositoryIds },
      notice: '旧版会话包含多个知识领域，请重新确认知识范围；已保留代码库选择。',
    }
  }
  const selected = selectedDomains[0]
  return {
    enabled: state.enabled ?? true,
    scope: {
      domainId: selected?.[0] ?? '',
      systemIds: unique(selected?.[1].systems ?? []),
      repositoryIds,
    },
  }
}
