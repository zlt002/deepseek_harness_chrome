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
    if (event.button !== 0 || event.isPrimary === false || event.target?.closest?.('button')) return
    dragStart = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, x, y }
    preview.setPointerCapture?.(event.pointerId)
    preview.classList.add('is-panning')
    event.preventDefault()
  })
  preview.addEventListener('pointermove', (event) => {
    if (dragStart === undefined || event.isPrimary === false || (dragStart.pointerId !== undefined && event.pointerId !== dragStart.pointerId)) return
    x = dragStart.x + event.clientX - dragStart.clientX
    y = dragStart.y + event.clientY - dragStart.clientY
    apply()
  })
  const finishDrag = (event) => {
    if (dragStart === undefined || (dragStart.pointerId !== undefined && event.pointerId !== dragStart.pointerId)) return
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
 * Use a page-level immersive overlay instead of browser fullscreen. Native
 * fullscreen hides the extension side panel; this mode changes neither the
 * Mermaid source nor its viewer transform.
 */
export function wireMermaidFullscreen(block, fullscreenButton, closeButton) {
  const document = block.ownerDocument
  const body = document.body
  let immersive = false
  let disposed = false
  let observer
  const active = () => immersive
  const update = () => {
    const isActive = active()
    block.classList.toggle('is-fullscreen-fallback', isActive)
    block.classList.toggle('is-fullscreen-active', isActive)
    body?.classList.toggle('mermaid-immersive-active', isActive)
    fullscreenButton.setAttribute('aria-pressed', String(isActive))
    fullscreenButton.hidden = isActive
    closeButton.hidden = !isActive
  }
  const exit = async () => {
    immersive = false
    update()
  }
  const enter = async () => {
    if (active()) return
    immersive = true
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
    void exit()
    document.removeEventListener('keydown', onKeydown)
    fullscreenButton.removeEventListener('click', onFullscreenClick)
    closeButton.removeEventListener('click', onCloseClick)
    observer?.disconnect()
  }
  const onFullscreenClick = () => { void enter() }
  const onCloseClick = () => { void exit() }

  fullscreenButton.addEventListener('click', onFullscreenClick)
  closeButton.addEventListener('click', onCloseClick)
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
