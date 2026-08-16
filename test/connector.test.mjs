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

test('publishes every trusted pinned context and unavailable item without model-selected targets', async () => {
  const first = { browser: 'chrome', windowId: 4, tabId: 12, url: 'https://docs.example.test/one' }
  const primary = { browser: 'chrome', windowId: 4, tabId: 13, url: 'https://docs.example.test/two' }
  const unavailable = { browserTarget: { browser: 'chrome', windowId: 4, tabId: 14, url: 'https://docs.example.test/closed' }, reason: 'closed_or_changed' }
  const connector = new BrowserConnector({
    requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
      browserTarget: primary, browserTargets: [first, primary], unavailableBrowserTargets: [unavailable],
      result: {
        status: 'browser_target_verified', pageIdentity: { title: 'Two', url: primary.url }, documentIdentity: null,
        primaryBrowserTarget: primary,
        pages: [
          { browserTarget: first, pageIdentity: { title: 'One', url: first.url }, documentIdentity: null, isPrimary: false },
          { browserTarget: primary, pageIdentity: { title: 'Two', url: primary.url }, documentIdentity: null, isPrimary: true },
        ],
        unavailableBrowserTargets: [unavailable],
      },
    })),
  })
  connector.bindBrowserTarget('run-pinned', primary, [first, primary], [unavailable])
  const endpoint = await connector.start()
  try {
    const body = await callOfficeGetContext(endpoint)
    assert.deepEqual(body.result.structuredContent.browserTargets, [first, primary])
    assert.deepEqual(body.result.structuredContent.primaryBrowserTarget, primary)
    assert.deepEqual(body.result.structuredContent.unavailableBrowserTargets, [unavailable])
    assert.equal(body.result.structuredContent.officeContext.pages.length, 2)
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
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['office_get_context', 'office_read_range', 'office_write_range', 'office_document', 'office_spreadsheet', 'team_doc_create', 'team_knowledge_item', 'team_knowledge_batch', 'pmd_prd_delivery', 'browser_open_tab', 'knowledge_search', 'code_search'])
    const spreadsheet = tools.tools.find((tool) => tool.name === 'office_spreadsheet')
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_zoom'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_freeze_panes'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_print_settings'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_outline_group'))
    assert.ok(spreadsheet.inputSchema.properties.action.enum.includes('special_cells'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_rows_hidden'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('set_columns_hidden'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('auto_fit'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('fill_range'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('batch_write'))
    assert.ok(spreadsheet.inputSchema.properties.operation.enum.includes('activate_worksheet'))
    assert.equal(spreadsheet.inputSchema.properties.operation.enum.includes('copy_worksheet'), false)
    const codeSearch = tools.tools.find((tool) => tool.name === 'code_search')
    assert.deepEqual(codeSearch?.inputSchema, {
      type: 'object', additionalProperties: false, required: ['question'],
      properties: { question: { type: 'string', minLength: 1, maxLength: 4000 } },
    })

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

test('routes a continuable child identity to the knowledge adapter without model-controlled scope arguments', async () => {
  let seen
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      seen = request
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
        result: { status: 'complete', answer: '知识答案', sources: [{ id: 'page-1', title: '来源' }] },
      }))
    },
  })
  connector.registerRun('knowledge-run')
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_search', arguments: { question: '订单流程' }, _meta: { 'io.deepseek.harness/sessionId': 'child-1', 'io.deepseek.harness/parentSessionId': 'parent-1' } } }),
    })
    const body = await response.json()
    assert.equal(body.result.structuredContent.answer, '知识答案')
    assert.deepEqual(seen, { type: 'connector_request', requestId: seen.requestId, runId: 'knowledge-run', generation: seen.generation, tool: 'knowledge_search', harnessSessionId: 'child-1', harnessParentSessionId: 'parent-1', question: '订单流程' })
  } finally { await connector.stop() }
})

