// WXT's generated development HTML bypasses Vite's transformIndexHtml hook.
// Initialise React Refresh from the client entry so HMR has its preamble.
import '@vitejs/plugin-react/preamble'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { HarnessFrameSource, HarnessHandoffSessionFromLocation, HarnessSurfaceFromLocation, NormalizeActiveTabForBrowserTarget } from './harness-frame'
import { openFullscreenTab as openFullscreenTabFromSidePanel, returnToSidePanel as returnToSidePanelFromFullscreen } from './fullscreen-handoff'
import './style.css'

type HarnessStatus = 'starting' | 'ready' | 'error'
type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

interface HarnessResponse { ok: boolean; url?: string; error?: string }
interface BrowserTarget { browser: 'chrome'; windowId: number; tabId: number; url: string }
interface BrowserTargetTab extends BrowserTarget { title: string; favIconUrl?: string }
interface BrowserTargetSettings { mode: BrowserTargetMode; pinnedTabs: BrowserTarget[]; primaryTabId?: number }
interface BrowserTargetSettingsResponse { ok: boolean; settings?: BrowserTargetSettings; tabs?: BrowserTargetTab[]; error?: string }
interface ActiveTab extends BrowserTargetTab {}
interface ActiveTabResponse { ok: boolean; epoch?: string; sequence?: number; tab?: ActiveTab; error?: string }
interface KnowledgeScope { domainId: string; systemIds: string[]; repositoryIds: string[] }
type KnowledgeServiceState = 'checking' | 'ready' | 'unauthenticated' | 'unavailable'
type KnowledgeScopeOptions = { enabled?: boolean; remember?: boolean; action?: 'login' | 'retry' }
interface KnowledgeScopeResponse { ok: boolean; scope?: KnowledgeScope; enabled?: boolean; remember?: boolean; serviceState?: KnowledgeServiceState; catalog?: unknown; error?: string }

type BrowserTargetCommand =
  | { command: 'refresh' }
  | { command: 'set-mode'; mode: BrowserTargetMode }
  | { command: 'toggle-pinned-tab'; tabId: number; checked: boolean }
  | { command: 'set-primary'; tabId: number }

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
  const command = value as { command?: unknown; mode?: unknown; tabId?: unknown; checked?: unknown }
  if (command.command === 'refresh') return true
  if (command.command === 'set-mode') return command.mode === 'follow-active-tab' || command.mode === 'pinned-tabs' || command.mode === 'none'
  if (command.command === 'toggle-pinned-tab') return Number.isInteger(command.tabId) && typeof command.checked === 'boolean'
  return command.command === 'set-primary' && Number.isInteger(command.tabId)
}

function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null
    && typeof (value as KnowledgeScope).domainId === 'string'
    && Array.isArray((value as KnowledgeScope).systemIds) && (value as KnowledgeScope).systemIds.every((item) => typeof item === 'string')
    && Array.isArray((value as KnowledgeScope).repositoryIds) && (value as KnowledgeScope).repositoryIds.every((item) => typeof item === 'string')
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

