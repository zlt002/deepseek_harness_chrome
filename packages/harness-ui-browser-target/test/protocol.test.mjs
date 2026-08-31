import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { browserTargetBridgeConfig, createBrowserTargetProtocol, requestHarnessReconnect, requestOpenFullscreenTab, requestReturnToSidepanel } from '../src/client/protocol.js'

async function activeBridge() {
  const source = await readFile(new URL('../src/client/active-tab-bridge.ts', import.meta.url), 'utf8')
  const storeModule = `export function createSnapshotStore(initial) { return { value: initial, set(value) { this.value = value }, getSnapshot() { return this.value }, subscribe() { return () => {} } } }`
  const storeUrl = `data:text/javascript,${encodeURIComponent(storeModule)}`
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("from '@deepseek-ai/dsh-client-runtime/client'", `from '${storeUrl}'`)
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

function store(initial) { return { value: initial, set(value) { this.value = value } } }
const snapshot = { settings: { mode: 'follow-active-tab', pinnedTabs: [] }, tabs: [], activeTab: { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test', title: 'Example' } }

test('accepts only the configured parent origin, nonce, and increasing snapshot sequence', () => {
  const bridge = createBrowserTargetProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' })
  const parent = {}
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://other', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot } }, parent), false)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot } }, parent), true)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot } }, parent), false)
  assert.equal(bridge.source.value.activeTab.title, 'Example')
})

test('validates a bounded, unambiguous active Run owner array while accepting legacy snapshots', () => {
  const parent = {}
  const a = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://a.example.test', title: 'A' }
  const first = { sessionId: 'session-a', submissionId: 'submission-a', target: a }
  const second = { sessionId: 'session-b', submissionId: 'submission-b', target: a }
  const bridge = createBrowserTargetProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' })
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, activeRunLocks: [first, second], activeRunLock: first } }, parent), true)
  assert.deepEqual(bridge.source.value.activeRunLocks, [first, second])
  const invalid = createBrowserTargetProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' })
  assert.equal(invalid.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, activeRunLocks: [first, first] } }, parent), false)
  const conflicting = createBrowserTargetProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' })
  assert.equal(conflicting.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, activeRunLocks: [first, { ...second, target: { ...a, tabId: 3 } }] } }, parent), false)
})

test('emits extension commands with its own increasing sequence', () => {
  const bridge = createBrowserTargetProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' })
  const sent = []
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) }
  bridge.send({ command: 'refresh' }, parent)
  bridge.send({ command: 'set-mode', mode: 'none' }, parent)
  bridge.send({ command: 'capture-design-reference', tabId: 2 }, parent)
  assert.deepEqual(sent, [
    { message: { type: 'browser-target-command/v1', nonce: 'nonce', sequence: 1, command: { command: 'refresh' } }, origin: 'chrome-extension://abc' },
    { message: { type: 'browser-target-command/v1', nonce: 'nonce', sequence: 2, command: { command: 'set-mode', mode: 'none' } }, origin: 'chrome-extension://abc' },
    { message: { type: 'browser-target-command/v1', nonce: 'nonce', sequence: 3, command: { command: 'capture-design-reference', tabId: 2 } }, origin: 'chrome-extension://abc' },
  ])
})

test('accepts only a bounded integer for the in-flight design-reference tab id', async () => {
  const { createBrowserTargetBridge } = await activeBridge()
  const parent = {}
  const valid = createBrowserTargetBridge('nonce', 'chrome-extension://abc')
  assert.equal(valid.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, capturingDesignReferenceTabId: 2 } }, parent), true)
  assert.equal(valid.source.getSnapshot().capturingDesignReferenceTabId, 2)
  for (const invalid of [-1, 2.5, Number.MAX_SAFE_INTEGER]) {
    const bridge = createBrowserTargetBridge('nonce', 'chrome-extension://abc')
    assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, capturingDesignReferenceTabId: invalid } }, parent), false)
  }
})

