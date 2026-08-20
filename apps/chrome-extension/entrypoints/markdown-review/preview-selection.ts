const MAX_PREVIEW_QUOTE_LENGTH = 8_000

export interface SourceRange { start: number; end: number }

function validRange(value: SourceRange | undefined, sourceLength: number): value is SourceRange {
  return value !== undefined && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end >= value.start && value.end <= sourceLength
}

/**
 * Finds an exact preview quote only when it has exactly one occurrence within
 * the mdast node's original source range. This deliberately declines fuzzy
 * or document-wide matching, which would attach an annotation to a duplicate.
 */
export function uniquePreviewSelectionMatch(source: string, quote: string, sourceRange: SourceRange | undefined): SourceRange | undefined {
  if (quote.length === 0 || quote.length > MAX_PREVIEW_QUOTE_LENGTH || !validRange(sourceRange, source.length)) return undefined
  const window = source.slice(sourceRange.start, sourceRange.end)
  const first = window.indexOf(quote)
  if (first < 0 || window.indexOf(quote, first + quote.length) >= 0) return undefined
  return { start: sourceRange.start + first, end: sourceRange.start + first + quote.length }
}

function elementFor(node: Node, root: HTMLElement): Element | undefined {
  if (node instanceof Element) return root.contains(node) ? node : undefined
  const parent = node.parentElement
  return parent !== null && root.contains(parent) ? parent : undefined
}

function rangeFor(element: Element): SourceRange | undefined {
  const start = Number(element.getAttribute('data-source-start'))
  const end = Number(element.getAttribute('data-source-end'))
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start ? { start, end } : undefined
}

function ancestorRanges(element: Element, root: HTMLElement): SourceRange[] {
  const ranges: SourceRange[] = []
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const range = rangeFor(current)
    if (range !== undefined) ranges.push(range)
    if (current === root) break
  }
  return ranges
}

function sharedSourceRange(range: Range, root: HTMLElement): SourceRange | undefined {
  const startElement = elementFor(range.startContainer, root)
  const endElement = elementFor(range.endContainer, root)
  if (startElement === undefined || endElement === undefined) return undefined
  const endRanges = new Set(ancestorRanges(endElement, root).map(({ start, end }) => `${start}:${end}`))
  return ancestorRanges(startElement, root).find(({ start, end }) => endRanges.has(`${start}:${end}`))
}

/** Maps a live DOM selection to source offsets using shared mdast boundaries. */
export function previewSelectionToSourceRange(source: string, selection: Selection | null, root: HTMLElement | null): SourceRange | undefined {
  if (root === null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return undefined
  const quote = selection.toString()
  if (quote.length === 0 || quote.length > MAX_PREVIEW_QUOTE_LENGTH) return undefined
  return uniquePreviewSelectionMatch(source, quote, sharedSourceRange(selection.getRangeAt(0), root))
}
