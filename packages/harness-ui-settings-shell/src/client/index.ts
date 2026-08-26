import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { SettingsRoot } from './SettingsRoot.tsx'
import { ReleaseUpdateSection } from './ReleaseUpdateSection.tsx'
import { createReleaseUpdateBridge } from './release-update-bridge.ts'
import { ReleaseUpdateToolbar, type ReleaseUpdateToolbarInjected } from './ReleaseUpdateToolbar.tsx'

export const inject = ['slots', 'settingsScope', 'theme']

export function apply(ctx: ClientContext): void {
  const themeSettings = ctx.settingsScope.bind({ namespace: 'ui-theme' })
  const applyDefaultTheme = (): void => {
    const snapshot = themeSettings.getSnapshot()
    if (snapshot.status === 'loading') return
    const user = snapshot.user
    const hasSavedPreference = user !== null && typeof user === 'object'
      && Object.prototype.hasOwnProperty.call(user, 'preference')
    if (!hasSavedPreference && ctx.theme.getTheme().preference === 'system') ctx.theme.setTheme('light')
  }
  applyDefaultTheme()
  ctx.effect(() => themeSettings.subscribe(applyDefaultTheme), 'settings-shell: light theme default')

  ctx.slots.inject('settings.presentation', () => ctx.slots.register({
    name: 'settings.presentation',
    select: presentation => presentation,
    priority: -100,
  }, SettingsRoot))
  if (!/Windows/i.test(navigator.userAgent)) return
  const query = new URLSearchParams(window.location.search)
  const nonce = query.get('dshBrowserTargetNonce'); const parentOrigin = query.get('dshBrowserTargetParentOrigin')
  if (nonce === null || parentOrigin === null) return
  const bridge = createReleaseUpdateBridge(nonce, parentOrigin)
  ctx.effect(() => { const receive = (event: MessageEvent): void => { bridge.accept(event, window.parent) }; window.addEventListener('message', receive); return () => window.removeEventListener('message', receive) }, 'release update bridge')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'accrui-release-update', order: 35, label: '在线更新', inject: () => ({ request: bridge.request }) }, ReleaseUpdateSection))
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({ name: 'sidebar.compact.action', id: 'release-update', order: 9, inject: (): ReleaseUpdateToolbarInjected => ({ request: bridge.request }) }, ReleaseUpdateToolbar))
}

export { SettingsRoot } from './SettingsRoot.tsx'
export type { SettingsPresentationOwnerProps, SettingsRootComponentProps } from './shell-contract.ts'
