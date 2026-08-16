export type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

export interface BrowserTarget {
  browser: 'chrome'
  windowId: number
  tabId: number
  url: string
}

export interface BrowserTargetTab extends BrowserTarget {
  title: string
  favIconUrl?: string
}

export interface BrowserTargetSettings {
  mode: BrowserTargetMode
  pinnedTabs: BrowserTarget[]
  primaryTabId?: number
}

export interface BrowserTargetSnapshot {
  settings: BrowserTargetSettings
  tabs: BrowserTargetTab[]
  activeTab?: BrowserTargetTab
  error?: string
}

export type BrowserTargetCommand =
  | { command: 'refresh' }
  | { command: 'set-mode'; mode: BrowserTargetMode }
  | { command: 'toggle-pinned-tab'; tabId: number; checked: boolean }
  | { command: 'set-primary'; tabId: number }
