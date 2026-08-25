import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Mirrors the product-owned compact-picker child contract without importing its implementation. */
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

export type WorkspacePickerDirectoryProps = PropsRuntime<'accrui.workspace-picker.directory'>
