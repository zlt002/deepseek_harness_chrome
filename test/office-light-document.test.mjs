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

function normalizeLightDocumentCall(name, arguments_) {
  const args = arguments_ ?? {}
  if (name === 'light_document_write_preview') {
    return { name: 'light_document_write_preview', arguments: { operation: args.operation, payload: args.payload } }
  }
  if (name === 'light_document_write_commit') {
    return { name: 'light_document_write_commit', arguments: { challenge: args.challenge } }
  }
  return { name, arguments: arguments_ }
}

async function call(endpoint, name, arguments_, id = 1, meta) {
  const mapped = normalizeLightDocumentCall(name, arguments_)
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: mapped.name, arguments: mapped.arguments, ...(meta === undefined ? {} : { _meta: meta }) } }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('advertises and explains the recoverable insert_drawing Mermaid contract', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 11, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/99?id=99' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '流程图文档', fingerprint: 'before' }
  const selectionFingerprint = 'selection-v4-1234567890abcdef1234567890abcdef'
  let received
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => {
      received = request
      connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [], ...(request.action === 'inspect_write' ? { selection: { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, selectionIdsValid: true, selectedTagIds: ['selected-one', 'selected-two'], selectionFingerprint } } : {}) } },
      })
    }),
  })
  connector.bindBrowserTarget('light-doc-drawing-schema-run', target)
  const endpoint = await connector.start()
  try {
    const listed = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const tools = await listed.json()
    const preview = tools.result.tools.find((tool) => tool.name === 'light_document_write_preview')
    const drawingContract = preview.inputSchema.allOf.find((entry) => entry.if?.properties?.operation?.const === 'insert_drawing')
    assert.deepEqual(drawingContract.then.properties.payload, {
      type: 'object', additionalProperties: false, required: ['mermaid'],
      properties: {
        mermaid: { type: 'string', minLength: 1, maxLength: 20000, description: 'Mermaid source; xychart-beta is not verified for this WebEdit target.' },
        position: { enum: ['start', 'end', 'before', 'after', 'after_selection'], description: 'Defaults to end. before/after require id or index. after_selection requires expectedSelectionFingerprint from light_document_selection_read.' },
        id: { type: 'string', minLength: 1, maxLength: 256 },
        index: { type: 'integer', minimum: 0, maximum: 100000 },
        expectedSelectionFingerprint: { type: 'string', pattern: '^selection-v4-[0-9a-f]{32}$' },
      },
    })
    assert.match(preview.description, /position: "after_selection"/)
    assert.match(preview.description, /rechecks that same selection at commit/)
    const deleteContract = preview.inputSchema.allOf.find((entry) => entry.if?.properties?.operation?.const === 'blocks_delete')
    assert.deepEqual(deleteContract.then.properties.payload, {
      type: 'object', additionalProperties: false, required: ['blocks'],
      properties: { blocks: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 256 } } } } },
    })

    const selectionPreview = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { mermaid: 'flowchart TD\n开始 --> 结束', position: 'after_selection', expectedSelectionFingerprint: selectionFingerprint } }, 2)
    assert.equal(selectionPreview.result.structuredContent.action, 'inspect_write')
    assert.deepEqual(selectionPreview.result.structuredContent.insertion, { position: 'after_selection', selectedTagIds: ['selected-one', 'selected-two'] })
    assert.equal(received.action, 'inspect_write')
    assert.equal(received.payload.position, 'after_selection')

    const rejected = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { svg: '<svg />' } }, 3)
    assert.equal(rejected.error.code, -32602)
    assert.match(rejected.error.message, /payload \{ mermaid: "flowchart TD/)
    assert.match(rejected.error.message, /SVG.*not accepted/)
    const unsupported = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { mermaid: 'xychart-beta\n  x-axis [一月, 二月]' } }, 4)
    assert.equal(unsupported.error.code, -32602)
    assert.match(unsupported.error.message, /xychart-beta.*flowchart.*pie/i)
    const compatible = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { mermaid: 'sequenceDiagram\n甲->>乙: 确认' } }, 5)
    assert.equal(compatible.result.structuredContent.action, 'inspect_write')
    const indexedDelete = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_delete', payload: { blocks: [{ index: 7 }] } }, 6)
    assert.equal(indexedDelete.error.code, -32602)
    assert.match(indexedDelete.error.message, /blocks_delete.*\{ blocks: \[\{ id \}\] \}.*index.*light_document_read/i)
  } finally {
    await connector.stop()
  }
})

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
    const listed = await call(endpoint, 'light_document_read', { offset: 0, limit: 20 })
    assert.equal(listed.result.structuredContent.resource.kind, 'webedit_light_document')
    assert.deepEqual(received, {
      type: 'connector_request', requestId: received.requestId, runId: 'light-doc-run', generation: received.generation,
      browserTarget: target, tool: 'light_document', action: 'read', offset: 0, limit: 20,
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
    const denied = await call(endpoint, 'light_document_write_commit', { challenge: 'not-a-grant', idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } })
    assert.equal(denied.result.isError, true)
    assert.match(denied.result.content[0].text, /challenge/i)

    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '写入内容' } }, 2)
    const written = await call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } }, 3)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(written.result.structuredContent.observed.text, '写入内容')

    const replay = await call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'write-1', operation: 'title', payload: { markdown: '写入内容' } }, 4)
    assert.equal(replay.result.isError, true)
  } finally {
    await connector.stop()
  }
})

