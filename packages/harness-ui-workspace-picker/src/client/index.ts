import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'
import type { ClaudeImportController } from './ClaudeImportModal.tsx'
import { claudeImportRequest, type PreparedImport } from './claude-import-api.ts'
import { createWorkspaceHeaderClaudeImportAction } from './WorkspaceSurfaceActions.tsx'

export const inject = ['slots', 'sessions', 'workspaces']

/** Fill the workspace owner's compact seat without taking over directory adoption. */
export function apply(ctx: ClientContext): void {
  const claudeImport: ClaudeImportController = {
    async importSession(input) {
      const prepared = await claudeImportRequest<PreparedImport>({
        action: 'prepare', projectKey: input.projectKey, sessionId: input.session.sessionId,
        sourceRoot: input.sourceRoot, workspacePath: input.workspacePath, forceCopy: input.forceCopy === true,
      }, input.signal)
      if (prepared.kind === 'existing') {
        const existing = prepared.sessionId as SessionId
        if (ctx.sessions.list.getSnapshot().byId[existing] === undefined) return 'existing-unavailable'
        ctx.sessions.open(existing)
        return 'opened-existing'
      }
      if (input.signal?.aborted === true) throw new DOMException('Claude Code 导入已取消', 'AbortError')
      input.onCreating()
      const sessionId = await ctx.workspaces.connectWorkspace(input.workspaceId as WorkspaceId)
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error('新会话创建成功，但客户端尚未能访问它')
      const admitted = await session.prompt([{ type: 'text', text: prepared.prompt }], 'queue')
      if (!admitted.ok) throw new Error(`迁移上下文发送失败：${admitted.error.message}`)
      await claudeImportRequest({ action: 'commit', sourceRoot: input.sourceRoot, sourceKey: prepared.sourceKey, sessionId })
      ctx.sessions.open(sessionId)
      const renamed = await session.rename(prepared.title)
      if (!renamed.ok) throw new Error(`会话已导入，但标题更新失败：${renamed.error.message}`)
      return 'imported'
    },
  }
  ctx.slots.inject('sidebar.workspaces.compact', () => ctx.slots.register({
    name: 'sidebar.workspaces.compact',
    id: 'accrui-workspace-picker',
    order: 0,
    select: _owner => claudeImport,
    children: {
      'accrui.workspace-picker.directory': { kind: 'single', scope: 'root' },
    },
  }, CompactWorkspacePicker))
  ctx.slots.inject('sidebar.workspaces.header.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.header.action',
    id: 'accrui-claude-code-import',
    order: 0,
  }, createWorkspaceHeaderClaudeImportAction(claudeImport)))
}

export { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'
export { WORKSPACE_PICKER_DIRECTORY_SLOT, type WorkspacePickerDirectoryOwner } from './directory-slot.ts'
export { selectWorkspaceDirectorySession } from './directory-selection.ts'
export { workspacePickerMaxHeight } from './popover-geometry.ts'
export { workspacePickerTabForKey } from './tab-navigation.ts'
