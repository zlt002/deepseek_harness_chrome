import { createSnapshotStore, type ClientContext, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserTargetControl, BrowserTargetPanel, type BrowserTargetInjected } from './BrowserTargetControl.tsx'
import { FullscreenReturnControl, type FullscreenReturnControlInjected } from './FullscreenReturnControl.tsx'
import { HarnessReconnectAction, type HarnessReconnectActionInjected } from './HarnessReconnectAction.tsx'
import { activeTabBridgeConfig, createBrowserTargetBridge } from './active-tab-bridge.ts'
import { restoreHandoffSession } from './session-handoff.ts'

export const inject = ['slots', 'sessions', 'settingsQuickActions']

/** Mount the accepted e327 Browser Target UI through public slots. */
export function apply(ctx: ClientContext): void {
  const config = activeTabBridgeConfig()
  const quickActions = ctx.get('settingsQuickActions')!
  const fullscreenTab = config?.surface === 'fullscreen-tab'
  const fullscreenTabSupported = new URLSearchParams(window.location.search).get('dshBrowserTargetFullscreenTabSupported') !== 'false'
  if (!fullscreenTab && config !== undefined && !fullscreenTabSupported) {
    ctx.effect(() => quickActions.register({
      id: 'fullscreen-unavailable',
      label: '全屏模式需 Chrome 141+（仍可使用侧边栏）',
      order: 5,
      requiresSession: false,
      run: () => window.alert('全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。'),
    }), 'accrui-browser-target: full-screen compatibility notice')
  } else {
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
  }
  if (config === undefined) return
  if (config.surface === 'sidepanel') {
    ctx.effect(() => quickActions.register({
      id: 'prototype-studio',
      label: '原型',
      order: 20,
      requiresSession: false,
      run: () => {
        window.parent.postMessage({ type: 'open-recent-prototypes/v1', nonce: config.nonce }, config.parentOrigin)
      },
    }), 'accrui-browser-target: open recent prototypes action')
  }
  ctx.effect(() => {
    const reportSelectedSession = (): void => {
      const sessionId = ctx.sessions.list.getSnapshot().current
      window.parent.postMessage({ type: 'harness-session-selected/v1', nonce: config.nonce, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, config.parentOrigin)
    }
    reportSelectedSession()
    return ctx.sessions.list.subscribe(reportSelectedSession)
  }, 'accrui-browser-target: report selected session')
  if (config.sessionId !== undefined) {
    ctx.effect(() => restoreHandoffSession({
      sessionId: config.sessionId! as SessionId,
      list: ctx.sessions.list,
      open: id => ctx.sessions.open(id),
      reportApplied: () => window.parent.postMessage({ type: 'session-handoff-applied/v1', nonce: config.nonce, sessionId: config.sessionId }, config.parentOrigin),
    }), 'accrui-browser-target: restore handed-off session')
  }
  const bridge = createBrowserTargetBridge(config.nonce, config.parentOrigin)
  const panel = createSnapshotStore(false)
  const injected = (): BrowserTargetInjected => ({
    hooks: { browserTarget: bridge.source, browserTargetPanel: panel },
    onBrowserTargetCommand: command => {
      if (command.command !== 'capture-design-reference' && command.command !== 'capture-responsive-design-reference' && command.command !== 'capture-design-references' && command.command !== 'html-workbench-select') { bridge.send(command, window.parent); return }
      const sessionId = ctx.sessions.list.getSnapshot().current
      bridge.send({ ...command, ...(sessionId === undefined ? {} : { sessionId: String(sessionId) }) }, window.parent)
    },
    onBrowserTargetPanelChange: open => panel.set(open),
  })
  const reconnectInjected = (): HarnessReconnectActionInjected => ({
    reconnectHarness: () => bridge.reconnectHarness(window.parent),
  })
  const fullscreenReturnInjected = (): FullscreenReturnControlInjected => ({
    returnToSidePanel: sessionId => {
      window.parent.postMessage({ type: 'return-to-sidepanel/v1', nonce: config.nonce, sessionId: String(sessionId) }, config.parentOrigin)
    },
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'browser-target-ready/v1', nonce: config.nonce }, config.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-browser-target: iframe bridge')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'browser-target-control', order: 10, inject: injected }, BrowserTargetControl))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'browser-target-panel', order: 10, inject: injected }, BrowserTargetPanel))
  if (fullscreenTab) ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'fullscreen-return', order: 0, inject: fullscreenReturnInjected,
  }, FullscreenReturnControl))
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({ name: 'sidebar.compact.action', id: 'harness-reconnect', order: 10, inject: reconnectInjected }, HarnessReconnectAction))
}

export { BrowserTargetControl, BrowserTargetPanel }
export { HarnessReconnectAction } from './HarnessReconnectAction.tsx'
export { FullscreenReturnControl } from './FullscreenReturnControl.tsx'
export type { BrowserTargetInjected } from './BrowserTargetControl.tsx'
export type { BrowserTarget, BrowserTargetCommand, BrowserTargetMode, BrowserTargetSettings, BrowserTargetSnapshot, BrowserTargetTab } from './active-tab-bridge.ts'
