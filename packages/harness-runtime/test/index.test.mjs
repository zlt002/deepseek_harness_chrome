import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createSelectedSourceDispatchGuard, partitionTools, publicToolName, sessionMeta } from '../src/index.mjs'

test('separates only configured raw MCP names into the continuable-child scope', () => {
  const tools = new Map([
    ['mcp__chrome__browser_open_tab', { rawName: 'browser_open_tab', definition: {} }],
    ['mcp__chrome__code_search', { rawName: 'code_search', definition: {} }],
  ])
  const result = partitionTools(tools, { code_search: 'continuable-child', default: 'global' })
  assert.deepEqual([...result.global.keys()], ['mcp__chrome__browser_open_tab'])
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

test('admits only one selected-source child and rejects generic delegation after scope discovery in the same parent turn', () => {
  const guard = createSelectedSourceDispatchGuard()
  const exec = (name, turn) => ({
    name,
    agent: { id: 'parent-1', session: { events: [{ type: 'turn/start', data: { turn } }] } },
  })

  assert.equal(guard(exec('mcp__chrome__selected_source_scope', 1)), undefined)
  assert.match(guard(exec('subagent', 1)), /所选远程范围/)
  assert.equal(guard(exec('search_selected_remote_code', 1)), undefined)
  assert.match(guard(exec('search_selected_remote_code', 1)), /已启动一个检索子代理/)
  assert.equal(guard(exec('search_selected_remote_code', 2)), undefined)

  const directSearchGuard = createSelectedSourceDispatchGuard()
  assert.equal(directSearchGuard(exec('search_selected_remote_code', 3)), undefined)
  assert.match(directSearchGuard(exec('subagent', 3)), /所选远程范围/)
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
    { name: 'browser_open_tab', description: 'open a tab', inputSchema: { type: 'object' } },
    { name: 'code_search', description: 'search code', inputSchema: { type: 'object' } },
    { name: 'knowledge_search', description: 'search knowledge', inputSchema: { type: 'object' } },
  ]
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    requests.push(request)
    return {
      ok: true,
      async json() {
        return { jsonrpc: '2.0', id: request.id, result: request.method === 'tools/list' ? { tools: listedTools } : {} }
      },
    }
  }

  try {
    await apply(ctx, {
      serverName: 'chrome',
      url: 'http://connector.test/mcp',
      toolScopes: { code_search: 'continuable-child', knowledge_search: 'continuable-child' },
    })

    assert.equal(typeof installContinuableChild, 'function')
    assert.deepEqual([...rootTools.registered.keys()], ['mcp__chrome__browser_open_tab'])
    assert.deepEqual([...normalChildTools.registered.keys()], [])

    const removeContinuableChild = installContinuableChild({ tools: continuableChildTools })
    assert.deepEqual([...continuableChildTools.registered.keys()], [
      'mcp__chrome__code_search',
      'mcp__chrome__knowledge_search',
    ])
    assert.deepEqual([...new Map([...rootTools.registered, ...continuableChildTools.registered]).keys()], [
      'mcp__chrome__browser_open_tab',
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
