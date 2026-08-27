function strings(value) { return Array.isArray(value) && value.every(item => typeof item === 'string') }

function scope(value) {
  return value !== null && typeof value === 'object' && value.domainSystems !== null && typeof value.domainSystems === 'object'
    && Object.entries(value.domainSystems).every(([domainId, systemIds]) => typeof domainId === 'string' && strings(systemIds)) && strings(value.repositoryIds)
}

function snapshot(value) {
  const catalog = value?.catalog
  return value !== null && typeof value === 'object' && typeof value.sessionId === 'string'
    && (value.scope === undefined || scope(value.scope))
    && (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.remember === undefined || typeof value.remember === 'boolean')
    && (value.requestSequence === undefined || (Number.isInteger(value.requestSequence) && value.requestSequence > 0))
    && (value.serviceState === undefined || ['checking', 'ready', 'unauthenticated', 'unavailable'].includes(value.serviceState))
    && (value.notice === undefined || (typeof value.notice === 'string' && value.notice.length <= 2_000))
    && catalog !== null && typeof catalog === 'object'
    && Array.isArray(catalog.domains) && Array.isArray(catalog.systems) && Array.isArray(catalog.repositories)
}

/** Live selected-source search progress relayed by the extension shell. */
function searchProgress(value) {
  return value !== null && typeof value === 'object' && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.harnessSessionId === 'string' && value.harnessSessionId.length > 0
    && (value.harnessParentSessionId === undefined || typeof value.harnessParentSessionId === 'string')
    && (value.tool === 'code_search' || value.tool === 'knowledge_search')
    && typeof value.question === 'string'
    && (value.phase === 'querying' || value.phase === 'streaming' || value.phase === 'done' || value.phase === 'error')
    && Number.isInteger(value.chars) && value.chars >= 0
    && typeof value.content === 'string' && value.content.length <= 16_000
    && (value.eventType === undefined || typeof value.eventType === 'string')
    && (value.process === undefined || (typeof value.process === 'string' && value.process.length <= 32_000))
}

export function createScopeProtocol({ createStore, nonce, parentOrigin }) {
  const source = createStore(undefined)
  const progress = createStore([])
  let progressEntries = []
  let incoming = 0
  let progressIncoming = 0
  let outgoing = 0
  return {
    source,
    progress,
    accept(event, parent) {
      const message = event.data
      if (event.source !== parent || event.origin !== parentOrigin || message === null || typeof message !== 'object') return false
      if (message.type === 'knowledge-scope-snapshot/v1' && message.nonce === nonce && Number.isInteger(message.sequence) && message.sequence > incoming && snapshot(message.snapshot)) {
        incoming = message.sequence
        source.set(message.snapshot)
        return true
      }
      if (message.type === 'search-progress/v1' && message.nonce === nonce && Number.isInteger(message.sequence) && message.sequence > progressIncoming && searchProgress(message.progress)) {
        progressIncoming = message.sequence
        progressEntries = [...progressEntries.filter(item => item.requestId !== message.progress.requestId), message.progress].slice(-12)
        progress.set(progressEntries)
        return true
      }
      return false
    },
    request(sessionId, nextScope, options, parent) {
      outgoing += 1
      parent.postMessage({ type: 'knowledge-scope-command/v1', nonce, sequence: outgoing, sessionId, ...(nextScope === undefined ? {} : { scope: nextScope }), ...options }, parentOrigin)
      return outgoing
    },
  }
}

export function knowledgeScopeBridgeConfig(location = window.location) {
  const query = new URLSearchParams(location.search)
  if (query.get('dshBrowserTargetBridge') !== '1') return undefined
  const nonce = query.get('dshBrowserTargetNonce'); const parentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (nonce === null || parentOrigin === null) return undefined
  try { const parsed = new URL(parentOrigin); return parsed.protocol === 'chrome-extension:' && parsed.host !== '' && `${parsed.protocol}//${parsed.host}` === parentOrigin ? { nonce, parentOrigin } : undefined } catch { return undefined }
}
