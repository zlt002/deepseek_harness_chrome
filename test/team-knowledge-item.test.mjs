import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'

const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const parent = {
  parentId: '9', bookId: '10', parentName: 'Root', parentType: 'directory',
  canRead: true, canCreate: true, fingerprint: 'parent-v2',
}

async function open(responder, responseTarget = (request) => request.browserTarget) {
  const requests = []
  let connector
  connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => {
      const resolvedTarget = typeof responseTarget === 'function' ? responseTarget(request) : responseTarget
      if (request.action === 'inspect_parent') connector.bindBrowserTarget(request.runId, resolvedTarget)
      connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: resolvedTarget, result: responder(request) })
    })
  } })
  assert.equal(connector.bindBrowserTarget('run-item', target), true)
  const endpoint = await connector.start()
  const callTool = async (name, id, arguments_) => (await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })).json()
  const call = (id, arguments_) => callTool('team_knowledge_item', id, arguments_)
  return { connector, endpoint, requests, call, callTool }
}

test('publishes flat spreadsheet tools while retaining the legacy item dispatcher', async () => {
  const connector = new BrowserConnector({ requestExtension: () => {} })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    const tools = (await response.json()).result.tools
    assert.equal(tools.some((item) => item.name === 'team_knowledge_item'), false)
    const preview = tools.find((item) => item.name === 'team_knowledge_spreadsheet_preview')
    const create = tools.find((item) => item.name === 'team_knowledge_spreadsheet_create')
    const readback = tools.find((item) => item.name === 'team_knowledge_spreadsheet_readback')
    assert.deepEqual(preview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    assert.match(preview.description, /idempotency identity/)
    assert.deepEqual(preview.inputSchema.required, ['name', 'body'])
    assert.deepEqual(create.inputSchema.required, ['challenge', 'idempotencyIdentity', 'name', 'body'])
    assert.match(create.description, /does not populate cells/)
    assert.equal(create.annotations.destructiveHint, true)
    assert.deepEqual(readback.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  } finally { await connector.stop() }
})

test('forces the flat spreadsheet preview action and kind over raw caller overrides', async () => {
  const requests = []
  const harness = await open((request) => {
    requests.push(request)
    return { status: 'ok', parent, capabilities: { light_document: true, spreadsheet: true } }
  })
  try {
    const result = await harness.callTool('team_knowledge_spreadsheet_preview', 1, { action: 'create', kind: 'light_document', name: 'Sheet', body: '' })
    assert.equal(result.result.structuredContent.action, 'preview')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].action, 'inspect_parent')
  } finally { await harness.connector.stop() }
})

test('binds the create grant to parent, kind, name and body and rejects challenge replay and changed payload', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true, spreadsheet: true } }
    : (++creates, { status: 'verified_write', item: { catalogId: '11', kind: request.kind, name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/11?id=11', fingerprint: 'item-11' }, stages: request.kind === 'spreadsheet' ? ['parent_inspected', 'created', 'rediscovered', 'identity_readback_verified'] : ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readback: { body: request.body } }))
  try {
    const name = `Child ${crypto.randomUUID()}`
    const body = `# ${name}`
    const preview = await harness.callTool('team_knowledge_spreadsheet_preview', 2, { name, body })
    const challenge = preview.result.structuredContent.challenge
    const identity = preview.result.structuredContent.idempotencyIdentity
    const created = await harness.callTool('team_knowledge_spreadsheet_create', 3, { challenge, idempotencyIdentity: identity, name, body })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.equal(creates, 1)
    const replay = await harness.call(4, { action: 'create', challenge, idempotencyIdentity: identity, kind: 'light_document', name, body })
    assert.equal(replay.result.isError, true)
    const inspectAgain = await harness.call(5, { action: 'inspect_parent' })
    const previewAgain = await harness.call(6, { action: 'preview', parentFingerprint: inspectAgain.result.structuredContent.parent.fingerprint, kind: 'light_document', name, body })
    const changed = await harness.call(7, { action: 'create', challenge: previewAgain.result.structuredContent.challenge, idempotencyIdentity: identity, kind: 'spreadsheet', name, body: '' })
    assert.equal(changed.result.isError, true)
    assert.match(changed.result.content[0].text, /identity|conflict/i)
  } finally { await harness.connector.stop() }
})

test('surfaces a directory-required inspect result instead of a generic invalid parent', async () => {
  const harness = await open(() => ({ status: 'partial_delivery', item: null, stages: [], failedAt: 'inspect', error: 'team_doc_directory_required' }))
  try {
    const inspected = await harness.call(1, { action: 'inspect_parent' })
    assert.equal(inspected.result.isError, true)
    assert.equal(inspected.result.content[0].text, 'team_doc_directory_required')
    assert.equal(inspected.result.structuredContent, undefined)
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

test('adopts an inspect-migrated Browser Target for grants and never writes against the old target', async () => {
  const migrated = { browser: 'chrome', windowId: 1, tabId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9?id=9' }
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : { status: 'verified_write', item: { catalogId: '11', kind: request.kind, name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/11?id=11', fingerprint: 'item-11' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readback: { body: request.body } }, migrated)
  try {
    const inspected = await harness.call(1, { action: 'inspect_parent' })
    assert.deepEqual(inspected.result.structuredContent.browserTarget, migrated)
    const preview = await harness.call(2, { action: 'preview', parentFingerprint: parent.fingerprint, kind: 'light_document', name: 'Child', body: '# child' })
    assert.deepEqual(preview.result.structuredContent.browserTarget, migrated)
    const created = await harness.call(3, { action: 'create', challenge: preview.result.structuredContent.challenge, idempotencyIdentity: `migrated-child-${crypto.randomUUID()}`, kind: 'light_document', name: 'Child', body: '# child' })
    assert.equal(created.result.structuredContent.status, 'verified_write')
    assert.deepEqual(created.result.structuredContent.browserTarget, migrated)
    assert.ok(harness.requests.every((request) => request.action === 'inspect_parent' || request.browserTarget.url === migrated.url))
    assert.deepEqual(harness.requests.at(-1).browserTarget, migrated)
  } finally { await harness.connector.stop() }
})
