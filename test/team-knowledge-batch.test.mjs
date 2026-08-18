import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { TeamDocRecordStore } from '../apps/native-server/src/team-doc-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from '../apps/native-server/src/team-knowledge-batch-record-store.mjs'

const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const parent = { parentId: '9', bookId: '10', parentName: 'Root', parentType: 'directory', canRead: true, canCreate: true, fingerprint: 'parent-batch-v1' }
const documents = [{ name: 'One', body: '# One\nsecret one' }, { name: 'Two', body: '# Two\nsecret two' }]

// Matches Harness's current model-facing projection: it reads only top-level
// properties and required fields, ignoring JSON Schema composition such as oneOf.
function harnessProjectedArguments(schema) {
  return { required: schema.required ?? [], properties: Object.keys(schema.properties ?? {}).sort() }
}

function verified(request, id) {
  return { status: 'verified_write', item: { catalogId: id, kind: 'light_document', name: request.name, url: `https://doc.midea.com/teamKnowledge/detail/docOnline/${id}?id=${id}`, fingerprint: `item-${id}` }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readback: { body: request.body } }
}

async function open(responder, responseTarget = (request) => request.browserTarget) {
  const directory = await mkdtemp(join(tmpdir(), 'team-knowledge-batch-'))
  const batchStore = new TeamKnowledgeBatchRecordStore({ recordPath: join(directory, 'batch.json') })
  const teamDocStore = new TeamDocRecordStore({ recordPath: join(directory, 'items.json') })
  let connector
  const requests = []
  connector = new BrowserConnector({ teamKnowledgeBatchStore: batchStore, teamDocStore, requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => {
      const resolvedTarget = typeof responseTarget === 'function' ? responseTarget(request) : responseTarget
      if (request.action === 'inspect_parent') connector.bindBrowserTarget(request.runId, resolvedTarget)
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: resolvedTarget, result: responder(request) })
    })
  } })
  connector.bindBrowserTarget('batch-run', target)
  const endpoint = await connector.start()
  const callTool = async (name, id, arguments_) => (await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) })).json()
  const call = (id, arguments_) => callTool('team_knowledge_batch', id, arguments_)
  return { connector, batchStore, teamDocStore, directory, requests, call, callTool }
}

async function preview(harness, batchId, items = documents, id = 1) { return harness.call(id, { action: 'preview', batchId, parentFingerprint: parent.fingerprint, items }) }
async function create(harness, batchId, challenge, items = documents, id = 2) { return harness.call(id, { action: 'create', batchId, challenge, items }) }

