import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createKnowledgeScopeBridge, knowledgeScopeBridgeConfig } from './bridge.ts'
import { KnowledgeScopePanel, KnowledgeScopeStrip, type KnowledgeScopeInjected } from './KnowledgeScope.tsx'
import { RemoteSearchToolRow } from './RemoteSearchToolRow.tsx'
import { SelectedSourceScopeToolRow } from './SelectedSourceScopeToolRow.tsx'

export const inject = ['slots']

/** Mount through generic public composer slots; no upstream component is replaced. */
export function apply(ctx: ClientContext): void {
  const config = knowledgeScopeBridgeConfig()
  if (config === undefined) return
  const bridge = createKnowledgeScopeBridge(config.nonce, config.parentOrigin)
  const injected = (): KnowledgeScopeInjected => ({
    hooks: { knowledgeScope: bridge.source },
    request: (sessionId, scope, options) => bridge.request(sessionId, scope, options),
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-knowledge-scope: extension bridge')
  const progressInjected = () => ({ hooks: { searchProgress: bridge.progress } })
  ctx.slots.inject('conversation.composer.above', () => ctx.slots.register({ name: 'conversation.composer.above', id: 'accrui-knowledge-scope-strip', order: 20, inject: injected }, KnowledgeScopeStrip))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'accrui-knowledge-scope-panel', order: 20, inject: injected }, KnowledgeScopePanel))
  for (const key of ['search_selected_remote_code', 'mcp__chrome__code_search', 'search_selected_knowledge', 'mcp__chrome__knowledge_search']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: progressInjected }, RemoteSearchToolRow))
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'mcp__chrome__selected_source_scope' },
    SelectedSourceScopeToolRow,
  ))
}

export { KnowledgeScopePanel, KnowledgeScopeStrip }
export type { KnowledgeScopeInjected } from './KnowledgeScope.tsx'
export type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './bridge.ts'
