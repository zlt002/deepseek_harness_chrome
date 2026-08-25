import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Mirrors the product-owned compact-picker child contract without importing its implementation. */
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

export type WorkspacePickerDirectoryProps = PropsRuntime<'accrui.workspace-picker.directory'>
export type WorkspacePickerDirectoryActionsProps = PropsRuntime<'accrui.workspace-picker.directory.actions'>
