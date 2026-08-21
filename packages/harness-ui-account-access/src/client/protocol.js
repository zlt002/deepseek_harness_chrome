function snapshot(value) {
  return value !== null && typeof value === 'object'
    && value.apiKey === undefined
    && ['guest', 'authenticated', 'unavailable'].includes(value.status)
    && (value.displayName === undefined || typeof value.displayName === 'string')
    && typeof value.knowledgeAccess === 'boolean'
    && typeof value.codeAccess === 'boolean'
    && (value.modelMode === 'manual' || value.modelMode === 'company-pending')
    && (value.gateway === undefined || gateway(value.gateway))
    && (value.message === undefined || (typeof value.message === 'string' && value.message.length <= 2_000))
}

function quota(value) {
  return value !== null && typeof value === 'object'
    && (value.usagePercent === null || (typeof value.usagePercent === 'number' && Number.isFinite(value.usagePercent) && value.usagePercent >= 0 && value.usagePercent <= 100))
    && (value.nextResetTime === null || typeof value.nextResetTime === 'string')
    && ['daily', 'weekly', 'monthly', 'unlimited'].includes(value.resetCycle)
}

function capability(value) {
  if (value === undefined) return true
  return value !== null && typeof value === 'object'
    && (value.protocol === 'anthropic-messages' || value.protocol === 'openai-completions')
    && typeof value.modelId === 'string' && value.modelId.length > 0 && value.modelId.length <= 160
    && value.tools === true
    && (value.verifiedAt === undefined || typeof value.verifiedAt === 'string')
}

function gateway(value) {
  return value !== null && typeof value === 'object' && typeof value.checkedAt === 'string'
    && value.apiKey === undefined
    && Array.isArray(value.models) && value.models.length <= 200
    && value.models.every(model => model !== null && typeof model === 'object' && typeof model.id === 'string' && typeof model.name === 'string' && (model.description === undefined || typeof model.description === 'string'))
    && quota(value.quota)
    && capability(value.capability)
}

function gatewayProbe(value) {
  return value !== null && typeof value === 'object' && typeof value.requestId === 'string' && value.requestId.length > 0
    && value.apiKey === undefined
    && ((value.status === 'ready' && gateway(value.gateway))
      || (value.status === 'error' && typeof value.error === 'string' && value.error.length <= 2_000))
}

export function createAccountAccessProtocol({ createStore, nonce, parentOrigin }) {
  const source = createStore(undefined)
  const gatewayProbeSource = createStore(undefined)
  let incoming = 0
  let gatewayIncoming = 0
  let outgoing = 0
  let gatewayOutgoing = 0
  return {
    source,
    gatewayProbe: gatewayProbeSource,
    accept(event, parent) {
      const message = event.data
      if (event.source !== parent || event.origin !== parentOrigin || message === null || typeof message !== 'object') return false
      if (message.nonce !== nonce || !Number.isInteger(message.sequence)) return false
      if (message.type === 'account-access-snapshot/v1' && message.sequence > incoming && snapshot(message.snapshot)) {
        incoming = message.sequence
        source.set(message.snapshot)
        return true
      }
      if (message.type === 'company-gateway-probe-snapshot/v1' && message.sequence > gatewayIncoming && gatewayProbe(message.snapshot)) {
        gatewayIncoming = message.sequence
        gatewayProbeSource.set(message.snapshot)
        return true
      }
      return false
    },
    request(command, parent) {
      if (!['refresh', 'login', 'logout'].includes(command)) return false
      outgoing += 1
      parent.postMessage({ type: 'account-access-command/v1', nonce, sequence: outgoing, command }, parentOrigin)
      return true
    },
    probeGateway(apiKey, protocol, requestedModelId, parent) {
      if (protocol !== 'anthropic-messages' && protocol !== 'openai-completions') throw new Error('Unsupported company gateway protocol.')
      if (requestedModelId !== undefined && (typeof requestedModelId !== 'string' || requestedModelId.trim().length === 0 || requestedModelId.length > 160)) throw new Error('Invalid company gateway model.')
      gatewayOutgoing += 1
      const requestId = crypto.randomUUID()
      parent.postMessage({ type: 'company-gateway-probe-command/v1', nonce, sequence: gatewayOutgoing, requestId, apiKey, protocol, ...(requestedModelId === undefined ? {} : { requestedModelId: requestedModelId.trim() }) }, parentOrigin)
      return requestId
    },
  }
}

export function accountAccessBridgeConfig(location = window.location) {
  const query = new URLSearchParams(location.search)
  if (query.get('dshBrowserTargetBridge') !== '1') return undefined
  const nonce = query.get('dshBrowserTargetNonce'); const parentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (nonce === null || parentOrigin === null) return undefined
  try { const parsed = new URL(parentOrigin); return parsed.protocol === 'chrome-extension:' && parsed.host !== '' && `${parsed.protocol}//${parsed.host}` === parentOrigin ? { nonce, parentOrigin } : undefined } catch { return undefined }
}
