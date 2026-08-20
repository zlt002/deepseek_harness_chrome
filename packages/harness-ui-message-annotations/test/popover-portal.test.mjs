import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from '../../../.generated/harness-product/node_modules/jsdom/lib/api.js'
import { popoverPortalHost } from '../src/client/popover-portal.js'

test('mounts the annotation panel beside, not inside, the composer overlay DOM tree', () => {
  const document = new JSDOM('<body><main data-assistant-message-id="m1">正文</main><div data-composer-overlay-surface></div></body>').window.document
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  const host = popoverPortalHost(document)
  host.append(panel)

  assert.equal(host.parentElement, document.body)
  assert.equal(panel.closest('[data-composer-overlay-surface]'), null)
  assert.equal(panel.closest('[data-assistant-message-id]'), null)
  assert.equal(popoverPortalHost(document), host)
})
