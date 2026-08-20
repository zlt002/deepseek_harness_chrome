/**
 * Decide whether a selection popover should be dismissed.
 *
 * The optional fields describe one event or placement check. Keeping the
 * event details outside the component makes the close contract testable
 * without requiring a browser DOM.
 */
export function shouldClosePopover({ targetInsidePanel, key, rangeRectValid } = {}) {
  if (key === 'Escape') return true
  if (rangeRectValid === false) return true
  if (targetInsidePanel !== undefined) return targetInsidePanel === false
  return false
}
