// WXT's generated development HTML bypasses Vite's transformIndexHtml hook.
// Initialise React Refresh from the client entry so HMR has its preamble.
import '@vitejs/plugin-react/preamble'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { HarnessFrameSource, HarnessHandoffSessionFromLocation, HarnessHandoffTabFromLocation, HarnessSurfaceFromLocation, NormalizeActiveTabForBrowserTarget } from './harness-frame'
import { openFullscreenTab as openFullscreenTabFromSidePanel, returnToSidePanel as returnToSidePanelFromFullscreen } from './fullscreen-handoff'
import { MARKDOWN_AI_ACK_TIMEOUT_MS } from '../markdown-review/delivery-timeouts'
import { validateWorkspaceMarkdownFeedback } from './markdown-feedback-validator'
import './style.css'

type HarnessStatus = 'starting' | 'ready' | 'error'
type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

interface HarnessResponse { ok: boolean; url?: string; error?: string }
interface SidePanelHandoffResponse { ok: boolean; sessionId?: string; tabId?: number; error?: string }
interface BrowserTarget { browser: 'chrome'; windowId: number; tabId: number; url: string }
interface BrowserTargetTab extends BrowserTarget { title: string; favIconUrl?: string }
interface BrowserTargetSettings { mode: BrowserTargetMode; pinnedTabs: BrowserTarget[]; primaryTabId?: number }
interface BrowserTargetSettingsResponse { ok: boolean; settings?: BrowserTargetSettings; tabs?: BrowserTargetTab[]; error?: string }
interface DesignReferenceCaptureResponse { ok: boolean; referenceId?: string; error?: string }
interface RecentPrototypeStudio { projectId: string; referenceId: string; referenceTitle?: string; referenceUrl?: string; projectName?: string; currentRevisionId?: string; revisionCount?: number; updatedAt: number; authorizationActive: boolean; boundToCurrentSession?: boolean }
interface RecentPrototypeStudiosResponse { ok: boolean; projects?: RecentPrototypeStudio[]; error?: string }
interface ActiveTab extends BrowserTargetTab {}
interface ActiveTabResponse { ok: boolean; epoch?: string; sequence?: number; tab?: ActiveTab; error?: string }
interface KnowledgeScope { domainId: string; systemIds: string[]; repositoryIds: string[] }
type KnowledgeServiceState = 'checking' | 'ready' | 'unauthenticated' | 'unavailable'
type KnowledgeScopeOptions = { enabled?: boolean; remember?: boolean; action?: 'login' | 'retry' }
interface KnowledgeScopeResponse { ok: boolean; scope?: KnowledgeScope; enabled?: boolean; remember?: boolean; serviceState?: KnowledgeServiceState; catalog?: unknown; notice?: string; error?: string }
type AccountAccessStatus = 'guest' | 'authenticated' | 'unavailable'
type CompanyGatewayProtocol = 'anthropic-messages' | 'openai-completions'
interface CompanyGatewayModel { id: string; name: string; description?: string }
interface CompanyGatewayQuota { usagePercent: number | null; nextResetTime: string | null; resetCycle: 'daily' | 'weekly' | 'monthly' | 'unlimited' }
interface CompanyGatewayCapability { protocol: CompanyGatewayProtocol; modelId: string; tools: true }
interface CompanyGatewayMetadata { models: CompanyGatewayModel[]; quota: CompanyGatewayQuota; capability?: CompanyGatewayCapability; checkedAt: string }
interface AccountAccessSnapshot { status: AccountAccessStatus; displayName?: string; knowledgeAccess: boolean; codeAccess: boolean; modelMode: 'manual' | 'company-pending'; gateway?: CompanyGatewayMetadata; message?: string }
interface AccountAccessResponse { ok: boolean; snapshot?: AccountAccessSnapshot; error?: string }
interface CompanyGatewayProbeResponse { ok: boolean; requestId?: string; gateway?: CompanyGatewayMetadata; error?: string }
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

function isActiveTab(value: unknown): value is ActiveTab {
  return typeof value === 'object' && value !== null
    && Number.isInteger((value as ActiveTab).windowId)
    && Number.isInteger((value as ActiveTab).tabId)
    && typeof (value as ActiveTab).title === 'string'
    && typeof (value as ActiveTab).url === 'string'
    && (typeof (value as ActiveTab).favIconUrl === 'string' || (value as ActiveTab).favIconUrl === undefined)
}

