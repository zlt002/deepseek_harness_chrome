import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { TeamDocRecordStore } from '../apps/native-server/src/team-doc-record-store.mjs'
import { PmdDeliveryRecordStore } from '../apps/native-server/src/pmd-delivery-record-store.mjs'

const target = { browser: 'chrome', windowId: 7, tabId: 8, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const parent = { parentId: '9', bookId: '10', parentName: 'PMD', parentType: 'directory', canRead: true, canCreate: true, fingerprint: 'parent-pmd-1' }
const requirementId = 'REQ-20260816-001'
const deliveryRunId = 'delivery-1'
const documents = [
  { kind: 'analysis', name: `${requirementId}_订单预警_01_需求分析与研发交付`, body: '# 需求分析\n完整正文' },
  { kind: 'prd', name: `${requirementId}_订单预警_02_PRD`, body: '# PRD\n完整正文' },
]

function verified(request, catalogId) {
  return {
    status: 'verified_write',
    item: { catalogId, kind: 'light_document', name: request.name, url: `https://doc.midea.com/teamKnowledge/detail/docOnline/${catalogId}?id=${catalogId}`, fingerprint: `item-${catalogId}` },
    stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'],
    readback: { body: request.body },
  }
}

async function open(responder, responseTarget = (request) => request.browserTarget) {
  const directory = await mkdtemp(join(tmpdir(), 'pmd-prd-delivery-'))
  const pmdDeliveryStore = new PmdDeliveryRecordStore({ recordPath: join(directory, 'pmd.json') })
  const teamDocStore = new TeamDocRecordStore({ recordPath: join(directory, 'items.json') })
  let connector
  const requests = []
  connector = new BrowserConnector({ pmdDeliveryStore, teamDocStore, requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => {
      const resolvedTarget = typeof responseTarget === 'function' ? responseTarget(request) : responseTarget
      if (request.action === 'inspect_parent') connector.bindBrowserTarget(request.runId, resolvedTarget)
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: resolvedTarget, result: responder(request) })
    })
  } })
  assert.equal(connector.bindBrowserTarget('run-pmd', target), true)
  const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pmd_prd_delivery', arguments: arguments_ } }),
  })).json()
  return { connector, endpoint, pmdDeliveryStore, teamDocStore, requests, call }
}

