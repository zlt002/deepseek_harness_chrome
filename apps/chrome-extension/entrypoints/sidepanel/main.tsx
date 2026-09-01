// WXT's generated development HTML bypasses Vite's transformIndexHtml hook.
// Initialise React Refresh from the client entry so HMR has its preamble.
import '@vitejs/plugin-react/preamble'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { HarnessFrameSource, HarnessHandoffSessionFromLocation, HarnessHandoffTabFromLocation, HarnessSurfaceFromLocation, NormalizeActiveTabForBrowserTarget } from './harness-frame'
import { openFullscreenTab as openFullscreenTabFromSidePanel, returnToSidePanel as returnToSidePanelFromFullscreen } from './fullscreen-handoff'
import { MARKDOWN_AI_ACK_TIMEOUT_MS } from '../markdown-review/delivery-timeouts'
import { validateWorkspaceMarkdownFeedback, validateWorkspaceMarkdownReviewAction, type WorkspaceMarkdownFeedback, type WorkspaceMarkdownReviewAction } from './markdown-feedback-validator'
import './style.css'

type HarnessStatus = 'starting' | 'ready' | 'error'
type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

interface HarnessResponse { ok: boolean; url?: string; error?: string }
interface SidePanelHandoffResponse { ok: boolean; sessionId?: string; tabId?: number; nonce?: string; error?: string }
interface BrowserTarget { browser: 'chrome'; windowId: number; tabId: number; url: string }
interface BrowserTargetTab extends BrowserTarget { title: string; favIconUrl?: string }
interface LockedRunTarget { sessionId: string; submissionId: string; target: BrowserTargetTab; observedActivity: boolean }
interface BrowserTargetSettings { mode: BrowserTargetMode; pinnedTabs: BrowserTarget[]; primaryTabId?: number }
interface BrowserTargetSettingsResponse { ok: boolean; settings?: BrowserTargetSettings; tabs?: BrowserTargetTab[]; error?: string }
interface ActiveBrowserTargetLockResponse { ok: boolean; lock?: { sessionId?: unknown; submissionId?: unknown; browserTarget?: unknown; observedActivity?: unknown }; locks?: { sessionId?: unknown; submissionId?: unknown; browserTarget?: unknown; observedActivity?: unknown }[]; error?: string }
interface DesignReferenceCaptureResponse { ok: boolean; referenceId?: string; error?: string }
interface RecentPrototypeStudio { projectId: string; referenceId: string; referenceTitle?: string; referenceUrl?: string; projectName?: string; currentRevisionId?: string; revisionCount?: number; updatedAt: number; authorizationActive: boolean; boundToCurrentSession?: boolean }
interface RecentPrototypeStudiosResponse { ok: boolean; projects?: RecentPrototypeStudio[]; error?: string }
interface ActiveTab extends BrowserTargetTab {}
interface ActiveTabResponse { ok: boolean; epoch?: string; sequence?: number; tab?: ActiveTab; error?: string }
interface KnowledgeScope { domainSystems: Record<string, string[]>; repositoryIds: string[] }
type KnowledgeServiceState = 'checking' | 'ready' | 'unauthenticated' | 'unavailable'
type KnowledgeScopeOptions = { enabled?: boolean; remember?: boolean; action?: 'login' | 'retry' }
interface KnowledgeScopeResponse { ok: boolean; scope?: KnowledgeScope; enabled?: boolean; remember?: boolean; serviceState?: KnowledgeServiceState; catalog?: unknown; notice?: string; error?: string }
type AccountAccessStatus = 'guest' | 'authenticated' | 'unavailable'
type CompanyGatewayProtocol = 'anthropic-messages' | 'openai-completions'
interface CompanyGatewayModel { id: string; name: string; description?: string }
interface CompanyGatewayQuota { usagePercent: number | null; nextResetTime: string | null; resetCycle: 'daily' | 'weekly' | 'monthly' | 'unlimited' }
interface CompanyGatewayMetadata { models: CompanyGatewayModel[]; quota: CompanyGatewayQuota; checkedAt: string }
interface AccountAccessSnapshot { status: AccountAccessStatus; displayName?: string; knowledgeAccess: boolean; codeAccess: boolean; modelMode: 'manual' | 'company-pending'; gateway?: CompanyGatewayMetadata; message?: string }
interface AccountAccessResponse { ok: boolean; snapshot?: AccountAccessSnapshot; error?: string }
interface CompanyGatewayProbeResponse { ok: boolean; requestId?: string; gateway?: CompanyGatewayMetadata; error?: string }
interface ReleaseUpdateResponse { ok: boolean; update?: { available: boolean; version?: string; sha256?: string; error?: string }; error?: string }
interface OpenMarkdownReview {
  v: 1
  reviewId: string
  harnessSessionId: string
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
  capability: string
}

interface MarkdownReviewIdentity { reviewId: string; harnessSessionId: string; resourceId: string }
interface PrototypePromptPayload { projectId: string; sessionId: string; requestId: string; expectedRevisionId?: string; request: string; selection?: { elementId?: unknown; type?: unknown; label?: unknown }; evidence: unknown[]; revisions: unknown[]; currentRevisionId?: unknown; designSpec?: unknown; document?: unknown }
interface BriefSuggestionPayload { projectId: string; sessionId: string; requestId: string }

type BrowserTargetCommand =
  | { command: 'refresh' }
  | { command: 'set-mode'; mode: BrowserTargetMode }
  | { command: 'toggle-pinned-tab'; tabId: number; checked: boolean }
  | { command: 'set-primary'; tabId: number }
  | { command: 'capture-design-reference'; tabId: number; sessionId?: string }
  | { command: 'capture-responsive-design-reference'; tabId: number; sessionId?: string }
  | { command: 'capture-design-references'; tabIds: number[]; sessionId?: string }
  | { command: 'html-workbench-select'; tabId: number; sessionId?: string }

function isActiveTab(value: unknown): value is ActiveTab {
  return typeof value === 'object' && value !== null
    && Number.isInteger((value as ActiveTab).windowId)
    && Number.isInteger((value as ActiveTab).tabId)
    && typeof (value as ActiveTab).title === 'string'
    && typeof (value as ActiveTab).url === 'string'
    && (typeof (value as ActiveTab).favIconUrl === 'string' || (value as ActiveTab).favIconUrl === undefined)
}

function isBrowserTarget(value: unknown): value is BrowserTarget {
  return typeof value === 'object' && value !== null
    && (value as BrowserTarget).browser === 'chrome'
    && Number.isInteger((value as BrowserTarget).windowId)
    && Number.isInteger((value as BrowserTarget).tabId)
    && typeof (value as BrowserTarget).url === 'string'
}

function browserTargetTabForLock(target: BrowserTarget, activeTab: ActiveTab | undefined, tabs: BrowserTargetTab[]): BrowserTargetTab {
  if (activeTab?.windowId === target.windowId && activeTab.tabId === target.tabId && activeTab.url === target.url) return activeTab
  return tabs.find(tab => tab.windowId === target.windowId && tab.tabId === target.tabId && tab.url === target.url) ?? { ...target, title: target.url }
}

/** Keeps pending acknowledgements isolated so another Harness session cannot cancel this Run's target projection. */
export class BrowserTargetRunLockProjection {
  #pendingBySubmission = new Map<string, LockedRunTarget>()
  #currentBySubmission = new Map<string, LockedRunTarget>()

  #current(): LockedRunTarget[] {
    return [...this.#currentBySubmission.values()]
  }

  start(sessionId: string, submissionId: string, target: BrowserTargetTab): void {
    this.#pendingBySubmission.set(submissionId, { sessionId, submissionId, target, observedActivity: false })
  }

