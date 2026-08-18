import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function adapter() {
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const end = background.indexOf('\nconst NATIVE_HOST_NAME')
  assert.notEqual(end, -1, 'knowledge adapter source block must remain before background bootstrap')
  const source = `${background.slice(0, end)}\nexport { executeKnowledgeQuery, loadKnowledgeCatalog, scopeFingerprint, validScope, mergeStreamText, isAnswerDelta, retrievalQuestion, selectedSourceScopeEcho, sseEvents as consumeSseChunk, errorChain, isRetryableKnowledgeTransport, knowledgeFetch }\nexport function setKnowledgeProxyConfig(config) { knowledgeProxyConfig = config }\nexport function resetKnowledgeCatalogCache() { knowledgeCatalogCache = undefined }\n`
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
    const value = await executeKnowledgeQuery('knowledge', 'question', { domainId: 'domain', systemIds: ['system'], repositoryIds: [] }, undefined, new AbortController().signal)
    assert.equal(value.result.answer, 'hello')
    assert.deepEqual(value.result.sources, [{ id: 'p1', title: 'Page' }])
    assert.equal(value.sessionId, 'upstream')
  } finally { globalThis.fetch = previousFetch }
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
    const value = await executeKnowledgeQuery('code', '问题', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal, item => { if (item.content !== '') progress.push(item.content) })
    assert.deepEqual(progress, ['最终事实'])
    assert.equal(value.result.answer, '最终事实')
  } finally { globalThis.fetch = previousFetch }
})

test('remote retrieval prompt requests facts without agent execution narration', async () => {
  const { retrievalQuestion } = await adapter()
  const code = retrievalQuestion('code', '有哪些模块')
  assert.match(code, /所选远程代码仓库/)
  assert.match(code, /所有面向用户的流式内容和最终答案都必须使用简体中文/)
  assert.match(code, /即使转述后的问题包含英文，也不要用英文叙述/)
  assert.match(code, /不要输出思考过程、检索计划、工具选择、工作目录判断/)
  assert.match(code, /用户问题：有哪些模块/)
  const english = retrievalQuestion('code', 'Which modules exist?')
  assert.match(english, /Use the same language as the user question/)
  assert.doesNotMatch(english, /必须使用简体中文/)
})

test('scope fingerprints isolate an upstream continuation when the user changes scope', async () => {
  const { scopeFingerprint } = await adapter()
  assert.notEqual(scopeFingerprint({ domainId: 'one', systemIds: ['s'], repositoryIds: ['r'] }), scopeFingerprint({ domainId: 'two', systemIds: ['s'], repositoryIds: ['r'] }))
})

test('initial catalog preserves repository grouping and type metadata for the composer tree', async () => {
  const { loadKnowledgeCatalog, validScope } = await adapter()
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/api/auth/me')
      ? { data: { id: 'current-user' } }
      : String(url).endsWith('/api/domains')
      ? { data: [{ id: 'domain', name: '领域' }] }
      : { data: [{ id: 'repo', name: '代码库', domain: 'domain', system_key: 'system', repo_type: 'frontend' }] }), { status: 200 })
  }
  try {
    assert.equal(validScope({ domainId: '', systemIds: [], repositoryIds: ['repo'] }), true)
    assert.deepEqual(await loadKnowledgeCatalog(), {
      domains: [{ id: 'domain', name: '领域' }], systems: [], repositories: [{ id: 'repo', name: '代码库', domainId: 'domain', systemId: 'system', type: 'frontend' }],
    })
    assert.ok(calls.some((url) => url.endsWith('/api/auth/me')))
    assert.ok(calls.some((url) => url.endsWith('/api/repos')))
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
    if (value.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { id: 'current-user' } }), { status: 200 })
    if (value.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }), { status: 200 })
    if (value.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '代码库' }] }), { status: 200 })
    if (value.endsWith('/api/domains')) return new Promise(() => {})
    throw new Error(`unexpected request: ${value}`)
  }
  try {
    const catalog = await Promise.race([
      loadKnowledgeCatalog(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('catalog_still_checking')), 100)),
    ])
    assert.deepEqual(catalog.domains, [{ id: 'domain', name: '领域' }])
    assert.equal(calls.some((url) => url.endsWith('/api/domains')), false)
  } finally { globalThis.fetch = previousFetch }
})

test('selected-source echo reports composer names without treating placeholders as selected', async () => {
  const { selectedSourceScopeEcho } = await adapter()
  assert.deepEqual(selectedSourceScopeEcho(
    { scope: { domainId: '', systemIds: [], repositoryIds: ['r1'] }, enabled: true },
    { domains: [], systems: [], repositories: [{ id: 'r1', name: 'lcrm-frontend' }] },
  ), { enabled: true, codeSelected: true, knowledgeSelected: false, repositories: ['lcrm-frontend'], knowledge: [] })
  assert.deepEqual(selectedSourceScopeEcho(
    { scope: { domainId: '', systemIds: [], repositoryIds: [] }, enabled: true },
    { domains: [], systems: [], repositories: [{ id: 'r1', name: 'lcrm-frontend' }] },
  ), { enabled: true, codeSelected: false, knowledgeSelected: false, repositories: [], knowledge: [] })
})

test('knowledge search rejects a code-only scope before requesting the platform', async () => {
  const { executeKnowledgeQuery } = await adapter()
  await assert.rejects(
    executeKnowledgeQuery('knowledge', 'question', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal),
    { message: 'knowledge_scope_requires_domain' },
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
    const value = await executeKnowledgeQuery('knowledge', 'question', { domainId: 'domain', systemIds: ['system'], repositoryIds: [] }, undefined, new AbortController().signal)
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
    const value = await executeKnowledgeQuery('code', '问题', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal)
    assert.equal(value.result.status, 'complete')
    assert.equal(value.result.answer, '完整答案')
  } finally { globalThis.fetch = previousFetch }
})

test('empty incomplete SSE still fails closed', async () => {
  const { executeKnowledgeQuery } = await adapter()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.close() } }), { status: 200 })
  try {
    await assert.rejects(
      executeKnowledgeQuery('code', '问题', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal),
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
    if (value.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { id: 'current-user' } }), { status: 200 })
    if (value.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }), { status: 200 })
    if (value.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '代码库' }] }), { status: 200 })
    throw new Error(`unexpected request: ${value}`)
  }
  try {
    const first = await loadKnowledgeCatalog()
    const second = await loadKnowledgeCatalog()
    assert.deepEqual(first.domains, [{ id: 'domain', name: '领域' }])
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
