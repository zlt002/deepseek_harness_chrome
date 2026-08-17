import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BrowserTargetControl, BrowserTargetPanel, type BrowserTargetInjected } from './BrowserTargetControl.tsx'
import { HarnessReconnectAction, type HarnessReconnectActionInjected } from './HarnessReconnectAction.tsx'
import { activeTabBridgeConfig, createBrowserTargetBridge } from './active-tab-bridge.ts'

export const inject = ['slots']

/** Mount the accepted e327 Browser Target UI through public slots. */
export function apply(ctx: ClientContext): void {
  const config = activeTabBridgeConfig()
  if (config === undefined) return
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
