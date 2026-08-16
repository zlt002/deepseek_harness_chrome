import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserConnector } from '../native-server/src/connector.mjs'
import { OfficeDocumentWriteRecordStore } from '../native-server/src/office-document-write-record-store.mjs'

function writeStore() { return new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-light-document-${randomUUID()}.json`) }) }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

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
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { text: '写入内容', verifiedFragments: ['写入内容'], verified: true } }
        : { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
    officeDocumentWriteStore: writeStore(),
  })
  connector.bindBrowserTarget('light-doc-write-run', target)
  const endpoint = await connector.start()
  try {
    const denied = await call(endpoint, 'office_document', { action: 'write', challenge: 'not-a-grant', idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } })
    assert.equal(denied.result.isError, true)
    assert.match(denied.result.content[0].text, /challenge/i)

    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: '写入内容' } }, 2)
    const written = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } }, 3)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(written.result.structuredContent.observed.text, '写入内容')

    const replay = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } }, 4)
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
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { text: '写入内容', verified: true } }
        : { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
    officeDocumentWriteStore: writeStore(),
  })
  connector.bindBrowserTarget('light-doc-lifecycle-run', target)
  const endpoint = await connector.start()
  const realNow = Date.now
  try {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: '写入内容' } })
    const challenge = inspected.result.structuredContent.challenge
    Date.now = () => realNow() + 60_001
    const expired = await call(endpoint, 'office_document', { action: 'write', challenge, idempotencyIdentity: 'expired-write', operation: 'title', payload: { markdown: '写入内容' } }, 2)
    assert.equal(expired.result.isError, true)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    Date.now = realNow

    const forOldRun = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: '写入内容' } }, 3)
    connector.bindBrowserTarget('replacement-run', target)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    const staleRun = await call(endpoint, 'office_document', { action: 'write', challenge: forOldRun.result.structuredContent.challenge, idempotencyIdentity: 'stale-run-write', operation: 'title', payload: { markdown: '写入内容' } }, 4)
    assert.equal(staleRun.result.isError, true)

    for (let index = 0; index < 256; index += 1) connector.officeDocumentWrites.set(`old-${index}`, { fingerprint: String(index), result: {} })
    const inspectedForWrite = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: '写入内容' } }, 5)
    const written = await call(endpoint, 'office_document', { action: 'write', challenge: inspectedForWrite.result.structuredContent.challenge, idempotencyIdentity: 'new-write', operation: 'title', payload: { markdown: '写入内容' } }, 6)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(connector.officeDocumentWrites.size, 256)
    assert.equal(connector.officeDocumentWrites.has('old-0'), false)
    assert.equal(connector.officeDocumentWrites.has('new-write'), true)
  } finally {
    Date.now = realNow
    await connector.stop()
  }
})

test('forwards bounded extended light-document reads and challenged export writes', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 15, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/103?id=103' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const received = []
  const connector = new BrowserConnector({
    requestExtension: (request) => { received.push(request); queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } }
        : { status: 'ok', resource, document: request.payload?.kind === 'word_count' ? { supported: true, wordCount: { words: 12 } } : { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })) },
    officeDocumentWriteStore: writeStore(),
  })
  connector.bindBrowserTarget('light-doc-extended-run', target)
  const endpoint = await connector.start()
  try {
    const words = await call(endpoint, 'office_document', { action: 'read', payload: { kind: 'word_count' } })
    assert.equal(words.result.structuredContent.document.wordCount.words, 12)
    assert.deepEqual(received[0].payload, { kind: 'word_count' })
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'x' } }, 2)
    const exported = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'insert-1', operation: 'title', payload: { markdown: 'x' } }, 3)
    assert.equal(exported.result.structuredContent.status, 'verified_write')
    assert.equal(received.at(-1).operation, 'title')
  } finally { await connector.stop() }
})

test('binds approval and extension readback to the exact operation and payload, then fences uncertain writes', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 16, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/104?id=104' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  let writes = 0
  const connector = new BrowserConnector({
    officeDocumentWriteStore: writeStore(),
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? (writes += 1, { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: { markdown: 'wrong' } }, observed: { verified: true } })
        : { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
  })
  connector.bindBrowserTarget('light-doc-contract-run', target); const endpoint = await connector.start()
  try {
    const inspection = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'right' } })
    const mismatch = await call(endpoint, 'office_document', { action: 'write', challenge: inspection.result.structuredContent.challenge, idempotencyIdentity: 'contract-1', operation: 'title', payload: { markdown: 'wrong' } }, 2)
    assert.equal(mismatch.result.isError, true); assert.match(mismatch.result.content[0].text, /approval/i); assert.equal(writes, 0)
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'right' } }, 3)
    const invalid = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'contract-1', operation: 'title', payload: { markdown: 'right' } }, 4)
    assert.equal(invalid.result.isError, true); assert.equal(writes, 1)
    const retryInspection = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'right' } }, 5)
    const retry = await call(endpoint, 'office_document', { action: 'write', challenge: retryInspection.result.structuredContent.challenge, idempotencyIdentity: 'contract-1', operation: 'title', payload: { markdown: 'right' } }, 6)
    assert.equal(retry.result.isError, true); assert.match(retry.result.content[0].text, /uncertain/i); assert.equal(writes, 1)
    const paste = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'paste_image', payload: {} }, 7)
    assert.equal(paste.error.code, -32602)
  } finally { await connector.stop() }
})

test('accepts exact ordered blocks_delete and blocks_format readback through the Connector', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 19, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/107?id=107' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '批量文档', fingerprint: 'before' }
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
    result: request.action !== 'write' ? { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [] } }
      : request.operation === 'blocks_delete'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after-delete' }, requested: { operation: request.operation, payload: request.payload, count: 2 }, observed: { verifiedBlocks: request.payload.blocks.map((item) => ({ id: item.id, deleted: true })), verified: true } }
        : { status: 'verified_write', resource: { ...resource, fingerprint: 'after-format' }, requested: { operation: request.operation, payload: request.payload, count: 2 }, observed: { verifiedBlocks: request.payload.blocks.map((item) => ({ id: item.id, text: item.id, type: item.style.blockType ?? 'p', style: item.style })), verified: true } },
  })) })
  connector.bindBrowserTarget('light-doc-batch-success-run', target); const endpoint = await connector.start()
  const write = async (operation, payload, identity, id) => {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation, payload }, id)
    return call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation, payload }, id + 1)
  }
  try {
    const deleted = await write('blocks_delete', { blocks: [{ id: 'two' }, { id: 'one' }] }, 'batch-delete-success', 1)
    assert.equal(deleted.result.structuredContent.status, 'verified_write'); assert.deepEqual(deleted.result.structuredContent.observed.verifiedBlocks.map((item) => item.id), ['two', 'one'])
    const formatted = await write('blocks_format', { blocks: [{ id: 'one', style: { bold: true, blockType: 'h2' } }, { id: 'two', style: { italic: false } }] }, 'batch-format-success', 3)
    assert.equal(formatted.result.structuredContent.status, 'verified_write'); assert.deepEqual(formatted.result.structuredContent.observed.verifiedBlocks.map((item) => item.id), ['one', 'two'])
  } finally { await connector.stop() }
})

test('rejects forged batch operation, partial ordered readback, and wrong target, then fences retries', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 20, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/108?id=108' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '批量文档', fingerprint: 'before' }
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action !== 'write') return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [] } } })
    writes += 1; const marker = request.payload.blocks[0].id
    const verifiedBlocks = request.payload.blocks.map((item) => ({ id: item.id, deleted: true }))
    const result = { status: 'verified_write', resource: marker === 'wrong-target' ? { ...resource, documentName: '另一文档', fingerprint: 'after' } : { ...resource, fingerprint: 'after' }, requested: { operation: marker === 'wrong-operation' ? 'delete' : request.operation, payload: request.payload, count: request.payload.blocks.length }, observed: { verifiedBlocks: marker === 'partial' ? verifiedBlocks.slice(0, 1) : verifiedBlocks, verified: true } }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result })
  }) })
  connector.bindBrowserTarget('light-doc-batch-forgery-run', target); const endpoint = await connector.start()
  const write = async (payload, identity, id) => {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'blocks_delete', payload }, id)
    return call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation: 'blocks_delete', payload }, id + 1)
  }
  try {
    for (const [marker, identity, id] of [['wrong-operation', 'forged-operation', 1], ['partial', 'partial-readback', 3], ['wrong-target', 'wrong-target-readback', 5]]) {
      const payload = { blocks: [{ id: marker }, { id: 'second' }] }; const result = await write(payload, identity, id)
      assert.equal(result.result.isError, true)
    }
    assert.equal(writes, 3)
    const retry = await write({ blocks: [{ id: 'partial' }, { id: 'second' }] }, 'partial-readback', 7)
    assert.equal(retry.result.isError, true); assert.match(retry.result.content[0].text, /uncertain/i); assert.equal(writes, 3)
  } finally { await connector.stop() }
})

test('persists a timeout checkpoint across connector restart and never repeats the mutation', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 17, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/105?id=105' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const store = writeStore(); let writes = 0
  const responder = (connector, respondWrite) => (request) => {
    if (request.action === 'write') { writes += 1; if (!respondWrite) return }
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: request.action === 'write' ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } } : { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } } }))
  }
  let first
  first = new BrowserConnector({ officeDocumentWriteStore: store, requestTimeoutMs: 10, requestExtension: responder(first, false) })
  // Rebind now that the connector exists; the closure resolves it at request time.
  first.requestExtension = responder(first, false); first.bindBrowserTarget('light-doc-recovery-run', target); const endpoint = await first.start()
  try {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'x' } })
    const timedOut = await call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'timeout-1', operation: 'title', payload: { markdown: 'x' } }, 2)
    assert.equal(timedOut.result.isError, true); assert.equal(writes, 1)
  } finally { await first.stop() }
  let second
  second = new BrowserConnector({ officeDocumentWriteStore: store, requestExtension: responder(second, true) }); second.requestExtension = responder(second, true); second.bindBrowserTarget('light-doc-recovery-run', target); const restarted = await second.start()
  try {
    const inspected = await call(restarted, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'x' } })
    const retry = await call(restarted, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'timeout-1', operation: 'title', payload: { markdown: 'x' } }, 2)
    assert.equal(retry.result.isError, true); assert.match(retry.result.content[0].text, /uncertain/i); assert.equal(writes, 1)
  } finally { await second.stop() }
})

test('never dispatches a historical pending checkpoint or two concurrent writes with one identity', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 18, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/106?id=106' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const store = writeStore()
  const payload = { markdown: 'same' }
  await store.create({ idempotencyIdentity: 'crash-1', targetFingerprint: sha256(canonicalJson(target)), resourceFingerprint: resource.fingerprint, operation: 'title', payloadHash: sha256(canonicalJson({ operation: 'title', payload })) })
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: store, requestExtension: (request) => {
    if (request.action === 'write') { writes += 1; setTimeout(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } } }), 20); return }
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } } }))
  } })
  connector.bindBrowserTarget('light-doc-pending-run', target); const endpoint = await connector.start()
  try {
    const historical = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload })
    const historicalRetry = await call(endpoint, 'office_document', { action: 'write', challenge: historical.result.structuredContent.challenge, idempotencyIdentity: 'crash-1', operation: 'title', payload }, 9)
    assert.equal(historicalRetry.result.isError, true); assert.match(historicalRetry.result.content[0].text, /uncertain/i); assert.equal(writes, 0)
    const first = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'same' } })
    const second = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'title', payload: { markdown: 'same' } }, 2)
    const [one, two] = await Promise.all([
      call(endpoint, 'office_document', { action: 'write', challenge: first.result.structuredContent.challenge, idempotencyIdentity: 'concurrent-1', operation: 'title', payload: { markdown: 'same' } }, 3),
      call(endpoint, 'office_document', { action: 'write', challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'concurrent-1', operation: 'title', payload: { markdown: 'same' } }, 4),
    ])
    assert.equal(writes, 1); assert.equal([one, two].filter((value) => value.result?.structuredContent?.status === 'verified_write').length, 1)
    assert.equal([one, two].filter((value) => value.result?.isError).length, 1)
  } finally { await connector.stop() }
})
