import { IconNewChatOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarCompactPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './ResponsiveSidebarPresentation.module.css'

/** Exact AccrUI compact header; all runtime state and child-seat rendering stay upstream. */
export function ResponsiveSidebarPresentation(owner: SidebarCompactPresentationOwnerProps) {
  if (owner.mode !== 'standard') {
    return (
      <header className={css.root} data-testid={`compact-${owner.mode}-header`}>
        <div className={css.detailTitle} title={owner.title}>{owner.title}</div>
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
