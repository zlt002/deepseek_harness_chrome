import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../native-server/src/connector.mjs'

test('publishes office_read_range and correlates a bounded WebEdit range response', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://doc.midea.com/sheets/budget' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response',
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget: request.browserTarget,
      result: {
        status: 'ok',
        resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'webedit:budget-summary' },
        range: {
          address: 'Summary!A1:B2', rowCount: 2, columnCount: 2,
          rows: [
            { index: 1, cells: [{ address: 'A1', row: 1, column: 1, text: 'Revenue', value: 'Revenue', formula: null }, { address: 'B1', row: 1, column: 2, text: '42', value: 42, formula: null }] },
            { index: 2, cells: [{ address: 'A2', row: 2, column: 1, text: 'Cost', value: 'Cost', formula: null }, { address: 'B2', row: 2, column: 2, text: '7', value: 7, formula: '=SUM(3,4)' }] },
          ],
        },
      },
    })),
  })
  connector.bindBrowserTarget('run-office-read', target)
  const endpoint = await connector.start()

  try {
    const list = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const tools = (await list.json()).result.tools
    const tool = tools.find((candidate) => candidate.name === 'office_read_range')
    assert.deepEqual(tool.inputSchema.required, ['range'])

    const call = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_read_range', arguments: { range: 'Summary!A1:B2' } } }),
    })
    const body = await call.json()
    assert.equal(body.result.structuredContent.runId, 'run-office-read')
    assert.equal(body.result.structuredContent.browserTarget.tabId, 12)
    assert.deepEqual(body.result.structuredContent.range.rows[1].cells[1], {
      address: 'B2', row: 2, column: 2, text: '7', value: 7, formula: '=SUM(3,4)',
    })
  } finally {
    await connector.stop()
  }
})