test('reports one body-free online-document event for every AI light-document Verified Write', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 31, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/801?id=801' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '新建文档', fingerprint: 'before' }
  const events = []
  const connector = new BrowserConnector({
    reportPrdEvent: async (event) => { events.push(event) },
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { text: request.payload.markdown, verifiedFragments: [request.payload.markdown], verified: true } }
        : { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
    officeDocumentWriteStore: writeStore(),
  })
  connector.bindBrowserTarget('accepted-run', target)
  const endpoint = await connector.start()
  try {
    assert.equal(connector.recordPmdPrdReviewAdoption({
      runId: 'accepted-run', harnessSessionId: 'prd-session', reviewId: 'review-1', resourceId: 'resource-1',
      displayPath: 'pmd-workspace/spec/REQ_CRM_PRD.md', revision: 'revision-1', fingerprint: 'a'.repeat(64), contentHash: 'b'.repeat(64),
    }), true)
    connector.bindBrowserTarget('write-run', target)
    const identity = { 'io.deepseek.harness/sessionId': 'tool-session', 'io.deepseek.harness/parentSessionId': 'prd-session' }
    const preview = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '已采纳 PRD' } }, 1, identity)
    const written = await call(endpoint, 'light_document_write_commit', { challenge: preview.result.structuredContent.challenge }, 2, identity)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(events.length, 1)
    assert.deepEqual({ ...events[0], eventId: '<id>', occurredAt: '<time>' }, {
      eventId: '<id>', eventType: 'document_published', outcome: 'succeeded', occurredAt: '<time>',
      sessionId: 'prd-session', runId: 'write-run',
      documentName: 'REQ_CRM_PRD', documentCatalogId: '801', documentUrl: target.url,
    })
    assert.match(events[0].eventId, /^document:ai-write:[a-f0-9]{48}$/)
    for (const forbidden of ['body', 'content', 'userInput', 'comment', 'rewriteReason']) assert.equal(forbidden in events[0], false)

    const secondPreview = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '后续普通编辑' } }, 3, identity)
    const secondWrite = await call(endpoint, 'light_document_write_commit', { challenge: secondPreview.result.structuredContent.challenge }, 4, identity)
    assert.equal(secondWrite.result.structuredContent?.status, 'verified_write', JSON.stringify(secondWrite))
    const otherPreview = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '其他会话编辑' } }, 5, { 'io.deepseek.harness/sessionId': 'other-session' })
    const otherWrite = await call(endpoint, 'light_document_write_commit', { challenge: otherPreview.result.structuredContent.challenge }, 6, { 'io.deepseek.harness/sessionId': 'other-session' })
    assert.equal(otherWrite.result.structuredContent?.status, 'verified_write', JSON.stringify(otherWrite))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(events.length, 3)
    assert.equal(new Set(events.map((event) => event.eventId)).size, 3)
    assert.equal(events[1].documentName, '新建文档')
    assert.equal(events[2].sessionId, 'other-session')
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '写入内容' } })
    const challenge = inspected.result.structuredContent.challenge
    Date.now = () => realNow() + 10 * 60_000 + 1
    const expired = await call(endpoint, 'light_document_write_commit', { challenge, idempotencyIdentity: 'expired-write', operation: 'title', payload: { markdown: '写入内容' } }, 2)
    assert.equal(expired.result.isError, true)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    Date.now = realNow

    const forOldRun = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '写入内容' } }, 3)
    connector.bindBrowserTarget('replacement-run', target)
    assert.equal(connector.officeDocumentChallenges.size, 0)
    const staleRun = await call(endpoint, 'light_document_write_commit', { challenge: forOldRun.result.structuredContent.challenge, idempotencyIdentity: 'stale-run-write', operation: 'title', payload: { markdown: '写入内容' } }, 4)
    assert.equal(staleRun.result.isError, true)

    for (let index = 0; index < 256; index += 1) connector.officeDocumentWrites.set(`old-${index}`, { fingerprint: String(index), result: {} })
    const inspectedForWrite = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: '写入内容' } }, 5)
    const written = await call(endpoint, 'light_document_write_commit', { challenge: inspectedForWrite.result.structuredContent.challenge, idempotencyIdentity: 'new-write', operation: 'title', payload: { markdown: '写入内容' } }, 6)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.equal(connector.officeDocumentWrites.size, 256)
    assert.equal(connector.officeDocumentWrites.has('old-0'), false)
    assert.equal([...connector.officeDocumentWrites.keys()].some((identity) => identity.startsWith('light-write:')), true)
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
    const words = await call(endpoint, 'light_document_read', { payload: { kind: 'word_count' } })
    assert.equal(words.result.structuredContent.document.wordCount.words, 12)
    assert.deepEqual(received[0].payload, { kind: 'word_count' })
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'x' } }, 2)
    const exported = await call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'insert-1', operation: 'title', payload: { markdown: 'x' } }, 3)
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
        ? (writes += 1, { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } })
        : { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } },
    })),
  })
  connector.bindBrowserTarget('light-doc-contract-run', target); const endpoint = await connector.start()
  try {
    const inspection = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'right' } })
    const tamperedCommit = await call(endpoint, 'light_document_write_commit', { challenge: inspection.result.structuredContent.challenge, payload: { markdown: 'wrong' } }, 2)
    assert.equal(tamperedCommit.result.structuredContent.requested.payload.markdown, 'right'); assert.equal(writes, 1)
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'right' } }, 3)
    const written = await call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'contract-1', operation: 'title', payload: { markdown: 'right' } }, 4)
    assert.equal(written.result.structuredContent.status, 'verified_write'); assert.equal(writes, 1)
    const retryInspection = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'right' } }, 5)
    const retry = await call(endpoint, 'light_document_write_commit', { challenge: retryInspection.result.structuredContent.challenge, idempotencyIdentity: 'contract-1', operation: 'title', payload: { markdown: 'right' } }, 6)
    assert.equal(retry.result.structuredContent.status, 'verified_write'); assert.equal(writes, 1)
    const paste = await call(endpoint, 'light_document_write_preview', { operation: 'paste_image', payload: {} }, 7)
    assert.equal(paste.error.code, -32602)
    const bare = await call(endpoint, 'light_document_write_preview', {}, 8)
    assert.equal(bare.error.code, -32602)
    assert.match(bare.error.message, /invalid arguments|selection_insert/)
    const missingFingerprint = await call(endpoint, 'light_document_write_preview', { operation: 'selection_insert', payload: { text: '演示内容' } }, 9)
    assert.equal(missingFingerprint.error.code, -32602)
    assert.match(missingFingerprint.error.message, /invalid arguments|expectedSelectionFingerprint/)
    const emptyReplace = await call(endpoint, 'light_document_write_preview', { operation: 'replace', payload: { markdown: '演示内容' } }, 10)
    assert.equal(emptyReplace.result.isError, true)
    assert.match(emptyReplace.result.content[0].text, /no public replaceable block/)
    const emptyBlocks = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_replace', payload: { type: 'h1', text: '演示内容' } }, 11)
    assert.equal(emptyBlocks.result.isError, true)
    assert.match(emptyBlocks.result.content[0].text, /selection_insert/)
    const emptyInsert = await call(endpoint, 'light_document_write_preview', { operation: 'selection_insert', payload: { text: '演示内容', expectedSelectionFingerprint: 'selection-v4-ac78eacf0123456789abcdef01234567' } }, 12)
    assert.equal(emptyInsert.result.structuredContent.action, 'inspect_write')
    assert.ok(emptyInsert.result.structuredContent.challenge)
    const drawing = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { mermaid: 'flowchart TD\n开始 --> 结束' } }, 13)
    assert.equal(drawing.result.structuredContent.action, 'inspect_write')
    const blocks = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_insert', payload: { position: 'end', blocks: [{ type: 'h2', text: '项目概述' }, { type: 'table', rows: [['负责人', '交付物'], ['张三', '说明书']] }] } }, 14)
    assert.equal(blocks.result.structuredContent.action, 'inspect_write')
    const missingDrawing = await call(endpoint, 'light_document_write_preview', { operation: 'insert_drawing', payload: { text: 'flowchart TD' } }, 15)
    assert.equal(missingDrawing.error.code, -32602)
    assert.match(missingDrawing.error.message, /invalid arguments|mermaid/)
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation, payload }, id)
    return call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation, payload }, id + 1)
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_delete', payload }, id)
    return call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation: 'blocks_delete', payload }, id + 1)
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'x' } })
    const timedOut = await call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'timeout-1', operation: 'title', payload: { markdown: 'x' } }, 2)
    assert.equal(timedOut.result.isError, true); assert.equal(writes, 1)
  } finally { await first.stop() }
  let second
  second = new BrowserConnector({ officeDocumentWriteStore: store, requestExtension: responder(second, true) }); second.requestExtension = responder(second, true); second.bindBrowserTarget('light-doc-recovery-run', target); const restarted = await second.start()
  try {
    const inspected = await call(restarted, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'x' } })
    const retry = await call(restarted, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'timeout-1', operation: 'title', payload: { markdown: 'x' } }, 2)
    assert.equal(retry.result.isError, true); assert.match(retry.result.content[0].text, /uncertain/i); assert.match(retry.result.content[0].text, /light_document_read/); assert.equal(writes, 1)
  } finally { await second.stop() }
})

