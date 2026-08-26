import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { accountAccessBridgeConfig, createAccountAccessProtocol } from './protocol.js'
import type { AccountAccessCommand, AccountAccessSnapshot, CompanyGatewayProbeSnapshot, CompanyGatewayProtocol } from './types.ts'

export { accountAccessBridgeConfig }

export function createAccountAccessBridge(nonce: string, parentOrigin: string): {
  source: SnapshotStore<AccountAccessSnapshot | undefined>
  gatewayProbe: SnapshotStore<CompanyGatewayProbeSnapshot | undefined>
  accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean
  request(command: AccountAccessCommand, parent?: WindowProxy): void
  probeGateway(apiKey: string, protocol: CompanyGatewayProtocol, parent?: WindowProxy): string
} {
  const protocol = createAccountAccessProtocol({ createStore: createSnapshotStore, nonce, parentOrigin })
  return {
    source: protocol.source,
    gatewayProbe: protocol.gatewayProbe,
    accept: protocol.accept,
    request: (command, parent = window.parent) => { protocol.request(command, parent) },
    probeGateway: (apiKey, protocolName, parent = window.parent) => protocol.probeGateway(apiKey, protocolName, parent),
  }
}
