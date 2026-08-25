/** Keep the picker inside the visible viewport while preserving its natural content height. */
export function workspacePickerMaxHeight(triggerBottom: number, viewportHeight: number, bottomInset = 12): number {
  return Math.max(0, Math.floor(viewportHeight - triggerBottom - bottomInset))
}
