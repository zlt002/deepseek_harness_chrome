import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function adapter() {
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const end = background.indexOf('\nconst NATIVE_HOST_NAME')
  assert.notEqual(end, -1, 'knowledge adapter source block must remain before background bootstrap')
  const source = `${background.slice(0, end)}\nexport { executeKnowledgeQuery, loadKnowledgeCatalog, scopeFingerprint, validScope, normalizeScope, mergeStreamText, isAnswerDelta, isProcessEvent, processEventText, appendProcess, retrievalQuestion, selectedSourceScopeEcho, sseEvents as consumeSseChunk, errorChain, isRetryableKnowledgeTransport, knowledgeFetch, describeKnowledgeTransportError, isKnowledgeStream, knowledgeConversationOwner, planKnowledgeContinuation, controlledVocabulary, knowledgeIdentity, filterCatalogByIdentity, pruneScope }\nexport function setKnowledgeProxyConfig(config) { knowledgeProxyConfig = config }\nexport function resetKnowledgeCatalogCache() { knowledgeCatalogCache = undefined }\n`
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

test('SSE parser buffers split lines and a finished stream with done or [DONE] is complete', async () => {
  const { consumeSseChunk, executeKnowledgeQuery } = await adapter()
  const first = consumeSseChunk('', 'data: {"delta":"hel')
  assert.deepEqual(first.events, [])
  const second = consumeSseChunk(first.remainder, 'lo"}\n\ndata: {"type":"done","citations":[{"page_id":"p1","page_title":"Page"}],"session_id":"upstream"}\n\ndata: [DONE]\n\n')
  assert.equal(second.events.length, 3)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"delta":"hello"}\n\ndata: {"type":"done","citations":[{"page_id":"p1","page_title":"Page"}],"session_id":"upstream"}\n\ndata: [DONE]\n\n')); controller.close() } }), { status: 200 })
  try {
    const value = await executeKnowledgeQuery('knowledge', 'question', { domainSystems: { domain: ['system'] }, repositoryIds: [] }, undefined, new AbortController().signal)
    assert.equal(value.result.answer, 'hello')
    assert.deepEqual(value.result.sources, [{ id: 'p1', title: 'Page' }])
    assert.equal(value.sessionId, 'upstream')
  } finally { globalThis.fetch = previousFetch }
})

test('knowledge retrieval keeps same-named systems paired with their own categories', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"delta":"ok"}\n\ndata: [DONE]\n\n')); controller.close() } }), { status: 200 })
  }
  try {
    await executeKnowledgeQuery('knowledge', 'question', { domainSystems: { order: ['common', 'oms'], warehouse: ['common', 'wms'] }, repositoryIds: [] }, undefined, new AbortController().signal)
    assert.deepEqual(bodies[0].domain_system_config, {
      order: { self: false, systems: ['common', 'oms'] },
      warehouse: { self: false, systems: ['common', 'wms'] },
    })
  } finally { globalThis.fetch = previousFetch }
})

test('normalizes saved V1 single-category scopes into paired selections', async () => {
  const { validScope, normalizeScope } = await adapter()
  const savedV1 = { domainId: 'order', systemIds: ['common', 'oms'], repositoryIds: ['repo'] }
  assert.equal(validScope(savedV1), true)
  assert.deepEqual(normalizeScope(savedV1), { domainSystems: { order: ['common', 'oms'] }, repositoryIds: ['repo'] })
})

test('SSE answer assembly deduplicates cumulative snapshots and excludes reasoning events', async () => {
  const { mergeStreamText, isAnswerDelta } = await adapter()
  assert.equal(mergeStreamText('', '第一段'), '第一段')
  assert.equal(mergeStreamText('第一段', '第一段第二段'), '第一段第二段')
  assert.equal(mergeStreamText('第一段第二段', '第二段第三段'), '第一段第二段第三段')
  assert.equal(mergeStreamText('相同内容', '相同内容'), '相同内容')
  assert.equal(isAnswerDelta({ type: 'reasoning', delta: 'internal' }), false)
  assert.equal(isAnswerDelta({ type: 'thinking', delta: 'internal' }), false)
  assert.equal(isAnswerDelta({ type: 'answer', delta: 'visible' }), true)
  assert.equal(isAnswerDelta({ delta: 'legacy visible' }), true)
})

