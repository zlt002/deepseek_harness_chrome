import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CopySessionLogDialog, type CopySessionLogDialogInjected } from './Dialog.tsx'
import { CopySessionLogController } from './controller.ts'
import { en, NS, zh, type CopySessionLogKey } from './locales.ts'

/** Public surface supplied by the official Session-log export client plugin. */
interface SessionLogDownload {
  download(sessionId: SessionId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionLogDownload: SessionLogDownload
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { productSessionLogCopy: CopySessionLogKey }
}

export const inject = ['slots', 'locale', 'settingsQuickActions', 'sessionLogDownload']

export function apply(ctx: ClientContext): void {
  const controller = new CopySessionLogController()
  const sessionLogDownload = ctx.get('sessionLogDownload')!
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'product-session-log-copy: dictionaries')
  ctx.effect(() => ctx.get('settingsQuickActions')!.register({
    id: 'copy-session-log', label: '复制日志', order: 20,
    run: (sessionId: SessionId) => controller.copy(sessionId),
  }), 'product-session-log-copy: quick action')
  ctx.effect(() => ctx.get('settingsQuickActions')!.register({
    id: 'download-session-log', label: '下载 Session log', order: 30,
    run: (sessionId: SessionId) => sessionLogDownload.download(sessionId),
  }), 'product-session-log-copy: download quick action')
  ctx.effect(() => async () => { await controller.dispose() }, 'product-session-log-copy: lifecycle')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'accrui-copy-session-log', order: 10, locale: NS,
    inject: (): CopySessionLogDialogInjected => ({ hooks: { copySessionLog: controller.store }, dismiss: (sessionId) => { controller.dismiss(sessionId) } }),
  }, CopySessionLogDialog))
}

export { CopySessionLogController } from './controller.ts'
export { CopySessionLogDialog } from './Dialog.tsx'
