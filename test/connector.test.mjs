import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BrowserConnector } from '../native-server/src/connector.mjs'

async function callOfficeGetContext(endpoint, args = {}, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'office_get_context', arguments: args },
    }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('publishes office_get_context and correlates a simulated extension response', async () => {
  const requests = []
  const target = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://docs.example.test/budget' }
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      requests.push(request)
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: {
          status: 'browser_target_verified',
          pageIdentity: { title: 'Budget.xlsx — Summary', url: target.url },
          documentIdentity: null,
        },
      }))
    },
  })
  connector.bindBrowserTarget('run-7', target)
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
    assert.deepEqual(listBody.result.tools[0].inputSchema, {
      type: 'object', additionalProperties: false, properties: {},
    })
    assert.deepEqual(listBody.result.tools[0].outputSchema.required, [
      'runId', 'requestId', 'generation', 'browserTarget', 'officeContext',
    ])

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
          arguments: {},
        },
      }),
    })
    assert.equal(called.status, 200)
    const callBody = await called.json()
    assert.equal(callBody.result.structuredContent.runId, 'run-7')
    assert.equal(callBody.result.structuredContent.browserTarget.tabId, 12)
    assert.equal(callBody.result.structuredContent.officeContext.pageIdentity.title, 'Budget.xlsx — Summary')
    assert.equal(callBody.result.structuredContent.officeContext.documentIdentity, null)
    assert.deepEqual(callBody.result.structuredContent.officeContext.pageIdentity, {
      title: 'Budget.xlsx — Summary', url: target.url,
    })
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
  const target = { browser: 'chrome', windowId: 3, tabId: 8, url: 'https://docs.example.test/official' }
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: {
          status: 'browser_target_verified',
          pageIdentity: { title: 'Official-client.xlsx — Sheet1', url: target.url },
          documentIdentity: null,
        },
      }))
    },
  })
  connector.bindBrowserTarget('run-official-client', target)
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
      arguments: {},
    })
    assert.equal(result.structuredContent.runId, 'run-official-client')
    assert.equal(result.structuredContent.officeContext.pageIdentity.title, 'Official-client.xlsx — Sheet1')
  } finally {
    await client.close()
    await connector.stop()
  }
})

test('rejects office_get_context before extension execution until the trusted Native Host binding exists', async () => {
  const boundTarget = { browser: 'chrome', windowId: 9, tabId: 6, url: 'https://docs.example.test/bound' }
  let extensionRequests = 0
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      extensionRequests += 1
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: {
          status: 'browser_target_verified',
          pageIdentity: { title: 'Bound workbook', url: boundTarget.url },
          documentIdentity: null,
        },
      }))
    },
  })
  connector.bindBrowserTarget('run-bound', boundTarget)
  const endpoint = await connector.start()

  try {
    const unboundConnector = new BrowserConnector({ requestExtension: () => { extensionRequests += 1 } })
    const unboundEndpoint = await unboundConnector.start()
    const unbound = await callOfficeGetContext(unboundEndpoint)
    assert.equal(unbound.result.isError, true)
    assert.match(unbound.result.content[0].text, /no Browser Target is bound/i)
    assert.equal(extensionRequests, 0)
    await unboundConnector.stop()

    const bound = await callOfficeGetContext(endpoint)
    assert.equal(bound.result.structuredContent.runId, 'run-bound')
    assert.equal(extensionRequests, 1)

    const modelSelectedTarget = await callOfficeGetContext(endpoint, {
      runId: 'run-bound', browserTarget: boundTarget,
    }, 2)
    assert.equal(modelSelectedTarget.error.code, -32602)
    assert.match(modelSelectedTarget.error.message, /no model-controlled target arguments/i)
    assert.equal(extensionRequests, 1)
  } finally {
    await connector.stop()
  }
})

test('rejects an Extension response that does not satisfy the canonical office_get_context output schema', async () => {
  const target = { browser: 'chrome', windowId: 2, tabId: 5, url: 'https://docs.example.test/canonical' }
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: { workbook: 'not-canonical' },
      }))
    },
  })
  connector.bindBrowserTarget('run-canonical', target)
  const endpoint = await connector.start()

  try {
    const invalid = await callOfficeGetContext(endpoint)
    assert.equal(invalid.result.isError, true)
    assert.match(invalid.result.content[0].text, /canonical Office context schema/i)
  } finally {
    await connector.stop()
  }
})