test('projects an acknowledged follow-mode Run target until it is cleared, without changing pinned or none modes', async () => {
  const { browserTargetTriggerTab, createBrowserTargetBridge } = await activeBridge()
  const a = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://a.example.test', title: 'A' }
  const b = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://b.example.test', title: 'B' }

  const followLocked = { settings: { mode: 'follow-active-tab', pinnedTabs: [] }, tabs: [a, b], activeTab: b, lockedRunTarget: a }
  const bridge = createBrowserTargetBridge('nonce', 'chrome-extension://abc')
  const parent = {}
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...followLocked } }, parent), true)
  assert.deepEqual(bridge.source.getSnapshot().lockedRunTarget, a, 'the acknowledged target is carried into the snapshot')
  assert.deepEqual(browserTargetTriggerTab(followLocked), a, 'an active-tab change during the Run must not replace the acknowledged target')
  assert.deepEqual(browserTargetTriggerTab({ ...followLocked, lockedRunTarget: undefined }), b, 'the next idle snapshot returns to the active tab')

  const pinned = { settings: { mode: 'pinned-tabs', pinnedTabs: [a], primaryTabId: a.tabId }, tabs: [a, b], activeTab: b, lockedRunTarget: b }
  assert.deepEqual(browserTargetTriggerTab(pinned), b, 'an in-flight Run lock overrides the next-Run pinned policy')
  assert.deepEqual(browserTargetTriggerTab({ ...pinned, settings: { mode: 'none', pinnedTabs: [] } }), b, 'an in-flight Run lock overrides the next-Run none policy')
  assert.deepEqual(browserTargetTriggerTab({ ...pinned, lockedRunTarget: undefined }), a, 'an initial pinned policy still selects its primary target')
  assert.equal(browserTargetTriggerTab({ ...pinned, lockedRunTarget: undefined, settings: { mode: 'none', pinnedTabs: [] } }), undefined, 'initial none remains unbound')
})

test('projects every active Run identity with its locked target for lifecycle recovery', async () => {
  const { createBrowserTargetBridge } = await activeBridge()
  const a = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://a.example.test', title: 'A' }
  const bridge = createBrowserTargetBridge('nonce', 'chrome-extension://abc')
  const parent = {}
  const activeRunLock = { sessionId: 'session-a', submissionId: 'submission-a', target: a }
  const activeRunLocks = [activeRunLock, { sessionId: 'session-b', submissionId: 'submission-b', target: a }]
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, lockedRunTarget: a, activeRunLock, activeRunLocks } }, parent), true)
  assert.deepEqual(bridge.source.getSnapshot().activeRunLock, activeRunLock)
  assert.deepEqual(bridge.source.getSnapshot().activeRunLocks, activeRunLocks)
  const invalid = createBrowserTargetBridge('nonce', 'chrome-extension://abc')
  assert.equal(invalid.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 1, ...snapshot, activeRunLock: { sessionId: 'session-a', submissionId: '', target: a } } }, parent), false)
  assert.equal(invalid.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 2, ...snapshot, activeRunLocks: [activeRunLock, activeRunLock] } }, parent), false, 'duplicate submissions cannot produce ambiguous lifecycle recovery')
  assert.equal(invalid.accept({ source: parent, origin: 'chrome-extension://abc', data: { type: 'browser-target-snapshot/v1', nonce: 'nonce', sequence: 3, ...snapshot, activeRunLocks: [activeRunLock, { sessionId: 'session-b', submissionId: 'submission-b', target: { ...a, url: 'https://other.example.test' } }] } }, parent), false, 'all active owners must share one Browser Target')
})

test('requires an exact chrome extension parent origin in the opt-in bridge URL', () => {
  assert.deepEqual(browserTargetBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabc')), { nonce: 'n', parentOrigin: 'chrome-extension://abc', surface: 'sidepanel' })
  assert.deepEqual(browserTargetBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabc&dshBrowserTargetSurface=fullscreen-tab&dshHarnessSessionId=session-current')), { nonce: 'n', parentOrigin: 'chrome-extension://abc', surface: 'fullscreen-tab', sessionId: 'session-current' })
  assert.equal(browserTargetBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=https%3A%2F%2Fexample.test')), undefined)
})

test('reconnect action posts only the nonce-bound message to the configured parent origin', () => {
  const sent = []
  requestHarnessReconnect({ postMessage: (message, origin) => sent.push({ message, origin }) }, 'nonce', 'chrome-extension://abc')
  assert.deepEqual(sent, [{ message: { type: 'harness-reconnect/v1', nonce: 'nonce' }, origin: 'chrome-extension://abc' }])
})

test('full-screen handoff messages remain nonce- and origin-bound in both directions', () => {
  const sent = []
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) }
  requestOpenFullscreenTab(parent, 'nonce', 'chrome-extension://abc', 'session-current')
  requestReturnToSidepanel(parent, 'nonce', 'chrome-extension://abc')
  assert.deepEqual(sent, [
    { message: { type: 'open-fullscreen-tab/v1', nonce: 'nonce', sessionId: 'session-current' }, origin: 'chrome-extension://abc' },
    { message: { type: 'return-to-sidepanel/v1', nonce: 'nonce' }, origin: 'chrome-extension://abc' },
  ])
})
