function strings(value) { return Array.isArray(value) && value.every(item => typeof item === 'string') }

function scope(value) {
  return value !== null && typeof value === 'object' && typeof value.domainId === 'string'
    && strings(value.systemIds) && strings(value.repositoryIds)
}

function snapshot(value) {
  const catalog = value?.catalog
  return value !== null && typeof value === 'object' && typeof value.sessionId === 'string'
    && (value.scope === undefined || scope(value.scope))
    && (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.remember === undefined || typeof value.remember === 'boolean')
    && (value.serviceState === undefined || ['checking', 'ready', 'unauthenticated', 'unavailable'].includes(value.serviceState))
    && catalog !== null && typeof catalog === 'object'
    && Array.isArray(catalog.domains) && Array.isArray(catalog.systems) && Array.isArray(catalog.repositories)
}

export function createScopeProtocol({ createStore, nonce, parentOrigin }) {
  const source = createStore(undefined)
  let incoming = 0
  let outgoing = 0
  return {
    source,
    accept(event, parent) {
      const message = event.data
      if (event.source !== parent || event.origin !== parentOrigin || message === null || typeof message !== 'object') return false
      if (message.type !== 'knowledge-scope-snapshot/v1' || message.nonce !== nonce || !Number.isInteger(message.sequence) || message.sequence <= incoming || !snapshot(message.snapshot)) return false
      incoming = message.sequence
      source.set(message.snapshot)
      return true
    },
    request(sessionId, nextScope, options, parent) {
      outgoing += 1
      parent.postMessage({ type: 'knowledge-scope-command/v1', nonce, sequence: outgoing, sessionId, ...(nextScope === undefined ? {} : { scope: nextScope }), ...options }, parentOrigin)
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
