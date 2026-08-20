import assert from 'node:assert/strict'
import test from 'node:test'
import { accountAccessBridgeConfig, createAccountAccessProtocol } from '../src/client/protocol.js'

function store(initial) { return { value: initial, set(value) { this.value = value } } }
const authenticated = { status: 'authenticated', displayName: '测试用户', knowledgeAccess: true, codeAccess: true, modelMode: 'company-pending' }

test('accepts snapshots only from the exact parent, origin, nonce, and increasing sequence', () => {
  const protocol = createAccountAccessProtocol({ createStore: store, nonce: 'n', parentOrigin: 'chrome-extension://abc' }); const parent = {}
  const message = { type: 'account-access-snapshot/v1', nonce: 'n', sequence: 1, snapshot: authenticated }
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://other', data: message }, parent), false)
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), true)
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), false)
  assert.deepEqual(protocol.source.value, authenticated)
})

test('sends only supported account commands with a local sequence', () => {
  const sent = []; const parent = { postMessage: (message, origin) => sent.push({ message, origin }) }
  const protocol = createAccountAccessProtocol({ createStore: store, nonce: 'n', parentOrigin: 'chrome-extension://abc' })
  assert.equal(protocol.request('login', parent), true)
  assert.equal(protocol.request('invalid', parent), false)
  assert.deepEqual(sent, [{ message: { type: 'account-access-command/v1', nonce: 'n', sequence: 1, command: 'login' }, origin: 'chrome-extension://abc' }])
})

test('gateway probes send the key only toward the extension and never accept it in snapshots', () => {
  const sent = []; const parent = { postMessage: (message, origin) => sent.push({ message, origin }) }
  const protocol = createAccountAccessProtocol({ createStore: store, nonce: 'n', parentOrigin: 'chrome-extension://abc' })
  const requestId = protocol.probeGateway('sk-secret', parent)
  assert.equal(sent[0].origin, 'chrome-extension://abc')
  assert.deepEqual(sent[0].message, { type: 'company-gateway-probe-command/v1', nonce: 'n', sequence: 1, requestId, apiKey: 'sk-secret' })
  const gateway = { models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }], quota: { usagePercent: 16.8, nextResetTime: '2026-08-21T00:00:00+08:00', resetCycle: 'daily' }, checkedAt: '2026-08-20T00:00:00Z' }
  const response = { type: 'company-gateway-probe-snapshot/v1', nonce: 'n', sequence: 1, snapshot: { requestId, status: 'ready', gateway } }
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://abc', data: response }, parent), true)
  assert.deepEqual(protocol.gatewayProbe.value, response.snapshot)
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://abc', data: { ...response, sequence: 2, snapshot: { ...response.snapshot, apiKey: 'must-not-return' } } }, parent), false)
})

test('requires the chrome extension bridge origin', () => {
  assert.deepEqual(accountAccessBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabc')), { nonce: 'n', parentOrigin: 'chrome-extension://abc' })
  assert.equal(accountAccessBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=https%3A%2F%2Fexample.test')), undefined)
})
