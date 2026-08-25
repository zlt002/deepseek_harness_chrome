export type PreviewViewport = 'desktop' | 'tablet' | 'mobile'

export const PREVIEW_VIEWPORT_WIDTHS: Record<PreviewViewport, number> = {
  desktop: 1_440,
  tablet: 768,
  mobile: 390,
}

export interface PreviewStageLayout {
  viewportWidth: number
  viewportHeight: number
  scale: number
  displayWidth: number
  displayHeight: number
}

/** Keeps the iframe's real layout viewport exact while scaling only its visual stage. */
export function previewStageLayout(containerWidth: number, containerHeight: number, viewport: PreviewViewport): PreviewStageLayout {
  const viewportWidth = PREVIEW_VIEWPORT_WIDTHS[viewport]
  const safeWidth = Number.isFinite(containerWidth) ? Math.max(240, containerWidth - 24) : viewportWidth
  const safeHeight = Number.isFinite(containerHeight) ? Math.max(360, containerHeight - 24) : 720
  const scale = Math.max(.2, Math.min(1, safeWidth / viewportWidth))
  const viewportHeight = Math.max(600, Math.ceil(safeHeight / scale))
  return {
    viewportWidth,
    viewportHeight,
    scale,
    displayWidth: Math.round(viewportWidth * scale),
    displayHeight: Math.round(viewportHeight * scale),
  }
}
