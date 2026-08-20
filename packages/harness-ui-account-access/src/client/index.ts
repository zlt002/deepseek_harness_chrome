import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AccountAccessSection, type AccountAccessInjected } from './AccountAccessSection.tsx'
import { accountAccessBridgeConfig, createAccountAccessBridge } from './bridge.ts'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const config = accountAccessBridgeConfig()
  if (config === undefined) return
  const bridge = createAccountAccessBridge(config.nonce, config.parentOrigin)
  const api = (ctx.get('connection') as ConnectionHandle).api
  const injected = (): AccountAccessInjected => ({
    hooks: { accountAccess: bridge.source, companyGatewayProbe: bridge.gatewayProbe },
    command: command => bridge.request(command),
    probeGateway: apiKey => bridge.probeGateway(apiKey),
    api,
  })
  ctx.effect(() => {
    const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'account-access-ready/v1', nonce: config.nonce }, config.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-account-access: extension bridge')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'accrui-account', order: 5, label: '个人中心', inject: injected,
  }, AccountAccessSection))
}

export { AccountAccessSection }
export type { AccountAccessCommand, AccountAccessSnapshot, AccountAccessStatus } from './types.ts'