test('never dispatches a historical pending checkpoint or two concurrent writes with one identity', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 18, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/106?id=106' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '演示文档', fingerprint: 'before' }
  const store = writeStore()
  const payload = { markdown: 'historical' }
  const historicalIdentity = `light-write:${sha256(canonicalJson([resource.fingerprint, 'title', payload])).slice(0, 48)}`
  await store.create({ idempotencyIdentity: historicalIdentity, targetFingerprint: sha256(canonicalJson(target)), resourceFingerprint: resource.fingerprint, operation: 'title', payloadHash: sha256(canonicalJson({ operation: 'title', payload })) })
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: store, requestExtension: (request) => {
    if (request.action === 'write') { writes += 1; setTimeout(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } } }), 20); return }
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 0, offset: 0, limit: 1, hasMore: false, blocks: [] } } }))
  } })
  connector.bindBrowserTarget('light-doc-pending-run', target); const endpoint = await connector.start()
  try {
    const historical = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload })
    const historicalRetry = await call(endpoint, 'light_document_write_commit', { challenge: historical.result.structuredContent.challenge, idempotencyIdentity: 'crash-1', operation: 'title', payload }, 9)
    assert.equal(historicalRetry.result.isError, true); assert.match(historicalRetry.result.content[0].text, /uncertain/i); assert.equal(writes, 0)
    const first = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'same' } })
    const second = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload: { markdown: 'same' } }, 2)
    const [one, two] = await Promise.all([
      call(endpoint, 'light_document_write_commit', { challenge: first.result.structuredContent.challenge, idempotencyIdentity: 'concurrent-1', operation: 'title', payload: { markdown: 'same' } }, 3),
      call(endpoint, 'light_document_write_commit', { challenge: second.result.structuredContent.challenge, idempotencyIdentity: 'concurrent-1', operation: 'title', payload: { markdown: 'same' } }, 4),
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation, payload }, id)
    return call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation, payload }, id + 1)
  }
  try {
    const drawn = await write('insert_drawing', drawingPayload, 'drawing-1', 1)
    assert.equal(drawn.result.structuredContent.status, 'verified_write')
    const inserted = await write('blocks_insert', blocksPayload, 'blocks-1', 3)
    assert.equal(inserted.result.structuredContent.status, 'verified_write')
    assert.equal(writes, 2)
    const rejected = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_insert', payload: { blocks: [{ type: 'unknown', text: 'x' }] } }, 5)
    assert.equal(rejected.error.code, -32602)
    const escapedNewline = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_insert', payload: { blocks: [{ type: 'p', text: '第一行\\n第二行' }] } }, 6)
    assert.equal(escapedNewline.error.code, -32602)
    assert.match(escapedNewline.error.message, /literal \\n/)
    const codeBlock = await call(endpoint, 'light_document_write_preview', { operation: 'blocks_insert', payload: { blocks: [{ type: 'codeblock', text: 'const escaped = "\\n"' }] } }, 7)
    assert.equal(typeof codeBlock.result.structuredContent.challenge, 'string')
  } finally { await connector.stop() }
})

