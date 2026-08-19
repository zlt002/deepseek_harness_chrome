import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, HoverCard, IconChevronDownOutline14, IconEditOutline16, IconEllipsisOutline16,
  IconFolderClose16, IconFolderOpenOutline16, IconNewChatOutline16, IconPlusOutline16, IconTrashOutline16, Menu, Modal,
  StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CompactWorkspacePickerOwnerProps, CompactWorkspacePickerWorkspace,
} from '@deepseek-ai/dsh-client-ui-workspace/client'
import css from './CompactWorkspacePicker.module.css'

/** Avoid a runtime dependency for the small conditional class lists in this bundle. */
function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
}

function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function WorkspaceHoverContent({
  workspace, createdLabel,
}: {
  workspace: CompactWorkspacePickerWorkspace
  createdLabel: string
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{workspace.title}</div>
      <div className={css.hoverPath}>{workspace.path}</div>
      <div className={css.hoverTime}>{createdLabel}</div>
    </div>
  )
}

/** One workspace row: count by default, hover swaps in new-session + and the actions menu. */
function WorkspaceRow({
  workspace, selected, onSelect, owner, menuOpen, onMenuOpenChange, onRename, onDelete, onCreate,
}: {
  workspace: CompactWorkspacePickerWorkspace
  selected: boolean
  onSelect: () => void
  owner: CompactWorkspacePickerOwnerProps
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onRename: () => void
  onDelete: () => void
  onCreate: () => void
}) {
  return (
    <HoverCard
      disabled={menuOpen}
      copyText={workspace.path}
      copyLabel={owner.labels.copy}
      copiedLabel={owner.labels.copied}
      content={<WorkspaceHoverContent workspace={workspace} createdLabel={owner.createdLabel(workspace.createdAt)} />}
      anchor={(
        <div
          role="button"
          tabIndex={0}
          className={classes(css.row, selected && css.rowActive, menuOpen && css.rowMenuOpen)}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect()
            }
          }}
        >
          <IconFolderClose16 className={css.folder} size={15} />
          <span>{workspace.title}</span>
          <span className={css.count}>{workspace.sessionCount}</span>
          <span className={css.rowActions} onClick={event => { event.stopPropagation() }}>
            <Menu
              open={menuOpen}
              onClose={() => { onMenuOpenChange(false) }}
              items={[
                { id: 'open', label: owner.labels.openFolder, icon: <IconFolderOpenOutline16 /> },
                { id: 'rename', label: owner.labels.rename, icon: <IconEditOutline16 /> },
                { id: 'delete', label: owner.labels.deleteWorkspace, icon: <IconTrashOutline16 />, danger: true },
              ]}
              onSelect={(id) => {
                onMenuOpenChange(false)
                if (id === 'open') void owner.openPath(workspace.path)
                if (id === 'rename') onRename()
                if (id === 'delete') onDelete()
              }}
              portal
              closeOnPointerLeave
              side="right"
              anchor={(
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={owner.workspaceActionsAria(workspace.title)}
                  onClick={(event) => { event.stopPropagation(); onMenuOpenChange(!menuOpen) }}
                >
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
            <Tooltip label={owner.labels.newSession} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={owner.newSessionAria(workspace.title)}
                onClick={(event) => {
                  event.stopPropagation()
                  onCreate()
                }}
              >
                <IconPlusOutline16 />
              </button>
            </Tooltip>
          </span>
        </div>
      )}
    />
  )
}

