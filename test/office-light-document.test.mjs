import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserConnector } from '../native-server/src/connector.mjs'

async function call(endpoint, name, arguments_, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('dispatches a bounded light-document read through the Browser Target instead of routing it to spreadsheet A1 APIs', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/100?id=100' }
  let received
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      received = request
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
        browserTarget: target,
        result: {
          status: 'ok',
          resource: { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'doc-fingerprint' },
          document: { blockCount: 1, offset: 0, limit: 20, hasMore: false, blocks: [{ index: 0, id: 'block-1', type: 'paragraph', text: '演示内容' }] },
        },
      }))
    },
  })
  connector.bindBrowserTarget('light-doc-run', target)
  const endpoint = await connector.start()
  try {
    const listed = await call(endpoint, 'office_document', { action: 'read', offset: 0, limit: 20 })
    assert.equal(listed.result.structuredContent.resource.kind, 'webedit_light_document')
    assert.deepEqual(received, {
      type: 'connector_request', requestId: received.requestId, runId: 'light-doc-run', generation: received.generation,
      browserTarget: target, tool: 'office_document', action: 'read', offset: 0, limit: 20,
    })
  } finally {
    await connector.stop()
  }
})

test('requires a one-time light-document challenge and returns only a verified write readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 13, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/101?id=101' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: 'insert' }, observed: { text: '写入内容', verifiedFragments: ['写入内容'] } }
        : { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
  })
  connector.bindBrowserTarget('light-doc-write-run', target)
  const endpoint = await connector.start()
  try {
    const denied = await call(endpoint, 'office_document', { action: 'write', challenge: 'not-a-grant', idempotencyIdentity: 'write-1', operation: 'insert', payload: { markdown: '写入内容' } })
    assert.equal(denied.result.isError, true)
    assert.match(denied.result.content[0].text, /challenge/i)

    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write' }, 2)
    const written = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'insert', payload: { markdown: '写入内容' } }, 3)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(written.result.structuredContent.observed.text, '写入内容')

    const replay = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'insert', payload: { markdown: '写入内容' } }, 4)
    assert.equal(replay.result.isError, true)
  } finally {
    await connector.stop()
  }
})

test('expires or clears light-document challenges and bounds idempotency records', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 14, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/102?id=102' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: 'insert' }, observed: { text: '写入内容' } }
        : { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
  })
  connector.bindBrowserTarget('light-doc-lifecycle-run', target)
  const endpoint = await connector.start()
  const realNow = Date.now
  try {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write' })
    const challenge = inspected.result.structuredContent.challenge
    Date.now = () => realNow() + 60_001
    const expired = await call(endpoint, 'office_document', { action: 'write', challenge, idempotencyIdentity: 'expired-write', operation: 'insert', payload: { markdown: '写入内容' } }, 2)
    assert.equal(expired.result.isError, true)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    Date.now = realNow

    const forOldRun = await call(endpoint, 'office_document', { action: 'inspect_write' }, 3)
    connector.bindBrowserTarget('replacement-run', target)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    const staleRun = await call(endpoint, 'office_document', { action: 'write', challenge: forOldRun.result.structuredContent.challenge, idempotencyIdentity: 'stale-run-write', operation: 'insert', payload: { markdown: '写入内容' } }, 4)
    assert.equal(staleRun.result.isError, true)

    for (let index = 0; index < 256; index += 1) connector.officeDocumentWrites.set(`old-${index}`, { fingerprint: String(index), result: {} })
    const inspectedForWrite = await call(endpoint, 'office_document', { action: 'inspect_write' }, 5)
    const written = await call(endpoint, 'office_document', { action: 'write', challenge: inspectedForWrite.result.structuredContent.challenge, idempotencyIdentity: 'new-write', operation: 'insert', payload: { markdown: '写入内容' } }, 6)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(connector.officeDocumentWrites.size, 256)
    assert.equal(connector.officeDocumentWrites.has('old-0'), false)
    assert.equal(connector.officeDocumentWrites.has('new-write'), true)
  } finally {
    Date.now = realNow
    await connector.stop()
  }
})
