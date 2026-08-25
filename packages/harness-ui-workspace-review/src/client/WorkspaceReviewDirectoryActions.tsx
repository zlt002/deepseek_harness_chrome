import { IconFolderOpenOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './WorkspaceReviewAction.module.css'

export interface WorkspaceReviewDirectoryActionsProps {
  readonly onOpenWorkspace: () => Promise<void>
  readonly onRefresh: () => void
}

/** Compact-picker actions live in its pane header; the tree owns no duplicate toolbar. */
export function WorkspaceReviewDirectoryActions({ onOpenWorkspace, onRefresh }: WorkspaceReviewDirectoryActionsProps) {
  return <span className={css.iconActions}>
    <Tooltip label="在资源管理器中打开工作区" side="bottom" delayMs={500}><button className={css.iconAction} type="button" aria-label="在资源管理器中打开工作区" title="在资源管理器中打开工作区" onClick={() => { void onOpenWorkspace() }}><IconFolderOpenOutline16 size={15} /></button></Tooltip>
    <Tooltip label="刷新文件树" side="bottom" delayMs={500}><button className={css.iconAction} type="button" aria-label="刷新文件树" title="刷新文件树" onClick={onRefresh}><IconRefreshOutline16 size={15} /></button></Tooltip>
  </span>
}
