import assert from 'node:assert/strict'
import test from 'node:test'
import { createScopeProtocol, knowledgeScopeBridgeConfig } from '../src/client/protocol.js'
import { scopeLabels } from '../src/client/labels.js'

function store(initial) { return { value: initial, set(value) { this.value = value } } }
const snapshot = { sessionId: 'session-1', enabled: true, serviceState: 'ready', scope: { domainId: 'd', systemIds: ['s1', 's2'], repositoryIds: ['r1', 'r2'] }, catalog: { domains: [{ id: 'd', name: '供应链' }], systems: [{ id: 's1', name: '订单知识库' }, { id: 's2', name: '结算知识库' }], repositories: [{ id: 'r1', name: 'OTP-后端-中台' }, { id: 'r2', name: 'OTP-前端-1' }] } }

test('preserves all selected repository and knowledge names for wide composer layouts', () => {
  assert.deepEqual(scopeLabels(snapshot.scope, snapshot.catalog), { repositories: 'OTP-后端-中台、OTP-前端-1', knowledge: '订单知识库、结算知识库' })
})

test('keeps unselected composer buttons as empty labels so agents do not probe either side', () => {
  assert.deepEqual(scopeLabels({ domainId: '', systemIds: [], repositoryIds: [] }, snapshot.catalog), {
    repositories: undefined,
    knowledge: undefined,
  })
})

test('keeps an already selected repository visible when a catalog refresh omits it', () => {
  assert.deepEqual(scopeLabels(
    { ...snapshot.scope, repositoryIds: ['r1', 'OTP-后端-中台'] },
    { ...snapshot.catalog, repositories: [{ id: 'r1', name: 'OTP-后端-中台' }] },
  ), { repositories: 'OTP-后端-中台、OTP-后端-中台', knowledge: '订单知识库、结算知识库' })
})

test('accepts only an exact parent, nonce, and increasing knowledge snapshot sequence', () => {
  const bridge = createScopeProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' }); const parent = {}
  const message = { type: 'knowledge-scope-snapshot/v1', nonce: 'nonce', sequence: 1, snapshot }
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://other', data: message }, parent), false)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), true)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), false)
  assert.equal(bridge.source.value.sessionId, 'session-1')
})

test('accepts bounded live search content only from the exact iframe parent', () => {
  const bridge = createScopeProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' }); const parent = {}
  const progress = { requestId: 'request-1', harnessSessionId: 'child', harnessParentSessionId: 'parent', tool: 'code_search', question: 'where', phase: 'streaming', chars: 5, content: 'hello', process: '正在检索仓库' }
  const message = { type: 'search-progress/v1', nonce: 'nonce', sequence: 1, progress }
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), true)
  assert.deepEqual(bridge.progress.value, [progress])
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { ...message, sequence: 2, progress: { ...progress, content: 'x'.repeat(16_001) } } }, parent), false)
})

test('sends a scope update with a local increasing command sequence', () => {
  const bridge = createScopeProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' }); const sent = []; const parent = { postMessage: (message, origin) => sent.push({ message, origin }) }
  bridge.request('session-1', snapshot.scope, { enabled: true }, parent)
  assert.deepEqual(sent[0], { message: { type: 'knowledge-scope-command/v1', nonce: 'nonce', sequence: 1, sessionId: 'session-1', scope: snapshot.scope, enabled: true }, origin: 'chrome-extension://abc' })
})

test('requires a chrome extension origin in the opt-in bridge config', () => {
  assert.deepEqual(knowledgeScopeBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=chrome-extension%3A%2F%2Fabc')), { nonce: 'n', parentOrigin: 'chrome-extension://abc' })
  assert.equal(knowledgeScopeBridgeConfig(new URL('https://loopback.test/?dshBrowserTargetBridge=1&dshBrowserTargetNonce=n&dshBrowserTargetParentOrigin=https%3A%2F%2Fexample.test')), undefined)
})