  acknowledge(sessionId: string, submissionId: string, locked: boolean): LockedRunTarget[] {
    const pending = this.#pendingBySubmission.get(submissionId)
    if (pending?.sessionId !== sessionId) return this.#current()
    this.#pendingBySubmission.delete(submissionId)
    if (locked) this.#currentBySubmission.set(submissionId, pending)
    else if (this.#currentBySubmission.get(submissionId)?.sessionId === sessionId) this.#currentBySubmission.delete(submissionId)
    return this.#current()
  }

  unlock(sessionId: string, submissionId: string): LockedRunTarget[] {
    if (this.#pendingBySubmission.get(submissionId)?.sessionId === sessionId) this.#pendingBySubmission.delete(submissionId)
    if (this.#currentBySubmission.get(submissionId)?.sessionId === sessionId) this.#currentBySubmission.delete(submissionId)
    return this.#current()
  }

  reconcile(sessionId: string, submissionId: string): LockedRunTarget[] {
    if (this.#pendingBySubmission.get(submissionId)?.sessionId === sessionId) this.#pendingBySubmission.delete(submissionId)
    if (this.#currentBySubmission.get(submissionId)?.sessionId === sessionId) this.#currentBySubmission.delete(submissionId)
    return this.#current()
  }

  observe(sessionId: string, submissionId: string): LockedRunTarget[] {
    const lock = this.#currentBySubmission.get(submissionId)
    if (lock?.sessionId === sessionId) this.#currentBySubmission.set(submissionId, { ...lock, observedActivity: true })
    return this.#current()
  }

  reset(): LockedRunTarget[] {
    this.#pendingBySubmission.clear()
    this.#currentBySubmission.clear()
    return this.#current()
  }

  hydrate(locks: readonly LockedRunTarget[]): LockedRunTarget[] {
    this.#currentBySubmission = new Map(locks.map(lock => [lock.submissionId, lock]))
    for (const lock of locks) this.#pendingBySubmission.delete(lock.submissionId)
    return this.#current()
  }
}

function isBrowserTargetCommand(value: unknown): value is BrowserTargetCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as { command?: unknown; mode?: unknown; tabId?: unknown; tabIds?: unknown; checked?: unknown; sessionId?: unknown }
  if (command.command === 'refresh') return true
  if (command.command === 'set-mode') return command.mode === 'follow-active-tab' || command.mode === 'pinned-tabs' || command.mode === 'none'
  if (command.command === 'toggle-pinned-tab') return Number.isInteger(command.tabId) && typeof command.checked === 'boolean'
  if (command.command === 'capture-design-reference' || command.command === 'capture-responsive-design-reference') return Number.isInteger(command.tabId) && (command.sessionId === undefined || boundedString(command.sessionId, 160))
  if (command.command === 'capture-design-references') return Array.isArray(command.tabIds) && command.tabIds.length >= 2 && command.tabIds.length <= 3 && command.tabIds.every(Number.isInteger) && new Set(command.tabIds).size === command.tabIds.length && (command.sessionId === undefined || boundedString(command.sessionId, 160))
  if (command.command === 'html-workbench-select') return Number.isInteger(command.tabId) && (command.sessionId === undefined || boundedString(command.sessionId, 160))
  return command.command === 'set-primary' && Number.isInteger(command.tabId)
}

function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null
    && typeof (value as KnowledgeScope).domainSystems === 'object' && (value as KnowledgeScope).domainSystems !== null
    && Object.entries((value as KnowledgeScope).domainSystems).every(([domainId, systemIds]) => typeof domainId === 'string' && Array.isArray(systemIds) && systemIds.every((item) => typeof item === 'string'))
    && Array.isArray((value as KnowledgeScope).repositoryIds) && (value as KnowledgeScope).repositoryIds.every((item) => typeof item === 'string')
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim() !== '')
}

function isOpenMarkdownReview(value: unknown): value is OpenMarkdownReview {
  if (typeof value !== 'object' || value === null) return false
  const review = value as Record<string, unknown>
  return review.v === 1
    && ['reviewId', 'harnessSessionId', 'resourceId', 'revision', 'fingerprint'].every(key => boundedString(review[key], 160))
    && boundedString(review.displayPath, 2_048)
    && boundedString(review.capability, 512)
}

function isMarkdownReviewIdentity(value: unknown): value is MarkdownReviewIdentity {
  if (typeof value !== 'object' || value === null) return false
  const review = value as Record<string, unknown>
  return ['reviewId', 'harnessSessionId', 'resourceId'].every(key => boundedString(review[key], 160))
}

function isPrototypePromptPayload(value: unknown): value is PrototypePromptPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (typeof item.projectId !== 'string' || !/^prototype-[a-z0-9-]{8,72}$/.test(item.projectId) || !boundedString(item.sessionId, 160) || !boundedString(item.requestId, 160) || !/^[A-Za-z0-9._:-]{8,160}$/.test(item.requestId) || (item.expectedRevisionId !== undefined && !boundedString(item.expectedRevisionId, 160)) || !boundedString(item.request, 4_000) || !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 3 || item.evidence.some(evidence => evidence === null || typeof evidence !== 'object' || Array.isArray(evidence) || Object.hasOwn(evidence, 'screenshotDataUrl')) || !Array.isArray(item.revisions) || item.revisions.length > 20) return false
  if (item.selection !== undefined && (typeof item.selection !== 'object' || item.selection === null || Array.isArray(item.selection))) return false
  try { return JSON.stringify(item).length <= 260_000 } catch { return false }
}

function isBriefSuggestionPayload(value: unknown): value is BriefSuggestionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 3 && /^prototype-[a-z0-9-]{8,72}$/.test(String(item.projectId)) && boundedString(item.sessionId, 160) && boundedString(item.requestId, 160) && /^[A-Za-z0-9._:-]{8,160}$/.test(String(item.requestId))
}

function requestHarness(message: unknown = { type: 'ensure-harness' }): Promise<HarnessResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: HarnessResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return a response.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestReleaseUpdate(action: 'check' | 'prepare'): Promise<ReleaseUpdateResponse> {
  return new Promise(resolve => chrome.runtime.sendMessage({ type: 'release-update/v1', action }, (response: ReleaseUpdateResponse | undefined) => {
    const runtimeError = chrome.runtime.lastError
    resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Native Host 未返回更新结果。' } : { ok: false, error: runtimeError.message })
  }))
}

function requestTargetSettings(message: unknown): Promise<BrowserTargetSettingsResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: BrowserTargetSettingsResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return target settings.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestActiveBrowserTargetLock(): Promise<ActiveBrowserTargetLockResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-active-browser-target-lock/v1' }, (response: ActiveBrowserTargetLockResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return the active Browser Target lock.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestDesignReferenceCapture(browserTarget: BrowserTarget, sessionId: string): Promise<DesignReferenceCaptureResponse> {
  return new Promise((resolve) => {
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: '提取设计规范超时，已自动结束。请确认网页加载完成后重试。' })
    }, 45_000)
    try {
      chrome.runtime.sendMessage({ type: 'capture-design-reference/v1', browserTarget, sessionId }, (response: DesignReferenceCaptureResponse | undefined) => {
        const runtimeError = chrome.runtime.lastError
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return the captured reference.' } : { ok: false, error: runtimeError.message })
      })
    } catch (cause) {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resolve({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  })
}

function requestResponsiveDesignReferenceCapture(browserTarget: BrowserTarget, sessionId: string): Promise<DesignReferenceCaptureResponse> {
  return new Promise(resolve => {
    let settled = false
    const timeout = window.setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: '多尺寸实测超时，临时窗口会自动清理。请确认网页可以正常打开后重试。' }) } }, 90_000)
    chrome.runtime.sendMessage({ type: 'capture-responsive-design-reference/v1', browserTarget, sessionId }, (response: DesignReferenceCaptureResponse | undefined) => {
      if (settled) return
      settled = true; window.clearTimeout(timeout)
      resolve(chrome.runtime.lastError === undefined ? response ?? { ok: false, error: '多尺寸实测没有返回结果。' } : { ok: false, error: chrome.runtime.lastError.message })
    })
  })
}

function requestDesignReferenceCaptures(browserTargets: BrowserTarget[], sessionId: string): Promise<DesignReferenceCaptureResponse> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve({ ok: false, error: '合并提取超时，未创建原型项目。请确认每个网页都已加载完成后重试。' }), 135_000)
    try {
      chrome.runtime.sendMessage({ type: 'capture-design-references/v1', browserTargets, sessionId }, (response: DesignReferenceCaptureResponse | undefined) => {
        window.clearTimeout(timeout)
        resolve(chrome.runtime.lastError === undefined ? response ?? { ok: false, error: 'Background did not return the captured references.' } : { ok: false, error: chrome.runtime.lastError.message })
      })
    } catch (cause) { window.clearTimeout(timeout); resolve({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }) }
  })
}

function requestRecentPrototypeStudios(sessionId?: string): Promise<RecentPrototypeStudiosResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'prototype-studio-recent/v1', ...(sessionId === undefined ? {} : { sessionId }) }, (response: RecentPrototypeStudiosResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: '无法读取最近原型。' } : { ok: false, error: runtimeError.message })
    })
  })
}

function continueRecentPrototypeStudio(projectId: string, sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'prototype-studio-continue-current/v1', projectId, sessionId }, (response: { ok: boolean; error?: string } | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: '无法在当前对话继续。' } : { ok: false, error: runtimeError.message })
    })
  })
}

function manageRecentPrototypeStudio(message: { type: 'prototype-studio-rename/v1'; projectId: string; projectName: string } | { type: 'prototype-studio-delete/v1'; projectId: string; confirmationProjectId: string }): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => chrome.runtime.sendMessage(message, (response: { ok: boolean; error?: string } | undefined) => {
    const runtimeError = chrome.runtime.lastError
    resolve(runtimeError === undefined ? response ?? { ok: false, error: '最近原型操作没有返回结果。' } : { ok: false, error: runtimeError.message })
  }))
}

function openRecentPrototypeStudio(projectId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'prototype-studio-open-recent/v1', projectId }, (response: { ok: boolean; error?: string } | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: '无法打开最近原型。' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestActiveTab(): Promise<ActiveTabResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-active-tab/v1' }, (response: ActiveTabResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return the active tab.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestKnowledgeScope(message: unknown): Promise<KnowledgeScopeResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: KnowledgeScopeResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return Knowledge scope.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestAccountAccess(command: 'refresh' | 'login' | 'logout'): Promise<AccountAccessResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'account-access/v1', command }, (response: AccountAccessResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return account access.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function requestCompanyGatewayProbe(requestId: string, apiKey: string, protocol: CompanyGatewayProtocol): Promise<CompanyGatewayProbeResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'company-gateway-probe/v1', requestId, apiKey, protocol }, (response: CompanyGatewayProbeResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, requestId, error: 'Background did not return company gateway data.' } : { ok: false, requestId, error: runtimeError.message })
    })
  })
}

function requestSidePanelHandoff(windowId: number): Promise<SidePanelHandoffResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-sidepanel-handoff/v1', windowId }, (response: SidePanelHandoffResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return the side-panel handoff.' } : { ok: false, error: runtimeError.message })
    })
  })
}

function currentExtensionTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || chrome.tabs?.getCurrent === undefined) { resolve(undefined); return }
    chrome.tabs.getCurrent((tab) => {
      resolve(chrome.runtime.lastError === undefined ? tab : undefined)
    })
  })
}

