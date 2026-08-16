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
        ? { status: 'verified_write', resource: { ...resource, fingerprint: 'sheet-after' }, operation: request.operation, requested: { range: 'A1', values: [[42]] }, observed: { range: 'A1', values: [[42]] } }
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
    assert.deepEqual(written.result.structuredContent.observed, { range: 'A1', values: [[42]] })

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