test('visual progress reports connected before the first answer delta', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"reasoning","delta":"plan"}\n\ndata: {"delta":"事实"}\n\ndata: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200 })
  const progress = []
  try {
    await executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal, item => progress.push(item))
    assert.deepEqual(progress[0], { chars: 0, content: '', eventType: 'connected' })
    assert.equal(progress.some(item => item.eventType === 'reasoning' && item.process === '远程检索正在分析问题…'), true)
    assert.equal(progress.at(-1)?.content, '事实')
  } finally { globalThis.fetch = previousFetch }
})

test('visual progress excludes upstream reasoning and streams only answer deltas', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const events = [
    { type: 'reasoning', delta: 'The user wants me to call search_code_repos.' },
    { type: 'answer', delta: '最终事实' },
    { type: 'done', citations: [], session_id: 'upstream' },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close() } }), { status: 200 })
  const progress = []
  try {
    const value = await executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal, item => progress.push(item))
    assert.equal(progress.find(item => item.eventType === 'reasoning')?.process, '远程检索正在分析问题…')
    assert.deepEqual(progress.filter(item => item.content !== '').map(item => item.content), ['最终事实'])
    assert.equal(value.result.answer, '最终事实')
  } finally { globalThis.fetch = previousFetch }
})

test('visual progress streams AccrUI-style repository log events as process lines', async () => {
  const { executeKnowledgeQuery, isProcessEvent, processEventText, appendProcess } = await adapter()
  assert.equal(isProcessEvent({ type: 'log' }), true)
  assert.equal(isProcessEvent({ type: 'step' }), true)
  assert.equal(processEventText({ type: 'reasoning', delta: 'The user wants me to call search_code_repos.' }), '远程检索正在分析问题…')
  assert.equal(processEventText({ type: 'log', source: 'H5_前端（前端）', message: '🔧 调用: mcp__repo-search__search_code_repos(question: "直通宝司机怎么接单")' }), 'H5_前端（前端） · 🔧 调用: mcp__repo-search__search_code_repos(question: "直通宝司机怎么接单")')
  assert.equal(appendProcess('远程检索正在分析问题…', 'H5_前端（前端） · 开始检索: H5_前端'), '远程检索正在分析问题…\nH5_前端（前端） · 开始检索: H5_前端')
  const events = [
    { type: 'reasoning', delta: 'The user is asking me to search code repositories.' },
    { type: 'log', source: 'H5_前端（前端）', message: '🔧 调用: mcp__repo-search__search_code_repos(question: "直通宝司机怎么接单")' },
    { type: 'log', source: 'H5_前端（前端）', message: '✅ mcp__repo-search__search_code_repos 完成（3254 字符）' },
    { type: 'log', source: 'H5_前端（前端）', message: '正在检索 1 个仓库: H5_前端' },
    { type: 'log', source: 'H5_前端（前端）', message: '仓库精搜 开始' },
    { type: 'log', source: 'H5_前端（前端）', message: '开始深度探索: H5_前端' },
    { type: 'text_delta', source: 'H5_前端（前端）', delta: '子代理正文不应进入答案。' },
    { type: 'log', source: 'H5_前端（前端）', message: '仓库检索完成: H5_前端（成功）' },
    { type: 'answer', delta: '司机接单入口在 TakeOrder.vue' },
    { type: 'done', citations: [], session_id: 'upstream' },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close() } }), { status: 200 })
  const progress = []
  try {
    const value = await executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal, item => progress.push(item))
    const processSnapshots = progress.filter(item => item.process).map(item => item.process)
    assert.equal(processSnapshots[0], '远程检索正在分析问题…')
    assert.match(processSnapshots.at(-1) ?? '', /H5_前端（前端） · 🔧 调用: mcp__repo-search__search_code_repos/)
    assert.match(processSnapshots.at(-1) ?? '', /仓库精搜 开始/)
    assert.match(processSnapshots.at(-1) ?? '', /仓库检索完成: H5_前端（成功）/)
    assert.equal(processSnapshots.at(-1)?.includes('子代理正文不应进入答案'), false)
    assert.equal(value.result.answer, '司机接单入口在 TakeOrder.vue')
    assert.equal(value.result.answer.includes('子代理正文'), false)
  } finally { globalThis.fetch = previousFetch }
})

