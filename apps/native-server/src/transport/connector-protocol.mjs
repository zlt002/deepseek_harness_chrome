/** Browser-safe runtime contract shared by the Chrome Extension and Native Server. */
export const CONNECTOR_REQUEST = 'connector_request'
export const CONNECTOR_RESPONSE = 'connector_response'
export const CONNECTOR_CANCEL = 'connector_cancel'

export function validBrowserTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 4 && value.browser === 'chrome'
    && Number.isInteger(value.windowId) && value.windowId >= 0
    && Number.isInteger(value.tabId) && value.tabId >= 0
    && typeof value.url === 'string' && value.url.length > 0
}

export function sameBrowserTarget(left, right) {
  return validBrowserTarget(left) && validBrowserTarget(right)
    && left.browser === right.browser && left.windowId === right.windowId
    && left.tabId === right.tabId && left.url === right.url
}

export function validUnavailableBrowserTarget(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && value.reason === 'closed_or_changed'
    && validBrowserTarget(value.browserTarget)
}

export function sameBrowserTargetList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((target, index) => sameBrowserTarget(target, right[index]))
}

export function sameUnavailableBrowserTargetList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((item, index) => validUnavailableBrowserTarget(item)
      && validUnavailableBrowserTarget(right[index]) && item.reason === right[index].reason
      && sameBrowserTarget(item.browserTarget, right[index].browserTarget))
}

export function validBrowserTargetBinding(browserTarget, browserTargets, unavailableBrowserTargets) {
  const targets = browserTargets ?? (validBrowserTarget(browserTarget) ? [browserTarget] : [])
  const unavailable = unavailableBrowserTargets ?? []
  return validBrowserTarget(browserTarget)
    && Array.isArray(targets) && targets.length > 0 && targets.every(validBrowserTarget)
    && targets.some((target) => sameBrowserTarget(target, browserTarget))
    && new Set(targets.map((target) => `${target.windowId}:${target.tabId}:${target.url}`)).size === targets.length
    && Array.isArray(unavailable) && unavailable.every(validUnavailableBrowserTarget)
}

export function validConnectorCorrelation(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.generation === 'string' && value.generation.length > 0
}

export function sameConnectorCorrelation(left, right) {
  return validConnectorCorrelation(left) && validConnectorCorrelation(right)
    && left.requestId === right.requestId && left.runId === right.runId
    && left.generation === right.generation
}

export function validConnectorResponseEnvelope(value) {
  return validConnectorCorrelation(value) && value.type === CONNECTOR_RESPONSE
    && (Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'))
}
