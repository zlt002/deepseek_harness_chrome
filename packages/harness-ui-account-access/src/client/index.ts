import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { AccountAccessSection, type AccountAccessInjected } from './AccountAccessSection.tsx'
import { CompanyGatewayOnboarding, type CompanyGatewayOnboardingInjected } from './CompanyGatewayOnboarding.tsx'
import { accountAccessBridgeConfig, createAccountAccessBridge } from './bridge.ts'
import { selectCompanyGatewayInitialModel } from './company-gateway.ts'

export const inject = ['slots', 'connection', 'modelDirectories', 'sessions']

export function apply(ctx: ClientContext): void {
  const config = accountAccessBridgeConfig()
  if (config === undefined) return
  const bridge = createAccountAccessBridge(config.nonce, config.parentOrigin)
  const api = (ctx.get('connection') as ConnectionHandle).api
  const selectInitialModel: NonNullable<AccountAccessInjected['selectInitialModel']> = async models => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    const directory = sessionId === undefined ? undefined : ctx.modelDirectories.directoryFor(sessionId)
    return selectCompanyGatewayInitialModel(directory, models)
  }
  const injected = (): AccountAccessInjected => ({
    hooks: { accountAccess: bridge.source, companyGatewayProbe: bridge.gatewayProbe },
    command: command => bridge.request(command),
    probeGateway: apiKey => bridge.probeGateway(apiKey),
    selectInitialModel,
    api,
  })
  const onboardingInjected = (): CompanyGatewayOnboardingInjected => ({
    hooks: { companyGatewayProbe: bridge.gatewayProbe },
    api,
    probeGateway: apiKey => bridge.probeGateway(apiKey),
    selectInitialModel,
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
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'accrui-company-gateway', order: -10, inject: onboardingInjected,
  }, CompanyGatewayOnboarding))
}

export { AccountAccessSection }
export type { AccountAccessCommand, AccountAccessSnapshot, AccountAccessStatus } from './types.ts'
