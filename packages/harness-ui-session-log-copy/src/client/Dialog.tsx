import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CopySessionLogState } from './controller.ts'
import { NS } from './locales.ts'

export interface CopySessionLogDialogInjected {
  hooks: { copySessionLog: ObservableSnapshot<CopySessionLogState> }
  dismiss: (sessionId: SessionId) => void
}

export type CopySessionLogDialogProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<CopySessionLogDialogInjected>

export function CopySessionLogDialog({ sessionId, useCopySessionLog, dismiss, t }: CopySessionLogDialogProps) {
  const entry = useCopySessionLog(state => state.bySession[String(sessionId)])
  if (entry?.open !== true) return null
  const title = entry.status === 'copying' ? t('copyingTitle') : entry.status === 'copied' ? t('copiedTitle') : t('errorTitle')
  const description = entry.status === 'copying' ? t('copyingDescription') : entry.status === 'copied' ? t('copiedDescription') : entry.error ?? t('commandFailed')
  return <Modal open onClose={() => { dismiss(sessionId) }} title={title} description={description} closeLabel={t('close')}
    footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('close')}</Button>} />
}