test('remote retrieval prompt requests facts without agent execution narration', async () => {
  const { retrievalQuestion } = await adapter()
  const code = retrievalQuestion('code', '有哪些模块')
  assert.match(code, /所选远程代码仓库/)
  assert.match(code, /所有面向用户的流式内容和最终答案都必须使用简体中文/)
  assert.match(code, /即使转述后的问题包含英文，也不要用英文叙述/)
  assert.match(code, /最终答案只保留事实和引用/)
  assert.match(code, /一次只返回一个文件或一个函数的核心片段/)
  assert.match(code, /检索计划、当前正在查的仓库或知识、工具选择和进度可通过独立过程事件流式返回/)
  assert.match(code, /用户问题：有哪些模块/)
  const english = retrievalQuestion('code', 'Which modules exist?')
  assert.match(english, /Use the same language as the user question/)
  assert.doesNotMatch(english, /必须使用简体中文/)
})

test('scope fingerprints isolate an upstream continuation when the user changes scope', async () => {
  const { scopeFingerprint } = await adapter()
  assert.notEqual(scopeFingerprint({ domainSystems: { one: ['s'] }, repositoryIds: ['r'] }), scopeFingerprint({ domainSystems: { two: ['s'] }, repositoryIds: ['r'] }))
})

test('the same parent conversation reuses one remote session across new local search children', async () => {
  const { knowledgeConversationOwner, planKnowledgeContinuation, scopeFingerprint } = await adapter()
  const fingerprint = scopeFingerprint({ domainSystems: {}, repositoryIds: ['H5_前端'] })
  const firstOwner = knowledgeConversationOwner('child-1', 'parent-1')
  const secondOwner = knowledgeConversationOwner('child-2', 'parent-1')
  assert.equal(firstOwner, 'parent-1')
  assert.equal(secondOwner, 'parent-1')
  const first = planKnowledgeContinuation({}, firstOwner, 'code', fingerprint)
  assert.equal(first.priorSessionId, undefined)
  const second = planKnowledgeContinuation({ [first.key]: { sessionId: 'remote-session-first', fingerprint } }, secondOwner, 'code', fingerprint)
  assert.equal(second.key, first.key)
  assert.equal(second.priorSessionId, 'remote-session-first')
  const knowledge = planKnowledgeContinuation({ [first.key]: { sessionId: 'remote-session-first', fingerprint } }, secondOwner, 'knowledge', fingerprint)
  assert.notEqual(knowledge.key, first.key)
  assert.equal(knowledge.priorSessionId, undefined)
  const otherScope = planKnowledgeContinuation({ [first.key]: { sessionId: 'remote-session-first', fingerprint } }, secondOwner, 'code', scopeFingerprint({ domainSystems: {}, repositoryIds: ['其他仓库'] }))
  assert.notEqual(otherScope.key, first.key)
  assert.equal(otherScope.priorSessionId, undefined)
})

test('a resumed remote query sends the prior session_id and asks the agent not to rescan', async () => {
  const { executeKnowledgeQuery, retrievalQuestion } = await adapter()
  assert.match(retrievalQuestion('code', '第一种方式详细看看', true), /同一远程检索会话的追问/)
  assert.doesNotMatch(retrievalQuestion('code', '直通宝有哪些入口'), /同一远程检索会话的追问/)
  const previousFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"继续回答"}\n\ndata: {"type":"done","citations":[{"page_id":"p1","page_title":"入口"}],"session_id":"remote-session-second"}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 })
  }
  try {
    const value = await executeKnowledgeQuery('code', '第一种方式详细看看', { domainSystems: {}, repositoryIds: ['H5_前端'] }, 'remote-session-first', new AbortController().signal)
    assert.equal(value.sessionId, 'remote-session-second')
    assert.equal(bodies[0].session_id, 'remote-session-first')
    assert.deepEqual(bodies[0].repo_keys, ['H5_前端'])
    assert.match(bodies[0].question, /同一远程检索会话的追问/)
  } finally { globalThis.fetch = previousFetch }
})

