import { createSnapshotStore, type ClientContext, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserTargetControl, BrowserTargetPanel, type BrowserTargetInjected } from './BrowserTargetControl.tsx'
import { HarnessReconnectAction, type HarnessReconnectActionInjected } from './HarnessReconnectAction.tsx'
import { activeTabBridgeConfig, createBrowserTargetBridge } from './active-tab-bridge.ts'

export const inject = ['slots', 'sessions', 'settingsQuickActions']

/** Mount the accepted e327 Browser Target UI through public slots. */
export function apply(ctx: ClientContext): void {
  const config = activeTabBridgeConfig()
  const quickActions = ctx.get('settingsQuickActions')!
  const fullscreenTab = config?.surface === 'fullscreen-tab'
  ctx.effect(() => quickActions.register({
    id: fullscreenTab ? 'close-fullscreen' : 'open-fullscreen',
    label: fullscreenTab ? '关闭全屏' : '全屏',
    order: 5,
    requiresSession: false,
    run: (sessionId?: SessionId) => {
      if (config !== undefined) {
        window.parent.postMessage({ type: fullscreenTab ? 'return-to-sidepanel/v1' : 'open-fullscreen-tab/v1', nonce: config.nonce, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, config.parentOrigin)
      } else {
        window.open(window.location.href, '_blank')
      }
    },
  }), 'accrui-browser-target: open-fullscreen action')
  if (config === undefined) return
  if (fullscreenTab) {
    ctx.effect(() => {
      const reportSelectedSession = (): void => {
        const sessionId = ctx.sessions.list.getSnapshot().current
        window.parent.postMessage({ type: 'harness-session-selected/v1', nonce: config.nonce, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, config.parentOrigin)
      }
      reportSelectedSession()
      return ctx.sessions.list.subscribe(reportSelectedSession)
    }, 'accrui-browser-target: report full-screen session')
  }
  if (config.sessionId !== undefined) {
    ctx.effect(() => {
      const select = (): boolean => {
        if (ctx.sessions.list.getSnapshot().byId[config.sessionId!] === undefined) return false
        ctx.sessions.open(config.sessionId! as SessionId)
        if (ctx.sessions.list.getSnapshot().current !== config.sessionId) return false
        window.parent.postMessage({ type: 'session-handoff-applied/v1', nonce: config.nonce, sessionId: config.sessionId }, config.parentOrigin)
        return true
      }
      if (select()) return
      const stop = ctx.sessions.list.subscribe(() => { if (select()) stop() })
      return stop
    }, 'accrui-browser-target: restore handed-off session')
  }
  const bridge = createBrowserTargetBridge(config.nonce, config.parentOrigin)
  const panel = createSnapshotStore(false)
  const injected = (): BrowserTargetInjected => ({
    hooks: { browserTarget: bridge.source, browserTargetPanel: panel },
    onBrowserTargetCommand: command => bridge.send(command, window.parent),
    onBrowserTargetPanelChange: open => panel.set(open),
  })
  const reconnectInjected = (): HarnessReconnectActionInjected => ({
    reconnectHarness: () => bridge.reconnectHarness(window.parent),
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'browser-target-ready/v1', nonce: config.nonce }, config.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-browser-target: iframe bridge')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'browser-target-control', order: 10, inject: injected }, BrowserTargetControl))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'browser-target-panel', order: 10, inject: injected }, BrowserTargetPanel))
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({ name: 'sidebar.compact.action', id: 'harness-reconnect', order: 10, inject: reconnectInjected }, HarnessReconnectAction))
}

export { BrowserTargetControl, BrowserTargetPanel }
export { HarnessReconnectAction } from './HarnessReconnectAction.tsx'
export type { BrowserTargetInjected } from './BrowserTargetControl.tsx'
export type { BrowserTarget, BrowserTargetCommand, BrowserTargetMode, BrowserTargetSettings, BrowserTargetSnapshot, BrowserTargetTab } from './active-tab-bridge.ts'
