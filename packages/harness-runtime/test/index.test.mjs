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

test('rejects concurrent selected-source children and generic delegation after scope discovery', () => {
  const guard = createSelectedSourceDispatchGuard()
  const exec = (name, turn) => ({
    name,
    agent: { id: 'parent-1', session: { events: [{ type: 'turn/start', data: { turn } }] } },
  })

  assert.equal(guard(exec('mcp__chrome__selected_source_scope', 1)), undefined)
  assert.match(guard(exec('subagent', 1)), /所选远程范围/)
  assert.equal(guard(exec('search_selected_remote_code', 1)), undefined)
  assert.match(guard(exec('search_selected_remote_code', 1)), /尚未结算/)
  assert.match(guard(exec('search_selected_knowledge', 1)), /不能并发或排队/)
  assert.equal(guard(exec('search_selected_remote_code', 2)), undefined)
  assert.match(guard(exec('search_selected_knowledge', 2)), /尚未结算/)
  assert.equal(guard(exec('search_selected_knowledge', 3)), undefined)

  const directSearchGuard = createSelectedSourceDispatchGuard()
  assert.equal(directSearchGuard(exec('search_selected_remote_code', 3)), undefined)
  assert.match(directSearchGuard(exec('subagent', 3)), /所选远程范围/)
})

test('admits a settled focused follow-up in the same parent turn, but rejects an unreasoned repeat', () => {
  const guard = createSelectedSourceDispatchGuard()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'tool/call',
      data: {
        callId: 'selected-source-1',
        name: 'search_selected_remote_code',
        arguments: { description: '初次检索任务列表', prompt: '检索任务列表当前实现' },
      },
    },
  ]
  const exec = (description, prompt) => ({
    name: 'search_selected_remote_code',
    arguments: { description, prompt },
    agent: { id: 'parent-serial', session: { events } },
  })

  const first = exec('初次检索任务列表', '检索任务列表当前实现')
  assert.equal(guard(first), undefined, 'the current tool/call event is not a prior search')
  guard.childStarted(first)
  guard.dispatchSettled(first)

  assert.match(guard(exec('再次查询', '检索任务列表当前实现')), /prompt 与上次相同/)
  assert.match(guard(exec('补查任务列表', '根据初次结果补查任务列表分页接口')), /证据缺口/)
  assert.equal(
    guard(exec('初次结果缺少分页接口', '根据初次结果补查任务列表分页接口')),
    undefined,
  )
})

test('bounds settled focused follow-ups per parent turn and accepts English evidence gaps', () => {
  const guard = createSelectedSourceDispatchGuard()
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  for (let index = 1; index <= 3; index += 1) {
    const search = {
      name: 'search_selected_remote_code',
      arguments: { description: `missing evidence ${index}`, prompt: `focused search ${index}` },
      agent: { id: 'parent-bound', session: { events } },
    }
    assert.equal(guard(search), undefined)
    guard.childStarted(search)
    guard.dispatchSettled(search)
  }
  const exec = {
    name: 'search_selected_remote_code',
    arguments: { description: 'missing evidence 4', prompt: 'focused search 4' },
    agent: { id: 'parent-bound', session: { events } },
  }

  assert.match(guard(exec), /已完成 3 次/)
})

test('does not mistake an earlier result event for settlement of the latest follow-up', () => {
  const guard = createSelectedSourceDispatchGuard()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId: 'first', name: 'search_selected_remote_code', arguments: { prompt: 'first' } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'first result', isError: false }], source: { kind: 'tool', callId: 'first' } } } },
  ]
  const first = {
    name: 'search_selected_remote_code',
    arguments: { description: 'initial', prompt: 'first' },
    agent: { id: 'parent-latest-settlement', session: { events } },
  }
  assert.equal(guard(first), undefined)
  guard.childStarted(first)
  guard.dispatchSettled(first)
  const second = {
    name: 'search_selected_remote_code',
    arguments: { description: 'missing second dependency', prompt: 'second' },
    agent: { id: 'parent-latest-settlement', session: { events } },
  }
  assert.equal(guard(second), undefined)
  guard.childStarted(second)
  const third = {
    name: 'search_selected_remote_code',
    arguments: { description: 'missing third dependency', prompt: 'third' },
    agent: { id: 'parent-latest-settlement', session: { events } },
  }

  assert.match(guard(third), /尚未结算/)
})

