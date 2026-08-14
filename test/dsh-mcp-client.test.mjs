import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserConnector } from '../native-server/src/connector.mjs'
import { HarnessWebProcess } from '../native-server/src/harness-process.mjs'
import { Context } from '../../deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../deepseek-harness/packages/core/tools/lib/index.js'
import * as McpClient from '../../deepseek-harness/packages/mcp/mcp-client/lib/index.js'

function target(url = 'https://docs.example.test/dsh-client') {
  return { browser: 'chrome', windowId: 5, tabId: 9, url }
}

function respondingConnector(browserTarget, options = {}) {
  const connector = new BrowserConnector({
    ...options,
    requestExtension: (request) => {
      queueMicrotask(() => connector.acceptExtensionResponse({
        type: 'connector_response',
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        result: {
          status: 'browser_target_verified',
          pageIdentity: { title: 'DSH client workbook', url: browserTarget.url },
          documentIdentity: null,
        },
      }))
    },
  })
  connector.bindBrowserTarget('trusted-dsh-run', browserTarget)
  return connector
}

test('the installed DSH MCP client discovers and executes the Connector tool through ToolRuntime', async () => {
  const browserTarget = target()
  const connector = respondingConnector(browserTarget)
  const endpoint = await connector.start()
  const ctx = new Context()

  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin({ inject: McpClient.inject, apply: McpClient.apply }, {
      transport: 'streamable-http',
      serverName: 'chrome',
      url: `${endpoint.url}/mcp`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
      failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
    })

    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ['mcp__chrome__office_get_context'])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'dsh-mcp-client-test',
      name: 'mcp__chrome__office_get_context',
      arguments: {},
    })
    assert.equal(result.isError, false)
    assert.equal(result.value.structuredContent.runId, 'trusted-dsh-run')
    assert.equal(result.value.structuredContent.officeContext.documentIdentity, null)
  } finally {
    await ctx.fiber.dispose()
    await connector.stop()
  }
})

test('a real DSH Web profile loads its generated MCP patch and discovers the Connector tool', { timeout: 60_000 }, async () => {
  const browserTarget = target('https://docs.example.test/profile')
  const listed = Promise.withResolvers()
  const connector = respondingConnector(browserTarget, {
    onToolsListed: () => listed.resolve(),
  })
  const endpoint = await connector.start()
  const harness = new HarnessWebProcess({
    mcpConnector: { url: `${endpoint.url}/mcp`, token: endpoint.token },
  })

  try {
    const url = await harness.start()
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const timeout = setTimeout(() => listed.reject(new Error('DSH Web profile never listed the generated Connector patch tools')), 15_000)
    try {
      await listed.promise
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await harness.stop()
    await connector.stop()
  }
})
