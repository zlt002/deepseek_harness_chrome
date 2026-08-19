import { IconBranchOutline16, IconCopyOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsQuickAction } from '@deepseek-ai/dsh-client-ui-settings/client'
import { NS } from './locales.ts'
import css from './CompactSubagentHeaderActions.module.css'

export interface CompactSubagentHeaderActionsInjected {
  hooks: {
    quickActions: HostObservable<readonly SettingsQuickAction[]>
    view: HostObservable<string | null>
  }
}

export type CompactSubagentHeaderActionsProps =
  PropsRuntime<'sidebar.compact.subagent.action'>
  & InjectFace<CompactSubagentHeaderActionsInjected>
  & PropsLocale<typeof NS>

export function CompactSubagentHeaderActions({
  sessionId, useQuickActions, useView, t,
}: CompactSubagentHeaderActionsProps) {
  const actions = useQuickActions(value => value)
  const view = useView(value => value)
  const trajectory = actions.find(action => action.id === 'trajectory')
  const copyLog = actions.find(action => action.id === 'copy-session-log')

  return (
    <div className={css.root}>
      {view !== 'trajectory' && trajectory !== undefined && (
        <Tooltip label={t('compact.detail.trajectory')} delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={t('compact.detail.trajectory')}
            onClick={() => { void trajectory.run(sessionId) }}
          >
            <span data-testid="compact-detail-trajectory-icon">
              <IconBranchOutline16 size={17} />
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
    </div>
  )
}
