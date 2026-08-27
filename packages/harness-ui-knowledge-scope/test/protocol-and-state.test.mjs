import assert from 'node:assert/strict'
import test from 'node:test'
import { createScopeProtocol, knowledgeScopeBridgeConfig } from '../src/client/protocol.js'
import { scopeLabels } from '../src/client/labels.js'
import { selectKnowledgeDomain, selectKnowledgeSystem } from '../src/client/selection.js'
import { migrateLegacyKnowledgeScope } from '../../../apps/chrome-extension/src/legacy-knowledge-scope.mjs'

function store(initial) { return { value: initial, set(value) { this.value = value } } }
const snapshot = { sessionId: 'session-1', enabled: true, serviceState: 'ready', scope: { domainSystems: { d: ['s1'], d2: ['s2'] }, repositoryIds: ['r1', 'r2'] }, catalog: { domains: [{ id: 'd', name: '供应链' }, { id: 'd2', name: '仓储' }], systems: [{ id: 's1', name: '订单知识库', domainId: 'd' }, { id: 's2', name: '库存知识库', domainId: 'd2' }], repositories: [{ id: 'r1', name: 'OTP-后端-中台' }, { id: 'r2', name: 'OTP-前端-1' }] } }

test('preserves all selected repository and knowledge names for wide composer layouts', () => {
  assert.deepEqual(scopeLabels(snapshot.scope, snapshot.catalog), { repositories: 'OTP-后端-中台、OTP-前端-1', knowledge: '订单知识库、库存知识库' })
})

test('checking knowledge systems preserves selections across categories', () => {
  const empty = { domainSystems: {}, repositoryIds: ['repo'] }
  assert.deepEqual(selectKnowledgeSystem(empty, 'transport', 'tms', true), {
    domainSystems: { transport: ['tms'] }, repositoryIds: ['repo'],
  })
  assert.deepEqual(selectKnowledgeSystem({ domainSystems: { transport: ['tms'] }, repositoryIds: [] }, 'transport', 'oms', true), {
    domainSystems: { transport: ['tms', 'oms'] }, repositoryIds: [],
  })
  assert.deepEqual(selectKnowledgeSystem({ domainSystems: { transport: ['tms'] }, repositoryIds: [] }, 'warehouse', 'wms', true), {
    domainSystems: { transport: ['tms'], warehouse: ['wms'] }, repositoryIds: [],
  })
  assert.deepEqual(selectKnowledgeSystem({ domainSystems: { transport: ['tms'] }, repositoryIds: [] }, 'transport', 'tms', false, ['tms']), {
    domainSystems: {}, repositoryIds: [],
  })
})

test('checking a category selects every child without clearing another category', () => {
  const empty = { domainSystems: { warehouse: ['wms'] }, repositoryIds: [] }
  assert.deepEqual(selectKnowledgeDomain(empty, 'transport', ['tms', 'oms'], true), {
    domainSystems: { warehouse: ['wms'], transport: ['tms', 'oms'] }, repositoryIds: [],
  })
  assert.deepEqual(selectKnowledgeDomain({ domainSystems: { warehouse: ['wms'], transport: ['tms'] }, repositoryIds: [] }, 'transport', ['tms', 'oms'], false), {
    domainSystems: { warehouse: ['wms'] }, repositoryIds: [],
  })
})

test('migrates saved and legacy multi-category selections without losing either category', () => {
  assert.deepEqual(migrateLegacyKnowledgeScope({
    enabled: true,
    scope: { hasCommon: false, domains: { transport: { self: false, systems: ['tms'] }, warehouse: { self: false, systems: ['wms'] } }, repoKeys: ['repo'] },
  }), {
    enabled: true,
    scope: { domainSystems: { transport: ['tms'], warehouse: ['wms'] }, repositoryIds: ['repo'] },
  })
})

test('keeps unselected composer buttons as empty labels so agents do not probe either side', () => {
  assert.deepEqual(scopeLabels({ domainSystems: {}, repositoryIds: [] }, snapshot.catalog), {
    repositories: undefined,
    knowledge: undefined,
  })
})

test('keeps an already selected repository visible when a catalog refresh omits it', () => {
  assert.deepEqual(scopeLabels(
    { ...snapshot.scope, repositoryIds: ['r1', 'OTP-后端-中台'] },
    { ...snapshot.catalog, repositories: [{ id: 'r1', name: 'OTP-后端-中台' }] },
  ), { repositories: 'OTP-后端-中台、OTP-后端-中台', knowledge: '订单知识库、库存知识库' })
})

test('accepts only an exact parent, nonce, and increasing knowledge snapshot sequence', () => {
  const bridge = createScopeProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' }); const parent = {}
  const message = { type: 'knowledge-scope-snapshot/v1', nonce: 'nonce', sequence: 1, snapshot }
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://other', data: message }, parent), false)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), true)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), false)
  assert.equal(bridge.source.value.sessionId, 'session-1')
})

test('accepts a bounded legacy-scope migration notice while the service is ready', () => {
  const bridge = createScopeProtocol({ createStore: store, nonce: 'nonce', parentOrigin: 'chrome-extension://abc' }); const parent = {}
  const message = { type: 'knowledge-scope-snapshot/v1', nonce: 'nonce', sequence: 1, snapshot }
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: message }, parent), true)
  assert.equal(bridge.source.value.notice, snapshot.notice)
  assert.equal(bridge.accept({ source: parent, origin: 'chrome-extension://abc', data: { ...message, sequence: 2, snapshot: { ...snapshot, notice: 'x'.repeat(2_001) } } }, parent), false)
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
