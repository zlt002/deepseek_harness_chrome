import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CopySessionLogDialog, type CopySessionLogDialogInjected } from './Dialog.tsx'
import { CopySessionLogController } from './controller.ts'
import { en, NS, zh, type CopySessionLogKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { productSessionLogCopy: CopySessionLogKey }
}

export const inject = ['slots', 'locale', 'settingsQuickActions']

export function apply(ctx: ClientContext): void {
  const controller = new CopySessionLogController()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'product-session-log-copy: dictionaries')
  ctx.effect(() => ctx.get('settingsQuickActions')!.register({
    id: 'copy-session-log', label: '复制日志', order: 20,
    run: (sessionId: SessionId) => controller.copy(sessionId),
  }), 'product-session-log-copy: quick action')
  ctx.effect(() => async () => { await controller.dispose() }, 'product-session-log-copy: lifecycle')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'accrui-copy-session-log', order: 10, locale: NS,
    inject: (): CopySessionLogDialogInjected => ({ hooks: { copySessionLog: controller.store }, dismiss: (sessionId) => { controller.dismiss(sessionId) } }),
  }, CopySessionLogDialog))
}

export { CopySessionLogController } from './controller.ts'
export { CopySessionLogDialog } from './Dialog.tsx'
