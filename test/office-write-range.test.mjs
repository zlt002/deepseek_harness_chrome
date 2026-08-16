import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'

test('publishes approval-annotated office_write_range and returns a verified readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sha256:sheet-1' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: { status: 'verified_write', resource, requested: { range: 'Summary!A1:B1', values: [['Revenue', 42]] }, observed: { range: 'Summary!A1:B1', values: [['Revenue', 42]] } },
    })),
  })
  connector.bindBrowserTarget('run-office-write', target)
  const endpoint = await connector.start()
  try {
    const listed = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const tool = (await listed.json()).result.tools.find((item) => item.name === 'office_write_range')
    assert.deepEqual(tool.annotations, { destructiveHint: true, idempotentHint: false, openWorldHint: false })
    const called = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_write_range', arguments: { range: 'Summary!A1:B1', values: [['Revenue', 42]], resource } } }),
    })
    const body = await called.json()
    assert.equal(body.result.structuredContent.runId, 'run-office-write')
    assert.deepEqual(body.result.structuredContent.requested, body.result.structuredContent.observed)
    assert.equal(body.result.structuredContent.resource.fingerprint, resource.fingerprint)
  } finally {
    await connector.stop()
  }
})

test('rejects a stale resource fingerprint and a mismatched readback from the extension peer', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sha256:sheet-1' }
  let call = 0
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      ...(call++ === 0 ? { error: { code: 'fingerprint_mismatch', message: 'sheet changed' } } : { result: { status: 'verified_write', resource, requested: { range: 'Summary!A1', values: [[1]] }, observed: { range: 'Summary!A1', values: [[2]] } } }),
    })),
  })
  connector.bindBrowserTarget('run-office-write', target)
  const endpoint = await connector.start()
  const bodyFor = async (id) => (await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'office_write_range', arguments: { range: 'Summary!A1', values: [[1]], resource } } }) })).json()
  try {
    const fingerprint = await bodyFor(1)
    assert.equal(fingerprint.result.isError, true)
    assert.match(fingerprint.result.content[0].text, /fingerprint_mismatch/)
    const mismatch = await bodyFor(2)
    assert.equal(mismatch.result.isError, true)
    assert.match(mismatch.result.content[0].text, /invalid verified Office write schema/)
  } finally { await connector.stop() }
})

test('does not accept a write response for a changed Browser Target', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://doc.midea.com/sheets/budget' }
  const changed = { ...target, url: 'https://doc.midea.com/sheets/other' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sha256:sheet-1' }
  let accepted
  const connector = new BrowserConnector({ requestTimeoutMs: 15, requestExtension: (request) => { accepted = connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: changed, result: { status: 'verified_write', resource, requested: { range: 'Summary!A1', values: [[1]] }, observed: { range: 'Summary!A1', values: [[1]] } } }) } })
  connector.bindBrowserTarget('run-office-write', target)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'office_write_range', arguments: { range: 'Summary!A1', values: [[1]], resource } } }) })
    const body = await response.json()
    assert.equal(accepted, false)
    assert.equal(body.result.isError, true)
  } finally { await connector.stop() }
})
