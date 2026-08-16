import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BrowserTargetControl, BrowserTargetPanel, HarnessReconnectAction, type BrowserTargetInjected } from './BrowserTargetControl.tsx'
import { browserTargetBridgeConfig, createBrowserTargetBridge, requestHarnessReconnect } from './bridge.ts'

export const inject = ['slots']

/** Mount only against clean upstream public composer slots. */
export function apply(ctx: ClientContext): void {
  const config = browserTargetBridgeConfig()
  if (config === undefined) return
  const bridge = createBrowserTargetBridge(config.nonce, config.parentOrigin)
  const panel = createSnapshotStore(false)
  const injected = (): BrowserTargetInjected => ({
    hooks: { browserTarget: bridge.source, browserTargetPanel: panel },
    send: command => bridge.send(command, window.parent),
    setPanelOpen: open => panel.set(open),
    reconnect: () => requestHarnessReconnect(window.parent, config.nonce, config.parentOrigin),
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'browser-target-ready/v1', nonce: config.nonce }, config.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-browser-target: extension bridge')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'accrui-browser-target-control', order: 10, inject: injected }, BrowserTargetControl))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'accrui-browser-target-panel', order: 10, inject: injected }, BrowserTargetPanel))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'accrui-harness-reconnect', order: 10, inject: injected }, HarnessReconnectAction))
}

export { BrowserTargetControl, BrowserTargetPanel, HarnessReconnectAction }
export type { BrowserTargetInjected } from './BrowserTargetControl.tsx'
export type { BrowserTarget, BrowserTargetCommand, BrowserTargetMode, BrowserTargetSettings, BrowserTargetSnapshot, BrowserTargetTab } from './bridge.ts'
