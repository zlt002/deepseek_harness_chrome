import { useState } from 'react'
import { IconFolderOpenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceHeaderActionOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceReviewBridgeConfig } from './bridge.ts'
import { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
import css from './WorkspaceReviewAction.module.css'

interface WorkspaceReviewHeaderActionProps extends WorkspaceHeaderActionOwnerProps {
  readonly bridge: WorkspaceReviewBridgeConfig | undefined
  readonly useSessionForWorkspace: (workspaceId: string | undefined) => string | undefined
}

/** Full-width workspace columns retain their official browser and add only a directory drawer. */
export function WorkspaceReviewHeaderAction({ workspace, bridge, useSessionForWorkspace }: WorkspaceReviewHeaderActionProps) {
  const [open, setOpen] = useState(false)
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
    {open && <aside className={css.drawer} aria-label="工作区目录">
      <header className={css.header}><strong>{workspace?.title ?? '工作区目录'}</strong><button type="button" aria-label="关闭文件树" title="关闭文件树" onClick={() => { setOpen(false) }}>×</button></header>
      <WorkspaceReviewTree sessionId={sessionId} bridge={bridge} onClose={() => { setOpen(false) }} />
    </aside>}
  </>
}

export function createWorkspaceReviewHeaderAction(
  bridge: WorkspaceReviewBridgeConfig | undefined,
  useSessionForWorkspace: (workspaceId: string | undefined) => string | undefined,
) {
  return function WorkspaceReviewHeaderActionEntry(owner: WorkspaceHeaderActionOwnerProps) {
    return <WorkspaceReviewHeaderAction {...owner} bridge={bridge} useSessionForWorkspace={useSessionForWorkspace} />
  }
}
