/**
 * Keeps the rendered Mermaid widget and its decorated ProseMirror source node
 * in one view state. The source is outside the widget because it is a node
 * decoration, so resolve it only after ProseMirror has inserted the widget.
 */
export function wireMermaidViewToggle(block, sourceId, visualButton, sourceButton) {
  const setView = (view) => {
    const showSource = view === 'source'
    block.classList.toggle('is-source', showSource)
    visualButton.setAttribute('aria-pressed', String(!showSource))
    sourceButton.setAttribute('aria-pressed', String(showSource))
    block.parentElement?.querySelector(`[data-mermaid-source="${sourceId}"]:not(.mermaid-block)`)?.classList.toggle('mermaid-source-hidden', !showSource)
  }

  visualButton.addEventListener('click', () => setView('visual'))
  sourceButton.addEventListener('click', () => setView('source'))
  return setView
}

/**
 * A local-only SVG viewer. It deliberately changes only the canvas transform:
 * the Mermaid source and the ProseMirror document are never written here.
 */
export function wireMermaidViewer(block, preview, canvas, zoomInButton, zoomOutButton, resetButton) {
  let scale = 1
  let x = 0
  let y = 0
  let dragStart

  const apply = () => {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    block.dataset.mermaidZoom = String(scale)
  }
  const reset = () => {
    scale = 1
    x = 0
    y = 0
    apply()
  }
  const zoom = (delta) => {
    scale = Math.max(0.6, Math.min(2.4, Math.round((scale + delta) * 100) / 100))
    apply()
  }

  zoomInButton.addEventListener('click', () => zoom(0.2))
  zoomOutButton.addEventListener('click', () => zoom(-0.2))
  resetButton.addEventListener('click', reset)
  preview.addEventListener('pointerdown', (event) => {
    if (scale <= 1 || event.target?.closest?.('button')) return
    dragStart = { clientX: event.clientX, clientY: event.clientY, x, y }
    preview.setPointerCapture?.(event.pointerId)
    preview.classList.add('is-panning')
    event.preventDefault()
  })
  preview.addEventListener('pointermove', (event) => {
    if (dragStart === undefined) return
    x = dragStart.x + event.clientX - dragStart.clientX
    y = dragStart.y + event.clientY - dragStart.clientY
    apply()
  })
  const finishDrag = (event) => {
    if (dragStart === undefined) return
    dragStart = undefined
    preview.releasePointerCapture?.(event.pointerId)
    preview.classList.remove('is-panning')
  }
  preview.addEventListener('pointerup', finishDrag)
  preview.addEventListener('pointercancel', finishDrag)
  apply()
  return { reset }
}

/**
 * Prefer the browser fullscreen surface, with a page-level overlay when an
 * extension page or a test runtime denies the Fullscreen API. Neither mode
 * touches the Mermaid source or the viewer transform.
 */
export function wireMermaidFullscreen(block, fullscreenButton, closeButton) {
  const document = block.ownerDocument
  let fallback = false
  let disposed = false
  let observer
  const nativeActive = () => document.fullscreenElement === block
  const active = () => fallback || nativeActive()
  const update = () => {
    const isActive = active()
    block.classList.toggle('is-fullscreen-fallback', fallback)
    block.classList.toggle('is-fullscreen-active', isActive)
    fullscreenButton.setAttribute('aria-pressed', String(isActive))
    closeButton.hidden = !isActive
  }
  const exit = async () => {
    fallback = false
    if (nativeActive() && typeof document.exitFullscreen === 'function') {
      try { await document.exitFullscreen() } catch { /* Native exit may already be in progress. */ }
    }
    update()
  }
  const enter = async () => {
    if (active()) return
    if (typeof block.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
      try {
        await block.requestFullscreen()
        if (nativeActive()) {
          update()
          return
        }
      } catch {
        // Some extension pages reject Fullscreen API calls; use the overlay.
      }
    }
    fallback = true
    update()
  }
  const onFullscreenChange = () => {
    if (!nativeActive()) fallback = false
    update()
  }
  const onKeydown = (event) => {
    if (event.key !== 'Escape' || !active()) return
    event.preventDefault()
    void exit()
  }
  const destroy = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    document.removeEventListener('keydown', onKeydown)
    fullscreenButton.removeEventListener('click', onFullscreenClick)
    closeButton.removeEventListener('click', onCloseClick)
    observer?.disconnect()
  }
  const onFullscreenClick = () => { void enter() }
  const onCloseClick = () => { void exit() }

  fullscreenButton.addEventListener('click', onFullscreenClick)
  closeButton.addEventListener('click', onCloseClick)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('keydown', onKeydown)
  const MutationObserver = document.defaultView?.MutationObserver
  if (MutationObserver !== undefined && block.isConnected) {
    observer = new MutationObserver(() => { if (!block.isConnected) destroy() })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }
  update()
  return { enter, exit, destroy }
}

/** Keep the review card aligned with the document regardless of diagram size. */
export function fitMermaidPreview(preview) {
  preview.style.width = '100%'
  preview.style.removeProperty('max-width')
  if (preview.parentElement?.classList.contains('mermaid-block')) {
    preview.parentElement.style.width = '100%'
    preview.parentElement.style.removeProperty('max-width')
    preview.parentElement.style.removeProperty('margin-inline')
  }
}
