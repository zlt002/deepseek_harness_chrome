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

/** The final visible line of a Range is the only safe anchor for a compact selection affordance. */
export function selectionAnchor(range) {
  const rects = [...range.getClientRects()].filter(rect => rect.width !== 0 || rect.height !== 0)
  return rects.at(-1)
}

/** Place the popover beside the selection while preserving an 8px viewport gutter. */
export function popoverPosition(anchor, size, viewport, { preferInline = false, preferAbove = false } = {}) {
  const maxLeft = Math.max(EDGE, viewport.width - size.width - EDGE)
  const left = Math.min(maxLeft, Math.max(EDGE, anchor.left + anchor.width / 2 - size.width / 2))
  const right = anchor.right ?? anchor.left + anchor.width
  const maxTop = Math.max(EDGE, viewport.height - size.height - EDGE)
  const inlineTop = Math.min(maxTop, Math.max(EDGE, anchor.bottom - size.height))
  if (preferInline) {
    if (right + GAP + size.width <= viewport.width - EDGE) return { left: right + GAP, top: inlineTop, placement: 'right' }
    if (anchor.left - GAP - size.width >= EDGE) return { left: anchor.left - GAP - size.width, top: inlineTop, placement: 'left' }
  }
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - size.height
  if (preferAbove && above >= EDGE) return { left, top: above, placement: 'above' }
  if (below + size.height <= viewport.height - EDGE) return { left, top: below, placement: 'below' }
  if (above >= EDGE) return { left, top: above, placement: 'above' }
  return { left, top: Math.max(EDGE, Math.min(below, maxTop)), placement: 'below' }
}
