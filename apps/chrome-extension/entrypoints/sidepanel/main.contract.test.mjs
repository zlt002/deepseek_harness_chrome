import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the side panel accepts the iframe session report before enabling prototype capture', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /value\.type === 'harness-session-selected\/v1'/)
  assert.match(source, /selectedSessionId === undefined \|\| isHarnessSessionIdentity\(selectedSessionId\)/)
  assert.match(source, /setObservedHarnessSessionId\(selectedSessionId\)/)
  assert.match(source, /command: 'capture-design-reference', tabId: activeTab\.tab\.tabId, sessionId: activeHarnessSessionId/)
})

test('observing the selected session cannot reload the side-panel iframe', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /const \[observedHarnessSessionId, setObservedHarnessSessionId\]/)
  assert.match(source, /const activeHarnessSessionId = observedHarnessSessionId/)
  assert.match(source, /setObservedHarnessSessionId\(selectedSessionId\)/)
  assert.match(source, /sessionId: sidePanelHandoff\.sessionId/)
  assert.doesNotMatch(source, /sessionId: activeHarnessSessionId \}\), \[activeHarnessSessionId, frameNonce/, 'the observed session must never be an iframe URL dependency')
})

test('changing the observed session refreshes recent prototypes without reconnecting Harness', async () => {
  const source = await readFile(new URL('./main.tsx', import.meta.url), 'utf8')

  assert.match(source, /void connect\(\); void loadTargetSettings\(\)/)
  assert.match(source, /void loadRecentPrototypes\(\)/)
  assert.doesNotMatch(source, /void connect\(\); void loadTargetSettings\(\); void loadRecentPrototypes\(\)/, 'session-scoped recent projects must not share the Harness initialization effect')
})
