import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { OfficeDocumentWriteRecordStore } from '../apps/native-server/src/office-document-write-record-store.mjs'

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
    const bare = await call(endpoint, 'office_document', { action: 'inspect_write' }, 8)
    assert.equal(bare.error.code, -32602)
    assert.match(bare.error.message, /selection_insert/)
    const missingFingerprint = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'selection_insert', payload: { text: '演示内容' } }, 9)
    assert.equal(missingFingerprint.error.code, -32602)
    assert.match(missingFingerprint.error.message, /expectedSelectionFingerprint/)
    const emptyReplace = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'replace', payload: { markdown: '演示内容' } }, 10)
    assert.equal(emptyReplace.result.isError, true)
    assert.match(emptyReplace.result.content[0].text, /no public replaceable block/)
    const emptyBlocks = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'blocks_replace', payload: { type: 'h1', text: '演示内容' } }, 11)
    assert.equal(emptyBlocks.result.isError, true)
    assert.match(emptyBlocks.result.content[0].text, /selection_insert/)
    const emptyInsert = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'selection_insert', payload: { text: '演示内容', expectedSelectionFingerprint: 'selection-v4-ac78eacf0123456789abcdef01234567' } }, 12)
    assert.equal(emptyInsert.result.structuredContent.action, 'inspect_write')
    assert.ok(emptyInsert.result.structuredContent.challenge)
    const drawing = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'insert_drawing', payload: { mermaid: 'flowchart TD\n开始 --> 结束' } }, 13)
    assert.equal(drawing.result.structuredContent.action, 'inspect_write')
    const blocks = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'blocks_insert', payload: { position: 'end', blocks: [{ type: 'h2', text: '项目概述' }, { type: 'table', rows: [['负责人', '交付物'], ['张三', '说明书']] }] } }, 14)
    assert.equal(blocks.result.structuredContent.action, 'inspect_write')
    const missingDrawing = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'insert_drawing', payload: { text: 'flowchart TD' } }, 15)
    assert.equal(missingDrawing.error.code, -32602)
    assert.match(missingDrawing.error.message, /mermaid/)
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

test('blocks_insert and insert_drawing obtain a challenge on empty documents and attest payload-bound XML evidence', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 22, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/110?id=110' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '空文档', fingerprint: 'before' }
  const drawingPayload = { mermaid: 'flowchart TD\n开始 --> 结束', position: 'end' }
  const blocksPayload = { position: 'end', blocks: [{ type: 'h2', text: '项目概述' }, { type: 'table', rows: [['负责人', '交付物'], ['张三', '说明书']] }] }
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action !== 'write') return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } } })
    writes += 1
    const fragments = request.operation === 'insert_drawing' ? ['flowchart', 'TD', '开始', '结束'] : ['项目概述', '负责人', '交付物', '张三', '说明书']
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: `after-${request.operation}` }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true, verifiedFragments: fragments, fragmentEvidence: fragments.map((fragment) => ({ fragment, blockIds: ['inserted'] })), observedBlocks: [{ id: 'inserted', type: request.operation === 'insert_drawing' ? 'codeblock' : 'h2', text: fragments.join(' ') }] } } })
  }) })
  connector.bindBrowserTarget('light-doc-insert-run', target); const endpoint = await connector.start()
  const write = async (operation, payload, identity, id) => {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation, payload }, id)
    return call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation, payload }, id + 1)
  }
  try {
    const drawn = await write('insert_drawing', drawingPayload, 'drawing-1', 1)
    assert.equal(drawn.result.structuredContent.status, 'verified_write')
    const inserted = await write('blocks_insert', blocksPayload, 'blocks-1', 3)
    assert.equal(inserted.result.structuredContent.status, 'verified_write')
    assert.equal(writes, 2)
    const rejected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'blocks_insert', payload: { blocks: [{ type: 'unknown', text: 'x' }] } }, 5)
    assert.equal(rejected.error.code, -32602)
  } finally { await connector.stop() }
})

test('selection_insert requires a stable fingerprint and attests payload-bound XML evidence without retrying an uncertain mutation', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 21, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/109?id=109' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  const payload = { text: '写入内容', expectedSelectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', insertBelow: true }
  let writes = 0; let validEvidence = true
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action !== 'write') return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [] } } })
    writes += 1
    const observed = validEvidence
      ? { verified: true, verifiedFragments: ['写入内容'], fragmentEvidence: [{ fragment: '写入内容', blockIds: ['inserted'] }], observedBlocks: [{ id: 'inserted', type: 'p', text: '写入内容' }] }
      : { verified: true, verifiedFragments: [], fragmentEvidence: [], observedBlocks: [] }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed } })
  }) })
  connector.bindBrowserTarget('light-doc-selection-run', target); const endpoint = await connector.start()
  const write = async (identity, id) => {
    const inspected = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'selection_insert', payload }, id)
    return call(endpoint, 'office_document', { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation: 'selection_insert', payload }, id + 1)
  }
  try {
    const invalid = await call(endpoint, 'office_document', { action: 'inspect_write', operation: 'selection_insert', payload: { text: 'x' } })
    assert.equal(invalid.error.code, -32602); assert.equal(writes, 0)
    const succeeded = await write('selection-success', 2)
    assert.equal(succeeded.result.structuredContent.status, 'verified_write'); assert.equal(writes, 1)
    validEvidence = false
    const rejected = await write('selection-invalid', 4)
    assert.equal(rejected.result.isError, true); assert.equal(writes, 2)
    const replay = await write('selection-invalid', 6)
    assert.equal(replay.result.isError, true); assert.match(replay.result.content[0].text, /uncertain/i); assert.equal(writes, 2)
  } finally { await connector.stop() }
})

