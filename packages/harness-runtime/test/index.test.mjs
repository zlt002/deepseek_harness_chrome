import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createSelectedSourceDispatchGuard, installSelectedSourceDispatchTracking, installSelectedSourceProgressCompletionGate, partitionTools, publicToolName, sessionMeta } from '../src/index.mjs'

test('separates only configured raw MCP names into the continuable-child scope', () => {
  const tools = new Map([
    ['mcp__chrome__list_work_tabs', { rawName: 'list_work_tabs', definition: {} }],
    ['mcp__chrome__code_search', { rawName: 'code_search', definition: {} }],
  ])
  const result = partitionTools(tools, { code_search: 'continuable-child', default: 'global' })
  assert.deepEqual([...result.global.keys()], ['mcp__chrome__list_work_tabs'])
  assert.deepEqual([...result.continuableChild.keys()], ['mcp__chrome__code_search'])
})

test('forwards session lineage only when the product enables it', () => {
  const exec = { agent: { id: 'child-1', session: { header: { parentSession: 'parent-1' } } } }
  assert.equal(sessionMeta(exec, false), undefined)
  assert.deepEqual(sessionMeta(exec, true), {
    'io.deepseek.harness/sessionId': 'child-1',
    'io.deepseek.harness/parentSessionId': 'parent-1',
  })
})

test('keeps public names deterministic and within Harness function-name limits', () => {
  const name = publicToolName('chrome', 'search/with spaces and a deliberately very long name that exceeds the limit')
  assert.match(name, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(name, publicToolName('chrome', 'search/with spaces and a deliberately very long name that exceeds the limit'))
})

test('admits one selected-source child per parent turn and rejects generic delegation after scope discovery', () => {
  const guard = createSelectedSourceDispatchGuard()
  const exec = (name, turn) => ({
    name,
    agent: { id: 'parent-1', session: { events: [{ type: 'turn/start', data: { turn } }] } },
  })

  assert.equal(guard(exec('mcp__chrome__selected_source_scope', 1)), undefined)
  assert.match(guard(exec('subagent', 1)), /所选远程范围/)
  assert.equal(guard(exec('search_selected_remote_code', 1)), undefined)
  assert.match(guard(exec('search_selected_remote_code', 1)), /已启动一个 selected-source 检索/)
  assert.match(guard(exec('search_selected_knowledge', 1)), /先等待该结果结算/)
  assert.equal(guard(exec('search_selected_remote_code', 2)), undefined)
  assert.match(guard(exec('search_selected_knowledge', 2)), /已启动一个 selected-source 检索/)
  assert.equal(guard(exec('search_selected_knowledge', 3)), undefined)

  const directSearchGuard = createSelectedSourceDispatchGuard()
  assert.equal(directSearchGuard(exec('search_selected_remote_code', 3)), undefined)
  assert.match(directSearchGuard(exec('subagent', 3)), /所选远程范围/)
})

test('rejects expanded first selected-source prompts until real search evidence settles', () => {
  const guard = createSelectedSourceDispatchGuard()
  const userMessage = (text) => ({
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
    },
  })
  const exec = (name, prompt, events) => ({
    name,
    arguments: { description: '检索客户管理', prompt },
    agent: { id: 'parent-pmd', session: { events } },
  })
  const initialEvents = [
    userMessage('/pmd-prd  优化下客户管理功能'),
    { type: 'turn/start', data: { turn: 1 } },
  ]
  const expanded = '请检索客户列表、导入导出、权限、软删除等完整现状'

  assert.match(
    guard(exec('search_selected_remote_code', expanded, initialEvents)),
    /首次检索.*优化下客户管理功能/,
  )
  assert.equal(
    guard(exec('search_selected_remote_code', '优化下客户管理功能', initialEvents)),
    undefined,
  )

  const knowledgeGuard = createSelectedSourceDispatchGuard()
  assert.match(
    knowledgeGuard(exec('search_selected_knowledge', expanded, initialEvents)),
    /首次检索.*优化下客户管理功能/,
  )
  assert.equal(
    knowledgeGuard(exec('search_selected_knowledge', '优化下客户管理功能', initialEvents)),
    undefined,
  )

  const directGuard = createSelectedSourceDispatchGuard()
  const directEvents = [userMessage('怎么出库啊'), { type: 'turn/start', data: { turn: 1 } }]
  assert.match(
    directGuard(exec('search_selected_remote_code', '请完整解释怎么出库', directEvents)),
    /请把 prompt 原样改为："怎么出库啊"/,
  )
  assert.equal(
    directGuard(exec('search_selected_remote_code', '怎么出库啊', directEvents)),
    undefined,
  )

  const latestUserGuard = createSelectedSourceDispatchGuard()
  const latestUserEvents = [
    userMessage('/pmd-prd  优化下客户管理功能'),
    userMessage('重点优化客户查询速度'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.match(
    latestUserGuard(exec('search_selected_remote_code', '优化下客户管理功能', latestUserEvents)),
    /请把 prompt 原样改为："重点优化客户查询速度"/,
  )
  assert.equal(
    latestUserGuard(exec('search_selected_remote_code', '重点优化客户查询速度', latestUserEvents)),
    undefined,
  )

  const failedFollowupGuard = createSelectedSourceDispatchGuard()
  const failedEvents = [
    ...initialEvents.slice(0, 1),
    {
      type: 'tool/call',
      data: { callId: 'selected-source-failed', name: 'search_selected_remote_code', arguments: '{}' },
    },
    {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'It left no closing message.' }],
        source: {
          kind: 'subagent-settled',
          senderSessionId: 'child-failed',
          summary: 'Background subagent child-failed failed before it finished.',
        },
        role: 'user',
      },
    },
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.match(
    failedFollowupGuard(exec('search_selected_remote_code', expanded, failedEvents)),
    /首次检索.*优化下客户管理功能/,
  )

  const followupGuard = createSelectedSourceDispatchGuard()
  const settledEvents = [
    userMessage('/pmd-prd  优化下客户管理功能'),
    {
      type: 'tool/call',
      data: {
        callId: 'selected-source-1',
        name: 'search_selected_remote_code',
        arguments: JSON.stringify({ prompt: '优化下客户管理功能' }),
      },
    },
    {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'Its closing message:\nsrc/customer.ts 显示已有客户列表。' }],
        source: {
          kind: 'subagent-settled',
          senderSessionId: 'child-1',
          summary: 'Background subagent child-1 finished and will do no further work unless you send it more.',
        },
        role: 'user',
      },
    },
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.equal(
    followupGuard(exec('search_selected_knowledge', '根据 src/customer.ts 补查客户状态规则', settledEvents)),
    undefined,
  )
})

