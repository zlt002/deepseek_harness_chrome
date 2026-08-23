import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('offers reference capture on a Browser Target and keeps the command nonce-bound', async () => {
  const [control, bridge, sidepanel] = await Promise.all([
    readFile(new URL('../packages/harness-ui-browser-target/src/client/BrowserTargetControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../packages/harness-ui-browser-target/src/client/active-tab-bridge.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(control, />作为参考<\/button>/)
  assert.match(bridge, /capture-design-reference/)
  assert.match(sidepanel, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(sidepanel, /capture-design-reference\/v1/)
  assert.match(sidepanel, /requestDesignReferenceCapture/)
})

test('background capture validates the Side Panel and the same Browser Target before persisting', async () => {
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(background, /request\.type === 'capture-design-reference\/v1'/)
  assert.match(background, /!isSidePanelSender\(sender\) \|\| !isBrowserTarget\(request\.browserTarget\)/)
  assert.match(background, /!sameBrowserTarget\(liveBefore, browserTarget\)/)
  assert.match(background, /world: 'ISOLATED'/)
  assert.match(background, /captureVisibleTab\(browserTarget\.windowId, \{ format: 'jpeg', quality: 60 \}\)/)
  assert.match(background, /!sameBrowserTarget\(liveAfter, browserTarget\)/)
  assert.match(background, /readback\?\.fingerprint !== evidence\.fingerprint/)
  assert.match(background, /PROTOTYPE_STUDIO_OPEN_PATH/)
  assert.match(background, /prototype-studio-snapshot\/v1/)
  assert.match(background, /prototype-studio-prompt\/v1/)
  assert.match(background, /prototype-studio\.html/)
})