test('selection_insert requires a stable fingerprint and attests payload-bound XML evidence without retrying an uncertain mutation', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 21, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/109?id=109' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  let payload = { text: '写入内容', expectedSelectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', insertBelow: true }
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
    const inspected = await call(endpoint, 'light_document_write_preview', { operation: 'selection_insert', payload }, id)
    return call(endpoint, 'light_document_write_commit', { challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, operation: 'selection_insert', payload }, id + 1)
  }
  try {
    const invalid = await call(endpoint, 'light_document_write_preview', { operation: 'selection_insert', payload: { text: 'x' } })
    assert.equal(invalid.error.code, -32602); assert.equal(writes, 0)
    const succeeded = await write('selection-success', 2)
    assert.equal(succeeded.result.structuredContent.status, 'verified_write'); assert.equal(writes, 1)
    payload = { ...payload, text: '另一段写入内容' }
    validEvidence = false
    const rejected = await write('selection-invalid', 4)
    assert.equal(rejected.result.isError, true); assert.equal(writes, 2)
    const replay = await write('selection-invalid', 6)
    assert.equal(replay.result.isError, true); assert.match(replay.result.content[0].text, /uncertain/i); assert.equal(writes, 2)
  } finally { await connector.stop() }
})

test('a fingerprint mismatch before mutation releases its pending fence so reread and re-preview of the same payload can succeed', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 24, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/111?id=111' }
  const payload = { markdown: '同一份待写内容' }
  let fingerprint = 'before-one'; let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '版本变化文档', fingerprint }
    if (request.action !== 'write') return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [] } } })
    writes += 1
    if (writes === 1) return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, error: { code: 'fingerprint_mismatch', message: 'The light document changed before mutation' } })
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true } } })
  }) })
  connector.bindBrowserTarget('light-doc-fingerprint-recovery-run', target); const endpoint = await connector.start()
  try {
    const first = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload }, 1)
    const rejected = await call(endpoint, 'light_document_write_commit', { challenge: first.result.structuredContent.challenge }, 2)
    assert.equal(rejected.result.isError, true)
    assert.match(rejected.result.content[0].text, /fingerprint_mismatch.*before any write/i)
    assert.equal(writes, 1)
    fingerprint = 'before-two'
    const second = await call(endpoint, 'light_document_write_preview', { operation: 'title', payload }, 3)
    const committed = await call(endpoint, 'light_document_write_commit', { challenge: second.result.structuredContent.challenge }, 4)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.equal(writes, 2)
  } finally { await connector.stop() }
})

