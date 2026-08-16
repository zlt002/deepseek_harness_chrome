import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserConnector } from '../native-server/src/connector.mjs'

async function call(endpoint, arguments_, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'office_spreadsheet', arguments: arguments_ } }),
  })
  return response.json()
}

test('requires a bound one-time spreadsheet inspection grant and returns the verified write readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 21, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'sheet-after' }, operation: request.operation, requested: { range: 'A1', values: [[42]] }, observed: { range: 'A1', values: [[42]], verified: true } }
        : { status: 'ok', resource, context: { workbookName: 'Budget.xlsx' } },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-write-run', target)
  const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write' })
    const grant = inspected.result.structuredContent.challenge
    const write = { action: 'write', challenge: grant, idempotencyIdentity: 'spreadsheet-1', resource, operation: 'set_values', payload: { range: 'A1', values: [[42]] } }
    const written = await call(endpoint, write, 2)
    assert.equal(written.result.structuredContent.status, 'verified_write')
    assert.deepEqual(written.result.structuredContent.observed, { range: 'A1', values: [[42]], verified: true })

    const replay = await call(endpoint, write, 3)
    assert.equal(replay.result.isError, true)
    assert.match(replay.result.content[0].text, /challenge/i)
  } finally { await connector.stop() }
})

test('rejects an invalid or mismatched spreadsheet extension readback instead of claiming a write succeeded', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 22, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write' ? { status: 'verified_write', resource, operation: 'set_values', requested: { range: 'A1', values: [[1]] }, observed: { range: 'A1', values: [[2]] } } : { status: 'ok', resource, context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-readback-run', target)
  const endpoint = await connector.start()
  try {
    const inspected = await call(endpoint, { action: 'inspect_write' })
    const response = await call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: 'spreadsheet-mismatch', resource, operation: 'set_values', payload: { range: 'A1', values: [[1]] } }, 2)
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('rejects generic spreadsheet write attestations for structural and filter-clear operations', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 24, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: request.payload.range, clear: true }, observed: { range: request.payload.range, verified: true, after: { operator: 'equals' } } }
        : { status: 'ok', resource, context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-generic-attestation-run', target)
  const endpoint = await connector.start()
  const write = async (operation, payload, id) => {
    const inspected = await call(endpoint, { action: 'inspect_write' }, id)
    return call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: `generic-${operation}`, resource, operation, payload }, id + 1)
  }
  try {
    const structural = await write('insert_rows', { range: '1:1' }, 1)
    assert.equal(structural.result.isError, true)
    assert.match(structural.result.content[0].text, /invalid verified spreadsheet write/i)
    const unclearedFilters = await write('clear_filters', { range: 'A1:B2' }, 3)
    assert.equal(unclearedFilters.result.isError, true)
    assert.match(unclearedFilters.result.content[0].text, /invalid verified spreadsheet write/i)
  } finally { await connector.stop() }
})

test('keeps spreadsheet artifact text compact and rejects an oversized final MCP response', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 23, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-before' }
  let artifactBytes = 16 * 1024
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: target,
      result: request.action === 'write'
        ? { status: 'verified_write', resource, operation: request.operation, requested: { range: 'A1' }, observed: { range: 'A1', verified: true, artifact: { kind: 'range_image', mimeType: 'image/png', byteLength: artifactBytes, delivery: 'inline', dataUrl: `data:image/png;base64,${Buffer.alloc(artifactBytes, 1).toString('base64')}` } } }
        : { status: 'ok', resource, context: {} },
    })),
  })
  connector.bindBrowserTarget('spreadsheet-artifact-run', target)
  const endpoint = await connector.start()
  const write = async (identity, id) => {
    const inspected = await call(endpoint, { action: 'inspect_write' }, id)
    return call(endpoint, { action: 'write', challenge: inspected.result.structuredContent.challenge, idempotencyIdentity: identity, resource, operation: 'export_range_image', payload: { range: 'A1' } }, id + 1)
  }
  try {
    const compact = await write('spreadsheet-artifact-small', 1)
    assert.equal(compact.result.isError, undefined)
    assert.equal(compact.result.content[0].text.includes('data:image'), false)
    assert.match(compact.result.structuredContent.observed.artifact.dataUrl, /^data:image\/png;base64,/)

    artifactBytes = 128 * 1024
    const oversized = await write('spreadsheet-artifact-large', 3)
    assert.equal(oversized.result.isError, true)
    assert.match(oversized.result.content[0].text, /response limit/i)
  } finally { await connector.stop() }
})
