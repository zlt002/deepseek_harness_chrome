import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { TeamDocRecordStore } from '../apps/native-server/src/team-doc-record-store.mjs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('keeps legacy Team Knowledge creation tools out of the model-facing tool list', async () => {
  const connector = new BrowserConnector({ requestExtension: () => {} })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    const tools = (await response.json()).result.tools
    for (const legacy of ['team_doc_create', 'team_knowledge_batch', 'team_knowledge_item']) assert.equal(tools.some((item) => item.name === legacy), false)
    for (const modelTool of ['team_knowledge_batch_preview', 'team_knowledge_batch_create', 'team_knowledge_batch_status', 'team_knowledge_spreadsheet_preview', 'team_knowledge_spreadsheet_create']) assert.ok(tools.some((item) => item.name === modelTool))
  } finally { await connector.stop() }
})

test('accepts empty known inspect placeholders but rejects non-empty and unknown fields', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget,
    result: { parent: { parentId: '9', bookId: '10', parentName: 'Root', canRead: true, canCreate: true, fingerprint: 'parent-1' } },
  })) })
  connector.bindBrowserTarget('run-doc', target)
  const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'team_doc_create', arguments: arguments_ } }) })).json()
  try {
    const accepted = await call(1, { phase: 'inspect', name: '', body: '', challenge: '', idempotencyIdentity: '' })
    assert.equal(typeof accepted.result.structuredContent.challenge, 'string')
    for (const [id, arguments_] of [
      [2, { phase: 'inspect', name: 'not-empty' }],
      [3, { phase: 'inspect', unexpected: '' }],
    ]) {
      const rejected = await call(id, arguments_)
      assert.equal(rejected.error?.code, -32602)
    }
  } finally { await connector.stop() }
})

test('does not issue an approval challenge for a non-creatable parent', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/x' }
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget,
    result: { parent: { parentId: '9', bookId: '10', parentName: 'Root', canRead: true, canCreate: false, fingerprint: 'parent-1' } },
  })) })
  connector.bindBrowserTarget('run-doc', target)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'team_doc_create', arguments: { phase: 'inspect' } } }) })
    const result = (await response.json()).result
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /invalid Team Doc parent/)
  } finally { await connector.stop() }
})

test('surfaces a directory-required inspect result without issuing a challenge', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9' }
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget,
    result: { status: 'partial_delivery', documentId: null, stages: [], readbackMatches: false, failedAt: 'inspect', error: 'team_doc_directory_required' },
  })) })
  connector.bindBrowserTarget('run-doc', target)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'team_doc_create', arguments: { phase: 'inspect' } } }) })
    const result = (await response.json()).result
    assert.equal(result.isError, true)
    assert.equal(result.content[0].text, 'team_doc_directory_required')
    assert.equal(result.structuredContent, undefined)
  } finally { await connector.stop() }
})

test('surfaces redacted inspect stage diagnostics for source lookup failures', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9' }
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget,
    result: { status: 'partial_delivery', documentId: null, stages: [], readbackMatches: false, failedAt: 'inspect', error: 'team_doc_parent_inspection_failed',
      diagnostic: { stage: 'source_internal', httpStatus: 503, errorCode: 'INTERNAL_DOWN', attempts: [{ stage: 'source_openapi', httpStatus: 200, errorCode: '20001' }, { stage: 'source_internal', httpStatus: 503, errorCode: 'INTERNAL_DOWN' }] } },
  })) })
  connector.bindBrowserTarget('run-doc', target)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'team_doc_create', arguments: { phase: 'inspect' } } }) })
    const result = (await response.json()).result
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /stage=source_internal/)
    assert.match(result.content[0].text, /httpStatus=503/)
    assert.match(result.content[0].text, /errorCode=INTERNAL_DOWN/)
    assert.match(result.content[0].text, /attempts=source_openapi:200\/20001,source_internal:503\/INTERNAL_DOWN/)
    assert.doesNotMatch(result.content[0].text, /SECRET/)
  } finally { await connector.stop() }
})

test('requires a one-time inspect challenge then reuses a verified record without another create', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/x' }; let creates = 0
  const store = new TeamDocRecordStore({ recordPath: join(await mkdtemp(join(tmpdir(), 'dsh-doc-')), 'state.json') })
  const connector = new BrowserConnector({ teamDocStore: store, requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result: request.phase === 'inspect' ? { parent: { parentId: '9007199254740993', bookId: '9', parentName: 'Root', canRead: true, canCreate: true, fingerprint: 'parent-1' } } : (++creates, { status: 'verified_write', documentId: '9007199254740993', stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readbackMatches: true, observedBody: '# one' }) })) })
  connector.bindBrowserTarget('run-doc', target); const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'team_doc_create', arguments: arguments_ } }) })).json()
  try {
    const inspect = await call(1, { phase: 'inspect' }); const challenge = inspect.result.structuredContent.challenge
    const created = await call(2, { phase: 'create', challenge, idempotencyIdentity: 'one', name: 'One', body: '# one' })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    const inspectAgain = await call(3, { phase: 'inspect' })
    const retried = await call(4, { phase: 'create', challenge: inspectAgain.result.structuredContent.challenge, idempotencyIdentity: 'one', name: 'One', body: '# one' })
    assert.equal(retried.result.structuredContent.documentId, '9007199254740993'); assert.equal(creates, 1)
  } finally { await connector.stop() }
})