function isBrowserTargetCommand(value: unknown): value is BrowserTargetCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as { command?: unknown; mode?: unknown; tabId?: unknown; tabIds?: unknown; checked?: unknown; sessionId?: unknown }
  if (command.command === 'refresh') return true
  if (command.command === 'set-mode') return command.mode === 'follow-active-tab' || command.mode === 'pinned-tabs' || command.mode === 'none'
  if (command.command === 'toggle-pinned-tab') return Number.isInteger(command.tabId) && typeof command.checked === 'boolean'
  if (command.command === 'capture-design-reference' || command.command === 'capture-responsive-design-reference') return Number.isInteger(command.tabId) && (command.sessionId === undefined || boundedString(command.sessionId, 160))
  if (command.command === 'capture-design-references') return Array.isArray(command.tabIds) && command.tabIds.length >= 2 && command.tabIds.length <= 3 && command.tabIds.every(Number.isInteger) && new Set(command.tabIds).size === command.tabIds.length && (command.sessionId === undefined || boundedString(command.sessionId, 160))
  return command.command === 'set-primary' && Number.isInteger(command.tabId)
}

function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null
    && typeof (value as KnowledgeScope).domainId === 'string'
    && Array.isArray((value as KnowledgeScope).systemIds) && (value as KnowledgeScope).systemIds.every((item) => typeof item === 'string')
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

function requestTargetSettings(message: unknown): Promise<BrowserTargetSettingsResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: BrowserTargetSettingsResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError
      resolve(runtimeError === undefined ? response ?? { ok: false, error: 'Background did not return target settings.' } : { ok: false, error: runtimeError.message })
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