test('publishes, creates, reports status, and stores a body-free batch of light documents', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, String(++creates)))
  try {
    const list = await fetch(`${harness.connector.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${harness.connector.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }) })
    const tools = (await list.json()).result.tools
    const previewTool = tools.find((candidate) => candidate.name === 'team_knowledge_batch_preview')
    const createTool = tools.find((candidate) => candidate.name === 'team_knowledge_batch_create')
    assert.equal(tools.some((candidate) => candidate.name === 'team_knowledge_batch'), false)
    assert.deepEqual(harnessProjectedArguments(previewTool.inputSchema), { required: ['batchId', 'items'], properties: ['batchId', 'items'] })
    assert.equal(previewTool.inputSchema.properties.items.maxItems, 10)
    assert.deepEqual(harnessProjectedArguments(createTool.inputSchema), { required: ['batchId', 'challenge', 'items'], properties: ['batchId', 'challenge', 'items'] })
    const plan = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'batch-success', items: documents })
    const result = await harness.callTool('team_knowledge_batch_create', 2, { batchId: 'batch-success', challenge: plan.result.structuredContent.challenge, items: documents })
    assert.equal(result.result.structuredContent.status, 'verified_write')
    assert.deepEqual(result.result.structuredContent.batch.items.map((item) => item.status), ['created', 'created'])
    const status = await harness.callTool('team_knowledge_batch_status', 3, { batchId: 'batch-success' })
    assert.equal(status.result.structuredContent.batch.status, 'completed'); assert.equal(creates, 2)
    const raw = await readFile(harness.batchStore.recordPath, 'utf8'); const itemRaw = await readFile(harness.teamDocStore.recordPath, 'utf8')
    assert.doesNotMatch(raw, /secret one|secret two|"body"/); assert.doesNotMatch(itemRaw, /secret one|secret two|"body"|observedBody/)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects a changed ordered payload after preview and does not create documents', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : (creates += 1, verified(request, '1')))
  try {
    const plan = await preview(harness, 'batch-drift'); const changed = [{ ...documents[1] }, { ...documents[0] }]
    const response = await create(harness, 'batch-drift', plan.result.structuredContent.challenge, changed)
    assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /challenge|changed/i); assert.equal(creates, 0)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('resumes only failed items and accepts a completed duplicate without duplicate creates', async () => {
  const calls = []; let twoAttempts = 0
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    calls.push(request.name)
    if (request.name === 'Two' && ++twoAttempts === 1) return { status: 'partial_delivery', item: { catalogId: '2', kind: 'light_document', name: 'Two', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2?id=2', fingerprint: 'item-2' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'], failedAt: 'readback', error: 'business_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } }
    return verified(request, request.name === 'One' ? '1' : '2')
  })
  try {
    const first = await preview(harness, 'batch-recover'); const partial = await create(harness, 'batch-recover', first.result.structuredContent.challenge)
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    assert.deepEqual(partial.result.structuredContent.batch.items.map((item) => item.status), ['created', 'failed'])
    const retry = await preview(harness, 'batch-recover', documents, 3); const done = await create(harness, 'batch-recover', retry.result.structuredContent.challenge, documents, 4)
    assert.equal(done.result.structuredContent.status, 'verified_write'); assert.deepEqual(calls, ['One', 'Two', 'Two'])
    const duplicate = await preview(harness, 'batch-recover', documents, 5); assert.equal(duplicate.result.structuredContent.status, 'already_completed')
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('serializes concurrent confirmed creates and accepts exactly ten items', async () => {
  let creates = 0
  const ten = Array.from({ length: 10 }, (_, index) => ({ name: `Doc ${index + 1}`, body: `body ${index + 1}` }))
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : (creates += 1, verified(request, String(creates))))
  try {
    const first = await preview(harness, 'batch-concurrent', ten); const second = await preview(harness, 'batch-concurrent', ten, 2)
    const [left, right] = await Promise.all([create(harness, 'batch-concurrent', first.result.structuredContent.challenge, ten, 3), create(harness, 'batch-concurrent', second.result.structuredContent.challenge, ten, 4)])
    assert.equal(left.result.structuredContent.status, 'verified_write'); assert.equal(right.result.structuredContent.status, 'verified_write'); assert.equal(creates, 10)
    const tooMany = await preview(harness, 'batch-too-many', [...ten, { name: 'Doc 11', body: 'body 11' }], 5)
    assert.equal(tooMany.error.code, -32602)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects non-canonical duplicate names before preview', async () => {
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    const response = await preview(harness, 'batch-spaces', [{ name: 'Doc', body: 'one' }, { name: 'Doc ', body: 'two' }])
    assert.equal(response.error.code, -32602)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('does not complete a batch from a schema-valid result for the wrong item', async () => {
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : {
    status: 'verified_write', item: { catalogId: '77', kind: 'spreadsheet', name: 'Wrong', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/77?id=77', fingerprint: 'wrong-77' },
    stages: ['parent_inspected', 'created', 'rediscovered', 'identity_readback_verified'], readback: { resource: {} },
  })
  try {
    const plan = await preview(harness, 'batch-wrong-item', [{ name: 'Right', body: '# Right' }])
    const response = await create(harness, 'batch-wrong-item', plan.result.structuredContent.challenge, [{ name: 'Right', body: '# Right' }])
    assert.equal(response.result.structuredContent.status, 'partial_delivery')
    assert.equal(response.result.structuredContent.batch.items[0].status, 'failed')
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('binds batch status to the current Run Browser Target and parent', async () => {
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    const plan = await preview(harness, 'batch-status-target', [{ name: 'One', body: '# One' }])
    await create(harness, 'batch-status-target', plan.result.structuredContent.challenge, [{ name: 'One', body: '# One' }])
    harness.connector.bindBrowserTarget('other-run', { ...target, tabId: 99 })
    const response = await harness.call(9, { action: 'status', batchId: 'batch-status-target' })
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /target_mismatch/i)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('uses the inspect-migrated Browser Target for batch grants, fingerprints, and every create', async () => {
  const migrated = { browser: 'chrome', windowId: 1, tabId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9?id=9' }
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(++creates)), migrated)
  try {
    const inspected = await harness.call(1, { action: 'inspect_parent' })
    assert.deepEqual(inspected.result.structuredContent.browserTarget, migrated)
    const plan = await preview(harness, 'migrated-batch', documents, 2)
    assert.deepEqual(plan.result.structuredContent.browserTarget, migrated)
    const created = await create(harness, 'migrated-batch', plan.result.structuredContent.challenge, documents, 3)
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.deepEqual(created.result.structuredContent.browserTarget, migrated)
    const record = await harness.batchStore.load('migrated-batch')
    assert.match(record.targetFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(creates, 2)
    assert.ok(harness.requests.every((request) => request.action === 'inspect_parent' || request.browserTarget.url === migrated.url))
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})
