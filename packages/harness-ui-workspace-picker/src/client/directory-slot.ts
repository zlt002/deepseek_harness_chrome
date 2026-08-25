import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

export const WORKSPACE_PICKER_DIRECTORY_SLOT = 'accrui.workspace-picker.directory' as const

/** The compact picker owns selection; a child only receives its stable review target. */
export interface WorkspacePickerDirectoryOwner {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly sessionId: string | undefined
  readonly onClose: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'accrui.workspace-picker.directory': { kind: 'single'; scope: 'root'; owner: WorkspacePickerDirectoryOwner }
  }
}

export type CompactWorkspacePickerSlots = PropsRenderSlots<typeof WORKSPACE_PICKER_DIRECTORY_SLOT>
