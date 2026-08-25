import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

export const WORKSPACE_PICKER_DIRECTORY_SLOT = 'accrui.workspace-picker.directory' as const
export const WORKSPACE_PICKER_DIRECTORY_ACTIONS_SLOT = 'accrui.workspace-picker.directory.actions' as const

/** The compact picker owns selection; a child only receives its stable review target. */
export interface WorkspacePickerDirectoryOwner {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
  readonly sessionId: string | undefined
  readonly refreshGeneration: number
  readonly onClose: () => void
}

export interface WorkspacePickerDirectoryActionsOwner {
  readonly workspacePath: string
  readonly refreshDirectory: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'accrui.workspace-picker.directory': { kind: 'single'; scope: 'root'; owner: WorkspacePickerDirectoryOwner }
    'accrui.workspace-picker.directory.actions': { kind: 'single'; scope: 'root'; owner: WorkspacePickerDirectoryActionsOwner }
  }
}

export type CompactWorkspacePickerSlots = PropsRenderSlots<typeof WORKSPACE_PICKER_DIRECTORY_SLOT | typeof WORKSPACE_PICKER_DIRECTORY_ACTIONS_SLOT>
