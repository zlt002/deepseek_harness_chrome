import assert from 'node:assert/strict'
import test from 'node:test'
import { browserTargetBridgeConfig, createBrowserTargetProtocol, requestHarnessReconnect, requestOpenFullscreenTab, requestReturnToSidepanel } from '../src/client/protocol.js'

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
