import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { browserTargetBridgeConfig, createBrowserTargetProtocol, requestHarnessReconnect } from './protocol.js'
import type { BrowserTargetCommand, BrowserTargetSnapshot } from './types.ts'

export type { BrowserTarget, BrowserTargetCommand, BrowserTargetMode, BrowserTargetSettings, BrowserTargetSnapshot, BrowserTargetTab } from './types.ts'
export { browserTargetBridgeConfig }
export { requestHarnessReconnect }

export function createBrowserTargetBridge(nonce: string, parentOrigin: string): {
  source: SnapshotStore<BrowserTargetSnapshot | undefined>
  accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean
  send(command: BrowserTargetCommand, parent: WindowProxy): void
} {
  return createBrowserTargetProtocol({ createStore: createSnapshotStore, nonce, parentOrigin })
}