test('initial catalog preserves repository grouping and type metadata for the composer tree', async () => {
  const { loadKnowledgeCatalog, validScope } = await adapter()
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const value = String(url)
    calls.push(value)
    if (value.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { userCode: 'current-user', roleLevel: 'super_admin', domainIds: [] } }), { status: 200 })
    if (value.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: { domains: [{ id: 'domain', name: '领域' }], systems: [{ id: 'system', name: '系统', domain: 'domain' }] } }), { status: 200 })
    if (value.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '代码库', domain: 'domain', system_key: 'system', repo_type: 'frontend' }] }), { status: 200 })
    throw new Error(`unexpected request: ${value}`)
  }
  try {
    assert.equal(validScope({ domainSystems: {}, repositoryIds: ['repo'] }), true)
    assert.deepEqual(await loadKnowledgeCatalog(), {
      domains: [{ id: 'domain', name: '领域' }],
      systems: [{ id: 'system', name: '系统', domainId: 'domain' }],
      repositories: [{ id: 'repo', name: '代码库', domainId: 'domain', systemId: 'system', type: 'frontend' }],
    })
    assert.ok(calls.some((url) => url.endsWith('/api/auth/me')))
    assert.ok(calls.some((url) => url.endsWith('/api/repos')))
    assert.equal(calls.some((url) => url.includes('/api/domains')), false)
  } finally { globalThis.fetch = previousFetch }
})

test('catalog classifies an expired login before loading scope data', async () => {
  const { loadKnowledgeCatalog } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '请先登录' }), { status: 401, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(loadKnowledgeCatalog(), { message: 'knowledge_login_required' })
  } finally { globalThis.fetch = previousFetch }
})

test('catalog does not wait for the legacy domains endpoint when controlled vocabulary succeeds', async () => {
  const { loadKnowledgeCatalog } = await adapter()
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const value = String(url)
    calls.push(value)
    if (value.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { userCode: 'current-user', roleLevel: 'member', domainIds: ['domain'] } }), { status: 200 })
    if (value.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }), { status: 200 })
    if (value.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '代码库', domain: 'domain', system_key: 'system' }] }), { status: 200 })
    if (value.endsWith('/api/domains')) return new Promise(() => {})
    throw new Error(`unexpected request: ${value}`)
  }
  try {
    const catalog = await Promise.race([
      loadKnowledgeCatalog(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('catalog_still_checking')), 100)),
    ])
    assert.deepEqual(catalog.domains, [{ id: 'domain', name: '领域' }])
    assert.deepEqual(catalog.systems, [{ id: 'system', name: '系统', domainId: 'domain' }])
    assert.equal(calls.some((url) => url.endsWith('/api/domains')), false)
  } finally { globalThis.fetch = previousFetch }
})

test('controlled vocabulary keeps empty domains and attaches top-level systems', async () => {
  const { controlledVocabulary } = await adapter()
  assert.deepEqual(controlledVocabulary({
    data: {
      domains: [
        { id: 'AI', name: 'AI 领域' },
        { id: 'OPS', name: '运营', children: [{ id: 'tms', name: 'TMS' }] },
      ],
      systems: [
        { id: 'ai-test', name: 'AI 测试', domain: 'AI' },
        { id: 'ai-test', name: '重复 AI 测试', domain: 'AI' },
        { id: 'wms', name: 'WMS', domain: 'OPS' },
        { id: 'unknown', name: '未知领域系统', domain: 'UNKNOWN' },
      ],
    },
  }), {
    domains: [
      { id: 'AI', name: 'AI 领域' },
      { id: 'OPS', name: '运营' },
    ],
    systems: [
      { id: 'tms', name: 'TMS', domainId: 'OPS' },
      { id: 'ai-test', name: 'AI 测试', domainId: 'AI' },
      { id: 'wms', name: 'WMS', domainId: 'OPS' },
    ],
  })
})

test('ordinary members only see authorized domains, systems, and repositories', async () => {
  const { knowledgeIdentity, filterCatalogByIdentity, pruneScope } = await adapter()
  const catalog = {
    domains: [{ id: 'AI', name: 'AI 领域' }, { id: 'OPS', name: '运营' }],
    systems: [{ id: 'ai-test', name: 'AI 测试', domainId: 'AI' }, { id: 'tms', name: 'TMS', domainId: 'OPS' }],
    repositories: [{ id: 'ai-repo', name: 'AI 仓库', domainId: 'AI' }, { id: 'ops-repo', name: '运营仓库', domainId: 'OPS' }],
  }
  const member = knowledgeIdentity({ data: { userCode: 'u-1', roleLevel: 'member', domainIds: ['OPS'] } })
  const superAdmin = knowledgeIdentity({ data: { userCode: 'admin', roleLevel: 'super_admin', domainIds: [] } })
  assert.deepEqual(filterCatalogByIdentity(catalog, member), {
    domains: [{ id: 'OPS', name: '运营' }],
    systems: [{ id: 'tms', name: 'TMS', domainId: 'OPS' }],
    repositories: [{ id: 'ops-repo', name: '运营仓库', domainId: 'OPS' }],
  })
  assert.deepEqual(filterCatalogByIdentity(catalog, superAdmin), catalog)
  assert.deepEqual(pruneScope({ domainSystems: { AI: ['ai-test'] }, repositoryIds: ['ai-repo', 'ops-repo'] }, filterCatalogByIdentity(catalog, member)), {
    domainSystems: {},
    repositoryIds: ['ops-repo'],
  })
})

