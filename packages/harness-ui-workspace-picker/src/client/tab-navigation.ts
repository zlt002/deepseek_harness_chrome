export type WorkspacePickerPane = 'sessions' | 'directory'

/** Keyboard navigation for the two tabs, independent of DOM focus management. */
export function workspacePickerTabForKey(active: WorkspacePickerPane, key: string): WorkspacePickerPane | undefined {
  if (key === 'ArrowLeft' || key === 'Home') return 'sessions'
  if (key === 'ArrowRight' || key === 'End') return 'directory'
  return undefined
}
