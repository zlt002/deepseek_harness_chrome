export interface FullscreenHandoffResponse { ok: boolean; error?: string }

export interface FullscreenTabApi {
  runtime: {
    sendMessage?: (message: unknown) => Promise<FullscreenHandoffResponse | undefined>
  }
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
  if (chromeApi.runtime.sendMessage === undefined) {
    throw new Error('Chrome could not switch the Harness Workspace to a Tab.')
  }
  const response = await chromeApi.runtime.sendMessage({ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId, ...(sessionId === undefined ? {} : { sessionId }) })
  if (response?.ok !== true) throw new Error(response?.error ?? 'Chrome could not switch the Harness Workspace to a Tab.')
}

/**
 * The full-screen Tab must not remove itself: the background first replaces
 * any existing Side Panel instance and opens the session handoff there.
 */
export async function returnToSidePanel(
  chromeApi: FullscreenTabApi,
  windowId: number,
  tabId: number,
  sessionId?: string,
): Promise<void> {
  if (chromeApi.runtime.sendMessage === undefined) {
    throw new Error('Chrome could not switch the Harness Workspace to the side panel.')
  }
  const response = await chromeApi.runtime.sendMessage({ type: 'switch-harness-surface/v1', surface: 'sidepanel', windowId, tabId, ...(sessionId === undefined ? {} : { sessionId }) })
  if (response?.ok !== true) throw new Error(response?.error ?? 'Chrome could not switch the Harness Workspace to the side panel.')
}
