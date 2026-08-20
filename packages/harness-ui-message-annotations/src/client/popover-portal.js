const PORTAL_ATTRIBUTE = 'data-message-annotation-popover-root'

/**
 * Keep the selection popover outside composer and transcript stacking contexts.
 * The slot still owns its lifecycle; only its rendered surface moves to body.
 */
export function popoverPortalHost(document) {
  const selector = `[${PORTAL_ATTRIBUTE}]`
  const existing = document.body.querySelector(selector)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.setAttribute(PORTAL_ATTRIBUTE, '')
  document.body.append(host)
  return host
}
