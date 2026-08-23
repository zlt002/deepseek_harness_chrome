export interface BrowserTarget {
  browser: 'chrome'
  windowId: number
  tabId: number
  url: string
}

export interface UnavailableBrowserTarget {
  browserTarget: BrowserTarget
  reason: 'closed_or_changed'
}

export interface ConnectorCorrelation {
  requestId: string
  runId: string
  generation: string
}

export type { RuntimeIdentitySummary } from './runtime-identity-contract.mjs'

export const CONNECTOR_REQUEST: 'connector_request'
export const CONNECTOR_RESPONSE: 'connector_response'
export const CONNECTOR_CANCEL: 'connector_cancel'
export function validBrowserTarget(value: unknown): value is BrowserTarget
export function sameBrowserTarget(left: unknown, right: unknown): boolean
export function validUnavailableBrowserTarget(value: unknown): value is UnavailableBrowserTarget
export function sameBrowserTargetList(left: unknown, right: unknown): boolean
export function sameUnavailableBrowserTargetList(left: unknown, right: unknown): boolean
export function validBrowserTargetBinding(browserTarget: unknown, browserTargets?: unknown, unavailableBrowserTargets?: unknown): boolean
export function validConnectorCorrelation(value: unknown): value is ConnectorCorrelation
export function sameConnectorCorrelation(left: unknown, right: unknown): boolean
export function validConnectorResponseEnvelope(value: unknown): value is ConnectorCorrelation & { type: 'connector_response'; result?: unknown; error?: unknown }
