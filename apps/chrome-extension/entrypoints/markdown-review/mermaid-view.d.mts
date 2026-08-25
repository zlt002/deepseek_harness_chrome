export function wireMermaidViewToggle(
  block: HTMLElement,
  sourceId: string,
  visualButton: HTMLButtonElement,
  sourceButton: HTMLButtonElement,
): (view: 'visual' | 'source') => void
export function wireMermaidViewer(
  block: HTMLElement,
  preview: HTMLElement,
  canvas: HTMLElement,
  zoomInButton: HTMLButtonElement,
  zoomOutButton: HTMLButtonElement,
  resetButton: HTMLButtonElement,
): { reset: () => void }
export function wireMermaidFullscreen(
  block: HTMLElement,
  fullscreenButton: HTMLButtonElement,
  closeButton: HTMLButtonElement,
): { enter: () => Promise<void>; exit: () => Promise<void>; destroy: () => void }

export function fitMermaidPreview(preview: HTMLElement): void
