import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../native-server/src/connector.mjs'

const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const parent = {
  parentId: '9', bookId: '10', parentName: 'Root', parentType: 'directory',
  canRead: true, canCreate: true, fingerprint: 'parent-v2',
}

async function open(responder) {
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget, result: responder(request),
  })) })
  assert.equal(connector.bindBrowserTarget('run-item', target), true)
  const endpoint = await connector.start()
  const call = async (id, arguments_) => (await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'team_knowledge_item', arguments: arguments_ } }),
  })).json()
  return { connector, endpoint, call }
}

test('publishes one narrow Team Knowledge item tool for child light documents and spreadsheets', async () => {
  const connector = new BrowserConnector({ requestExtension: () => {} })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    const tool = (await response.json()).result.tools.find((item) => item.name === 'team_knowledge_item')
    assert.deepEqual(tool.inputSchema.properties.action.enum, ['inspect_parent', 'preview', 'create', 'readback'])
    assert.deepEqual(tool.inputSchema.properties.kind.enum, ['light_document', 'spreadsheet'])
    assert.equal(tool.annotations.destructiveHint, true)
  } finally { await connector.stop() }
})

test('binds the create grant to parent, kind, name and body and rejects challenge replay and changed payload', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true, spreadsheet: true } }
    : (++creates, { status: 'verified_write', item: { catalogId: '11', kind: request.kind, name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/11?id=11', fingerprint: 'item-11' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readback: { body: request.body } }))
  try {
    const identity = `child-${crypto.randomUUID()}`
    const inspected = await harness.call(1, { action: 'inspect_parent' })
    const preview = await harness.call(2, { action: 'preview', parentFingerprint: inspected.result.structuredContent.parent.fingerprint, kind: 'light_document', name: 'Child', body: '# child' })
    const challenge = preview.result.structuredContent.challenge
    const created = await harness.call(3, { action: 'create', challenge, idempotencyIdentity: identity, kind: 'light_document', name: 'Child', body: '# child' })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.equal(creates, 1)
    const replay = await harness.call(4, { action: 'create', challenge, idempotencyIdentity: identity, kind: 'light_document', name: 'Child', body: '# child' })
    assert.equal(replay.result.isError, true)
    const inspectAgain = await harness.call(5, { action: 'inspect_parent' })
    const previewAgain = await harness.call(6, { action: 'preview', parentFingerprint: inspectAgain.result.structuredContent.parent.fingerprint, kind: 'light_document', name: 'Child', body: '# child' })
    const changed = await harness.call(7, { action: 'create', challenge: previewAgain.result.structuredContent.challenge, idempotencyIdentity: identity, kind: 'spreadsheet', name: 'Child', body: '' })
    assert.equal(changed.result.isError, true)
    assert.match(changed.result.content[0].text, /identity|conflict/i)
  } finally { await harness.connector.stop() }
})

test('does not turn an HTTP-success business failure into a successful spreadsheet creation', async () => {
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true, spreadsheet: true } }
    : { status: 'partial_delivery', item: null, stages: ['parent_inspected'], failedAt: 'create', error: 'team_knowledge_create_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } })
  try {
    const identity = `sheet-${crypto.randomUUID()}`
    const inspect = await harness.call(1, { action: 'inspect_parent' })
    const preview = await harness.call(2, { action: 'preview', parentFingerprint: inspect.result.structuredContent.parent.fingerprint, kind: 'spreadsheet', name: 'Sheet', body: '' })
    const result = await harness.call(3, { action: 'create', challenge: preview.result.structuredContent.challenge, idempotencyIdentity: identity, kind: 'spreadsheet', name: 'Sheet', body: '' })
    assert.equal(result.result.structuredContent.status, 'partial_delivery')
    assert.equal(result.result.structuredContent.item, null)
    assert.equal(result.result.structuredContent.diagnostic.errorCode, '20001')
  } finally { await harness.connector.stop() }
})