test('selected-source echo reports composer names without treating placeholders as selected', async () => {
  const { selectedSourceScopeEcho } = await adapter()
  assert.deepEqual(selectedSourceScopeEcho(
    { scope: { domainSystems: {}, repositoryIds: ['r1'] }, enabled: true },
    { domains: [], systems: [], repositories: [{ id: 'r1', name: 'lcrm-frontend' }] },
  ), { enabled: true, codeSelected: true, knowledgeSelected: false, repositories: ['lcrm-frontend'], knowledge: [] })
  assert.deepEqual(selectedSourceScopeEcho(
    { scope: { domainSystems: {}, repositoryIds: [] }, enabled: true },
    { domains: [], systems: [], repositories: [{ id: 'r1', name: 'lcrm-frontend' }] },
  ), { enabled: true, codeSelected: false, knowledgeSelected: false, repositories: [], knowledge: [] })
})

test('knowledge search rejects a code-only scope before requesting the platform', async () => {
  const { executeKnowledgeQuery } = await adapter()
  await assert.rejects(
    executeKnowledgeQuery('knowledge', 'question', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal),
    { message: /没有选择知识范围/ },
  )
})

test('errorChain keeps undici cause codes instead of [object Object]', async () => {
  const { errorChain, isRetryableKnowledgeTransport } = await adapter()
  const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNRESET 10.0.0.1:443'), { code: 'ECONNRESET' }) })
  assert.match(errorChain(wrapped), /fetch failed/)
  assert.match(errorChain(wrapped), /ECONNRESET/)
  assert.equal(isRetryableKnowledgeTransport(wrapped), true)
  assert.equal(errorChain({ message: 'upstream', code: 'ETIMEDOUT' }), 'upstream: ETIMEDOUT')
})

test('an interrupted SSE stream with answer text is a partial Sourced Answer', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":"已检索到订单接口"}\n\n'))
      controller.close()
    },
  }), { status: 200 })
  try {
    const value = await executeKnowledgeQuery('knowledge', 'question', { domainSystems: { domain: ['system'] }, repositoryIds: [] }, undefined, new AbortController().signal)
    assert.equal(value.result.status, 'partial')
    assert.equal(value.result.answer, '已检索到订单接口')
  } finally { globalThis.fetch = previousFetch }
})

test('a finished stream that only emits [DONE] after answer text is complete', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":"完整答案"}\n\ndata: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200 })
  try {
    const value = await executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal)
    assert.equal(value.result.status, 'complete')
    assert.equal(value.result.answer, '完整答案')
  } finally { globalThis.fetch = previousFetch }
})

test('an upstream error after answer text is a partial Sourced Answer', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":"半段事实"}\n\ndata: {"type":"error","error":"upstream reset"}\n\n'))
      controller.close()
    },
  }), { status: 200 })
  try {
    const value = await executeKnowledgeQuery('knowledge', 'question', { domainSystems: { domain: ['system'] }, repositoryIds: [] }, undefined, new AbortController().signal)
    assert.equal(value.result.status, 'partial')
    assert.equal(value.result.answer, '半段事实')
  } finally { globalThis.fetch = previousFetch }
})

test('empty incomplete SSE still fails closed', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.close() } }), { status: 200 })
  try {
    await assert.rejects(
      executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal),
      { message: 'knowledge_platform_incomplete_sse' },
    )
  } finally { globalThis.fetch = previousFetch }
})

