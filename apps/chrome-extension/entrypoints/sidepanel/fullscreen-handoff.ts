export interface FullscreenHandoffResponse { ok: boolean; error?: string }

export const FULLSCREEN_TAB_UNSUPPORTED_MESSAGE = '全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。'

export interface FullscreenTabApi {
  runtime: {
    sendMessage?: (message: unknown) => Promise<FullscreenHandoffResponse | undefined>
  }
  sidePanel?: {
    close?: (options: { windowId: number }) => Promise<void>
    open?: (options: { windowId: number }) => Promise<void>
    setOptions?: (options: { path: string }) => Promise<void>
  }
}

function sidePanelHandoffPath(tabId: number, sessionId?: string): string {
  const query = new URLSearchParams({ dshHarnessHandoffTabId: String(tabId) })
  if (sessionId !== undefined && sessionId.trim() !== '') query.set('dshHarnessSessionId', sessionId)
  return `sidepanel.html?${query.toString()}`
}

/**
 * A side panel is not a safe place to close itself and then continue work: its
 * document can be torn down at the close await. Delegate the entire switch to
 * the background service worker, which survives the panel's lifecycle.
 */
export async function openFullscreenTab(
  chromeApi: FullscreenTabApi,
  windowId: number,
  sessionId?: string,
): Promise<void> {
  const sendMessage = chromeApi.runtime.sendMessage
  if (sendMessage === undefined || chromeApi.sidePanel?.close === undefined) throw new Error(FULLSCREEN_TAB_UNSUPPORTED_MESSAGE)
  const response = await sendMessage({ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId, ...(sessionId === undefined ? {} : { sessionId }) })
  if (response?.ok !== true) throw new Error(response?.error ?? 'Chrome could not switch the Harness Workspace to a Tab.')
}

/**
 * `sidePanel.open()` is guarded by Chrome user activation.  It therefore has
 * to be invoked directly from the full-screen Tab's click handler, before the
 * first await; the service worker only stores the handoff for the new panel.
 */
export async function returnToSidePanel(
  chromeApi: FullscreenTabApi,
  windowId: number,
  tabId: number,
  sessionId?: string,
): Promise<void> {
  const sendMessage = chromeApi.runtime.sendMessage
  const sidePanel = chromeApi.sidePanel
  if (sendMessage === undefined || sidePanel?.open === undefined || sidePanel.setOptions === undefined || sidePanel.close === undefined) {
    throw new Error('Chrome could not switch the Harness Workspace to the side panel.')
  }
  const preparation = sendMessage({ type: 'prepare-sidepanel-handoff/v1', windowId, tabId, ...(sessionId === undefined ? {} : { sessionId }) })

  // Issue all calls in this user-activation task. The handoff identity travels
  // in the controlled local panel path, so the new Side Panel never races the
  // service worker's pending-handoff map.
  const configure = sidePanel.setOptions({ path: sidePanelHandoffPath(tabId, sessionId) })
  const close = sidePanel.close({ windowId })
  const open = sidePanel.open({ windowId })

  const response = await preparation
  if (response?.ok !== true) throw new Error(response?.error ?? 'Chrome could not switch the Harness Workspace to the side panel.')
  await configure
  await close
  await open
}