test('uses the Team Knowledge write timeout only for a Team Doc create', async () => {
  const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
  const cancelled = []
  let answerInspects = true
  let connector
  connector = new BrowserConnector({
    requestTimeoutMs: 5,
    teamKnowledgeWriteRequestTimeoutMs: 60,
    requestExtension: (request) => {
      if (request.type === 'connector_cancel') { cancelled.push(request); return }
      if (request.phase === 'inspect') {
        if (!answerInspects) return
        queueMicrotask(() => connector.acceptExtensionResponse({
          type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
          result: { parent: { parentId: '9', bookId: '10', parentName: 'Root', canRead: true, canCreate: true, fingerprint: 'parent-1' } },
        }))
        return
      }
      setTimeout(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
        result: { status: 'verified_write', documentId: '9007199254740993', stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readbackMatches: true, observedBody: '# One' },
      }), 20)
    },
  })
  connector.bindBrowserTarget('run-doc-timeout', target)
  const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'team_doc_create', arguments: arguments_ } }),
  })).json()
  try {
    const inspect = await call(1, { phase: 'inspect' })
    const created = await call(2, { phase: 'create', challenge: inspect.result.structuredContent.challenge, idempotencyIdentity: 'timeout-one', name: 'One', body: '# One' })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.equal(cancelled.length, 0, 'the short generic timeout must not cancel a write still within its dedicated budget')

    answerInspects = false
    const timedOutInspect = await call(3, { phase: 'inspect' })
    assert.equal(timedOutInspect.result.isError, true)
    assert.match(timedOutInspect.result.content[0].text, /timed out waiting for the Extension peer/)
    assert.equal(cancelled.length, 1)
  } finally { await connector.stop() }
})

const recoveryTarget = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const recoveryParent = { parentId: '9', bookId: '10', parentName: 'Root', canRead: true, canCreate: true, fingerprint: 'parent-1' }
const recoveryDocumentId = '9007199254740993'
const recoveryBody = '# recover me'

async function openTeamDocConnector({ store, responder }) {
  const requests = []
  let connector
  connector = new BrowserConnector({
    teamDocStore: store,
    requestExtension: (request) => {
      requests.push(request)
      queueMicrotask(async () => {
        const result = await responder(request)
        connector.acceptExtensionResponse({
          type: 'connector_response', requestId: request.requestId, runId: request.runId,
          generation: request.generation, browserTarget: request.browserTarget, result,
        })
      })
    },
  })
  assert.equal(connector.bindBrowserTarget('run-doc', recoveryTarget), true)
  const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'team_doc_create', arguments: arguments_ } }),
  })).json()
  return { connector, endpoint, requests, call }
}

function partialResult(failedAt, stages) {
  return {
    status: 'partial_delivery', documentId: recoveryDocumentId, stages, readbackMatches: false,
    failedAt, error: `team_doc_${failedAt}_failed`,
  }
}

const inspectResult = { parent: recoveryParent }
const verifiedResult = {
  status: 'verified_write', documentId: recoveryDocumentId,
  stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'],
  readbackMatches: true, observedBody: recoveryBody,
}

test('persists a rediscovery partial, then resumes it with recovery identity without creating a duplicate', async () => {
  const store = new TeamDocRecordStore({ recordPath: join(await mkdtemp(join(tmpdir(), 'dsh-doc-recovery-')), 'state.json') })
  let createCalls = 0
  const first = await openTeamDocConnector({ store, responder: (request) => {
    if (request.phase === 'inspect') return inspectResult
    createCalls += 1
    return partialResult('rediscover', ['parent_inspected', 'created'])
  } })
  try {
    const firstInspect = await first.call(1, { phase: 'inspect' })
    const firstCreate = await first.call(2, { phase: 'create', challenge: firstInspect.result.structuredContent.challenge, idempotencyIdentity: 'recover-one', name: 'One', body: recoveryBody })
    assert.equal(firstCreate.result.structuredContent.status, 'partial_delivery')
    const saved = await store.load('recover-one')
    assert.equal(saved.documentId, recoveryDocumentId)
    assert.deepEqual(saved.stages, ['parent_inspected', 'created'])
  } finally { await first.connector.stop() }

  let recoveryRequest
  const second = await openTeamDocConnector({ store, responder: (request) => {
    if (request.phase === 'inspect') return inspectResult
    recoveryRequest = request
    if (!request.recovery) createCalls += 1
    return verifiedResult
  } })
  try {
    const secondInspect = await second.call(3, { phase: 'inspect' })
    const resumed = await second.call(4, { phase: 'create', challenge: secondInspect.result.structuredContent.challenge, idempotencyIdentity: 'recover-one', name: 'One', body: recoveryBody })
    assert.equal(resumed.result.structuredContent.status, 'verified_write')
    assert.deepEqual(recoveryRequest.recovery, { documentId: recoveryDocumentId, stages: ['parent_inspected', 'created'] })
    assert.equal(createCalls, 1, 'the retry must not issue a second document create')
    assert.equal((await store.load('recover-one')).verified, true)
  } finally { await second.connector.stop() }
})