test('catalog cache reuses a fresh vocabulary without a second network round trip', async () => {
  const { loadKnowledgeCatalog, resetKnowledgeCatalogCache } = await adapter()
  resetKnowledgeCatalogCache()
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    const value = String(url)
    if (value.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { userCode: 'current-user', roleLevel: 'member', domainIds: ['domain'] } }), { status: 200 })
    if (value.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: { domains: [{ id: 'domain', name: '领域' }], systems: [{ id: 'system', name: '系统', domain: 'domain' }] } }), { status: 200 })
    if (value.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '代码库', domain: 'domain', system_key: 'system' }] }), { status: 200 })
    throw new Error(`unexpected request: ${value}`)
  }
  try {
    const first = await loadKnowledgeCatalog()
    const second = await loadKnowledgeCatalog()
    assert.deepEqual(first.domains, [{ id: 'domain', name: '领域' }])
    assert.deepEqual(first.systems, [{ id: 'system', name: '系统', domainId: 'domain' }])
    assert.equal(second, first)
    assert.equal(calls, 3)
  } finally { globalThis.fetch = previousFetch }
})

test('knowledgeFetch falls back to Chrome when the native proxy reports a transport failure', async () => {
  const { knowledgeFetch, setKnowledgeProxyConfig } = await adapter()
  setKnowledgeProxyConfig({ url: 'http://127.0.0.1:9/knowledge-proxy', token: 't'.repeat(32) })
  const previousFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    const value = String(url)
    seen.push(value)
    if (value.includes('/knowledge-proxy')) return new Response('Knowledge proxy failed: fetch failed: ECONNRESET', { status: 502 })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await knowledgeFetch('https://anapi-uat.annto.com/api-sse-kd/api/repos')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(seen.some((url) => url.includes('/knowledge-proxy')), true)
    assert.equal(seen.some((url) => url.endsWith('/api/repos')), true)
  } finally { globalThis.fetch = previousFetch }
})

test('long RAG streams go through Chrome fetch instead of the native proxy', async () => {
  const { knowledgeFetch, setKnowledgeProxyConfig, isKnowledgeStream } = await adapter()
  assert.equal(isKnowledgeStream('https://anapi-uat.annto.com/api-sse-kd/api/rag/repo-search'), true)
  assert.equal(isKnowledgeStream('https://anapi-uat.annto.com/api-sse-kd/api/repos'), false)
  setKnowledgeProxyConfig({ url: 'http://127.0.0.1:9/knowledge-proxy', token: 't'.repeat(32) })
  const previousFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return new Response('data: {"delta":"ok"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const response = await knowledgeFetch('https://anapi-uat.annto.com/api-sse-kd/api/rag/repo-search', { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    assert.equal(seen.length, 1)
    assert.match(seen[0], /\/api\/rag\/repo-search$/)
    assert.equal(seen.some((url) => url.includes('/knowledge-proxy')), false)
  } finally { globalThis.fetch = previousFetch }
})

test('a mid-stream transport failure keeps process text and names the cause', async () => {
  const { executeKnowledgeQuery, describeKnowledgeTransportError } = await adapter()
  const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' }) })
  assert.match(describeKnowledgeTransportError(wrapped, 'H5_前端（前端） · 仓库精搜 开始'), /空闲超时/)
  assert.match(describeKnowledgeTransportError(wrapped, 'H5_前端（前端） · 仓库精搜 开始'), /UND_ERR_BODY_TIMEOUT/)
  assert.match(describeKnowledgeTransportError(wrapped, 'H5_前端（前端） · 仓库精搜 开始'), /仓库精搜 开始/)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"log","source":"H5_前端（前端）","message":"仓库精搜 开始"}\n\n'))
    },
    pull(controller) {
      controller.error(wrapped)
    },
  }), { status: 200 })
  try {
    await assert.rejects(
      executeKnowledgeQuery('code', '问题', { domainSystems: {}, repositoryIds: ['repo'] }, undefined, new AbortController().signal),
      (error) => {
        assert.match(String(error), /空闲超时|网络传输中断/)
        assert.match(String(error), /仓库精搜 开始/)
        return true
      },
    )
  } finally { globalThis.fetch = previousFetch }
})

test('knowledgeFetch does not treat a platform 401 as a proxy transport failure', async () => {
  const { knowledgeFetch, setKnowledgeProxyConfig } = await adapter()
  setKnowledgeProxyConfig({ url: 'http://127.0.0.1:9/knowledge-proxy', token: 't'.repeat(32) })
  const previousFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return new Response(JSON.stringify({ error: '请先登录' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await knowledgeFetch('https://anapi-uat.annto.com/api-sse-kd/api/repos')
    assert.equal(response.status, 401)
    assert.equal(seen.length, 1)
    assert.match(seen[0], /knowledge-proxy/)
  } finally { globalThis.fetch = previousFetch }
})
