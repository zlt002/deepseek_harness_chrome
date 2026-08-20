import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { HarnessWebProcess } from '../apps/native-server/src/harness-process.mjs'
import { Context } from '../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import { createScope } from '../upstream/deepseek-harness/packages/core/scope/lib/index.js'
import { Session, SessionId } from '../upstream/deepseek-harness/packages/core/session/lib/index.js'
import SystemPrompt from '../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../upstream/deepseek-harness/packages/core/tools/lib/index.js'
import * as McpClient from '../upstream/deepseek-harness/packages/mcp/mcp-client/lib/index.js'
import * as ProductMcpScopes from '../packages/harness-runtime/src/index.mjs'

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

    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name).sort(), [
      'mcp__chrome__code_search',
      'mcp__chrome__knowledge_search',
      'mcp__chrome__light_document_read',
      'mcp__chrome__light_document_search',
      'mcp__chrome__light_document_selection_read',
      'mcp__chrome__light_document_selection_replace_commit',
      'mcp__chrome__light_document_selection_replace_preview',
      'mcp__chrome__light_document_write_commit',
      'mcp__chrome__light_document_write_preview',
      'mcp__chrome__list_work_tabs',
      'mcp__chrome__read_work_tab',
      'mcp__chrome__selected_source_scope',
      'mcp__chrome__team_knowledge_batch_create',
      'mcp__chrome__team_knowledge_batch_preview',
    ])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'dsh-mcp-client-test',
      name: 'mcp__chrome__list_work_tabs',
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

test('the product MCP adapter keeps search tools private on clean official Harness services', async () => {
  const browserTarget = target('https://docs.example.test/product-mcp')
  const connector = respondingConnector(browserTarget)
  const endpoint = await connector.start()
  const ctx = new Context()
  let installContinuableChild

  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('subagents', {
      registerContinuableSetup(setup) {
        installContinuableChild = setup
        return () => { installContinuableChild = undefined }
      },
    })
    await ctx.plugin({ inject: ProductMcpScopes.inject, apply: ProductMcpScopes.apply }, {
      serverName: 'chrome',
      url: `${endpoint.url}/mcp`,
      headers: { Authorization: `Bearer ${endpoint.token}` },
      failOnStartupError: true,
      toolScopes: {
        default: 'global',
        code_search: 'continuable-child',
        knowledge_search: 'continuable-child',
      },
    })

    assert.equal(ctx.tools.get('mcp__chrome__list_work_tabs') !== undefined, true)
    assert.equal(ctx.tools.get('mcp__chrome__code_search'), undefined)
    assert.equal(ctx.tools.get('mcp__chrome__knowledge_search'), undefined)
    assert.equal(typeof installContinuableChild, 'function')

    const sessionId = SessionId('product-mcp-child')
    const session = Session.create(sessionId, [], { version: 0, id: sessionId, createdAt: 0, origin: 'subagent' })
    const child = { id: sessionId, session }
    const childCtx = createScope(ctx, child).ctx
    let release
    const childFiber = childCtx.plugin(Object.assign((injectedChildCtx) => {
      release = installContinuableChild(injectedChildCtx)
    }, { inject: ['tools'] }))
    await childFiber.await()
    assert.equal(ctx.tools.get('mcp__chrome__code_search', child) !== undefined, true)
    assert.equal(ctx.tools.get('mcp__chrome__knowledge_search', child) !== undefined, true)
    release()
    assert.equal(ctx.tools.get('mcp__chrome__code_search', child), undefined)
    await childFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
    await connector.stop()
  }
})

test('a real DSH Web profile loads, discovers, and executes its generated Connector patch', { timeout: 60_000 }, async () => {
  const browserTarget = target('https://docs.example.test/profile')
  const listed = Promise.withResolvers()
  const executed = Promise.withResolvers()
  const reporter = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    executed.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(204)
    response.end()
  })
  await new Promise((resolveListen) => reporter.listen(0, '127.0.0.1', resolveListen))
  const reporterAddress = reporter.address()
  assert.notEqual(typeof reporterAddress, 'string')
  const patchDir = await mkdtemp(`${tmpdir()}/deepseek-harness-profile-probe-`)
  const patchPath = resolve(patchDir, 'profile-probe.cordis.yml')
  await writeFile(patchPath, `- insert:\n    - id: profile-tool-probe\n      name: '${pathToFileURL(resolve('test/fixtures/profile-tool-probe.mjs')).href}'\n      config:\n        toolName: mcp__chrome__list_work_tabs\n        resultUrl: 'http://127.0.0.1:${String(reporterAddress.port)}'\n`)
  const connector = respondingConnector(browserTarget, {
    onToolsListed: () => listed.resolve(),
  })
  const endpoint = await connector.start()
  const harness = new HarnessWebProcess({
    mcpConnector: { url: `${endpoint.url}/mcp`, token: endpoint.token },
    extraPatchPaths: [patchPath],
  })

  try {
    const url = await harness.start()
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const html = await fetch(`${url}/`).then((response) => response.text())
    assert.match(html, /window\.__DSH_BOOT__/)
    const timeout = setTimeout(() => listed.reject(new Error('DSH Web profile never listed the generated Connector patch tools')), 15_000)
    try {
      await listed.promise
    } finally {
      clearTimeout(timeout)
    }
    const executionTimeout = setTimeout(() => executed.reject(new Error('DSH Web profile never executed the loaded Connector tool')), 5_000)
    try {
      const result = await executed.promise
      assert.equal(result.isError, false)
      assert.equal(result.value.structuredContent.browserTarget.url, browserTarget.url)
      assert.equal(result.value.structuredContent.officeContext.documentIdentity, null)
    } finally {
      clearTimeout(executionTimeout)
    }
  } finally {
    await harness.stop()
    await connector.stop()
    await new Promise((resolveClose) => reporter.close(resolveClose))
    await rm(patchDir, { recursive: true, force: true })
  }
})