function consumeSidePanelHandoff(windowId: number): void {
  chrome.runtime.sendMessage({ type: 'consume-sidepanel-handoff/v1', windowId }, () => undefined)
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

/** The extension shell owns Chrome permissions; the iframe owns all target UI. */
function App(): React.JSX.Element {
  const [status, setStatus] = useState<HarnessStatus>('starting')
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [targetSettings, setTargetSettings] = useState<BrowserTargetSettings>({ mode: 'follow-active-tab', pinnedTabs: [] })
  const [availableTabs, setAvailableTabs] = useState<BrowserTargetTab[]>([])
  const [targetError, setTargetError] = useState<string>()
  const [activeTab, setActiveTab] = useState<{ epoch: string; sequence: number; tab: ActiveTab }>()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridgeSequenceRef = useRef(0)
  const targetSettingsRef = useRef(targetSettings)
  const availableTabsRef = useRef(availableTabs)
  const commandSequenceRef = useRef(0)
  const knowledgeCommandSequenceRef = useRef(0)
  const knowledgeSnapshotSequenceRef = useRef(0)
  const searchProgressSequenceRef = useRef(0)
  const knowledgeLoginSessionRef = useRef<string | undefined>(undefined)
  const knowledgeLoginAttemptsRef = useRef(0)
  const knowledgeLoginTimerRef = useRef<number | undefined>(undefined)
  const knowledgeCommandHandlerRef = useRef<(sessionId: string, scope: KnowledgeScope | undefined, options: KnowledgeScopeOptions) => Promise<void>>(async () => {})
  const surface = useMemo(() => HarnessSurfaceFromLocation(), [])
  const handoffSessionId = useMemo(() => HarnessHandoffSessionFromLocation(), [])
  const [activeHarnessSessionId, setActiveHarnessSessionId] = useState<string | undefined>(handoffSessionId)
  const frameNonce = useMemo(() => crypto.randomUUID(), [url])
  const frameSrc = useMemo(() => url === undefined ? undefined : HarnessFrameSource(url, { nonce: frameNonce, parentOrigin: window.location.origin, surface, ...(handoffSessionId === undefined ? {} : { sessionId: handoffSessionId }) }), [frameNonce, handoffSessionId, surface, url])
  const frameOrigin = useMemo(() => frameSrc === undefined ? undefined : new URL(frameSrc).origin, [frameSrc])

  useEffect(() => {
    if (surface !== 'sidepanel' || handoffSessionId === undefined) return
    void currentBrowserWindowId().then((windowId) => {
      if (windowId !== undefined) consumeSidePanelHandoff(windowId)
    })
  }, [handoffSessionId, surface])

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

  const saveTargetSettings = useCallback(async (settings: BrowserTargetSettings) => {
    const response = await requestTargetSettings({ type: 'save-browser-target-settings', settings })
    if (!response.ok || response.settings === undefined) { setTargetError(response.error ?? 'Unable to save Browser Target settings.'); return }
    setTargetSettings(response.settings); setTargetError(undefined)
  }, [])

  useEffect(() => { void connect(); void loadTargetSettings() }, [connect, loadTargetSettings])

  const replaySearchProgress = useCallback(() => {
    if (frameOrigin === undefined) return
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
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: unknown; epoch?: unknown; sequence?: unknown; tab?: unknown; url?: unknown; error?: unknown; requestId?: unknown; harnessSessionId?: unknown; harnessParentSessionId?: unknown; tool?: unknown; question?: unknown; phase?: unknown; chars?: unknown; content?: unknown; eventType?: unknown; process?: unknown }
      if (value.type === 'active-tab-changed/v1') accept(value.epoch, value.sequence, value.tab)
      if (value.type === 'harness-ready' && typeof value.url === 'string') { setUrl(value.url); setStatus('ready'); setError(undefined) }
      if (value.type === 'harness-disconnected') { void connect() }
      // Relay live selected-source search progress into the Harness iframe,
      // guarded by the same nonce as every other bridge message.
      if (value.type === 'search-progress/v1' && typeof value.requestId === 'string' && typeof value.harnessSessionId === 'string' && (value.harnessParentSessionId === undefined || typeof value.harnessParentSessionId === 'string') && (value.tool === 'code_search' || value.tool === 'knowledge_search') && typeof value.question === 'string' && (value.phase === 'querying' || value.phase === 'streaming' || value.phase === 'done' || value.phase === 'error') && typeof value.chars === 'number' && typeof value.content === 'string' && frameOrigin !== undefined && frameRef.current?.contentWindow !== null) {
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

  const sendBrowserTargetSnapshot = useCallback(() => {
    if (frameOrigin === undefined) return
    const target = frameRef.current?.contentWindow
    if (target === null || target === undefined) return
    bridgeSequenceRef.current += 1
    target.postMessage({
      type: 'browser-target-snapshot/v1', nonce: frameNonce, sequence: bridgeSequenceRef.current,
      settings: targetSettings, tabs: availableTabs, activeTab: activeTab?.tab, error: targetError,
    }, frameOrigin)
  }, [activeTab, availableTabs, frameNonce, frameOrigin, targetError, targetSettings])

  useEffect(() => { sendBrowserTargetSnapshot() }, [sendBrowserTargetSnapshot])

  const handleFrameCommand = useCallback(async (command: BrowserTargetCommand) => {
    if (command.command === 'refresh') { await loadTargetSettings(); return }
    const settings = targetSettingsRef.current
    if (command.command === 'set-mode') { await saveTargetSettings({ ...settings, mode: command.mode }); return }
    const tab = availableTabsRef.current.find((item) => item.tabId === command.tabId)
      ?? (command.command === 'toggle-pinned-tab' && !command.checked ? settings.pinnedTabs.find((item) => item.tabId === command.tabId) : undefined)
    if (tab === undefined) { setTargetError('The selected Chrome tab is no longer available.'); return }
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
  }, [loadTargetSettings, saveTargetSettings])

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
  }, [])

  // This listener must exist before the iframe can finish booting: its ready
  // signal is the recovery path when the first onLoad snapshot arrives early.
  useLayoutEffect(() => {
    const onFrameMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== frameOrigin || !event.data || typeof event.data !== 'object') return
      const value = event.data as { type?: unknown; nonce?: unknown; sequence?: unknown; command?: unknown; sessionId?: unknown; scope?: unknown; enabled?: unknown; remember?: unknown; action?: unknown }
      if (value.nonce !== frameNonce) return
      if (value.type === 'harness-reconnect/v1' && value.nonce === frameNonce) { void connect(); return }
      if (value.type === 'open-fullscreen-tab/v1' && value.nonce === frameNonce) {
        void openFullscreenTab(typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined).catch((error: unknown) => console.error('[deepseek-harness] Failed to open full-screen Tab:', error))
        return
      }
      if (value.type === 'return-to-sidepanel/v1' && value.nonce === frameNonce) {
        void returnToSidePanel(isHarnessSessionIdentity(value.sessionId) ? value.sessionId : activeHarnessSessionId).catch((error: unknown) => console.error('[deepseek-harness] Failed to return to the side panel:', error))
        return
      }
      if (value.type === 'harness-session-selected/v1' && isHarnessSessionIdentity(value.sessionId)) { setActiveHarnessSessionId(value.sessionId); return }
      if (value.type === 'browser-target-ready/v1') { commandSequenceRef.current = 0; sendBrowserTargetSnapshot(); return }
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
  }, [activeHarnessSessionId, connect, frameNonce, frameOrigin, handleFrameCommand, handleKnowledgeScopeCommand, sendBrowserTargetSnapshot])

  return <main className="shell">
    {status === 'ready' && url !== undefined ? (
      <section className="harness-frame-shell">
        <iframe ref={frameRef} className="harness-frame" src={frameSrc} title="ACCRUI Web UI" allow="clipboard-read; clipboard-write" onLoad={() => { sendBrowserTargetSnapshot(); replaySearchProgress() }} />
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
