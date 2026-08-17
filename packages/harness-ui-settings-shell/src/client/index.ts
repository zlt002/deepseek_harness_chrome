import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsRoot } from './SettingsRoot.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.presentation', () => ctx.slots.register({
    name: 'settings.presentation',
    select: presentation => presentation,
    priority: -100,
  }, SettingsRoot))
}

export { SettingsRoot } from './SettingsRoot.tsx'
export type { SettingsPresentationOwnerProps, SettingsRootComponentProps } from './shell-contract.ts'
