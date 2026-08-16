import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createScopeProtocol, knowledgeScopeBridgeConfig } from './protocol.js'
import type { Scope, ScopeOptions, ScopeSnapshot } from './types.ts'

export type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './types.ts'
export { knowledgeScopeBridgeConfig }

export function createKnowledgeScopeBridge(nonce: string, parentOrigin: string): {
  source: SnapshotStore<ScopeSnapshot | undefined>
  accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean
  request(sessionId: string, scope?: Scope, options?: ScopeOptions, parent?: WindowProxy): void
} {
  const protocol = createScopeProtocol({ createStore: createSnapshotStore, nonce, parentOrigin })
  return { source: protocol.source, accept: protocol.accept, request: (sessionId, scope, options, parent = window.parent) => protocol.request(sessionId, scope, options, parent) }
}
