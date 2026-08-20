const EDGE = 8
const GAP = 8

function markerFor(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  const marker = element?.closest?.('[data-assistant-message-id]')
  const id = marker?.dataset?.assistantMessageId
  return typeof id === 'string' && id.length > 0 ? { marker, id } : undefined
}

/** A selection is eligible only when it starts and ends in one stable assistant message owner. */
export function assistantMessageIdForRange(range) {
  const start = markerFor(range.startContainer)
  const end = markerFor(range.endContainer)
  return start !== undefined && start.marker === end?.marker ? start.id : undefined
}

/** Place the popover beside the selection while preserving an 8px viewport gutter. */
export function popoverPosition(anchor, size, viewport) {
  const maxLeft = Math.max(EDGE, viewport.width - size.width - EDGE)
  const left = Math.min(maxLeft, Math.max(EDGE, anchor.left + anchor.width / 2 - size.width / 2))
  const below = anchor.bottom + GAP
  if (below + size.height <= viewport.height - EDGE) return { left, top: below, placement: 'below' }
  const above = anchor.top - GAP - size.height
  if (above >= EDGE) return { left, top: above, placement: 'above' }
  return { left, top: Math.max(EDGE, Math.min(below, viewport.height - size.height - EDGE)), placement: 'below' }
}
