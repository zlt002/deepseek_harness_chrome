import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createKnowledgeScopeBridge, knowledgeScopeBridgeConfig } from './bridge.ts'
import { KnowledgeScopePanel, KnowledgeScopeStrip, type KnowledgeScopeInjected } from './KnowledgeScope.tsx'

export const inject = ['slots']

/** Mount through generic public composer slots; no upstream component is replaced. */
export function apply(ctx: ClientContext): void {
  const config = knowledgeScopeBridgeConfig()
  if (config === undefined) return
  const bridge = createKnowledgeScopeBridge(config.nonce, config.parentOrigin)
  const panel = createSnapshotStore<'code' | 'knowledge' | null>(null)
  const injected = (): KnowledgeScopeInjected => ({
    hooks: { knowledgeScope: bridge.source, knowledgeScopePanel: panel },
    request: (sessionId, scope, options) => bridge.request(sessionId, scope, options),
    setPanel: next => panel.set(next),
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-knowledge-scope: extension bridge')
  ctx.slots.inject('conversation.composer.above', () => ctx.slots.register({ name: 'conversation.composer.above', id: 'accrui-knowledge-scope-strip', order: 20, inject: injected }, KnowledgeScopeStrip))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'accrui-knowledge-scope-panel', order: 20, inject: injected }, KnowledgeScopePanel))
}

export { KnowledgeScopePanel, KnowledgeScopeStrip }
export type { KnowledgeScopeInjected } from './KnowledgeScope.tsx'
export type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './bridge.ts'
