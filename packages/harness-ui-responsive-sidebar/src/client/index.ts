import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  ResponsiveSidebarPresentation, type ResponsiveSidebarPresentationInjected,
} from './ResponsiveSidebarPresentation.tsx'
import { en, NS, zh, type ResponsiveSidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    productResponsiveSidebar: ResponsiveSidebarKey
  }
}

export const inject = ['slots', 'sessions', 'locale', 'settingsQuickActions', 'conversationViewState']

/** Fill the official responsive seam; session and workspace state stay with ui-sidebar. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'product-responsive-sidebar: dictionaries')
  const injectProps = (): ResponsiveSidebarPresentationInjected => ({
    hooks: {
      quickActions: ctx.get('settingsQuickActions')!.store,
      view: ctx.get('conversationViewState')!.currentSource(ctx.sessions.list),
    },
    close(parentSessionId: SessionId) {
      ctx.sessions.open(parentSessionId)
    },
  })
  ctx.slots.inject('sidebar.compact.presentation', () => ctx.slots.register({
    name: 'sidebar.compact.presentation',
    id: 'accrui-responsive-sidebar',
    order: 0,
    locale: NS,
    select: owner => owner,
    inject: injectProps,
  }, ResponsiveSidebarPresentation))
}

export { ResponsiveSidebarPresentation } from './ResponsiveSidebarPresentation.tsx'
