import { sameBrowserTarget } from '../../../native-server/src/connector-protocol.mjs'
import type { BrowserTarget, UnavailableBrowserTarget } from '../../../native-server/src/connector-protocol.mjs'
import { defaultBrowserTargetSettings, samePinnedTab, settingsFromUnknown } from './browser-target-state'
import type { BrowserTargetSettings } from './browser-target-state'

const TARGET_SETTINGS_KEY = 'harnessBrowserTargetSettings'

export interface BrowserTargetBinding {
  browserTarget: BrowserTarget
  browserTargets: BrowserTarget[]
  unavailableBrowserTargets: UnavailableBrowserTarget[]
}

export interface BrowserTargetTab extends BrowserTarget {
  title: string
  favIconUrl?: string
}

interface BrowserTargetRuntimeOptions {
  storage: () => chrome.storage.StorageArea | undefined
  targetFromTab: (tab: chrome.tabs.Tab) => BrowserTarget | undefined
}

/**
 * Owns persisted Browser Target settings and all live-tab revalidation. The
 * background entrypoint consumes resolved bindings instead of reproducing
 * Chrome tab identity rules at each call site.
 */
export class BrowserTargetRuntime {
  private mutation: Promise<void> = Promise.resolve()

  constructor(private readonly options: BrowserTargetRuntimeOptions) {}

  settled(): Promise<void> { return this.mutation }

  async readSettings(): Promise<BrowserTargetSettings> {
    const storage = this.options.storage()
    if (storage === undefined) return { ...defaultBrowserTargetSettings }
    const values = await storage.get(TARGET_SETTINGS_KEY)
    return settingsFromUnknown(values[TARGET_SETTINGS_KEY])
  }

  saveSettings(settings: BrowserTargetSettings): Promise<BrowserTargetSettings> {
    return this.updateSettings((latest) => ({
      ...settings,
      ...(settings.candidate === undefined && latest.candidate !== undefined ? { candidate: latest.candidate } : {}),
    }))
  }

  updateSettings(mutator: (latest: BrowserTargetSettings) => BrowserTargetSettings): Promise<BrowserTargetSettings> {
    const operation = this.mutation.then(async () => {
      const latest = await this.readSettings()
      const updated = settingsFromUnknown(mutator(latest))
      await this.options.storage()?.set({ [TARGET_SETTINGS_KEY]: updated })
      return updated
    })
    this.mutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async active(windowId?: number): Promise<BrowserTarget> {
    const window = windowId === undefined ? await chrome.windows.getLastFocused() : { id: windowId }
    if (window.id === undefined) throw new Error('No Chrome window is available for the next Harness Run.')
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
    const target = tab === undefined ? undefined : this.options.targetFromTab(tab)
    if (target !== undefined) return target

    await this.mutation
    const candidate = (await this.readSettings()).candidate
    if (candidate !== undefined && candidate.windowId === window.id) {
      try {
        const live = this.options.targetFromTab(await chrome.tabs.get(candidate.tabId))
        if (live !== undefined && samePinnedTab(live, candidate) && live.windowId === window.id) return live
      } catch { /* candidate closed while a product-owned tab was active */ }
    }
    throw new Error('The active Chrome tab cannot be used as a Browser Target. Return to an ordinary page or select one again.')
  }

  binding(target: BrowserTarget): BrowserTargetBinding {
    return { browserTarget: target, browserTargets: [target], unavailableBrowserTargets: [] }
  }

  nativeFields(binding: BrowserTargetBinding): Partial<Pick<BrowserTargetBinding, 'browserTargets' | 'unavailableBrowserTargets'>> {
    return binding.browserTargets.length > 1 || binding.unavailableBrowserTargets.length > 0
      ? { browserTargets: binding.browserTargets, unavailableBrowserTargets: binding.unavailableBrowserTargets }
      : {}
  }

  async pinned(settings: BrowserTargetSettings): Promise<BrowserTargetBinding> {
    if (settings.pinnedTabs.length === 0) throw new Error('Select at least one pinned tab before starting a browser-bound Harness Run.')
    const available: BrowserTarget[] = []
    const unavailable: UnavailableBrowserTarget[] = []
    const nextPins: BrowserTarget[] = []
    let pinsChanged = false
    for (const target of settings.pinnedTabs) {
      try {
        const refreshed = this.options.targetFromTab(await chrome.tabs.get(target.tabId))
        if (refreshed !== undefined && samePinnedTab(refreshed, target)) {
          available.push(refreshed)
          nextPins.push(refreshed)
          if (!sameBrowserTarget(refreshed, target)) pinsChanged = true
        } else {
          unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
          nextPins.push(target)
        }
      } catch {
        unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
        nextPins.push(target)
      }
    }
    if (pinsChanged) await this.saveSettings({ ...settings, pinnedTabs: nextPins })
    const browserTarget = available.find((target) => target.tabId === settings.primaryTabId) ?? available[0]
    if (browserTarget === undefined) throw new Error('None of the pinned Browser Targets is still available. Select it again before starting.')
    return { browserTarget, browserTargets: available, unavailableBrowserTargets: unavailable }
  }

  async resolve(settings: BrowserTargetSettings, preferredTarget?: BrowserTarget): Promise<BrowserTargetBinding | undefined> {
    if (settings.mode === 'none') return undefined
    if (settings.mode === 'pinned-tabs') return this.pinned(settings)
    return this.binding(preferredTarget ?? await this.active())
  }

  async availableTabs(): Promise<BrowserTargetTab[]> {
    const window = await chrome.windows.getLastFocused()
    if (window.id === undefined) return []
    const tabs = await chrome.tabs.query({ windowId: window.id })
    return tabs.flatMap((tab): BrowserTargetTab[] => {
      const target = this.options.targetFromTab(tab)
      return target === undefined ? [] : [{ ...target, title: tab.title ?? '', ...(typeof tab.favIconUrl === 'string' && tab.favIconUrl.length > 0 ? { favIconUrl: tab.favIconUrl } : {}) }]
    })
  }
}
