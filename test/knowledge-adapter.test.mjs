import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function adapter() {
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const end = background.indexOf('\nconst NATIVE_HOST_NAME')
  assert.notEqual(end, -1, 'knowledge adapter source block must remain before background bootstrap')
  const source = `${background.slice(0, end)}\nexport { executeKnowledgeQuery, loadKnowledgeCatalog, scopeFingerprint, validScope, sseEvents as consumeSseChunk }\n`
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

test('SSE parser buffers split lines and completion requires both done and [DONE]', async () => {
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

test('knowledge search rejects a code-only scope before requesting the platform', async () => {
  const { executeKnowledgeQuery } = await adapter()
  await assert.rejects(
    executeKnowledgeQuery('knowledge', 'question', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal),
    { message: 'knowledge_scope_requires_domain' },
  )
})