test('flat selected-content preview uses the same preview and commit tools for safe deletion', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 25, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/112?id=112' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区删除文档', fingerprint: 'before' }
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action === 'write') {
      writes += 1
      return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true, deletedSelectionText: '要删除的内容', verifiedTextAfter: '保留内容' } } })
    }
    const selection = { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: false, replaceStrategy: 'public_replace_content', selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', content: { text: '要删除的内容' } }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [], selection } } })
  }) })
  connector.bindBrowserTarget('light-doc-selection-delete-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks: [] }, 1)
    assert.equal(preview.result.structuredContent.action, 'selection_delete_preview')
    const grant = connector.officeDocumentChallenges.get(preview.result.structuredContent.challenge)
    assert.equal(grant.operation, 'selection_delete')
    const committed = await call(endpoint, 'light_document_selection_replace_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.equal(writes, 1)
  } finally { await connector.stop() }
})

test('flat selected-content preview commits a whole-block deletion only with stable-id and surrounding-block readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 26, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/113?id=113' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '整块删除文档', fingerprint: 'before' }
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: writeStore(), requestExtension: (request) => queueMicrotask(() => {
    if (request.action === 'write') {
      writes += 1
      return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: { verified: true, deletedTagIds: ['one', 'two'], outsideSelectionBlocks: [{ index: 0, type: 'p', language: null, text: '保留正文' }], writeStrategy: 'full_canvas_patch' } } })
    }
    const selection = { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: true, selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', selectedTagIds: ['one', 'two'], content: { text: '第一段 第二段' } }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target, result: { status: 'ok', resource, document: { blockCount: 3, offset: 0, limit: 3, hasMore: false, blocks: [], selection } } })
  }) })
  connector.bindBrowserTarget('light-doc-whole-selection-delete-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks: [] }, 1)
    assert.equal(preview.result.structuredContent.action, 'selection_delete_preview')
    const committed = await call(endpoint, 'light_document_selection_replace_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.deepEqual(committed.result.structuredContent.observed.deletedTagIds, ['one', 'two'])
    assert.equal(writes, 1)
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
      if (request.payload.expectedSelectionFingerprint !== selectionFingerprint) return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: { code: 'fingerprint_mismatch', message: 'The light-document selection changed since inspect_write' } })
      return connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result: {
        status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload },
        observed: { verified: true, verifiedFragments: ['优化结论', '稳定替换正文'], fragmentEvidence: [{ fragment: '优化结论', blockIds: ['one'] }, { fragment: '稳定替换正文', blockIds: ['two'] }], observedBlocks: [{ id: 'one', type: 'h2', text: '优化结论' }, { id: 'two', type: 'p', text: '稳定替换正文' }], replacedTagIds: ['old-one', 'old-two'] },
      } })
    }
    const selection = { supported: true, stable: true, truncated: false, hasSelection: true, wholeBlockReplaceable: true, isCollapsed: false, selectionFingerprint, selectedTagIds: ['old-one', 'old-two'], content: { text: '原内容一 原内容二' } }
    connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [], ...(request.action === 'selection' ? { selection } : {}) } } })
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

    connector.bindBrowserTarget('flat-selection-run', movedTarget)
    selectionFingerprint = 'selection-v4-1234567890abcdef1234567890abcdef'
    const movedPreview = await call(endpoint, 'light_document_selection_replace_preview', { blocks }, 6)
    connector.bindBrowserTarget('flat-selection-run', target)
    const moved = await call(endpoint, 'light_document_selection_replace_commit', { challenge: movedPreview.result.structuredContent.challenge }, 7)
    assert.equal(moved.result.isError, true); assert.equal(writes, 2)
  } finally { await connector.stop() }
})

