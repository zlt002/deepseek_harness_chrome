import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the extension shell shows an exclusive full-screen return control and delegates the transaction to background', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /async function openFullscreenTab\(sessionId\?/) 
  assert.match(source, /async function returnToSidePanel\(sessionId\?/) 
  assert.match(source, /returnToSidePanelFromFullscreen\(chrome, tab\.windowId, tab\.id, sessionId\)/)
  assert.match(source, /surface === 'fullscreen-tab' && <button/)
  assert.match(source, /aria-label="收起全屏"/)
  assert.match(source, /title="收起全屏"/)
  assert.match(source, /get-sidepanel-handoff\/v1/)
  assert.match(source, /session-handoff-applied\/v1/)
  assert.match(source, /if \(!sidePanelHandoff\.ready\) return/)
  assert.match(source, /HarnessFrameSource\(url, \{ nonce: frameNonce, parentOrigin: window\.location\.origin, surface, \.\.\.\(activeHarnessSessionId === undefined \? \{\} : \{ sessionId: activeHarnessSessionId \}\) \}\)/)
})

test('only the nonce-bound Harness iframe can request either surface handoff', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(source, /value\.type === 'open-fullscreen-tab\/v1' && value\.nonce === frameNonce/)
  assert.match(source, /value\.type === 'return-to-sidepanel\/v1' && value\.nonce === frameNonce/)
})