async function currentBrowserWindowId(): Promise<number | undefined> {
  const tab = await currentExtensionTab()
  if (tab?.windowId !== undefined) return tab.windowId
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || chrome.windows?.getLastFocused === undefined) { resolve(undefined); return }
    chrome.windows.getLastFocused((window) => resolve(chrome.runtime.lastError === undefined ? window.id : undefined))
  })
}

/** Switch from the side panel to an extension Tab without keeping both containers visible. */
async function openFullscreenTab(sessionId?: string): Promise<void> {
  if (typeof chrome === 'undefined' || chrome.runtime?.sendMessage === undefined) {
    window.open(window.location.href, '_blank')
    return
  }
  const windowId = await currentBrowserWindowId()
  if (windowId === undefined) throw new Error('Chrome could not identify the browser window for the side panel.')
  await openFullscreenTabFromSidePanel(chrome, windowId, sessionId)
}

/** The background owns the close -> re-open -> Tab removal transaction. */
async function returnToSidePanel(sessionId?: string): Promise<void> {
  const tab = await currentExtensionTab()
  if (tab?.windowId === undefined || tab.id === undefined) throw new Error('Chrome could not identify the full-screen Harness Tab.')
  await returnToSidePanelFromFullscreen(chrome, tab.windowId, tab.id, sessionId)
}

function isHarnessSessionIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

/** Keep one reference capture in flight even when iframe commands arrive back-to-back. */
export async function runDesignReferenceCaptureOnce<T>(
  pending: { current: number | undefined },
  tabId: number,
  projectBusy: (tabId: number | undefined) => void,
  capture: () => Promise<T>,
): Promise<T | undefined> {
  if (pending.current !== undefined) return undefined
  pending.current = tabId
  projectBusy(tabId)
  try {
    return await capture()
  } finally {
    if (pending.current === tabId) {
      pending.current = undefined
      projectBusy(undefined)
    }
  }
}

