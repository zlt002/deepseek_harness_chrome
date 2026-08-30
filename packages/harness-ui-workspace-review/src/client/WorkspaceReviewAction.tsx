import { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconFolderOpenOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceHeaderActionOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceReviewBridgeConfig } from './bridge.ts'
import { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
import css from './WorkspaceReviewAction.module.css'

interface WorkspaceReviewHeaderActionProps extends WorkspaceHeaderActionOwnerProps {
  readonly bridge: WorkspaceReviewBridgeConfig | undefined
  readonly useSessionForWorkspace: (workspaceId: string | undefined) => string | undefined
  readonly openWorkspacePath: (path: string) => Promise<void>
}

/** Full-width workspace columns retain their official browser and add only a directory drawer. */
export function WorkspaceReviewHeaderAction({ workspace, bridge, useSessionForWorkspace, openWorkspacePath }: WorkspaceReviewHeaderActionProps) {
  const [open, setOpen] = useState(false)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const fullscreen = new URLSearchParams(window.location.search).get('dshBrowserTargetSurface') === 'fullscreen-tab'
  const sessionId = useSessionForWorkspace(workspace === undefined ? undefined : String(workspace.id))
  const label = workspace === undefined ? '请先创建工作区，再查看目录' : '查看工作区目录'
  return <>
    <Tooltip label={label} side="bottom" delayMs={500}>
      <span className={css.headerAction}>
        <button type="button" aria-label={label} disabled={workspace === undefined} onClick={() => { setOpen(true) }}>
          <IconFolderOpenOutline16 size={16} /><span>目录</span>
        </button>
      </span>
    </Tooltip>
    {open && createPortal(<aside className={`${css.drawer}${fullscreen ? ` ${css.fullscreenDrawer}` : ''}`} aria-label="工作区目录">
      <header className={css.header}><strong>{workspace?.title ?? '工作区目录'}</strong><span className={css.iconActions}>
        <Tooltip label="在资源管理器中打开工作区" side="bottom" delayMs={500}><button className={css.iconAction} type="button" aria-label="在资源管理器中打开工作区" title="在资源管理器中打开工作区" onClick={() => { if (workspace !== undefined) void openWorkspacePath(workspace.path) }}><IconFolderOpenOutline16 size={15} /></button></Tooltip>
        <Tooltip label="刷新文件树" side="bottom" delayMs={500}><button className={css.iconAction} type="button" aria-label="刷新文件树" title="刷新文件树" onClick={() => { setRefreshGeneration(value => value + 1) }}><IconRefreshOutline16 size={15} /></button></Tooltip>
      </span><button type="button" aria-label="关闭文件树" title="关闭文件树" onClick={() => { setOpen(false) }}>×</button></header>
      <WorkspaceReviewTree sessionId={sessionId} bridge={bridge} refreshGeneration={refreshGeneration} onClose={() => { setOpen(false) }} />
    </aside>, document.body)}
  </>
}

export function createWorkspaceReviewHeaderAction(
  bridge: WorkspaceReviewBridgeConfig | undefined,
  useSessionForWorkspace: (workspaceId: string | undefined) => string | undefined,
  openWorkspacePath: (path: string) => Promise<void>,
) {
  return function WorkspaceReviewHeaderActionEntry(owner: WorkspaceHeaderActionOwnerProps) {
    return <WorkspaceReviewHeaderAction {...owner} bridge={bridge} useSessionForWorkspace={useSessionForWorkspace} openWorkspacePath={openWorkspacePath} />
  }
}
