import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutline14, IconFolderClose16, IconNewChatOutline16, IconPlusOutline16, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompactWorkspacePickerOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import css from './CompactWorkspacePicker.module.css'

/** Avoid a runtime dependency for the small conditional class lists in this bundle. */
function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
}

/** The e327 compact header and two-column picker, rendered through the public owner contract. */
export function CompactWorkspacePicker(owner: CompactWorkspacePickerOwnerProps) {
  const [open, setOpen] = useState(false)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(owner.workspaces[0]?.id)
  const root = useRef<HTMLDivElement>(null)
  const defaultWorkspace = useMemo(
    () => owner.workspaces.find(workspace => workspace.sessions.some(session => session.id === owner.currentSessionId))
      ?? owner.workspaces[0],
    [owner.currentSessionId, owner.workspaces],
  )
  const selectedWorkspace = owner.workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? defaultWorkspace

  useEffect(() => {
    if (!open) setSelectedWorkspaceId(defaultWorkspace?.id)
  }, [defaultWorkspace?.id, open])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  return (
    <div ref={root} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => { setSelectedWorkspaceId(defaultWorkspace?.id); setOpen(value => !value) }}
      >
        <span className={css.titles}>
          <span className={css.workspaceTitle}>{owner.workspaceTitle}</span>
          <span className={css.sessionTitle}>{owner.sessionTitle}</span>
        </span>
        <IconChevronDownOutline14 className={classes(css.chevron, open && css.chevronOpen)} />
      </button>
      {open && (
        <div className={css.popover}>
          <section className={css.pane}>
            <div className={css.paneHeader}>
              <div className={css.paneTitle}>{owner.labels.workspaces}</div>
              {owner.directoryFlowAvailable && (
                <Tooltip label={owner.labels.addWorkspace} side="bottom" delayMs={500}>
                  <button
                    ref={owner.workspaceAddAnchor}
                    type="button"
                    className={css.addWorkspace}
                    aria-label={owner.labels.addWorkspace}
                    onClick={() => { owner.requestWorkspaceAdd(() => { setOpen(false) }) }}
                  ><IconPlusOutline16 size={16} /></button>
                </Tooltip>
              )}
            </div>
            <div className={css.list}>{owner.workspaces.map(workspace => (
              <button key={workspace.id} type="button" className={classes(css.row, workspace.id === selectedWorkspace?.id && css.rowActive)} onClick={() => { setSelectedWorkspaceId(workspace.id) }}>
                <IconFolderClose16 className={css.folder} size={15} /><span>{workspace.title}</span><span className={css.count}>{workspace.sessionCount}</span>
              </button>
            ))}</div>
          </section>
          <section className={classes(css.pane, css.sessionsPane)}>
            <div className={css.paneTitle}>{owner.labels.sessions}</div>
            <div className={css.list}>{selectedWorkspace?.sessions.map(session => (
              <button key={session.id} type="button" className={classes(css.row, session.id === owner.currentSessionId && css.rowActive)} onClick={() => { owner.openSession(session.id); setOpen(false) }}>
                <IconNewChatOutline16 className={css.sessionGlyph} size={14} /><span className={css.sessionRowTitle}>{session.title}</span>
                <span className={css.sessionState}><StateDot state={session.state} /></span><span className={css.sessionTime}>{session.time}</span>
              </button>
            ))}{(selectedWorkspace?.sessions.length ?? 0) === 0 && <div className={css.empty}>{owner.labels.newSession}</div>}</div>
          </section>
        </div>
      )}
      {owner.directoryFlow}
    </div>
  )
}