/** The extension shell owns Chrome permissions; the iframe owns all target UI. */
function App(): React.JSX.Element {
  const [status, setStatus] = useState<HarnessStatus>('starting')
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [targetSettings, setTargetSettings] = useState<BrowserTargetSettings>({ mode: 'follow-active-tab', pinnedTabs: [] })
  const [availableTabs, setAvailableTabs] = useState<BrowserTargetTab[]>([])
  const [targetError, setTargetError] = useState<string>()
  const [capturingDesignReferenceTabId, setCapturingDesignReferenceTabId] = useState<number>()
  const [capturingDesignReferenceProgress, setCapturingDesignReferenceProgress] = useState<{ current: number; total: number }>()
  const [recentPrototypes, setRecentPrototypes] = useState<RecentPrototypeStudio[]>([])
  const [recentPrototypesOpen, setRecentPrototypesOpen] = useState(false)
  const [recentPrototypeError, setRecentPrototypeError] = useState<string>()
  const [openingRecentProjectId, setOpeningRecentProjectId] = useState<string>()
  const [editingRecentProjectId, setEditingRecentProjectId] = useState<string>()
  const [recentProjectNameDraft, setRecentProjectNameDraft] = useState('')
  const [deletingRecentProjectId, setDeletingRecentProjectId] = useState<string>()
  const [activeTab, setActiveTab] = useState<{ epoch: string; sequence: number; tab: ActiveTab }>()
  const [lockedRunTargets, setLockedRunTargets] = useState<LockedRunTarget[]>([])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const frameReadyRef = useRef(false)
  const workspaceReviewBridgeReadyRef = useRef(false)
  const bridgeSequenceRef = useRef(0)
  const targetSettingsRef = useRef(targetSettings)
  const availableTabsRef = useRef(availableTabs)
  const activeTabRef = useRef(activeTab)
  const runTargetLockProjectionRef = useRef(new BrowserTargetRunLockProjection())
  const lockProjectionVersionRef = useRef(0)
  const lockHydrationRequestRef = useRef(0)
  const designReferenceCaptureRef = useRef<number | undefined>(undefined)
  const commandSequenceRef = useRef(0)
  const knowledgeCommandSequenceRef = useRef(0)
  const knowledgeSnapshotSequenceRef = useRef(0)
  const knowledgeRequestSequenceBySessionRef = useRef(new Map<string, number>())
  const accountCommandSequenceRef = useRef(0)
  const accountSnapshotSequenceRef = useRef(0)
  const gatewayCommandSequenceRef = useRef(0)
  const gatewaySnapshotSequenceRef = useRef(0)
  const accountLoginAttemptsRef = useRef(0)
  const accountLoginTimerRef = useRef<number | undefined>(undefined)
  const searchProgressSequenceRef = useRef(0)
  const reviewRehydrateRef = useRef(new Map<string, { sendResponse: (response?: unknown) => void; timeout: number }>())
  const reviewFeedbackRef = useRef(new Map<string, { feedback: WorkspaceMarkdownFeedback; sendResponse: (response?: unknown) => void; timeout: number }>())
  const reviewActionRef = useRef(new Map<string, { action: WorkspaceMarkdownReviewAction; sendResponse: (response?: unknown) => void; timeout: number }>())
  const prototypePromptRef = useRef(new Map<string, { sendResponse: (response?: unknown) => void; timeout: number }>())
  const knowledgeLoginSessionRef = useRef<string | undefined>(undefined)
  const knowledgeLoginAttemptsRef = useRef(0)
  const knowledgeLoginTimerRef = useRef<number | undefined>(undefined)
  const knowledgeCommandHandlerRef = useRef<(sessionId: string, scope: KnowledgeScope | undefined, options: KnowledgeScopeOptions, requestSequence: number) => Promise<void>>(async () => {})
  const accountCommandHandlerRef = useRef<(command: 'refresh' | 'login' | 'logout') => Promise<void>>(async () => {})
  const surface = useMemo(() => HarnessSurfaceFromLocation(), [])
  const handoffSessionId = useMemo(() => HarnessHandoffSessionFromLocation(), [])
  const handoffTabId = useMemo(() => HarnessHandoffTabFromLocation(), [])
  const handoffNonce = useMemo(() => new URLSearchParams(window.location.search).get('dshHarnessHandoffNonce') ?? undefined, [])
  // The loopback Harness UI is outside the extension origin. Pass the actual
  // installed extension version across the already trusted iframe URL instead
  // of hardcoding a release number in the product UI.
  const productVersion = useMemo(() => chrome.runtime.getManifest().version, [])
  const hasLocationHandoff = surface === 'sidepanel' && handoffSessionId !== undefined && handoffTabId !== undefined
  const [sidePanelHandoff, setSidePanelHandoff] = useState<{ ready: boolean; sessionId?: string; tabId?: number; nonce?: string }>({ ready: surface === 'fullscreen-tab' || hasLocationHandoff, ...(handoffSessionId === undefined ? {} : { sessionId: handoffSessionId }), ...(handoffTabId === undefined ? {} : { tabId: handoffTabId }), ...(handoffNonce === undefined ? {} : { nonce: handoffNonce }) })
  // A handoff session restores an iframe once. The observed session is only
  // for side-panel actions; feeding it back into frameSrc would reload the
  // iframe every time the Harness session list reports its current value.
  const [observedHarnessSessionId, setObservedHarnessSessionId] = useState<string | undefined>(handoffSessionId)
  const activeHarnessSessionId = observedHarnessSessionId
  const frameNonce = useMemo(() => crypto.randomUUID(), [url])
  const frameSrc = useMemo(() => url === undefined ? undefined : HarnessFrameSource(url, { nonce: frameNonce, parentOrigin: window.location.origin, surface, productVersion, fullscreenTabSupported: chrome.sidePanel?.close !== undefined, ...(sidePanelHandoff.sessionId === undefined ? {} : { sessionId: sidePanelHandoff.sessionId }) }), [frameNonce, productVersion, sidePanelHandoff.sessionId, surface, url])
  const frameOrigin = useMemo(() => frameSrc === undefined ? undefined : new URL(frameSrc).origin, [frameSrc])

  useEffect(() => { frameReadyRef.current = false; workspaceReviewBridgeReadyRef.current = false }, [frameNonce])

  useEffect(() => {
    if (surface !== 'sidepanel') return
    if (hasLocationHandoff) return
    void currentBrowserWindowId().then((windowId) => {
      if (windowId === undefined) { setSidePanelHandoff({ ready: true }); return }
      void requestSidePanelHandoff(windowId).then((response) => setSidePanelHandoff({
        ready: true,
        ...(response.ok && isHarnessSessionIdentity(response.sessionId) ? { sessionId: response.sessionId } : {}),
        ...(response.ok && Number.isInteger(response.tabId) ? { tabId: response.tabId } : {}),
        ...(response.ok && isHarnessSessionIdentity(response.nonce) ? { nonce: response.nonce } : {}),
      }))
    })
  }, [hasLocationHandoff, surface])

  useEffect(() => { targetSettingsRef.current = targetSettings }, [targetSettings])
  useEffect(() => { availableTabsRef.current = availableTabs }, [availableTabs])
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  const clearBrowserTargetLockProjection = useCallback(() => {
    lockProjectionVersionRef.current += 1
    lockHydrationRequestRef.current += 1
    setLockedRunTargets(runTargetLockProjectionRef.current.reset())
  }, [])

  const connect = useCallback(async () => {
    // Reconnecting unmounts and recreates the Harness iframe, whose command
    // sequence starts again at 1 even if the reused URL keeps the same nonce.
    clearBrowserTargetLockProjection()
    knowledgeCommandSequenceRef.current = 0
    knowledgeRequestSequenceBySessionRef.current.clear()
    setStatus('starting'); setError(undefined)
    const response = await requestHarness()
    if (response.ok && response.url !== undefined) { setUrl(response.url); setStatus('ready'); return }
    setStatus('error'); setError(response.error ?? 'Unable to start the ACCRUI native server.')
  }, [clearBrowserTargetLockProjection])

  const loadTargetSettings = useCallback(async () => {
    const response = await requestTargetSettings({ type: 'get-browser-target-settings' })
    if (!response.ok || response.settings === undefined) { setTargetError(response.error ?? 'Unable to read Browser Target settings.'); return }
    setTargetSettings(response.settings); setAvailableTabs(response.tabs ?? []); setTargetError(undefined)
  }, [])

  const hydrateActiveBrowserTargetLock = useCallback(async () => {
    const requestId = lockHydrationRequestRef.current += 1
    const version = lockProjectionVersionRef.current
    const response = await requestActiveBrowserTargetLock()
    if (requestId !== lockHydrationRequestRef.current || version !== lockProjectionVersionRef.current || !response.ok) return
    const rawLocks = response.locks ?? (response.lock === undefined ? [] : [response.lock])
    const locks: LockedRunTarget[] = []
    for (const rawLock of rawLocks) {
      const sessionId = rawLock.sessionId
      const submissionId = rawLock.submissionId
      const browserTarget = rawLock.browserTarget
      if (!isHarnessSessionIdentity(sessionId) || !isHarnessSessionIdentity(submissionId) || !isBrowserTarget(browserTarget)) return
      if (locks.some(lock => lock.submissionId === submissionId)) return
      locks.push({ sessionId, submissionId, target: browserTargetTabForLock(browserTarget, activeTabRef.current?.tab, availableTabsRef.current), observedActivity: rawLock.observedActivity === true })
    }
    setLockedRunTargets(runTargetLockProjectionRef.current.hydrate(locks))
  }, [])

  const loadRecentPrototypes = useCallback(async () => {
    const response = await requestRecentPrototypeStudios(activeHarnessSessionId)
    if (!response.ok) { setRecentPrototypeError(response.error ?? '无法读取最近原型。'); return }
    setRecentPrototypes((response.projects ?? []).filter(item => typeof item.projectId === 'string' && typeof item.referenceId === 'string' && Number.isSafeInteger(item.updatedAt)))
    setRecentPrototypeError(undefined)
  }, [activeHarnessSessionId])

  const saveTargetSettings = useCallback(async (settings: BrowserTargetSettings) => {
    const response = await requestTargetSettings({ type: 'save-browser-target-settings', settings })
    if (!response.ok || response.settings === undefined) { setTargetError(response.error ?? 'Unable to save Browser Target settings.'); return }
    setTargetSettings(response.settings); setTargetError(undefined)
  }, [])

  useEffect(() => {
    if (!sidePanelHandoff.ready) return
    void connect(); void loadTargetSettings(); void hydrateActiveBrowserTargetLock()
  }, [connect, hydrateActiveBrowserTargetLock, loadTargetSettings, sidePanelHandoff.ready])

  useEffect(() => {
    if (!sidePanelHandoff.ready) return
    void loadRecentPrototypes()
  }, [loadRecentPrototypes, sidePanelHandoff.ready])

  const replaySearchProgress = useCallback(() => {
    if (frameOrigin === undefined || !frameReadyRef.current) return
    chrome.runtime.sendMessage({ type: 'search-progress-snapshot/v1' }, (response: { ok?: boolean; progress?: unknown[] } | undefined) => {
      if (chrome.runtime.lastError !== undefined || response?.ok !== true || !Array.isArray(response.progress)) return
      for (const item of response.progress) {
        const value = item as { requestId?: unknown; harnessSessionId?: unknown; harnessParentSessionId?: unknown; tool?: unknown; question?: unknown; phase?: unknown; chars?: unknown; content?: unknown; eventType?: unknown; process?: unknown }
        if (typeof value.requestId !== 'string' || typeof value.harnessSessionId !== 'string' || (value.tool !== 'code_search' && value.tool !== 'knowledge_search') || typeof value.question !== 'string' || (value.phase !== 'querying' && value.phase !== 'streaming' && value.phase !== 'done' && value.phase !== 'error') || typeof value.chars !== 'number' || typeof value.content !== 'string') continue
        searchProgressSequenceRef.current += 1
        frameRef.current?.contentWindow?.postMessage({ type: 'search-progress/v1', nonce: frameNonce, sequence: searchProgressSequenceRef.current, progress: { ...value, ...(typeof value.eventType === 'string' ? { eventType: value.eventType } : {}), ...(typeof value.process === 'string' ? { process: value.process } : {}) } }, frameOrigin)
      }
    })
  }, [frameNonce, frameOrigin])

  const forwardPendingMarkdownReviewFeedback = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (!workspaceReviewBridgeReadyRef.current || frameOrigin === undefined || target === null || target === undefined) return
    for (const pending of reviewFeedbackRef.current.values()) {
      target.postMessage({ type: 'markdown-review-feedback/v1', nonce: frameNonce, feedback: pending.feedback }, frameOrigin)
    }
  }, [frameNonce, frameOrigin])

  const forwardPendingMarkdownReviewActions = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (!workspaceReviewBridgeReadyRef.current || frameOrigin === undefined || target === null || target === undefined) return
    for (const [requestId, pending] of reviewActionRef.current) {
      target.postMessage({ type: 'markdown-review-session-action/v1', nonce: frameNonce, requestId, action: pending.action }, frameOrigin)
    }
  }, [frameNonce, frameOrigin])

  useEffect(() => {
    const accept = (epoch: unknown, sequence: unknown, tab: unknown): void => {
      if (typeof epoch !== 'string' || epoch.length === 0 || typeof sequence !== 'number' || !Number.isInteger(sequence) || !isActiveTab(tab)) return
      const targetTab = NormalizeActiveTabForBrowserTarget(tab)
      setActiveTab((previous) => previous !== undefined && previous.epoch === epoch && sequence <= previous.sequence ? previous : { epoch, sequence, tab: targetTab })
    }
    void requestActiveTab().then((response) => { if (response.ok) accept(response.epoch, response.sequence, response.tab) })
    const onMessage = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean | void => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: unknown; epoch?: unknown; sequence?: unknown; tab?: unknown; tabId?: unknown; current?: unknown; total?: unknown; url?: unknown; error?: unknown; requestId?: unknown; harnessSessionId?: unknown; harnessParentSessionId?: unknown; tool?: unknown; question?: unknown; phase?: unknown; chars?: unknown; content?: unknown; eventType?: unknown; process?: unknown; feedback?: unknown; review?: unknown; action?: unknown; payload?: unknown }
      if (value.type === 'prototype-studio-brief-suggestion-forward/v1') {
        const target = frameRef.current?.contentWindow
        if (!isBriefSuggestionPayload(value.payload) || frameOrigin === undefined || target === null || target === undefined) { sendResponse({ ok: false, error: 'The bound Harness Workspace is not available.' }); return false }
        const deliveryId = crypto.randomUUID()
        const timeout = window.setTimeout(() => { const pending = prototypePromptRef.current.get(deliveryId); if (pending === undefined) return; prototypePromptRef.current.delete(deliveryId); pending.sendResponse({ ok: false, error: 'Timed out sending the product requirement request to Harness.' }) }, 5_000)
        prototypePromptRef.current.set(deliveryId, { sendResponse, timeout })
        target.postMessage({ type: 'prototype-studio-brief-suggestion/v1', nonce: frameNonce, deliveryId, payload: value.payload }, frameOrigin)
        return true
      }
      if (value.type === 'prototype-studio-prompt-forward/v1') {
        const target = frameRef.current?.contentWindow
        if (!isPrototypePromptPayload(value.payload) || frameOrigin === undefined || target === null || target === undefined) { sendResponse({ ok: false, error: 'The bound Harness Workspace is not available.' }); return false }
        const deliveryId = crypto.randomUUID()
        const timeout = window.setTimeout(() => { const pending = prototypePromptRef.current.get(deliveryId); if (pending === undefined) return; prototypePromptRef.current.delete(deliveryId); pending.sendResponse({ ok: false, error: 'Timed out sending the prototype request to Harness.' }) }, 5_000)
        prototypePromptRef.current.set(deliveryId, { sendResponse, timeout })
        target.postMessage({ type: 'prototype-studio-prompt/v1', nonce: frameNonce, deliveryId, payload: value.payload }, frameOrigin)
        return true
      }
      if (value.type === 'html-workbench-prompt-forward/v1') {
        const payload = value.payload as { sessionId?: unknown; pageUrl?: unknown; anchors?: unknown[] } | undefined
        const target = frameRef.current?.contentWindow
        if (!payload || !boundedString(payload.sessionId, 160) || !boundedString(payload.pageUrl, 4096) || !payload.pageUrl.startsWith('file:') || !Array.isArray(payload.anchors) || payload.anchors.length < 1 || payload.anchors.length > 12 || frameOrigin === undefined || target === null || target === undefined) { sendResponse({ ok: false, error: 'Harness 对话未准备好接收 HTML 页面选择。' }); return false }
        const deliveryId = crypto.randomUUID(); const timeout = window.setTimeout(() => { const pending = prototypePromptRef.current.get(deliveryId); if (pending === undefined) return; prototypePromptRef.current.delete(deliveryId); pending.sendResponse({ ok: false, error: 'HTML 页面选择发送至 Harness 超时。' }) }, 5_000)
        prototypePromptRef.current.set(deliveryId, { sendResponse, timeout })
        target.postMessage({ type: 'html-workbench-prompt/v1', nonce: frameNonce, deliveryId, payload }, frameOrigin)
        return true
      }
      if (value.type === 'markdown-review-rehydrate-forward/v1') {
        const target = frameRef.current?.contentWindow
        if (!boundedString(value.requestId, 160) || !isMarkdownReviewIdentity(value.review) || frameOrigin === undefined || target === null || target === undefined) {
          sendResponse({ ok: false, error: '侧边栏未打开或尚未准备好。请打开侧边栏后重试。' })
          return false
        }
        const requestId = value.requestId
        const timeout = window.setTimeout(() => {
          const pending = reviewRehydrateRef.current.get(requestId)
          if (pending === undefined) return
          reviewRehydrateRef.current.delete(requestId)
          pending.sendResponse({ ok: false, error: 'Timed out restoring Markdown review authorization.' })
        }, 5_000)
        reviewRehydrateRef.current.set(requestId, { sendResponse, timeout })
        target.postMessage({ type: 'markdown-review-rehydrate/v1', nonce: frameNonce, requestId, ...value.review }, frameOrigin)
        return true
      }
      if (value.type === 'markdown-review-feedback-forward/v1') {
        const target = frameRef.current?.contentWindow
        if (frameOrigin === undefined || target === null || target === undefined) {
          sendResponse({ ok: false, error: '侧边栏未打开或尚未准备好。请打开侧边栏后重新发送。' })
          return false
        }
        const validation = validateWorkspaceMarkdownFeedback(value.feedback)
        if (!validation.ok) {
          sendResponse({ ok: false, error: validation.error })
          return false
        }
        const deliveryId = validation.feedback.id
        const timeout = window.setTimeout(() => {
          const pending = reviewFeedbackRef.current.get(deliveryId)
          if (pending === undefined) return
          reviewFeedbackRef.current.delete(deliveryId)
          pending.sendResponse({ ok: false, error: 'Harness 未在 15 秒内确认 AI 请求；可以重试，同一批注不会重复发送。' })
        }, MARKDOWN_AI_ACK_TIMEOUT_MS)
        reviewFeedbackRef.current.set(deliveryId, { feedback: validation.feedback, sendResponse, timeout })
        forwardPendingMarkdownReviewFeedback()
        return true
      }
      if (value.type === 'markdown-review-session-action-forward/v1') {
        const target = frameRef.current?.contentWindow
        const validation = validateWorkspaceMarkdownReviewAction({
          ...(typeof value.review === 'object' && value.review !== null ? value.review as object : {}),
          action: value.action,
        })
        if (!validation.ok || frameOrigin === undefined || target === null || target === undefined) {
          sendResponse({ ok: false, error: validation.ok ? '侧边栏未打开或尚未准备好。请打开侧边栏后重试。' : validation.error })
          return false
        }
        const requestId = crypto.randomUUID()
        const timeout = window.setTimeout(() => {
          const pending = reviewActionRef.current.get(requestId)
          if (pending === undefined) return
          reviewActionRef.current.delete(requestId)
          pending.sendResponse({ ok: false, error: 'Harness 未在 15 秒内确认审阅动作。请重试。' })
        }, MARKDOWN_AI_ACK_TIMEOUT_MS)
        reviewActionRef.current.set(requestId, { action: validation.action, sendResponse, timeout })
        forwardPendingMarkdownReviewActions()
        return true
      }
      if (value.type === 'active-tab-changed/v1') accept(value.epoch, value.sequence, value.tab)
      if (value.type === 'design-reference-capture-progress/v1' && Number.isInteger(value.tabId) && Number.isInteger(value.current) && Number.isInteger(value.total) && (value.current as number) >= 1 && (value.total as number) >= (value.current as number)) {
        setCapturingDesignReferenceTabId(value.tabId as number); setCapturingDesignReferenceProgress({ current: value.current as number, total: value.total as number })
      }
      if (value.type === 'harness-ready' && typeof value.url === 'string') { setUrl(value.url); setStatus('ready'); setError(undefined) }
      if (value.type === 'harness-runtime-mismatch' && typeof value.error === 'string') { setStatus('error'); setError(value.error) }
      if (value.type === 'harness-disconnected') { void connect() }
      // Relay live selected-source search progress into the Harness iframe,
      // guarded by the same nonce as every other bridge message.
      if (value.type === 'search-progress/v1' && typeof value.requestId === 'string' && typeof value.harnessSessionId === 'string' && (value.harnessParentSessionId === undefined || typeof value.harnessParentSessionId === 'string') && (value.tool === 'code_search' || value.tool === 'knowledge_search') && typeof value.question === 'string' && (value.phase === 'querying' || value.phase === 'streaming' || value.phase === 'done' || value.phase === 'error') && typeof value.chars === 'number' && typeof value.content === 'string' && frameOrigin !== undefined && frameReadyRef.current && frameRef.current?.contentWindow !== null) {
        searchProgressSequenceRef.current += 1
        frameRef.current?.contentWindow?.postMessage({
          type: 'search-progress/v1', nonce: frameNonce, sequence: searchProgressSequenceRef.current,
          progress: { requestId: value.requestId, harnessSessionId: value.harnessSessionId, harnessParentSessionId: value.harnessParentSessionId, tool: value.tool, question: value.question, phase: value.phase, chars: value.chars, content: value.content, ...(typeof value.eventType === 'string' ? { eventType: value.eventType } : {}), ...(typeof value.process === 'string' ? { process: value.process } : {}) },
        }, frameOrigin)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [connect, forwardPendingMarkdownReviewFeedback, frameNonce, frameOrigin])

  const projectBrowserTargetSnapshot = useCallback((capturingTabId: number | undefined) => {
    if (frameOrigin === undefined || !frameReadyRef.current) return
    const target = frameRef.current?.contentWindow
    if (target === null || target === undefined) return
    bridgeSequenceRef.current += 1
    target.postMessage({
      type: 'browser-target-snapshot/v1', nonce: frameNonce, sequence: bridgeSequenceRef.current,
      settings: targetSettings, tabs: availableTabs, activeTab: activeTab?.tab,
      ...(lockedRunTargets[0] === undefined ? {} : { lockedRunTarget: lockedRunTargets[0].target }),
      ...(lockedRunTargets[0] === undefined ? {} : { activeRunLock: lockedRunTargets[0] }),
      activeRunLocks: lockedRunTargets,
      ...(capturingTabId === undefined ? {} : { capturingDesignReferenceTabId: capturingTabId }), ...(capturingDesignReferenceProgress === undefined ? {} : { capturingDesignReferenceProgress }), error: targetError,
    }, frameOrigin)
  }, [activeTab, availableTabs, capturingDesignReferenceProgress, frameNonce, frameOrigin, lockedRunTargets, targetError, targetSettings])

  const sendBrowserTargetSnapshot = useCallback(() => {
    projectBrowserTargetSnapshot(capturingDesignReferenceTabId)
  }, [capturingDesignReferenceTabId, projectBrowserTargetSnapshot])

  useEffect(() => { sendBrowserTargetSnapshot() }, [sendBrowserTargetSnapshot])

  const handleFrameCommand = useCallback(async (command: BrowserTargetCommand) => {
    if (command.command === 'refresh') { await loadTargetSettings(); return }
    const settings = targetSettingsRef.current
    if (command.command === 'set-mode') { await saveTargetSettings({ ...settings, mode: command.mode }); return }
    if ((command.command === 'capture-design-reference' || command.command === 'capture-responsive-design-reference' || command.command === 'capture-design-references') && designReferenceCaptureRef.current !== undefined) return
    if (command.command === 'capture-design-references') {
      if (command.sessionId === undefined) { setTargetError('请先打开一个 Harness 对话，再采集参考网页。'); return }
      const tabs = command.tabIds.map(tabId => availableTabsRef.current.find(item => item.tabId === tabId))
      if (tabs.some(item => item === undefined)) { setTargetError('有一个参考网页已关闭或切换，请刷新后重新选择。'); return }
      const selected = tabs as BrowserTargetTab[]
      setTargetError(undefined); setCapturingDesignReferenceProgress({ current: 1, total: selected.length })
      const response = await runDesignReferenceCaptureOnce(designReferenceCaptureRef, selected[0]!.tabId, tabId => { setCapturingDesignReferenceTabId(tabId); projectBrowserTargetSnapshot(tabId) }, () => requestDesignReferenceCaptures(selected.map(tab => ({ browser: 'chrome' as const, windowId: tab.windowId, tabId: tab.tabId, url: tab.url })), command.sessionId as string))
      setCapturingDesignReferenceProgress(undefined)
      if (response === undefined) return
      if (!response.ok) setTargetError(response.error ?? '无法合并提取这些参考网页；没有创建原型项目。')
      else void loadRecentPrototypes()
      return
    }
    const tab = availableTabsRef.current.find((item) => item.tabId === command.tabId)
      ?? (command.command === 'toggle-pinned-tab' && !command.checked ? settings.pinnedTabs.find((item) => item.tabId === command.tabId) : undefined)
    if (tab === undefined) { setTargetError('The selected Chrome tab is no longer available.'); return }
    if (command.command === 'html-workbench-select') {
      if (!tab.url.startsWith('file:')) { setTargetError('HTML 工作台只支持本地 file:// HTML Browser Target。'); return }
      const response = await chrome.runtime.sendMessage({ type: 'html-workbench-select/v1', tabId: tab.tabId, sessionId: command.sessionId ?? activeHarnessSessionId }) as { ok?: unknown; error?: unknown }
      if (response?.ok !== true) setTargetError(typeof response?.error === 'string' ? response.error : '无法启用 HTML 元素选择。请确认扩展详情中已开启“允许访问文件网址”。')
      return
    }
    if (command.command === 'capture-design-reference') {
      if (command.sessionId === undefined) { setTargetError('请先打开一个 Harness 对话，再采集参考网页。'); return }
      setTargetError(undefined)
      const response = await runDesignReferenceCaptureOnce(
        designReferenceCaptureRef,
        tab.tabId,
        capturingTabId => {
          setCapturingDesignReferenceTabId(capturingTabId)
          projectBrowserTargetSnapshot(capturingTabId)
        },
        () => requestDesignReferenceCapture({ browser: 'chrome', windowId: tab.windowId, tabId: tab.tabId, url: tab.url }, command.sessionId as string),
      )
      if (response === undefined) return
      if (!response.ok) setTargetError(response.error ?? '无法采集这个参考网页。')
      else void loadRecentPrototypes()
      return
    }
    if (command.command === 'capture-responsive-design-reference') {
      if (command.sessionId === undefined) { setTargetError('请先打开一个 Harness 对话，再进行多尺寸实测。'); return }
      setTargetError(undefined); setCapturingDesignReferenceProgress({ current: 1, total: 3 })
      const response = await runDesignReferenceCaptureOnce(designReferenceCaptureRef, tab.tabId, capturingTabId => { setCapturingDesignReferenceTabId(capturingTabId); projectBrowserTargetSnapshot(capturingTabId) }, () => requestResponsiveDesignReferenceCapture({ browser: 'chrome', windowId: tab.windowId, tabId: tab.tabId, url: tab.url }, command.sessionId as string))
      setCapturingDesignReferenceProgress(undefined)
      if (response === undefined) return
      if (!response.ok) setTargetError(response.error ?? '无法完成桌面、平板、手机实测。')
      else void loadRecentPrototypes()
      return
    }
    if (command.command === 'toggle-pinned-tab') {
      const pinnedTabs = command.checked
        ? [...settings.pinnedTabs.filter((item) => item.tabId !== tab.tabId), { browser: 'chrome' as const, windowId: tab.windowId, tabId: tab.tabId, url: tab.url }]
        : settings.pinnedTabs.filter((item) => item.tabId !== tab.tabId)
      const primaryTabId = command.checked ? settings.primaryTabId ?? tab.tabId : settings.primaryTabId === tab.tabId ? pinnedTabs[0]?.tabId : settings.primaryTabId
      await saveTargetSettings({ ...settings, pinnedTabs, ...(primaryTabId === undefined ? {} : { primaryTabId }) })
      return
    }
    if (!settings.pinnedTabs.some((item) => item.tabId === tab.tabId)) { setTargetError('Choose this tab before making it the primary target.'); return }
    await saveTargetSettings({ ...settings, primaryTabId: tab.tabId })
  }, [loadRecentPrototypes, loadTargetSettings, projectBrowserTargetSnapshot, saveTargetSettings])

  const handleAccountAccessCommand = useCallback(async (command: 'refresh' | 'login' | 'logout') => {
    if (command === 'login') {
      if (accountLoginTimerRef.current !== undefined) window.clearTimeout(accountLoginTimerRef.current)
      accountLoginAttemptsRef.current = 0
    }
    if (command === 'logout' && accountLoginTimerRef.current !== undefined) {
      window.clearTimeout(accountLoginTimerRef.current)
      accountLoginTimerRef.current = undefined
      accountLoginAttemptsRef.current = 0
    }
    const response = await requestAccountAccess(command)
    if (frameOrigin === undefined || frameRef.current?.contentWindow === null || frameRef.current?.contentWindow === undefined) return
    const snapshot = response.snapshot ?? { status: 'unavailable' as const, knowledgeAccess: false, codeAccess: false, modelMode: 'manual' as const, message: response.error ?? '无法读取账号状态。' }
    accountSnapshotSequenceRef.current += 1
    frameRef.current.contentWindow.postMessage({
      type: 'account-access-snapshot/v1', nonce: frameNonce, sequence: accountSnapshotSequenceRef.current, snapshot,
    }, frameOrigin)
    if (snapshot.status === 'authenticated' || command === 'logout') {
      if (accountLoginTimerRef.current !== undefined) window.clearTimeout(accountLoginTimerRef.current)
      accountLoginTimerRef.current = undefined
      accountLoginAttemptsRef.current = 0
      return
    }
    if (accountLoginAttemptsRef.current < 15 && command !== 'refresh') {
      accountLoginAttemptsRef.current += 1
      accountLoginTimerRef.current = window.setTimeout(() => { void accountCommandHandlerRef.current('refresh') }, 2_000)
    } else if (command === 'refresh' && accountLoginAttemptsRef.current > 0 && accountLoginAttemptsRef.current < 15) {
      accountLoginAttemptsRef.current += 1
      accountLoginTimerRef.current = window.setTimeout(() => { void accountCommandHandlerRef.current('refresh') }, 2_000)
    }
  }, [frameNonce, frameOrigin])

  useEffect(() => { accountCommandHandlerRef.current = handleAccountAccessCommand }, [handleAccountAccessCommand])

  const handleCompanyGatewayProbe = useCallback(async (requestId: string, apiKey: string, protocol: CompanyGatewayProtocol) => {
    const response = await requestCompanyGatewayProbe(requestId, apiKey, protocol)
    if (frameOrigin === undefined || frameRef.current?.contentWindow === null || frameRef.current?.contentWindow === undefined) return
    gatewaySnapshotSequenceRef.current += 1
    frameRef.current.contentWindow.postMessage({
      type: 'company-gateway-probe-snapshot/v1', nonce: frameNonce, sequence: gatewaySnapshotSequenceRef.current,
      snapshot: response.ok && response.gateway !== undefined
        ? { requestId, status: 'ready', gateway: response.gateway }
        : { requestId, status: 'error', error: response.error ?? '公司网关探测失败。' },
    }, frameOrigin)
  }, [frameNonce, frameOrigin])

  const handleKnowledgeScopeCommand = useCallback(async (sessionId: string, scope: KnowledgeScope | undefined, options: KnowledgeScopeOptions, requestSequence: number) => {
    if (options.action === 'login') {
      if (knowledgeLoginTimerRef.current !== undefined) window.clearTimeout(knowledgeLoginTimerRef.current)
      knowledgeLoginSessionRef.current = sessionId
      knowledgeLoginAttemptsRef.current = 0
    }
    const response = await requestKnowledgeScope({ type: 'knowledge-scope/v1', sessionId, ...(scope === undefined ? {} : { scope }), ...options })
    if (knowledgeRequestSequenceBySessionRef.current.get(sessionId) !== requestSequence) return
    if (frameOrigin === undefined || frameRef.current?.contentWindow === null || frameRef.current?.contentWindow === undefined) return
    const serviceState = response.serviceState ?? (response.ok ? 'ready' : 'unavailable')
    knowledgeSnapshotSequenceRef.current += 1
    frameRef.current.contentWindow.postMessage({
      type: 'knowledge-scope-snapshot/v1', nonce: frameNonce, sequence: knowledgeSnapshotSequenceRef.current,
      snapshot: {
        sessionId,
        ...(response.scope === undefined ? {} : { scope: response.scope }),
        enabled: response.enabled,
        remember: response.remember,
        requestSequence,
        serviceState,
        catalog: response.catalog ?? { domains: [], systems: [], repositories: [] },
        ...(response.notice === undefined ? {} : { notice: response.notice }),
        ...(response.error === undefined ? {} : { error: response.error }),
      },
    }, frameOrigin)
    if (serviceState === 'ready' && knowledgeLoginSessionRef.current === sessionId) {
      knowledgeLoginSessionRef.current = undefined
      knowledgeLoginAttemptsRef.current = 0
      if (knowledgeLoginTimerRef.current !== undefined) window.clearTimeout(knowledgeLoginTimerRef.current)
      knowledgeLoginTimerRef.current = undefined
      return
    }
    if (serviceState !== 'ready' && knowledgeLoginSessionRef.current === sessionId && knowledgeLoginAttemptsRef.current < 15) {
      knowledgeLoginAttemptsRef.current += 1
      knowledgeLoginTimerRef.current = window.setTimeout(() => {
        void knowledgeCommandHandlerRef.current(sessionId, undefined, {}, requestSequence)
      }, 2_000)
    }
  }, [frameNonce, frameOrigin])

  useEffect(() => {
    knowledgeCommandHandlerRef.current = handleKnowledgeScopeCommand
  }, [handleKnowledgeScopeCommand])

  useEffect(() => () => {
    if (knowledgeLoginTimerRef.current !== undefined) window.clearTimeout(knowledgeLoginTimerRef.current)
    if (accountLoginTimerRef.current !== undefined) window.clearTimeout(accountLoginTimerRef.current)
    for (const pending of reviewRehydrateRef.current.values()) { window.clearTimeout(pending.timeout); pending.sendResponse({ ok: false, error: 'The Harness Side Panel closed during Markdown review recovery.' }) }
    reviewRehydrateRef.current.clear()
    for (const pending of reviewFeedbackRef.current.values()) { window.clearTimeout(pending.timeout); pending.sendResponse({ ok: false, error: 'The Harness Side Panel closed before accepting Markdown feedback.' }) }
    reviewFeedbackRef.current.clear()
    for (const pending of reviewActionRef.current.values()) { window.clearTimeout(pending.timeout); pending.sendResponse({ ok: false, error: '侧边栏在确认审阅动作前已关闭。' }) }
    reviewActionRef.current.clear()
    for (const pending of prototypePromptRef.current.values()) { window.clearTimeout(pending.timeout); pending.sendResponse({ ok: false, error: 'The Harness Side Panel closed before accepting the prototype request.' }) }
    prototypePromptRef.current.clear()
  }, [])

  // This listener must exist before the iframe can finish booting: its ready
  // signal is the recovery path when the first onLoad snapshot arrives early.
  useLayoutEffect(() => {
    const onFrameMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== frameOrigin || !event.data || typeof event.data !== 'object') return
      const value = event.data as { type?: unknown; nonce?: unknown; sequence?: unknown; command?: unknown; sessionId?: unknown; submissionId?: unknown; browserTarget?: unknown; scope?: unknown; enabled?: unknown; remember?: unknown; action?: unknown; review?: unknown; requestId?: unknown; error?: unknown; deliveryId?: unknown; accepted?: unknown; targetSessionId?: unknown; targetSessionTitle?: unknown; status?: unknown; apiKey?: unknown; protocol?: unknown }
      if (value.nonce !== frameNonce) return
      if (value.type === 'prototype-studio-prompt-accepted/v1' && boundedString(value.deliveryId, 160)) {
        const pending = prototypePromptRef.current.get(value.deliveryId)
        if (pending === undefined) return
        prototypePromptRef.current.delete(value.deliveryId); window.clearTimeout(pending.timeout)
        pending.sendResponse(value.accepted === true ? { ok: true } : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness rejected the prototype request.' })
        return
      }
      if (value.type === 'html-workbench-prompt-accepted/v1' && boundedString(value.deliveryId, 160)) {
        const pending = prototypePromptRef.current.get(value.deliveryId)
        if (pending === undefined) return
        prototypePromptRef.current.delete(value.deliveryId); window.clearTimeout(pending.timeout)
        pending.sendResponse(value.accepted === true ? { ok: true } : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness 未接受 HTML 页面选择。' })
        return
      }
      if (value.type === 'markdown-review-feedback-accepted/v1' && boundedString(value.deliveryId, 160)) {
        const pending = reviewFeedbackRef.current.get(value.deliveryId)
        if (pending === undefined) return
        reviewFeedbackRef.current.delete(value.deliveryId)
        window.clearTimeout(pending.timeout)
        pending.sendResponse(value.accepted === true && boundedString(value.targetSessionId, 160) && boundedString(value.targetSessionTitle, 2_048) && (value.status === 'queued' || value.status === 'processing')
          ? { ok: true, targetSessionId: value.targetSessionId, targetSessionTitle: value.targetSessionTitle, status: value.status }
          : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness rejected the Markdown annotation.' })
        return
      }
      if (value.type === 'markdown-review-session-action-accepted/v1' && boundedString(value.requestId, 160)) {
        const pending = reviewActionRef.current.get(value.requestId)
        if (pending === undefined) return
        reviewActionRef.current.delete(value.requestId)
        window.clearTimeout(pending.timeout)
        const accepted = value.accepted === true && value.action === pending.action.action && boundedString(value.targetSessionId, 160) && boundedString(value.targetSessionTitle, 2_048)
          && (value.status === 'draft_ready' || value.status === 'queued' || value.status === 'processing')
        pending.sendResponse(accepted
          ? { ok: true, action: value.action, targetSessionId: value.targetSessionId, targetSessionTitle: value.targetSessionTitle, status: value.status }
          : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness 未接受审阅动作。' })
        return
      }
      if (value.type === 'workspace-review-bridge-ready/v1') {
        workspaceReviewBridgeReadyRef.current = true
        forwardPendingMarkdownReviewFeedback()
        forwardPendingMarkdownReviewActions()
        return
      }
      if (value.type === 'markdown-review-rehydrate-response/v1' && boundedString(value.requestId, 160)) {
        const pending = reviewRehydrateRef.current.get(value.requestId)
        if (pending === undefined) return
        reviewRehydrateRef.current.delete(value.requestId)
        window.clearTimeout(pending.timeout)
        if (isOpenMarkdownReview(value.review)) pending.sendResponse({ ok: true, review: value.review })
        else pending.sendResponse({ ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness could not restore Markdown review authorization.' })
        return
      }
      if (value.type === 'markdown-review-open/v1' && isOpenMarkdownReview(value.review)) {
        chrome.runtime.sendMessage({ type: 'open-markdown-review/v1', review: value.review }, (response: { ok?: boolean; error?: string } | undefined) => {
          const runtimeError = chrome.runtime.lastError
          if (runtimeError !== undefined || response?.ok !== true) console.error('[deepseek-harness] Failed to open Markdown Review Tab:', runtimeError?.message ?? response?.error)
        })
        return
      }
      if (value.type === 'harness-reconnect/v1' && value.nonce === frameNonce) { void connect(); return }
      if (value.type === 'open-fullscreen-tab/v1' && value.nonce === frameNonce) {
        void openFullscreenTab(typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined).catch((error: unknown) => console.error('[deepseek-harness] Failed to open full-screen Tab:', error))
        return
      }
      if (value.type === 'return-to-sidepanel/v1' && value.nonce === frameNonce) {
        void returnToSidePanel(isHarnessSessionIdentity(value.sessionId) ? value.sessionId : activeHarnessSessionId).catch((error: unknown) => console.error('[deepseek-harness] Failed to return to the side panel:', error))
        return
      }
      if (value.type === 'open-recent-prototypes/v1' && value.nonce === frameNonce) {
        setRecentPrototypesOpen(true)
        setRecentPrototypeError(undefined)
        setEditingRecentProjectId(undefined)
        setDeletingRecentProjectId(undefined)
        void loadRecentPrototypes()
        return
      }
      const selectedSessionId = value.sessionId
      if (value.type === 'harness-session-selected/v1' && (selectedSessionId === undefined || isHarnessSessionIdentity(selectedSessionId))) { setObservedHarnessSessionId(selectedSessionId); return }
      if (value.type === 'browser-target-lock/v1' && isHarnessSessionIdentity(value.sessionId) && isHarnessSessionIdentity(value.submissionId) && isBrowserTarget(value.browserTarget)) {
        const sessionId = value.sessionId
        const submissionId = value.submissionId
        const target = browserTargetTabForLock(value.browserTarget, activeTabRef.current?.tab, availableTabsRef.current)
        lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
        runTargetLockProjectionRef.current.start(sessionId, submissionId, target)
        void chrome.runtime.sendMessage({ type: 'lock-browser-target/v1', sessionId, submissionId, browserTarget: value.browserTarget })
          .then((response: { ok?: unknown; locked?: unknown; error?: unknown } | undefined) => {
            const locked = response?.ok === true && response?.locked === true
            lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
            setLockedRunTargets(runTargetLockProjectionRef.current.acknowledge(sessionId, submissionId, locked))
            frameRef.current?.contentWindow?.postMessage({
              type: 'browser-target-lock-ack/v1', nonce: frameNonce, sessionId, submissionId,
              ok: response?.ok === true, locked,
              ...(typeof response?.error === 'string' ? { error: response.error } : {}),
            }, frameOrigin)
          })
          .catch((error: unknown) => {
            lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
            setLockedRunTargets(runTargetLockProjectionRef.current.acknowledge(sessionId, submissionId, false))
            frameRef.current?.contentWindow?.postMessage({
              type: 'browser-target-lock-ack/v1', nonce: frameNonce, sessionId, submissionId, ok: false, locked: false,
              error: error instanceof Error ? error.message : String(error),
            }, frameOrigin)
          })
        return
      }
      if (value.type === 'browser-target-unlock/v1' && isHarnessSessionIdentity(value.sessionId) && isHarnessSessionIdentity(value.submissionId)) {
        lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
        setLockedRunTargets(runTargetLockProjectionRef.current.unlock(value.sessionId, value.submissionId))
        void chrome.runtime.sendMessage({ type: 'unlock-browser-target/v1', sessionId: value.sessionId, submissionId: value.submissionId }).catch(() => {})
        return
      }
      if (value.type === 'browser-target-observed/v1' && isHarnessSessionIdentity(value.sessionId) && isHarnessSessionIdentity(value.submissionId)) {
        lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
        setLockedRunTargets(runTargetLockProjectionRef.current.observe(value.sessionId, value.submissionId))
        void chrome.runtime.sendMessage({ type: 'observe-browser-target-lock/v1', sessionId: value.sessionId, submissionId: value.submissionId }).catch(() => {})
        return
      }
      if (value.type === 'browser-target-reconcile/v1' && isHarnessSessionIdentity(value.sessionId) && isHarnessSessionIdentity(value.submissionId)) {
        lockProjectionVersionRef.current += 1; lockHydrationRequestRef.current += 1
        setLockedRunTargets(runTargetLockProjectionRef.current.reconcile(value.sessionId, value.submissionId))
        void chrome.runtime.sendMessage({ type: 'reconcile-browser-target-lock/v1', sessionId: value.sessionId, submissionId: value.submissionId }).catch(() => {})
        return
      }
      if (value.type === 'session-handoff-applied/v1' && value.sessionId === sidePanelHandoff.sessionId && surface === 'sidepanel' && sidePanelHandoff.tabId !== undefined) {
        void currentBrowserWindowId().then((windowId) => {
          if (windowId !== undefined && sidePanelHandoff.nonce !== undefined) chrome.runtime.sendMessage({ type: 'session-handoff-applied/v1', windowId, tabId: sidePanelHandoff.tabId, sessionId: value.sessionId, nonce: sidePanelHandoff.nonce })
        })
        return
      }
      if (value.type === 'browser-target-ready/v1') {
        frameReadyRef.current = true
        commandSequenceRef.current = 0
        sendBrowserTargetSnapshot()
        void hydrateActiveBrowserTargetLock()
        replaySearchProgress()
        return
      }
      if (value.type === 'account-access-ready/v1') { accountCommandSequenceRef.current = 0; void handleAccountAccessCommand('refresh'); return }
      if (value.type === 'release-update-command/v1') {
        if (typeof value.requestId !== 'string' || !boundedString(value.requestId, 160) || (value.action !== 'check' && value.action !== 'prepare') || frameOrigin === undefined || frameRef.current?.contentWindow === null || frameRef.current?.contentWindow === undefined) return
        void requestReleaseUpdate(value.action).then(response => frameRef.current?.contentWindow?.postMessage(
          response.ok ? { type: 'release-update-result/v1', nonce: frameNonce, requestId: value.requestId, update: response.update } : { type: 'release-update-failed/v1', nonce: frameNonce, requestId: value.requestId, error: response.error ?? '在线更新失败。' }, frameOrigin))
        return
      }
      if (value.type === 'account-access-command/v1') {
        if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= accountCommandSequenceRef.current || (value.command !== 'refresh' && value.command !== 'login' && value.command !== 'logout')) return
        accountCommandSequenceRef.current = value.sequence
        void handleAccountAccessCommand(value.command)
        return
      }
      if (value.type === 'company-gateway-probe-command/v1') {
        if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= gatewayCommandSequenceRef.current
          || typeof value.requestId !== 'string' || value.requestId.length === 0 || value.requestId.length > 160
          || typeof value.apiKey !== 'string' || value.apiKey.length === 0 || value.apiKey.length > 512 || !/^[\x21-\x7E]+$/.test(value.apiKey)
          || (value.protocol !== 'anthropic-messages' && value.protocol !== 'openai-completions')) return
        gatewayCommandSequenceRef.current = value.sequence
        void handleCompanyGatewayProbe(value.requestId, value.apiKey, value.protocol)
        return
      }
      if (value.type === 'knowledge-scope-command/v1') {
        if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= knowledgeCommandSequenceRef.current || typeof value.sessionId !== 'string' || value.sessionId.length === 0 || (value.scope !== undefined && !isKnowledgeScope(value.scope))) return
        knowledgeCommandSequenceRef.current = value.sequence
        if ((value.enabled !== undefined && typeof value.enabled !== 'boolean') || (value.remember !== undefined && typeof value.remember !== 'boolean') || (value.action !== undefined && value.action !== 'login' && value.action !== 'retry')) return
        knowledgeRequestSequenceBySessionRef.current.set(value.sessionId, value.sequence)
        void handleKnowledgeScopeCommand(value.sessionId, value.scope, { ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}), ...(typeof value.remember === 'boolean' ? { remember: value.remember } : {}), ...((value.action === 'login' || value.action === 'retry') ? { action: value.action } : {}) }, value.sequence)
        return
      }
      if (value.type !== 'browser-target-command/v1' || typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= commandSequenceRef.current || !isBrowserTargetCommand(value.command)) return
      commandSequenceRef.current = value.sequence
      void handleFrameCommand(value.command).then(sendBrowserTargetSnapshot)
    }
    window.addEventListener('message', onFrameMessage)
    return () => window.removeEventListener('message', onFrameMessage)
  }, [activeHarnessSessionId, connect, forwardPendingMarkdownReviewFeedback, frameNonce, frameOrigin, handleAccountAccessCommand, handleCompanyGatewayProbe, handleFrameCommand, handleKnowledgeScopeCommand, hydrateActiveBrowserTargetLock, loadRecentPrototypes, replaySearchProgress, sendBrowserTargetSnapshot, sidePanelHandoff.tabId, surface])

  return <main className="shell">
    {status === 'ready' && url !== undefined ? (
      <section className={`harness-frame-shell${surface === 'fullscreen-tab' ? ' harness-frame-shell-fullscreen' : ''}`}>
        <iframe ref={frameRef} className="harness-frame" src={frameSrc} title="ACCRUI Web UI" allow="clipboard-read; clipboard-write" />
        {recentPrototypesOpen && <section className="recent-prototypes-popover" aria-label="最近原型">
            <header><div><b>最近原型</b><small>关闭原型页后，也能从这里继续。</small></div><div className="recent-prototypes-header-actions"><button type="button" className="recent-prototypes-refresh" aria-label="刷新最近原型" onClick={() => void loadRecentPrototypes()}>↻</button><button type="button" className="recent-prototypes-close" aria-label="关闭最近原型" onClick={() => setRecentPrototypesOpen(false)}>关闭</button></div></header>
            <section className="recent-prototype-create" aria-label="新建原型"><button type="button" disabled={activeTab?.tab === undefined || activeHarnessSessionId === undefined || capturingDesignReferenceTabId !== undefined} onClick={() => { if (activeTab?.tab === undefined || activeHarnessSessionId === undefined) return; void handleFrameCommand({ command: 'capture-design-reference', tabId: activeTab.tab.tabId, sessionId: activeHarnessSessionId }) }}>{capturingDesignReferenceTabId !== undefined ? '正在采集当前网页…' : '采集当前网页'}</button><small>{activeTab?.tab === undefined ? '请先打开要参考的网页。' : activeHarnessSessionId === undefined ? '请先打开一个 AI 对话。' : `当前网页：${activeTab.tab.title || activeTab.tab.url}`}</small></section>
            {recentPrototypeError !== undefined ? <p className="recent-prototypes-error">{recentPrototypeError}</p> : recentPrototypes.length === 0 ? <p className="recent-prototypes-empty">还没有保存过原型。先在对话中选择网页并提取设计规范。</p> : <ul>{recentPrototypes.map(project => <li key={project.projectId}><div className="recent-prototype-card">
              <button className="recent-prototype-open" type="button" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); setRecentPrototypeError(undefined); void openRecentPrototypeStudio(project.projectId).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法打开最近原型。'); else setRecentPrototypesOpen(false) }).finally(() => setOpeningRecentProjectId(undefined)) }}><span><b>{project.projectName ?? project.referenceTitle ?? '未命名原型'}</b><small>{project.revisionCount === undefined ? '历史项目' : project.revisionCount === 0 ? '尚未生成版本' : `共 ${project.revisionCount} 个版本`} · {new Date(project.updatedAt).toLocaleString()}</small></span><em>{openingRecentProjectId === project.projectId ? '处理中…' : '打开'}</em></button>
              {editingRecentProjectId === project.projectId ? <div className="recent-prototype-edit"><input aria-label="原型名称" maxLength={80} value={recentProjectNameDraft} onChange={event => setRecentProjectNameDraft(event.target.value)} autoFocus /><button type="button" disabled={recentProjectNameDraft.trim() === '' || openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); void manageRecentPrototypeStudio({ type: 'prototype-studio-rename/v1', projectId: project.projectId, projectName: recentProjectNameDraft.trim() }).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法重命名原型。'); else { setEditingRecentProjectId(undefined); void loadRecentPrototypes() } }).finally(() => setOpeningRecentProjectId(undefined)) }}>保存</button><button type="button" onClick={() => setEditingRecentProjectId(undefined)}>取消</button></div> : deletingRecentProjectId === project.projectId ? <div className="recent-prototype-delete-confirm"><span>确认永久删除这个原型和全部版本？</span><button type="button" className="danger" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); void manageRecentPrototypeStudio({ type: 'prototype-studio-delete/v1', projectId: project.projectId, confirmationProjectId: project.projectId }).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法删除原型。'); else { setDeletingRecentProjectId(undefined); void loadRecentPrototypes() } }).finally(() => setOpeningRecentProjectId(undefined)) }}>确认删除</button><button type="button" onClick={() => setDeletingRecentProjectId(undefined)}>取消</button></div> : <div className="recent-prototype-actions">{activeHarnessSessionId !== undefined && project.boundToCurrentSession === false && <button type="button" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); setRecentPrototypeError(undefined); void continueRecentPrototypeStudio(project.projectId, activeHarnessSessionId).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法在当前对话继续。'); else setRecentPrototypesOpen(false) }).finally(() => setOpeningRecentProjectId(undefined)) }}>在当前对话继续</button>}<button type="button" onClick={() => { setEditingRecentProjectId(project.projectId); setRecentProjectNameDraft(project.projectName ?? project.referenceTitle ?? '未命名原型'); setDeletingRecentProjectId(undefined) }}>重命名</button><button type="button" onClick={() => { setDeletingRecentProjectId(project.projectId); setEditingRecentProjectId(undefined) }}>删除</button></div>}
            </div></li>)}</ul>}
            <footer>“在当前对话继续”会由你明确确认后，把项目交给现在打开的 AI 对话；历史版本不会丢失。</footer>
          </section>}
      </section>
    ) : (
      <section className="status-card" aria-live="polite">
        <div className={`status-dot status-${status}`} />
        <h2>{status === 'starting' ? '正在启动 ACCRUI…' : 'ACCRUI 尚未连接'}</h2>
        <p>{status === 'starting' ? '扩展正在通过 Native Messaging 启动本地服务，并等待 Web UI 就绪。' : '请确认已构建 ACCRUI，并完成 native host 注册。'}</p>
        {error !== undefined && <pre className="error">{error}</pre>}
        {status === 'error' && <button onClick={() => void connect()}>再次连接</button>}
      </section>
    )}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
