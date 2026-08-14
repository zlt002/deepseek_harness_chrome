import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BrowserConnector } from '../native-server/src/connector.mjs'

test('publishes office_get_context and correlates a simulated extension response', async () => {
  const requests = []
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      requests.push(request)
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: { workbookName: 'Budget.xlsx', worksheetName: 'Summary' },
      }))
    },
  })
  const started = await connector.start()

  try {
    const listed = await fetch(`${started.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${started.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    assert.equal(listed.status, 200)
    const listBody = await listed.json()
    assert.equal(listBody.result.tools[0].name, 'office_get_context')

    const called = await fetch(`${started.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${started.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'office_get_context',
          arguments: {
            runId: 'run-7',
            browserTarget: { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://docs.example.test/budget' },
          },
        },
      }),
    })
    assert.equal(called.status, 200)
    const callBody = await called.json()
    assert.equal(callBody.result.structuredContent.runId, 'run-7')
    assert.equal(callBody.result.structuredContent.browserTarget.tabId, 12)
    assert.equal(callBody.result.structuredContent.officeContext.workbookName, 'Budget.xlsx')
    assert.equal(requests[0].generation, callBody.result.structuredContent.generation)
    assert.equal(requests[0].requestId, callBody.result.structuredContent.requestId)
    assert.doesNotMatch(JSON.stringify(callBody), new RegExp(started.token))

    const rejected = await fetch(`${started.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })
    assert.equal(rejected.status, 401)
  } finally {
    await connector.stop()
  }
})

test('accepts the official MCP client at the public tools/list and tools/call seam', async () => {
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: { workbookName: 'Official-client.xlsx', worksheetName: 'Sheet1' },
      }))
    },
  })
  const started = await connector.start()
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${started.token}` } },
  })
  const client = new Client({ name: 'issue-2-test-client', version: '1.0.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['office_get_context'])

    const result = await client.callTool({
      name: 'office_get_context',
      arguments: {
        runId: 'run-official-client',
        browserTarget: { browser: 'chrome', windowId: 3, tabId: 8, url: 'https://docs.example.test/official' },
      },
    })
    assert.equal(result.structuredContent.runId, 'run-official-client')
    assert.equal(result.structuredContent.officeContext.workbookName, 'Official-client.xlsx')
  } finally {
    await client.close()
    await connector.stop()
  }
})