test('publishes a fixed two-document PMD delivery tool', async () => {
  const harness = await open(() => ({ status: 'ok', parent, capabilities: { light_document: true } }))
  try {
    const listed = await fetch(`${harness.endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${harness.endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    const tool = (await listed.json()).result.tools.find((candidate) => candidate.name === 'pmd_prd_delivery')
    assert.deepEqual(tool.inputSchema.properties.action.enum, ['inspect_parent', 'preview', 'create', 'status'])
    assert.match(tool.inputSchema.properties.action.description, /status requires requirementId and deliveryRunId/)
    assert.match(tool.inputSchema.properties.deliveryRunId.description, /reused unchanged/)
    assert.match(tool.inputSchema.properties.challenge.description, /fresh preview performed after user confirmation/)
    assert.equal(tool.inputSchema.properties.documents.minItems, 2)
    assert.equal(tool.inputSchema.properties.documents.maxItems, 2)
  } finally { await harness.connector.stop() }
})

test('creates exactly two approved PMD light documents and persists body-free readback state', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(101 + creates++)))
  try {
    const preview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    assert.ok(preview.result.structuredContent.expiresAt - Date.now() > 9 * 60_000)
    const result = await harness.call(2, { action: 'create', requirementId, deliveryRunId, challenge: preview.result.structuredContent.challenge, documents })
    assert.equal(result.result.structuredContent.status, 'verified_write')
    assert.equal(creates, 2)
    assert.deepEqual(result.result.structuredContent.delivery.documents.map((item) => item.status), ['created', 'created'])
    const raw = await readFile(harness.pmdDeliveryStore.recordPath, 'utf8')
    assert.doesNotMatch(raw, /完整正文/)
    const itemRaw = await readFile(harness.teamDocStore.recordPath, 'utf8')
    assert.doesNotMatch(itemRaw, /完整正文|"body"|observedBody/)
  } finally { await harness.connector.stop() }
})

test('resumes only the unfinished PRD after a partial delivery', async () => {
  const calls = []
  let prdAttempts = 0
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    calls.push({ name: request.name, recovery: request.recovery })
    if (request.name.endsWith('_01_需求分析与研发交付')) return verified(request, '201')
    prdAttempts += 1
    if (prdAttempts === 1) return {
      status: 'partial_delivery',
      item: { catalogId: '202', kind: 'light_document', name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/202?id=202', fingerprint: 'item-202' },
      stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'], failedAt: 'readback', error: 'readback_mismatch',
    }
    assert.deepEqual(request.recovery, { catalogId: '202', stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'] })
    return verified(request, '202')
  })
  try {
    const firstPreview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    const partial = await harness.call(2, { action: 'create', requirementId, deliveryRunId, challenge: firstPreview.result.structuredContent.challenge, documents })
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    assert.deepEqual(partial.result.structuredContent.delivery.documents.map((item) => item.status), ['created', 'failed'])
    const retryPreview = await harness.call(3, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    const completed = await harness.call(4, { action: 'create', requirementId, deliveryRunId, challenge: retryPreview.result.structuredContent.challenge, documents })
    assert.equal(completed.result.structuredContent.status, 'verified_write')
    assert.equal(calls.filter((call) => call.name.endsWith('_01_需求分析与研发交付')).length, 1)
    assert.equal(calls.filter((call) => call.name.endsWith('_02_PRD')).length, 2)
  } finally { await harness.connector.stop() }
})

test('rejects changed document content after preview without creating anything', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++creates, verified(request, '301')))
  try {
    const preview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    const changed = documents.map((item) => item.kind === 'prd' ? { ...item, body: `${item.body}\nchanged` } : item)
    const result = await harness.call(2, { action: 'create', requirementId, deliveryRunId, challenge: preview.result.structuredContent.challenge, documents: changed })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /pmd_delivery_challenge_content_changed/)
    assert.equal(creates, 0)
  } finally { await harness.connector.stop() }
})

test('reports an expired PMD approval grant without reaching document creation', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++creates, verified(request, '351')))
  try {
    const preview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId: 'delivery-expired', parentFingerprint: parent.fingerprint, documents })
    const challenge = preview.result.structuredContent.challenge
    harness.connector.pmdDeliveryChallenges.get(challenge).expiresAt = Date.now() - 1
    const result = await harness.call(2, { action: 'create', requirementId, deliveryRunId: 'delivery-expired', challenge, documents })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /pmd_delivery_challenge_expired/)
    assert.equal(creates, 0)
  } finally { await harness.connector.stop() }
})

test('reports a consumed PMD approval grant separately from expiry', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(361 + creates++)))
  try {
    const preview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId: 'delivery-consumed', parentFingerprint: parent.fingerprint, documents })
    const challenge = preview.result.structuredContent.challenge
    const created = await harness.call(2, { action: 'create', requirementId, deliveryRunId: 'delivery-consumed', challenge, documents })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    const replay = await harness.call(3, { action: 'create', requirementId, deliveryRunId: 'delivery-consumed', challenge, documents })
    assert.equal(replay.result.isError, true)
    assert.match(replay.result.content[0].text, /pmd_delivery_challenge_missing_or_already_used/)
    assert.equal(creates, 2)
  } finally { await harness.connector.stop() }
})

test('serializes two confirmed creates for one delivery run without duplicate documents', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(401 + creates++)))
  try {
    const first = await harness.call(1, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    const second = await harness.call(2, { action: 'preview', requirementId, deliveryRunId, parentFingerprint: parent.fingerprint, documents })
    const results = await Promise.all([
      harness.call(3, { action: 'create', requirementId, deliveryRunId, challenge: first.result.structuredContent.challenge, documents }),
      harness.call(4, { action: 'create', requirementId, deliveryRunId, challenge: second.result.structuredContent.challenge, documents }),
    ])
    assert.equal(creates, 2)
    assert.deepEqual(results.map((result) => result.result.structuredContent.status), ['verified_write', 'verified_write'])
  } finally { await harness.connector.stop() }
})

test('keeps PMD preview and both creates on the Browser Target resolved by inspection', async () => {
  const migrated = { browser: 'chrome', windowId: 7, tabId: 18, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9?id=9' }
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(501 + creates++)), migrated)
  try {
    const preview = await harness.call(1, { action: 'preview', requirementId, deliveryRunId: 'delivery-migrated', parentFingerprint: parent.fingerprint, documents })
    assert.deepEqual(preview.result.structuredContent.browserTarget, migrated)
    const created = await harness.call(2, { action: 'create', requirementId, deliveryRunId: 'delivery-migrated', challenge: preview.result.structuredContent.challenge, documents })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.deepEqual(created.result.structuredContent.browserTarget, migrated)
    assert.equal(creates, 2)
    assert.ok(harness.requests.every((request) => request.action === 'inspect_parent' || request.browserTarget.url === migrated.url))
  } finally { await harness.connector.stop() }
})
