import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'
import type { ClaudeImportController } from './ClaudeImportModal.tsx'
import { claudeImportRequest, type NativeImportResult, type PreparedImport } from './claude-import-api.ts'
import { openImportedSession } from './open-imported-session.mjs'
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
      if (prepared.kind === 'conflict') return 'conflict'
      if (prepared.kind === 'existing') {
        const existing = prepared.sessionId as SessionId
        return await openImportedSession(ctx.sessions, existing) ? 'opened-existing' : 'existing-unavailable'
      }
      if (input.signal?.aborted === true) throw new DOMException('Claude Code 导入已取消', 'AbortError')
      input.onCreating()
      const imported = await claudeImportRequest<NativeImportResult>({
        action: 'import', projectKey: input.projectKey, sessionId: input.session.sessionId,
        sourceRoot: input.sourceRoot, workspacePath: input.workspacePath, forceCopy: input.forceCopy === true,
      })
      if (imported.kind === 'conflict') return 'conflict'
      if (imported.kind === 'existing') {
        const existing = imported.sessionId as SessionId
        return await openImportedSession(ctx.sessions, existing) ? 'opened-existing' : 'existing-unavailable'
      }
      const sessionId = imported.sessionId as SessionId
      if (!await openImportedSession(ctx.sessions, sessionId)) throw new Error('会话已写入，但刷新后仍未出现在 Harness 会话列表中。')
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
      'accrui.workspace-picker.directory.actions': { kind: 'single', scope: 'root' },
    },
  }, CompactWorkspacePicker))
  ctx.slots.inject('sidebar.workspaces.header.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.header.action',
    id: 'accrui-claude-code-import',
    order: 0,
  }, createWorkspaceHeaderClaudeImportAction(claudeImport)))
}

export { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'
export { WORKSPACE_PICKER_DIRECTORY_SLOT, WORKSPACE_PICKER_DIRECTORY_ACTIONS_SLOT, type WorkspacePickerDirectoryOwner, type WorkspacePickerDirectoryActionsOwner } from './directory-slot.ts'
export { selectWorkspaceDirectorySession } from './directory-selection.ts'
export { workspacePickerMaxHeight } from './popover-geometry.ts'
export { workspacePickerTabForKey } from './tab-navigation.ts'
