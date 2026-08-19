import { IconChevronLeftOutline14, IconNewChatOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsQuickAction } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarCompactPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS } from './locales.ts'
import css from './ResponsiveSidebarPresentation.module.css'

export interface ResponsiveSidebarPresentationInjected {
  hooks: {
    quickActions: HostObservable<readonly SettingsQuickAction[]>
    view: HostObservable<string | null>
  }
  close: (parentSessionId: SessionId) => void
}

export type ResponsiveSidebarPresentationProps =
  SidebarCompactPresentationOwnerProps
  & { matched: SidebarCompactPresentationOwnerProps }
  & InjectFace<ResponsiveSidebarPresentationInjected>
  & PropsLocale<typeof NS>

/** Exact AccrUI compact header; all runtime state and child-seat rendering stay upstream. */
export function ResponsiveSidebarPresentation({
  matched: owner, useQuickActions, useView, close, t,
}: ResponsiveSidebarPresentationProps) {
  const actions = useQuickActions(value => value)
  const view = useView(value => value)
  const conversation = actions.find(action => action.id === 'conversation')
  const returnToConversation = owner.mode === 'trajectory' || view === 'trajectory'
  const backLabel = returnToConversation ? t('detail.back.conversation') : t('detail.back.parent')
  const onBack = (): void => {
    if (returnToConversation) {
      if (owner.sessionId !== undefined && conversation !== undefined) void conversation.run(owner.sessionId)
      return
    }
    if (owner.parentSessionId !== undefined) close(owner.parentSessionId)
  }

  if (owner.mode !== 'standard') {
    return (
      <header className={css.root} data-testid={`compact-${owner.mode}-header`}>
        <div className={css.detailLead}>
          <Tooltip label={backLabel} delayMs={500}>
            <button
              type="button"
              className={css.back}
              aria-label={backLabel}
              data-testid="compact-detail-back"
              onClick={onBack}
            >
              <IconChevronLeftOutline14 size={16} />
            </button>
          </Tooltip>
          <div className={css.detailTitle} title={owner.title}>{owner.title}</div>
        </div>
        <div className={css.detailActions} data-compact-region={`${owner.mode}-actions`}>
          {owner.renderDetailActions()}
        </div>
      </header>
    )
  }

  return (
    <header className={css.root} data-testid="compact-header">
      <div className={css.primary} data-compact-region="primary">
        <div className={css.workspaces}>{owner.renderWorkspace()}</div>
        <Tooltip label={owner.t('session.new.label')} delayMs={500}>
          <button type="button" className={css.action} aria-label={owner.t('session.new.label')}
            onClick={() => { owner.startSession() }}>
            <IconNewChatOutline16 size={18} />
          </button>
        </Tooltip>
      </div>
      <div className={css.actions} data-compact-region="actions">{owner.renderActions()}</div>
      <div className={css.settings} data-compact-region="settings">{owner.renderSettings()}</div>
    </header>
  )
}