/** The e327 compact header and two-column picker, rendered through the public owner contract. */
export function CompactWorkspacePicker(owner: CompactWorkspacePickerOwnerProps) {
  const [open, setOpen] = useState(false)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(owner.workspaces[0]?.id)
  const [menuWorkspaceId, setMenuWorkspaceId] = useState<string | undefined>()
  const [renameTarget, setRenameTarget] = useState<CompactWorkspacePickerWorkspace | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CompactWorkspacePickerWorkspace | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const composingRef = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const defaultWorkspace = useMemo(
    () => owner.workspaces.find(workspace => workspace.sessions.some(session => session.id === owner.currentSessionId))
      ?? owner.workspaces[0],
    [owner.currentSessionId, owner.workspaces],
  )
  const selectedWorkspace = owner.workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? defaultWorkspace
  const renameTrimmed = renameDraft.trim()
  const renameDuplicate = renameTarget !== null && renameTrimmed !== '' && renameTrimmed !== renameTarget.title
    && owner.workspaces.some(workspace => workspace.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameTrimmed === renameTarget.title || renameDuplicate

  useEffect(() => {
    if (!open) {
      setSelectedWorkspaceId(defaultWorkspace?.id)
      setMenuWorkspaceId(undefined)
    }
  }, [defaultWorkspace?.id, open])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target)) return
      if (menuWorkspaceId !== undefined) return
      if (renameTarget !== null || deleteTarget !== null) return
      if (event.target instanceof Element) {
        if (event.target.closest('[role="menu"], [role="dialog"], [aria-modal="true"]')) return
        const overlay = event.target.closest('[aria-label]')
        const label = overlay?.getAttribute('aria-label') ?? ''
        if (label.startsWith(`${owner.labels.copy}:`)) return
      }
      setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (renameTarget !== null || deleteTarget !== null || menuWorkspaceId !== undefined) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [deleteTarget, menuWorkspaceId, open, owner.labels.copy, renameTarget])
  useEffect(() => {
    if (deleteCommittedId === null || owner.workspaces.some(workspace => workspace.id === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    setDeleteTarget(null)
  }, [deleteCommittedId, owner.workspaces])

  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked || renameTarget === null) return
    setRenaming(true)
    setRenameError(null)
    owner.renameWorkspace(renameTarget.id, renameTrimmed).then(() => {
      setRenaming(false)
      setRenameTarget(null)
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(failureText(reason))
    })
  }
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
  }
  const confirmDelete = () => {
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    owner.deleteWorkspace(deleteTarget.id).then(() => {
      setDeleteCommittedId(deleteTarget.id)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(failureText(reason))
    })
  }

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
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                selected={workspace.id === selectedWorkspace?.id}
                onSelect={() => { setSelectedWorkspaceId(workspace.id) }}
                owner={owner}
                menuOpen={menuWorkspaceId === workspace.id}
                onMenuOpenChange={(next) => { setMenuWorkspaceId(next ? workspace.id : undefined) }}
                onRename={() => {
                  setRenameTarget(workspace)
                  setRenameDraft(workspace.title)
                  setRenameError(null)
                }}
                onDelete={() => {
                  setDeleteTarget(workspace)
                  setDeleteError(null)
                }}
                onCreate={() => {
                  owner.startSession(workspace.id)
                  setOpen(false)
                }}
              />
            ))}</div>
          </section>
          <section className={classes(css.pane, css.sessionsPane)}>
            <div className={css.paneHeader}>
              <div className={css.paneTitle}>{owner.labels.sessions}</div>
            </div>
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
      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        closeLabel={owner.labels.close}
        title={owner.labels.renameTitle}
        footer={(
          <>
            <Button variant="outline" disabled={renaming} onClick={closeRename}>{owner.labels.cancel}</Button>
            <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{owner.labels.rename}</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={renameDraft}
          aria-label={owner.labels.workspaceName}
          autoFocus
          disabled={renaming}
          onFocus={(event) => { event.target.select() }}
          onChange={(event) => { setRenameDraft(event.target.value); setRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composingRef.current) {
              event.preventDefault()
              confirmRename()
            }
          }}
        />
        {renameDuplicate && (
          <div className={css.renameError} role="alert">{owner.conflictNamed(renameTrimmed)}</div>
        )}
        {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
      </Modal>
      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        closeLabel={owner.labels.close}
        title={owner.labels.deleteWorkspace}
        {...deleteTarget === null ? {} : { description: owner.deleteDesc(deleteTarget.title) }}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={closeDelete}>{owner.labels.cancel}</Button>
            <Button variant="outline" className={css.deleteAction} disabled={deleting} onClick={confirmDelete}>
              {owner.labels.deleteWorkspace}
            </Button>
          </>
        )}
      >
        {deleting && <div className={css.deleteStatus} role="status">{owner.labels.deletePending}</div>}
        {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
      </Modal>
    </div>
  )
}