test('flat selected-content preview approves any stable non-collapsed selection with a public replacement strategy', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 39, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/119?id=119' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    if (request.action === 'write') {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
        result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: {
          verified: true, verifiedFragments: ['替换内容'], fragmentEvidence: [{ fragment: '替换内容', blockIds: ['one'] }], observedBlocks: [{ id: 'one', type: 'p', text: '替换内容' }],
        } },
      }))
      return
    }
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: { status: 'ok', resource, document: { blockCount: 2, offset: 0, limit: 2, hasMore: false, blocks: [], selection: { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: false, replaceStrategy: 'public_insert_content', selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', selectedTagIds: ['one', 'two'], content: { text: '局部文字' } } } },
    }))
  } })
  connector.bindBrowserTarget('flat-selection-preflight-run', target)
  const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks: [{ type: 'p', text: '替换内容' }] })
    assert.equal(preview.result.structuredContent.action, 'selection_content_replace_preview')
    const grant = connector.officeDocumentChallenges.get(preview.result.structuredContent.challenge)
    assert.equal(grant.operation, 'selection_content_replace')
    assert.equal(grant.payload.markdown, '替换内容')
    const committed = await call(endpoint, 'light_document_selection_replace_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.deepEqual(requests.map((request) => request.action), ['selection', 'write'])
  } finally { await connector.stop() }
})

