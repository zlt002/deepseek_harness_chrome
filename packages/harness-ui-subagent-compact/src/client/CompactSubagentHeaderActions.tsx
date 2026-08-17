import {
  IconBranchOutline16, IconCloseOutline16, IconCopyOutline16, IconNewChatOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsQuickAction } from '@deepseek-ai/dsh-client-ui-settings/client'
import { NS } from './locales.ts'
import css from './CompactSubagentHeaderActions.module.css'

export interface CompactSubagentHeaderActionsInjected {
  hooks: {
    quickActions: HostObservable<readonly SettingsQuickAction[]>
    view: HostObservable<string | null>
  }
  close: (parentSessionId: SessionId) => void
}

export type CompactSubagentHeaderActionsProps =
  PropsRuntime<'sidebar.compact.subagent.action'>
  & InjectFace<CompactSubagentHeaderActionsInjected>
  & PropsLocale<typeof NS>

export function CompactSubagentHeaderActions({
  sessionId, parentSessionId, useQuickActions, useView, close, t,
}: CompactSubagentHeaderActionsProps) {
  const actions = useQuickActions(value => value)
  const view = useView(value => value)
  const trajectory = actions.find(action => action.id === 'trajectory')
  const conversation = actions.find(action => action.id === 'conversation')
  const copyLog = actions.find(action => action.id === 'copy-session-log')
  const viewAction = view === 'trajectory' ? conversation : trajectory
  const viewLabel = view === 'trajectory' ? t('compact.detail.conversation') : t('compact.detail.trajectory')
  const viewIcon = view === 'trajectory' ? 'conversation' : 'trajectory'

  return (
    <div className={css.root}>
      {viewAction !== undefined && (
        <Tooltip label={viewLabel} delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={viewLabel}
            onClick={() => { void viewAction.run(sessionId) }}
          >
            <span data-testid={`compact-detail-${viewIcon}-icon`}>
              {view === 'trajectory'
                ? <IconNewChatOutline16 size={17} />
                : <IconBranchOutline16 size={17} />}
            </span>
          </button>
        </Tooltip>
      )}
      {copyLog !== undefined && (
        <Tooltip label={t('compact.detail.copyLog')} delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={t('compact.detail.copyLog')}
            onClick={() => { void copyLog.run(sessionId) }}
          >
            <IconCopyOutline16 size={17} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={t('compact.detail.close')} delayMs={500}>
        <button
          type="button"
          className={css.action}
          aria-label={t('compact.detail.close')}
          onClick={() => { close(parentSessionId) }}
        >
          <IconCloseOutline16 size={17} />
        </button>
      </Tooltip>
    </div>
  )
}
