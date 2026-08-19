/** Keep a small gap under the workspace/session bar so the chooser never kisses it. */
export const SCOPE_PANEL_GAP_PX = 8
/** Short viewports still need a usable list; the composer can cover the rest. */
export const SCOPE_PANEL_MIN_HEIGHT_PX = 160

/**
 * Ceiling for a bottom-anchored scope chooser: just below the compact
 * workspace/session bar, otherwise the product conversation column top.
 * @param {number | undefined} headerBottom
 * @param {number | undefined} presentationTop
 * @param {number} [viewportFallback]
 * @returns {number}
 */
export function scopePanelCeiling(headerBottom, presentationTop, viewportFallback = 0) {
  if (typeof headerBottom === 'number' && Number.isFinite(headerBottom)) return headerBottom
  if (typeof presentationTop === 'number' && Number.isFinite(presentationTop)) return presentationTop
  return viewportFallback
}

/**
 * Grow a bottom-anchored chooser up to the workspace/session bar.
 * @param {number} panelBottom
 * @param {number} ceiling
 * @param {number} [gap]
 * @returns {number}
 */
export function scopePanelMaxHeightPx(panelBottom, ceiling, gap = SCOPE_PANEL_GAP_PX) {
  return Math.max(SCOPE_PANEL_MIN_HEIGHT_PX, Math.round(panelBottom - ceiling - gap))
}