test('flat selected-content replacement keeps blocks only in preview and fails closed for replay, selection drift, and target drift', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 31, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/115?id=115' }
  const movedTarget = { ...target, tabId: 32 }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  const blocks = [{ type: 'h2', text: '优化结论' }, { type: 'p', text: '稳定替换正文' }]
  let selectionFingerprint = 'selection-v4-1234567890abcdef1234567890abcdef'; let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action === 'write') {
      writes += 1
      if (request.payload.expectedSelectionFingerprint !== selectionFingerprint) return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, error: { code: 'fingerprint_mismatch', message: 'The light-document selection changed since inspect_write' } })
      return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: {
        status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload },
        observed: { verified: true, verifiedFragments: ['优化结论', '稳定替换正文'], fragmentEvidence: [{ fragment: '优化结论', blockIds: ['one'] }, { fragment: '稳定替换正文', blockIds: ['two'] }], observedBlocks: [{ id: 'one', type: 'h2', text: '优化结论' }, { id: 'two', type: 'p', text: '稳定替换正文' }], replacedTagIds: ['old-one', 'old-two'] },
      } })
    }
    const selection = { supported: true, stable: true, truncated: false, hasSelection: true, wholeBlockReplaceable: true, isCollapsed: false, selectionFingerprint, selectedTagIds: ['old-one', 'old-two'], content: { text: '原内容一 原内容二' } }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [], ...(request.action === 'selection' ? { selection } : {}) } } })
  }) })
  connector.bindBrowserTarget('flat-selection-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks })
    assert.equal(preview.result.structuredContent.action, 'selection_blocks_replace_preview')
    assert.deepEqual(preview.result.structuredContent.blocks, blocks)
    const challenge = preview.result.structuredContent.challenge
    const commit = await call(endpoint, 'light_document_selection_replace_commit', { challenge }, 2)
    assert.equal(commit.result.structuredContent.status, 'verified_write')
    assert.equal(writes, 1)
    const replay = await call(endpoint, 'light_document_selection_replace_commit', { challenge }, 3)
    assert.equal(replay.result.isError, true); assert.equal(writes, 1)

    const driftPreview = await call(endpoint, 'light_document_selection_replace_preview', { blocks }, 4)
    selectionFingerprint = 'selection-v4-deadbeefdeadbeefdeadbeefdeadbeef'
    const drifted = await call(endpoint, 'light_document_selection_replace_commit', { challenge: driftPreview.result.structuredContent.challenge }, 5)
    assert.equal(drifted.result.isError, true); assert.equal(writes, 2)

    selectionFingerprint = 'selection-v4-1234567890abcdef1234567890abcdef'
    const movedPreview = await call(endpoint, 'light_document_selection_replace_preview', { blocks }, 6)
    connector.bindBrowserTarget('flat-selection-run', movedTarget)
    const moved = await call(endpoint, 'light_document_selection_replace_commit', { challenge: movedPreview.result.structuredContent.challenge }, 7)
    assert.equal(moved.result.isError, true); assert.equal(writes, 2)
  } finally { await connector.stop() }
})

test('flat selected-content preview rejects a partial or ambiguous selection before issuing an Approval Grant', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 39, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/119?id=119' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [], selection: { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: false, selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', selectedTagIds: ['one', 'two'], content: { text: '局部文字' } } } },
    }))
  } })
  connector.bindBrowserTarget('flat-selection-preflight-run', target)
  const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks: [{ type: 'p', text: '替换内容' }] })
    assert.equal(preview.result.isError, true)
    assert.match(preview.result.content[0].text, /complete contiguous whole-block selection/i)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    assert.deepEqual(requests.map((request) => request.action), ['selection'])
  } finally { await connector.stop() }
})

test('WebEdit light-document Skill prescribes one selection read before preview and requires complete blocks', async () => {
  const skill = await readFile(new URL('../skills/webedit-light-document/SKILL.md', import.meta.url), 'utf8')
  assert.equal((skill.match(/mcp__chrome__light_document_selection_read/g) ?? []).length, 1)
  assert.match(skill, /wholeBlockReplaceable=true/)
  assert.match(skill, /选区未变化时不要重复 `selection_read`/)
  assert.match(skill, /局部或歧义选区请用户重新选择完整块/)
})
