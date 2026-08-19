import { IconCopyOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsQuickAction } from '@deepseek-ai/dsh-client-ui-settings/client'
import { NS } from './locales.ts'
import css from './CompactSubagentHeaderActions.module.css'

export interface CompactTrajectoryHeaderActionsInjected {
  hooks: {
    quickActions: HostObservable<readonly SettingsQuickAction[]>
    view: HostObservable<string | null>
  }
}

export type CompactTrajectoryHeaderActionsProps =
  PropsRuntime<'sidebar.compact.trajectory.action'>
  & InjectFace<CompactTrajectoryHeaderActionsInjected>
  & PropsLocale<typeof NS>

export function CompactTrajectoryHeaderActions({
  sessionId, useQuickActions, useView, t,
}: CompactTrajectoryHeaderActionsProps) {
  const actions = useQuickActions(value => value)
  const view = useView(value => value)
  const copyLog = actions.find(action => action.id === 'copy-session-log')

  if (view !== 'trajectory' || copyLog === undefined) return null
  return (
    <div className={css.root}>
      <Tooltip label={t('compact.trajectory.copyLog')} delayMs={500}>
        <button
          type="button"
          className={css.action}
          aria-label={t('compact.trajectory.copyLog')}
          onClick={() => { void copyLog.run(sessionId) }}
        >
          <IconCopyOutline16 size={17} />
        </button>
      </Tooltip>
    </div>
  )
}
