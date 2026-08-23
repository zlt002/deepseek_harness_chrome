import {
  sameBrowserTarget,
  validBrowserTarget,
} from '../../../native-server/src/connector-protocol.mjs'
import type { BrowserTarget } from '../../../native-server/src/connector-protocol.mjs'

export type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

export interface BrowserTargetSettings {
  mode: BrowserTargetMode
  pinnedTabs: BrowserTarget[]
  primaryTabId?: number
  candidate?: BrowserTarget
}

export const defaultBrowserTargetSettings: BrowserTargetSettings = {
  mode: 'follow-active-tab',
  pinnedTabs: [],
}

export function samePinnedTab(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.browser === right.browser && left.tabId === right.tabId
}

export function isBrowserTargetMode(value: unknown): value is BrowserTargetMode {
  return value === 'follow-active-tab' || value === 'pinned-tabs' || value === 'none'
}

export function uniqueBrowserTargets(targets: BrowserTarget[]): BrowserTarget[] {
  const seen = new Set<number>()
  return targets.filter((target) => {
    if (seen.has(target.tabId)) return false
    seen.add(target.tabId)
    return true
  })
}

export function settingsFromUnknown(value: unknown): BrowserTargetSettings {
  if (!value || typeof value !== 'object') return { ...defaultBrowserTargetSettings }
  const settings = value as Partial<BrowserTargetSettings>
  const mode = isBrowserTargetMode(settings.mode) ? settings.mode : 'follow-active-tab'
  const pinnedTabs = Array.isArray(settings.pinnedTabs) ? uniqueBrowserTargets(settings.pinnedTabs.filter(validBrowserTarget)) : []
  const primaryTabId = Number.isInteger(settings.primaryTabId) && pinnedTabs.some((target) => target.tabId === settings.primaryTabId)
    ? settings.primaryTabId
    : undefined
  const candidate = validBrowserTarget(settings.candidate) ? settings.candidate : undefined
  return { mode, pinnedTabs, ...(primaryTabId === undefined ? {} : { primaryTabId }), ...(candidate === undefined ? {} : { candidate }) }
}

export { sameBrowserTarget, validBrowserTarget }