test('releases a selected-source admission when dispatch fails before a child starts', async () => {
  const guard = createSelectedSourceDispatchGuard()
  const listeners = new Map()
  const context = () => ({
    on(name, listener) {
      const registered = listeners.get(name) ?? new Set()
      registered.add(listener)
      listeners.set(name, registered)
      return () => registered.delete(listener)
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  })
  const rootCtx = context()
  const agentCtx = context()
  const exec = (name) => ({
    name,
    agent: { id: 'parent-retry', ctx: agentCtx, session: { events: [{ type: 'turn/start', data: { turn: 1 } }] } },
  })
  const stop = installSelectedSourceDispatchTracking(rootCtx, guard)
  const dispatch = async (call, body) => {
    const [listener] = listeners.get('tools/execute') ?? []
    return listener(call, body)
  }

  const search = exec('search_selected_remote_code')
  assert.equal(guard(search), undefined)
  await dispatch(search, async () => ({ isError: true }))
  assert.equal(guard(search), undefined)
  await dispatch(search, async () => {
    agentCtx.emit('subagent/start', { runId: 'child-1' })
    return { isError: true }
  })
  assert.match(guard(exec('search_selected_knowledge')), /已启动一个 selected-source 检索/)
  stop()
})

test('keeps a turn open when it claims background code search without starting a selected-source child', async () => {
  const guard = createSelectedSourceDispatchGuard()
  let stopping
  const ctx = {
    on(name, listener) {
      if (name === 'agent/turn-stopping') stopping = listener
      return () => { stopping = undefined }
    },
  }
  const steered = []
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: '代码正在后台查询，您无需等待；结果回来后我会先核对现状。' }],
        },
      },
    },
  ]
  const agent = {
    id: 'parent-progress-gate',
    session: { events },
    steer(message) { steered.push(message) },
  }

  const stop = installSelectedSourceProgressCompletionGate(ctx, guard)
  await stopping({ agent, turn: 1, signal: new AbortController().signal })

  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /立即调用 search_selected_remote_code/)

  await stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 2, 'the turn must remain open until a real child starts')

  events.push({ type: 'tool/call', data: { name: 'search_selected_remote_code' } })
  const search = { name: 'search_selected_remote_code', agent }
  assert.equal(guard(search), undefined)
  guard.childStarted(search)
  await stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 2)
  stop()
})

test('does not require a second wrapper after any selected-source child starts and skips subagent turns', async () => {
  const guard = createSelectedSourceDispatchGuard()
  let stopping
  const ctx = {
    on(name, listener) {
      if (name === 'agent/turn-stopping') stopping = listener
      return () => { stopping = undefined }
    },
  }
  const steered = []
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: '知识库正在后台查询，结果回来后我会继续整理。' }],
        },
      },
    },
  ]
  const agent = {
    id: 'parent-mismatched-progress-gate',
    session: { events },
    steer(message) { steered.push(message) },
  }

  const stop = installSelectedSourceProgressCompletionGate(ctx, guard)
  const search = { name: 'search_selected_remote_code', agent }
  assert.equal(guard(search), undefined)
  guard.childStarted(search)
  await stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0, 'any real selected-source child satisfies the progress gate')

  const subagentSteered = []
  const subagent = {
    id: 'selected-source-child',
    session: {
      header: { origin: 'subagent' },
      events,
    },
    steer(message) { subagentSteered.push(message) },
  }
  await stopping({ agent: subagent, turn: 1, signal: new AbortController().signal })
  assert.equal(subagentSteered.length, 0, 'the progress gate must not inspect subagent sessions')
  stop()
})