function requestCompanyGatewayProbe(requestId: string, apiKey: string, protocol: CompanyGatewayProtocol, requestedModelId?: string): Promise<CompanyGatewayProbeResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'company-gateway-probe/v1', requestId, apiKey, protocol, ...(requestedModelId === undefined ? {} : { requestedModelId }) }, (response: CompanyGatewayProbeResponse | undefined) => {
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
  const frameRef = useRef<HTMLIFrameElement>(null)
  const frameReadyRef = useRef(false)
  const bridgeSequenceRef = useRef(0)
  const targetSettingsRef = useRef(targetSettings)
  const availableTabsRef = useRef(availableTabs)
  const designReferenceCaptureRef = useRef<number | undefined>(undefined)
  const commandSequenceRef = useRef(0)
  const knowledgeCommandSequenceRef = useRef(0)
  const knowledgeSnapshotSequenceRef = useRef(0)
  const accountCommandSequenceRef = useRef(0)
  const accountSnapshotSequenceRef = useRef(0)
  const gatewayCommandSequenceRef = useRef(0)
  const gatewaySnapshotSequenceRef = useRef(0)
  const accountLoginAttemptsRef = useRef(0)
  const accountLoginTimerRef = useRef<number | undefined>(undefined)
  const searchProgressSequenceRef = useRef(0)
  const reviewRehydrateRef = useRef(new Map<string, { sendResponse: (response?: unknown) => void; timeout: number }>())
  const reviewFeedbackRef = useRef(new Map<string, { sendResponse: (response?: unknown) => void; timeout: number }>())
  const prototypePromptRef = useRef(new Map<string, { sendResponse: (response?: unknown) => void; timeout: number }>())
  const knowledgeLoginSessionRef = useRef<string | undefined>(undefined)
  const knowledgeLoginAttemptsRef = useRef(0)
  const knowledgeLoginTimerRef = useRef<number | undefined>(undefined)
  const knowledgeCommandHandlerRef = useRef<(sessionId: string, scope: KnowledgeScope | undefined, options: KnowledgeScopeOptions) => Promise<void>>(async () => {})
  const accountCommandHandlerRef = useRef<(command: 'refresh' | 'login' | 'logout') => Promise<void>>(async () => {})
  const surface = useMemo(() => HarnessSurfaceFromLocation(), [])
  const handoffSessionId = useMemo(() => HarnessHandoffSessionFromLocation(), [])
  const handoffTabId = useMemo(() => HarnessHandoffTabFromLocation(), [])
  const hasLocationHandoff = surface === 'sidepanel' && handoffSessionId !== undefined && handoffTabId !== undefined
  const [sidePanelHandoff, setSidePanelHandoff] = useState<{ ready: boolean; sessionId?: string; tabId?: number }>({ ready: surface === 'fullscreen-tab' || hasLocationHandoff, ...(handoffSessionId === undefined ? {} : { sessionId: handoffSessionId }), ...(handoffTabId === undefined ? {} : { tabId: handoffTabId }) })
  const activeHarnessSessionId = sidePanelHandoff.sessionId
  const frameNonce = useMemo(() => crypto.randomUUID(), [url])
  const frameSrc = useMemo(() => url === undefined ? undefined : HarnessFrameSource(url, { nonce: frameNonce, parentOrigin: window.location.origin, surface, ...(activeHarnessSessionId === undefined ? {} : { sessionId: activeHarnessSessionId }) }), [activeHarnessSessionId, frameNonce, surface, url])
  const frameOrigin = useMemo(() => frameSrc === undefined ? undefined : new URL(frameSrc).origin, [frameSrc])

  useEffect(() => { frameReadyRef.current = false }, [frameNonce])

  useEffect(() => {
    if (surface !== 'sidepanel') return
    if (hasLocationHandoff) return
    void currentBrowserWindowId().then((windowId) => {
      if (windowId === undefined) { setSidePanelHandoff({ ready: true }); return }
      void requestSidePanelHandoff(windowId).then((response) => setSidePanelHandoff({
        ready: true,
        ...(response.ok && isHarnessSessionIdentity(response.sessionId) ? { sessionId: response.sessionId } : {}),
        ...(response.ok && Number.isInteger(response.tabId) ? { tabId: response.tabId } : {}),
      }))
    })
  }, [hasLocationHandoff, surface])

  useEffect(() => { targetSettingsRef.current = targetSettings }, [targetSettings])
  useEffect(() => { availableTabsRef.current = availableTabs }, [availableTabs])

  const connect = useCallback(async () => {
    setStatus('starting'); setError(undefined)
    const response = await requestHarness()
    if (response.ok && response.url !== undefined) { setUrl(response.url); setStatus('ready'); return }
    setStatus('error'); setError(response.error ?? 'Unable to start the ACCRUI native server.')
  }, [])

  const loadTargetSettings = useCallback(async () => {
    const response = await requestTargetSettings({ type: 'get-browser-target-settings' })
    if (!response.ok || response.settings === undefined) { setTargetError(response.error ?? 'Unable to read Browser Target settings.'); return }
    setTargetSettings(response.settings); setAvailableTabs(response.tabs ?? []); setTargetError(undefined)
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
    void connect(); void loadTargetSettings(); void loadRecentPrototypes()
  }, [connect, loadRecentPrototypes, loadTargetSettings, sidePanelHandoff.ready])

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

  useEffect(() => {
    const accept = (epoch: unknown, sequence: unknown, tab: unknown): void => {
      if (typeof epoch !== 'string' || epoch.length === 0 || typeof sequence !== 'number' || !Number.isInteger(sequence) || !isActiveTab(tab)) return
      const targetTab = NormalizeActiveTabForBrowserTarget(tab)
      setActiveTab((previous) => previous !== undefined && previous.epoch === epoch && sequence <= previous.sequence ? previous : { epoch, sequence, tab: targetTab })
    }
    void requestActiveTab().then((response) => { if (response.ok) accept(response.epoch, response.sequence, response.tab) })
    const onMessage = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean | void => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: unknown; epoch?: unknown; sequence?: unknown; tab?: unknown; tabId?: unknown; current?: unknown; total?: unknown; url?: unknown; error?: unknown; requestId?: unknown; harnessSessionId?: unknown; harnessParentSessionId?: unknown; tool?: unknown; question?: unknown; phase?: unknown; chars?: unknown; content?: unknown; eventType?: unknown; process?: unknown; feedback?: unknown; review?: unknown; payload?: unknown }
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
      if (value.type === 'markdown-review-rehydrate-forward/v1') {
        const target = frameRef.current?.contentWindow
        if (!boundedString(value.requestId, 160) || !isMarkdownReviewIdentity(value.review) || frameOrigin === undefined || target === null || target === undefined) {
          sendResponse({ ok: false, error: 'The bound Harness Workspace is not available.' })
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
          sendResponse({ ok: false, error: 'The bound Harness Workspace is not available.' })
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
        reviewFeedbackRef.current.set(deliveryId, { sendResponse, timeout })
        target.postMessage({ type: 'markdown-review-feedback/v1', nonce: frameNonce, feedback: validation.feedback }, frameOrigin)
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
  }, [connect, frameNonce, frameOrigin])

  const projectBrowserTargetSnapshot = useCallback((capturingTabId: number | undefined) => {
    if (frameOrigin === undefined || !frameReadyRef.current) return
    const target = frameRef.current?.contentWindow
    if (target === null || target === undefined) return
    bridgeSequenceRef.current += 1
    target.postMessage({
      type: 'browser-target-snapshot/v1', nonce: frameNonce, sequence: bridgeSequenceRef.current,
      settings: targetSettings, tabs: availableTabs, activeTab: activeTab?.tab,
      ...(capturingTabId === undefined ? {} : { capturingDesignReferenceTabId: capturingTabId }), ...(capturingDesignReferenceProgress === undefined ? {} : { capturingDesignReferenceProgress }), error: targetError,
    }, frameOrigin)
  }, [activeTab, availableTabs, capturingDesignReferenceProgress, frameNonce, frameOrigin, targetError, targetSettings])

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

  const handleCompanyGatewayProbe = useCallback(async (requestId: string, apiKey: string, protocol: CompanyGatewayProtocol, requestedModelId?: string) => {
    const response = await requestCompanyGatewayProbe(requestId, apiKey, protocol, requestedModelId)
    if (frameOrigin === undefined || frameRef.current?.contentWindow === null || frameRef.current?.contentWindow === undefined) return
    gatewaySnapshotSequenceRef.current += 1
    frameRef.current.contentWindow.postMessage({
      type: 'company-gateway-probe-snapshot/v1', nonce: frameNonce, sequence: gatewaySnapshotSequenceRef.current,
      snapshot: response.ok && response.gateway !== undefined
        ? { requestId, status: 'ready', gateway: response.gateway }
        : { requestId, status: 'error', error: response.error ?? '公司网关探测失败。' },
    }, frameOrigin)
  }, [frameNonce, frameOrigin])

  const handleKnowledgeScopeCommand = useCallback(async (sessionId: string, scope: KnowledgeScope | undefined, options: KnowledgeScopeOptions) => {
    if (options.action === 'login') {
      if (knowledgeLoginTimerRef.current !== undefined) window.clearTimeout(knowledgeLoginTimerRef.current)
      knowledgeLoginSessionRef.current = sessionId
      knowledgeLoginAttemptsRef.current = 0
    }
    const response = await requestKnowledgeScope({ type: 'knowledge-scope/v1', sessionId, ...(scope === undefined ? {} : { scope }), ...options })
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
        void knowledgeCommandHandlerRef.current(sessionId, undefined, {})
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
    for (const pending of prototypePromptRef.current.values()) { window.clearTimeout(pending.timeout); pending.sendResponse({ ok: false, error: 'The Harness Side Panel closed before accepting the prototype request.' }) }
    prototypePromptRef.current.clear()
  }, [])

  // This listener must exist before the iframe can finish booting: its ready
  // signal is the recovery path when the first onLoad snapshot arrives early.
  useLayoutEffect(() => {
    const onFrameMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== frameOrigin || !event.data || typeof event.data !== 'object') return
      const value = event.data as { type?: unknown; nonce?: unknown; sequence?: unknown; command?: unknown; sessionId?: unknown; scope?: unknown; enabled?: unknown; remember?: unknown; action?: unknown; review?: unknown; requestId?: unknown; error?: unknown; deliveryId?: unknown; accepted?: unknown; apiKey?: unknown; protocol?: unknown; requestedModelId?: unknown }
      if (value.nonce !== frameNonce) return
      if (value.type === 'prototype-studio-prompt-accepted/v1' && boundedString(value.deliveryId, 160)) {
        const pending = prototypePromptRef.current.get(value.deliveryId)
        if (pending === undefined) return
        prototypePromptRef.current.delete(value.deliveryId); window.clearTimeout(pending.timeout)
        pending.sendResponse(value.accepted === true ? { ok: true } : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness rejected the prototype request.' })
        return
      }
      if (value.type === 'markdown-review-feedback-accepted/v1' && boundedString(value.deliveryId, 160)) {
        const pending = reviewFeedbackRef.current.get(value.deliveryId)
        if (pending === undefined) return
        reviewFeedbackRef.current.delete(value.deliveryId)
        window.clearTimeout(pending.timeout)
        pending.sendResponse(value.accepted === true
          ? { ok: true }
          : { ok: false, error: boundedString(value.error, 4_000) ? value.error : 'Harness rejected the Markdown annotation.' })
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
      if (value.type === 'harness-session-selected/v1' && isHarnessSessionIdentity(selectedSessionId)) { setSidePanelHandoff((previous) => ({ ...previous, sessionId: selectedSessionId })); return }
      if (value.type === 'session-handoff-applied/v1' && value.sessionId === activeHarnessSessionId && surface === 'sidepanel' && sidePanelHandoff.tabId !== undefined) {
        void currentBrowserWindowId().then((windowId) => {
          if (windowId !== undefined) chrome.runtime.sendMessage({ type: 'session-handoff-applied/v1', windowId, tabId: sidePanelHandoff.tabId, sessionId: value.sessionId })
        })
        return
      }
      if (value.type === 'browser-target-ready/v1') {
        frameReadyRef.current = true
        commandSequenceRef.current = 0
        sendBrowserTargetSnapshot()
        replaySearchProgress()
        return
      }
      if (value.type === 'account-access-ready/v1') { accountCommandSequenceRef.current = 0; void handleAccountAccessCommand('refresh'); return }
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
          || (value.protocol !== 'anthropic-messages' && value.protocol !== 'openai-completions')
          || (value.requestedModelId !== undefined && (typeof value.requestedModelId !== 'string' || value.requestedModelId.length === 0 || value.requestedModelId.length > 160))) return
        gatewayCommandSequenceRef.current = value.sequence
        void handleCompanyGatewayProbe(value.requestId, value.apiKey, value.protocol, value.requestedModelId as string | undefined)
        return
      }
      if (value.type === 'knowledge-scope-command/v1') {
        if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= knowledgeCommandSequenceRef.current || typeof value.sessionId !== 'string' || value.sessionId.length === 0 || (value.scope !== undefined && !isKnowledgeScope(value.scope))) return
        knowledgeCommandSequenceRef.current = value.sequence
        if ((value.enabled !== undefined && typeof value.enabled !== 'boolean') || (value.remember !== undefined && typeof value.remember !== 'boolean') || (value.action !== undefined && value.action !== 'login' && value.action !== 'retry')) return
        void handleKnowledgeScopeCommand(value.sessionId, value.scope, { ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}), ...(typeof value.remember === 'boolean' ? { remember: value.remember } : {}), ...((value.action === 'login' || value.action === 'retry') ? { action: value.action } : {}) })
        return
      }
      if (value.type !== 'browser-target-command/v1' || typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= commandSequenceRef.current || !isBrowserTargetCommand(value.command)) return
      commandSequenceRef.current = value.sequence
      void handleFrameCommand(value.command).then(sendBrowserTargetSnapshot)
    }
    window.addEventListener('message', onFrameMessage)
    return () => window.removeEventListener('message', onFrameMessage)
  }, [activeHarnessSessionId, connect, frameNonce, frameOrigin, handleAccountAccessCommand, handleCompanyGatewayProbe, handleFrameCommand, handleKnowledgeScopeCommand, loadRecentPrototypes, replaySearchProgress, sendBrowserTargetSnapshot, sidePanelHandoff.tabId, surface])

  return <main className="shell">
    {status === 'ready' && url !== undefined ? (
      <section className="harness-frame-shell">
        <iframe ref={frameRef} className="harness-frame" src={frameSrc} title="ACCRUI Web UI" allow="clipboard-read; clipboard-write" />
        {recentPrototypesOpen && <section className="recent-prototypes-popover" aria-label="最近原型">
            <header><div><b>最近原型</b><small>关闭原型页后，也能从这里继续。</small></div><div className="recent-prototypes-header-actions"><button type="button" className="recent-prototypes-refresh" aria-label="刷新最近原型" onClick={() => void loadRecentPrototypes()}>↻</button><button type="button" className="recent-prototypes-close" aria-label="关闭最近原型" onClick={() => setRecentPrototypesOpen(false)}>关闭</button></div></header>
            {recentPrototypeError !== undefined ? <p className="recent-prototypes-error">{recentPrototypeError}</p> : recentPrototypes.length === 0 ? <p className="recent-prototypes-empty">还没有保存过原型。先在对话中选择网页并提取设计规范。</p> : <ul>{recentPrototypes.map(project => <li key={project.projectId}><div className="recent-prototype-card">
              <button className="recent-prototype-open" type="button" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); setRecentPrototypeError(undefined); void openRecentPrototypeStudio(project.projectId).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法打开最近原型。'); else setRecentPrototypesOpen(false) }).finally(() => setOpeningRecentProjectId(undefined)) }}><span><b>{project.projectName ?? project.referenceTitle ?? '未命名原型'}</b><small>{project.revisionCount === undefined ? '历史项目' : project.revisionCount === 0 ? '尚未生成版本' : `共 ${project.revisionCount} 个版本`} · {new Date(project.updatedAt).toLocaleString()}</small></span><em>{openingRecentProjectId === project.projectId ? '处理中…' : '打开'}</em></button>
              {editingRecentProjectId === project.projectId ? <div className="recent-prototype-edit"><input aria-label="原型名称" maxLength={80} value={recentProjectNameDraft} onChange={event => setRecentProjectNameDraft(event.target.value)} autoFocus /><button type="button" disabled={recentProjectNameDraft.trim() === '' || openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); void manageRecentPrototypeStudio({ type: 'prototype-studio-rename/v1', projectId: project.projectId, projectName: recentProjectNameDraft.trim() }).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法重命名原型。'); else { setEditingRecentProjectId(undefined); void loadRecentPrototypes() } }).finally(() => setOpeningRecentProjectId(undefined)) }}>保存</button><button type="button" onClick={() => setEditingRecentProjectId(undefined)}>取消</button></div> : deletingRecentProjectId === project.projectId ? <div className="recent-prototype-delete-confirm"><span>确认永久删除这个原型和全部版本？</span><button type="button" className="danger" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); void manageRecentPrototypeStudio({ type: 'prototype-studio-delete/v1', projectId: project.projectId, confirmationProjectId: project.projectId }).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法删除原型。'); else { setDeletingRecentProjectId(undefined); void loadRecentPrototypes() } }).finally(() => setOpeningRecentProjectId(undefined)) }}>确认删除</button><button type="button" onClick={() => setDeletingRecentProjectId(undefined)}>取消</button></div> : <div className="recent-prototype-actions">{activeHarnessSessionId !== undefined && project.boundToCurrentSession === false && <button type="button" disabled={openingRecentProjectId === project.projectId} onClick={() => { setOpeningRecentProjectId(project.projectId); setRecentPrototypeError(undefined); void continueRecentPrototypeStudio(project.projectId, activeHarnessSessionId).then(response => { if (!response.ok) setRecentPrototypeError(response.error ?? '无法在当前对话继续。'); else setRecentPrototypesOpen(false) }).finally(() => setOpeningRecentProjectId(undefined)) }}>在当前对话继续</button>}<button type="button" onClick={() => { setEditingRecentProjectId(project.projectId); setRecentProjectNameDraft(project.projectName ?? project.referenceTitle ?? '未命名原型'); setDeletingRecentProjectId(undefined) }}>重命名</button><button type="button" onClick={() => { setDeletingRecentProjectId(project.projectId); setEditingRecentProjectId(undefined) }}>删除</button></div>}
            </div></li>)}</ul>}
            <footer>“在当前对话继续”会由你明确确认后，把项目交给现在打开的 AI 对话；历史版本不会丢失。</footer>
          </section>}
        {surface === 'fullscreen-tab' && <button
          className="fullscreen-collapse"
          type="button"
          aria-label="收起全屏"
          title="收起全屏"
          onClick={() => { void returnToSidePanel(activeHarnessSessionId).catch((error: unknown) => console.error('[deepseek-harness] Failed to return to the side panel:', error)) }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6" /></svg>
        </button>}
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