test('selected table preview binds approval to one containing table and never routes through a generic insert', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 40, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/120?id=120' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '表格文档', fingerprint: 'before' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    if (request.action === 'write') {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
        result: { status: 'verified_write', resource: { ...resource, fingerprint: 'after' }, requested: { operation: request.operation, payload: request.payload }, observed: {
          verified: true, replacementScope: 'containing_table', verifiedFragments: ['E-001'], fragmentEvidence: [{ fragment: 'E-001', blockIds: ['evidence'] }], observedBlocks: [{ id: 'evidence', type: 'table', text: 'E-001' }],
        } },
      }))
      return
    }
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [], selection: {
        supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: false,
        replaceStrategy: 'full_canvas_patch_selected_table', selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', selectedTagIds: [], selectionIdsValid: false,
        containingTable: { id: 'evidence', index: 0, rowCount: 4, columnCount: 5, selectedRowCount: 4, selectedColumnCount: 3 }, content: { text: '类型 事实或结论 来源' },
      } } },
    }))
  } })
  connector.bindBrowserTarget('selected-table-run', target)
  const endpoint = await connector.start()
  try {
    const blocks = [{ type: 'table', rows: [['Evidence ID', '类型', '状态'], ['E-001', '用户事实', '已确认']] }]
    const preview = await call(endpoint, 'light_document_selection_replace_preview', { blocks })
    assert.equal(preview.result.structuredContent.action, 'selection_table_replace_preview')
    assert.equal(preview.result.structuredContent.replacementScope.kind, 'containing_table')
    assert.equal(preview.result.structuredContent.replacementScope.id, 'evidence')
    const grant = connector.officeDocumentChallenges.get(preview.result.structuredContent.challenge)
    assert.equal(grant.operation, 'selection_content_replace')
    assert.deepEqual(requests.map((request) => request.action), ['selection'])
  } finally { await connector.stop() }
})

test('WebEdit light-document Skill prescribes one selection read and supports arbitrary stable selections', async () => {
  const skill = await readFile(new URL('../skills/webedit-light-document/SKILL.md', import.meta.url), 'utf8')
  assert.equal((skill.match(/mcp__chrome__light_document_selection_read/g) ?? []).length, 1)
  assert.match(skill, /任意稳定的非折叠选区/)
  assert.match(skill, /选区未变化时不要重复 `selection_read`/)
  assert.match(skill, /`\{ blocks: \[\] \}`/)
  assert.match(skill, /超时或回读不确定时不得自动重试/)
  assert.doesNotMatch(skill, /局部或歧义选区请用户重新选择完整块/)
})
