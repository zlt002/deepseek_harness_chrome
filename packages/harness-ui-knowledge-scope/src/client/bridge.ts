import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createScopeProtocol, knowledgeScopeBridgeConfig } from './protocol.js'
import type { Scope, ScopeOptions, ScopeSnapshot } from './types.ts'

export type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './types.ts'
/** Live selected-source search progress relayed by the extension shell. */
export interface SearchProgress {
  requestId: string
  harnessSessionId: string
  harnessParentSessionId?: string
  tool: 'code_search' | 'knowledge_search'
  question: string
  phase: 'querying' | 'streaming' | 'done' | 'error'
  chars: number
  content: string
  eventType?: string
  process?: string
}
export { knowledgeScopeBridgeConfig }

export function createKnowledgeScopeBridge(nonce: string, parentOrigin: string): {
  source: SnapshotStore<ScopeSnapshot | undefined>
  progress: SnapshotStore<readonly SearchProgress[]>
  accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean
  request(sessionId: string, scope?: Scope, options?: ScopeOptions, parent?: WindowProxy): void
} {
  const protocol = createScopeProtocol({ createStore: createSnapshotStore, nonce, parentOrigin })
  return {
    source: protocol.source,
    progress: protocol.progress,
    accept: protocol.accept,
    request: (sessionId, scope, options, parent = window.parent) => protocol.request(sessionId, scope, options, parent),
  }
}