test('retains confirmed stages and resumes a readback mismatch partial', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-doc-readback-')), 'state.json')
  const store = new TeamDocRecordStore({ recordPath: path })
  let createCalls = 0
  const first = await openTeamDocConnector({ store, responder: (request) => {
    if (request.phase === 'inspect') return inspectResult
    createCalls += 1
    return partialResult('readback', ['parent_inspected', 'created', 'rediscovered', 'body_written'])
  } })
  try {
    const inspect = await first.call(5, { phase: 'inspect' })
    const partial = await first.call(6, { phase: 'create', challenge: inspect.result.structuredContent.challenge, idempotencyIdentity: 'recover-readback', name: 'One', body: recoveryBody })
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    assert.deepEqual((await store.load('recover-readback')).stages, ['parent_inspected', 'created', 'rediscovered', 'body_written'])
  } finally { await first.connector.stop() }

  let requestOnRetry
  const second = await openTeamDocConnector({ store, responder: (request) => {
    if (request.phase === 'inspect') return inspectResult
    requestOnRetry = request
    if (!request.recovery) createCalls += 1
    return verifiedResult
  } })
  try {
    const retryInspect = await second.call(7, { phase: 'inspect' })
    const resumed = await second.call(8, { phase: 'create', challenge: retryInspect.result.structuredContent.challenge, idempotencyIdentity: 'recover-readback', name: 'One', body: recoveryBody })
    assert.equal(resumed.result.structuredContent.status, 'verified_write')
    assert.deepEqual(requestOnRetry.recovery, { documentId: recoveryDocumentId, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'] })
    assert.equal(createCalls, 1)
  } finally { await second.connector.stop() }
})

test('rejects challenge replay, target drift, and idempotency body mismatch', async () => {
  const store = new TeamDocRecordStore({ recordPath: join(await mkdtemp(join(tmpdir(), 'dsh-doc-guards-')), 'state.json') })
  let creates = 0
  const harness = await openTeamDocConnector({ store, responder: (request) => {
    if (request.phase === 'inspect') return inspectResult
    creates += 1
    return verifiedResult
  } })
  try {
    const inspect = await harness.call(9, { phase: 'inspect' })
    const challenge = inspect.result.structuredContent.challenge
    const created = await harness.call(10, { phase: 'create', challenge, idempotencyIdentity: 'guarded', name: 'One', body: recoveryBody })
    assert.equal(created.result.structuredContent.status, 'verified_write')

    const replay = await harness.call(11, { phase: 'create', challenge, idempotencyIdentity: 'guarded', name: 'One', body: recoveryBody })
    assert.equal(replay.result.isError, true)
    assert.match(replay.result.content[0].text, /challenge/i)

    const targetInspect = await harness.call(12, { phase: 'inspect' })
    const targetChallenge = targetInspect.result.structuredContent.challenge
    assert.equal(harness.connector.bindBrowserTarget('run-doc', { ...recoveryTarget, tabId: 3, url: 'https://doc.midea.com/teamKnowledge/catalog/11' }), true)
    const targetDrift = await harness.call(13, { phase: 'create', challenge: targetChallenge, idempotencyIdentity: 'guarded', name: 'One', body: recoveryBody })
    assert.equal(targetDrift.result.isError, true)
    assert.match(targetDrift.result.content[0].text, /challenge|target/i)

    const bodyInspect = await harness.call(14, { phase: 'inspect' })
    const bodyMismatch = await harness.call(15, { phase: 'create', challenge: bodyInspect.result.structuredContent.challenge, idempotencyIdentity: 'guarded', name: 'One', body: '# different' })
    assert.equal(bodyMismatch.result.isError, true)
    assert.match(bodyMismatch.result.content[0].text, /body|idempotency/i)
    assert.equal(creates, 1)
  } finally { await harness.connector.stop() }
})