test('requires a /pmd-prd first search to use a requirement-aware prompt while preserving ordinary queries verbatim', () => {
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
  const pmdPrompt = '需求理解：优化客户管理功能。请检索并说明：当前功能入口、相关页面或组件与接口；现有流程和可证实的问题；直接关联的影响范围及稳定代码位置。仅返回资料能够证实的现状。'

  assert.match(guard(exec('search_selected_remote_code', '优化下客户管理功能', initialEvents)), /需求理解/)
  assert.equal(
    guard(exec('search_selected_remote_code', pmdPrompt, initialEvents)),
    undefined,
  )

  const knowledgeGuard = createSelectedSourceDispatchGuard()
  assert.match(knowledgeGuard(exec('search_selected_knowledge', '优化下客户管理功能', initialEvents)), /需求理解/)
  assert.equal(
    knowledgeGuard(exec('search_selected_knowledge', pmdPrompt, initialEvents)),
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
  const continuedPmdPrdEvents = [
    userMessage('/pmd-prd  优化直通宝任务列表的UI和交互'),
    userMessage('继续'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  const continuedPmdPrompt = '需求理解：优化直通宝任务列表的 UI 和交互。请检索并说明：任务列表当前入口、页面组件和接口；现有 UI 与交互；关联影响范围和稳定代码位置。仅返回资料能够证实的现状。'
  assert.match(latestUserGuard(exec('search_selected_remote_code', '优化直通宝任务列表的UI和交互', continuedPmdPrdEvents)), /需求理解/)
  assert.equal(
    latestUserGuard(exec('search_selected_remote_code', continuedPmdPrompt, continuedPmdPrdEvents)),
    undefined,
  )

  const scopeConfirmationGuard = createSelectedSourceDispatchGuard()
  const scopeConfirmationEvents = [
    userMessage('/pmd-prd  优化直通宝任务列表的UI和交互'),
    userMessage('已选了'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.match(
    scopeConfirmationGuard(exec('search_selected_remote_code', '已选了', scopeConfirmationEvents)),
    /需求理解/,
  )
  assert.equal(
    scopeConfirmationGuard(exec('search_selected_remote_code', continuedPmdPrompt, scopeConfirmationEvents)),
    undefined,
  )

  const directFollowupEvents = [
    userMessage('怎么出库啊'),
    userMessage('重点说明出库失败的处理'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  const directFollowupGuard = createSelectedSourceDispatchGuard()
  assert.match(
    directFollowupGuard(exec('search_selected_remote_code', '怎么出库啊', directFollowupEvents)),
    /请把 prompt 原样改为："重点说明出库失败的处理"/,
  )
  assert.equal(
    directFollowupGuard(exec('search_selected_remote_code', '重点说明出库失败的处理', directFollowupEvents)),
    undefined,
  )

  const pmdPrdDirectFollowupEvents = [
    userMessage('/pmd-prd  优化下客户管理功能'),
    userMessage('重点优化客户查询速度'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  const pmdPrdDirectFollowupGuard = createSelectedSourceDispatchGuard()
  assert.match(
    pmdPrdDirectFollowupGuard(exec('search_selected_remote_code', '优化下客户管理功能', pmdPrdDirectFollowupEvents)),
    /请把 prompt 原样改为："重点优化客户查询速度"/,
  )
  assert.equal(
    pmdPrdDirectFollowupGuard(exec('search_selected_remote_code', '重点优化客户查询速度', pmdPrdDirectFollowupEvents)),
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
  assert.equal(
    failedFollowupGuard(exec('search_selected_remote_code', pmdPrompt, failedEvents)),
    undefined,
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

  const annotationFollowupGuard = createSelectedSourceDispatchGuard()
  const annotationPrompt = '以下是用户针对先前 assistant 回复的批注，请结合处理:\n<message_annotations>\n{\n  "annotations": [{\n    "selected_text": "暂时不便提供稿子",\n    "comment": "1"\n  }]\n}\n</message_annotations>'
  const annotationEvents = [
    userMessage('/pmd-prd 优化直通宝任务列表的UI和交互'),
    {
      type: 'tool/call',
      data: { callId: 'selected-source-annotation', name: 'search_selected_remote_code', arguments: '{}' },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'text', text: '已找到任务列表实现。', isError: false }],
          source: { kind: 'tool', callId: 'selected-source-annotation' },
        },
      },
    },
    userMessage(annotationPrompt),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.equal(
    annotationFollowupGuard(exec('search_selected_remote_code', '根据批注补查任务列表实现', annotationEvents)),
    undefined,
  )

  const failedAnnotationGuard = createSelectedSourceDispatchGuard()
  const failedAnnotationEvents = [
    userMessage('/pmd-prd 优化直通宝任务列表的UI和交互'),
    {
      type: 'tool/call',
      data: { callId: 'selected-source-annotation-failed', name: 'search_selected_remote_code', arguments: '{}' },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'text', text: '仓库检索失败', isError: true }],
          source: { kind: 'tool', callId: 'selected-source-annotation-failed' },
        },
      },
    },
    userMessage('继续'),
    { type: 'turn/start', data: { turn: 2 } },
  ]
  assert.equal(
    failedAnnotationGuard(exec('search_selected_remote_code', continuedPmdPrompt, failedAnnotationEvents)),
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
  assert.match(guard(exec('search_selected_knowledge')), /prompt 与上次相同或为空/)
  stop()
})

test('does not reuse an earlier child start when a focused follow-up fails before dispatch', async () => {
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
  const agent = { id: 'parent-focused-retry', ctx: agentCtx, session: { events: [{ type: 'turn/start', data: { turn: 1 } }] } }
  const exec = (description, prompt) => ({
    name: 'search_selected_remote_code',
    arguments: { description, prompt },
    agent,
  })
  const [dispatch] = [async (call, body) => {
    const [listener] = listeners.get('tools/execute') ?? []
    return listener(call, body)
  }]
  const stop = installSelectedSourceDispatchTracking(rootCtx, guard)

  const first = exec('初次检索', '检索任务列表')
  assert.equal(guard(first), undefined)
  await dispatch(first, async () => {
    agentCtx.emit('subagent/start', { runId: 'child-1' })
    return { isError: false }
  })

  const followup = exec('初次结果缺少分页接口', '补查分页接口')
  assert.equal(guard(followup), undefined)
  await dispatch(followup, async () => ({ isError: true }))
  assert.equal(guard(followup), undefined, 'a pre-start failure can retry the same focused prompt')
  stop()
})

test('steers an unstarted /pmd-prd search back to a structured prompt, not raw business text', async () => {
  const guard = createSelectedSourceDispatchGuard()
  let stopping
  const ctx = {
    on(name, listener) {
      if (name === 'agent/turn-stopping') stopping = listener
      return () => { stopping = undefined }
    },
  }
  const steered = []
  const agent = {
    id: 'parent-pmd-progress-gate',
    session: {
      events: [
        {
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: '/pmd-prd 优化直通宝任务列表的UI和交互' }],
            source: { kind: 'user' },
            role: 'user',
          },
        },
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '代码正在后台查询。' }] } },
        },
      ],
    },
    steer(message) { steered.push(message) },
  }

  const stop = installSelectedSourceProgressCompletionGate(ctx, guard)
  await stopping({ agent, turn: 1, signal: new AbortController().signal })

  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /先理解用户需求/)
  assert.match(steered[0].content[0].text, /结构化 prompt/)
  assert.doesNotMatch(steered[0].content[0].text, /原始业务文本/)
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
  assert.match(steered[0].content[0].text, /普通非 \/pmd-prd 检索/)

  await stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 2, 'the turn must remain open until a real child starts')

  const search = { name: 'search_selected_remote_code', agent }
  assert.equal(guard(search), undefined)
  events.push({ type: 'tool/call', data: { name: 'search_selected_remote_code' } })
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