function toolRegistry() {
  const registered = new Map()
  const guards = new Set()
  return {
    registered,
    guards,
    register(definition) {
      registered.set(definition.name, definition)
      return () => {
        if (registered.get(definition.name) === definition) registered.delete(definition.name)
      }
    },
    guard(guard) {
      guards.add(guard)
      return () => { guards.delete(guard) }
    },
  }
}

test('installs scoped MCP tools only for continuable children and cleans them up', async () => {
  const rootTools = toolRegistry()
  const normalChildTools = toolRegistry()
  const continuableChildTools = toolRegistry()
  let installContinuableChild
  let stopSetupCalls = 0
  let disposePlugin
  const ctx = {
    tools: rootTools,
    on() { return () => {} },
    subagents: {
      registerContinuableSetup(setup) {
        installContinuableChild = setup
        return () => { stopSetupCalls += 1 }
      },
    },
    effect(setup) { disposePlugin = setup() },
    logger: { error(message) { throw new Error(message) } },
  }
  const originalFetch = globalThis.fetch
  const listedTools = [
    { name: 'list_work_tabs', description: 'list work tabs', inputSchema: { type: 'object' } },
    { name: 'code_search', description: 'search code', inputSchema: { type: 'object' } },
    { name: 'knowledge_search', description: 'search knowledge', inputSchema: { type: 'object' } },
  ]
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    requests.push(request)
    const envelope = { jsonrpc: '2.0', id: request.id, result: request.method === 'tools/list' ? { tools: listedTools } : {} }
    return {
      ok: true,
      async json() { return envelope },
      async text() { return JSON.stringify(envelope) },
    }
  }

  try {
    await apply(ctx, {
      serverName: 'chrome',
      url: 'http://connector.test/mcp',
      toolScopes: { code_search: 'continuable-child', knowledge_search: 'continuable-child' },
      fetch: globalThis.fetch,
    })

    assert.equal(typeof installContinuableChild, 'function')
    assert.deepEqual([...rootTools.registered.keys()], ['mcp__chrome__list_work_tabs'])
    assert.deepEqual([...normalChildTools.registered.keys()], [])

    const removeContinuableChild = installContinuableChild({ tools: continuableChildTools })
    assert.deepEqual([...continuableChildTools.registered.keys()], [
      'mcp__chrome__code_search',
      'mcp__chrome__knowledge_search',
    ])
    assert.deepEqual([...new Map([...rootTools.registered, ...continuableChildTools.registered]).keys()], [
      'mcp__chrome__list_work_tabs',
      'mcp__chrome__code_search',
      'mcp__chrome__knowledge_search',
    ])
    assert.deepEqual(requests.map((request) => request.method), ['initialize', 'notifications/initialized', 'tools/list'])

    removeContinuableChild()
    assert.deepEqual([...continuableChildTools.registered.keys()], [])

    installContinuableChild({ tools: continuableChildTools })
    disposePlugin()
    assert.deepEqual([...rootTools.registered.keys()], [])
    assert.deepEqual([...continuableChildTools.registered.keys()], [])
    assert.equal(stopSetupCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('MCP tools/call keeps a quiet Connector response open and parses keep-alive JSON', async () => {
  const { createServer } = await import('node:http')
  const { connectorHttpFetch } = await import('../src/index.mjs')
  const listedTools = [
    { name: 'code_search', description: 'search code', inputSchema: { type: 'object' } },
  ]
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const reply = (body, delay = 0) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write('\n')
        setTimeout(() => response.end(JSON.stringify(body)), delay)
      }
      if (message.method === 'initialize') {
        reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '0' } } })
        return
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202)
        response.end()
        return
      }
      if (message.method === 'tools/list') {
        reply({ jsonrpc: '2.0', id: message.id, result: { tools: listedTools } })
        return
      }
      reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'complete', answer: '事实', sources: [] }) }], structuredContent: { status: 'complete', answer: '事实', sources: [] } } }, 40)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const rootTools = toolRegistry()
  const ctx = {
    tools: rootTools,
    on() { return () => {} },
    subagents: { registerContinuableSetup() { return () => {} } },
    effect() {},
    logger: { error(message) { throw new Error(message) } },
  }
  try {
    await apply(ctx, {
      serverName: 'chrome',
      url: `http://127.0.0.1:${port}/mcp`,
      fetch: connectorHttpFetch,
      failOnStartupError: true,
    })
    const result = await rootTools.registered.get('mcp__chrome__code_search').execute({ question: '直通宝司机怎么接单' }, { signal: new AbortController().signal })
    assert.equal(result.structuredContent.answer, '事实')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('connectorHttpFetch surfaces a transport cause instead of a bare fetch failed', async () => {
  const { connectorHttpFetch } = await import('../src/index.mjs')
  await assert.rejects(
    () => connectorHttpFetch('http://127.0.0.1:1/mcp', { method: 'POST', body: '{}' }),
    (error) => {
      assert.match(String(error), /ECONNREFUSED|connect/)
      assert.doesNotMatch(String(error), /^Error: fetch failed$/)
      return true
    },
  )
})
