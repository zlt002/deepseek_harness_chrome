import { useState } from 'react'
import {
  IconDownloadOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceHeaderActionOwnerProps,
} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ClaudeImportModal, type ClaudeImportController } from './ClaudeImportModal.tsx'
import css from './CompactWorkspacePicker.module.css'

/** Shared import action used by both compact and column workspace surfaces. */
export function ClaudeImportAction({
  workspace, controller, variant = 'compact',
}: {
  workspace: WorkspaceHeaderActionOwnerProps['workspace']
  controller: ClaudeImportController | undefined
  variant?: 'compact' | 'header'
}) {
  const [open, setOpen] = useState(false)
  const unavailable = controller === undefined
    ? 'Claude Code 导入正在连接，请稍候'
    : workspace === undefined ? '请先创建工作区，再导入 Claude Code 记录' : '从 Claude Code 导入记录'
  const visibleLabel = controller === undefined
    ? 'Claude Code 正在连接'
    : workspace === undefined ? '创建工作区后导入' : '导入 Claude Code'
  const header = variant === 'header'
  return (
    <>
      <Tooltip label={unavailable} side="bottom" delayMs={500}>
        <span className={header ? css.importActionSlot : undefined}>
          <button
            type="button"
            className={header ? css.importWorkspace : css.addWorkspace}
            aria-label={unavailable}
            title={unavailable}
            disabled={controller === undefined || workspace === undefined}
            onClick={() => { setOpen(true) }}
          >
            <IconDownloadOutline16 size={16} />
            {header && <span>{visibleLabel}</span>}
          </button>
        </span>
      </Tooltip>
      <ClaudeImportModal open={open} onClose={() => setOpen(false)} workspace={workspace} controller={controller} />
    </>
  )
}

/** Binds the product controller explicitly because list-slot owners have no selected value. */
export function createWorkspaceHeaderClaudeImportAction(controller: ClaudeImportController) {
  return function WorkspaceHeaderClaudeImportAction(owner: WorkspaceHeaderActionOwnerProps) {
    return <ClaudeImportAction workspace={owner.workspace} controller={controller} variant="header" />
  }
}