test('proxies only bounded Knowledge Platform requests with browser cookies inside the native boundary', async () => {
  const upstreamCalls = []
  const connector = new BrowserConnector({
    requestExtension: () => {},
    fetch: async (url, init) => {
      upstreamCalls.push({ url: String(url), init })
      return new Response(JSON.stringify({ data: [{ id: 'repo', name: 'H5_前端' }] }), { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })
    },
  })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/knowledge-proxy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/api-sse-kd/api/repos', method: 'GET', headers: [['accept', 'application/json']], cookie: 'session=browser-only' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.deepEqual(await response.json(), { data: [{ id: 'repo', name: 'H5_前端' }] })
    assert.equal(upstreamCalls[0].url, 'https://anapi-uat.annto.com/api-sse-kd/api/repos')
    assert.equal(upstreamCalls[0].init.headers.get('cookie'), 'session=browser-only')
    assert.equal(upstreamCalls[0].init.headers.get('origin'), 'https://wb-uat.annto.com')
    assert.equal(upstreamCalls[0].init.headers.get('referer'), 'https://wb-uat.annto.com/')
    assert.equal(upstreamCalls[0].init.headers.get('cache-control'), 'no-cache')
    assert.equal(upstreamCalls[0].init.redirect, 'follow')

    const identity = await fetch(`${endpoint.url}/knowledge-proxy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/api-sse-kd/api/auth/me', method: 'GET', cookie: 'session=browser-only' }),
    })
    assert.equal(identity.status, 200)
    assert.equal(upstreamCalls[1].url, 'https://anapi-uat.annto.com/api-sse-kd/api/auth/me')

    const rejected = await fetch(`${endpoint.url}/knowledge-proxy`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/api-sse-kd/api/admin', method: 'GET', cookie: 'session=browser-only' }),
    })
    assert.equal(rejected.status, 400)
    assert.equal(upstreamCalls.length, 2)
  } finally { await connector.stop() }
})

test('accepts a large enterprise SSO cookie header within the AccrUI 64KB boundary', async () => {
  const upstreamCalls = []
  const connector = new BrowserConnector({
    requestExtension: () => {},
    fetch: async (url, init) => {
      upstreamCalls.push({ url: String(url), init })
      return new Response(JSON.stringify({ data: { id: 'current-user' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/knowledge-proxy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/api-sse-kd/api/auth/me', method: 'GET', cookie: `enterprise_sso=${'x'.repeat(32_000)}` }),
    })
    assert.equal(response.status, 200)
    assert.equal(upstreamCalls.length, 1)
  } finally { await connector.stop() }
})

test('bounds catalog proxy requests separately from long knowledge queries', async () => {
  const connector = new BrowserConnector({
    requestExtension: () => {},
    knowledgeCatalogTimeoutMs: 20,
    knowledgeRequestTimeoutMs: 10_000,
    fetch: async (_url, init) => new Promise((_, reject) => {
      const fallback = setTimeout(() => reject(new Error('upstream catalog still pending')), 300)
      init.signal.addEventListener('abort', () => {
        clearTimeout(fallback)
        reject(init.signal.reason)
      }, { once: true })
    }),
  })
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/knowledge-proxy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/api-sse-kd/api/repos', method: 'GET', cookie: '' }),
      signal: AbortSignal.timeout(150),
    })
    assert.equal(response.status, 502)
  } finally { await connector.stop() }
})

test('keeps the long knowledge timeout separate and cancels the Extension request when it expires', async () => {
  const requests = []
  const connector = new BrowserConnector({
    requestExtension: (request) => requests.push(request),
    requestTimeoutMs: 1,
    knowledgeRequestTimeoutMs: 20,
  })
  connector.registerRun('knowledge-timeout-run')
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_search', arguments: { question: '慢查询' }, _meta: { 'io.deepseek.harness/sessionId': 'child-1', 'io.deepseek.harness/parentSessionId': 'parent-1' } } }),
    })
    const body = await response.json()
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /timed out/)
    assert.equal(requests[0].type, 'connector_request')
    assert.deepEqual(requests[1], {
      type: 'connector_cancel', requestId: requests[0].requestId, runId: 'knowledge-timeout-run', generation: requests[0].generation,
    })
  } finally { await connector.stop() }
})

test('publishes browser_open_tab and returns the target that the Extension explicitly transferred for the Run', async () => {
  const opened = { browser: 'chrome', windowId: 4, tabId: 19, url: 'https://docs.example.test/opened' }
  const initial = { browser: 'chrome', windowId: 4, tabId: 18, url: 'https://docs.example.test/initial' }
  const requests = []
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      requests.push(request)
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
        browserTarget: opened, result: { pageIdentity: { title: 'Opened target', url: opened.url } },
      }))
    },
  })
  connector.bindBrowserTarget('run-open', initial)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'browser_open_tab', arguments: { url: opened.url } },
      }),
    })
    const body = await response.json()
    assert.equal(body.result.structuredContent.runId, 'run-open')
    assert.deepEqual(body.result.structuredContent.browserTarget, opened)
    assert.deepEqual(body.result.structuredContent.pageIdentity, { title: 'Opened target', url: opened.url })
    assert.deepEqual(requests[0], {
      type: 'connector_request', requestId: requests[0].requestId, runId: 'run-open', generation: requests[0].generation,
      tool: 'browser_open_tab', url: opened.url,
    })
  } finally {
    await connector.stop()
  }
})

test('rejects browser_open_tab for an unbound none Run without requesting the Extension', async () => {
  let extensionRequests = 0
  const connector = new BrowserConnector({ requestExtension: () => { extensionRequests += 1 } })
  connector.registerRun('run-none')
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_open_tab', arguments: { url: 'https://docs.example.test/new' } } }),
    })
    const body = await response.json()
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /No Browser Target is bound/i)
    assert.equal(extensionRequests, 0)
  } finally {
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

test('uses an Extension-confirmed Browser Target transfer for the next office turn', async () => {
  const initial = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://www.baidu.com/' }
  const next = { browser: 'chrome', windowId: 7, tabId: 43, url: 'https://wb.example.test/' }
  const connector = new BrowserConnector({
    requestTimeoutMs: 50,
    requestExtension: (request) => {
      queueMicrotask(() => {
        connector.bindBrowserTarget(request.runId, next)
        connector.acceptExtensionResponse({
          type: 'connector_response',
          requestId: request.requestId,
          runId: request.runId,
          generation: request.generation,
          browserTarget: next,
          result: {
            status: 'browser_target_verified',
            pageIdentity: { title: 'WB', url: next.url },
            documentIdentity: null,
          },
        })
      })
    },
  })
  connector.bindBrowserTarget('run-follow', initial)
  const endpoint = await connector.start()

  try {
    const response = await callOfficeGetContext(endpoint)
    assert.equal(response.result.structuredContent.browserTarget.url, next.url)
    assert.equal(response.result.structuredContent.officeContext.pageIdentity.url, next.url)
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
