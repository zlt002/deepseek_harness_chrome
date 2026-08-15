import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function adapter() {
  const background = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
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

test('initial catalog includes repositories and code-only scopes stay valid', async () => {
  const { loadKnowledgeCatalog, validScope } = await adapter()
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/api/domains')
      ? { data: [{ id: 'domain', name: '领域' }] }
      : { data: [{ id: 'repo', name: '代码库' }] }), { status: 200 })
  }
  try {
    assert.equal(validScope({ domainId: '', systemIds: [], repositoryIds: ['repo'] }), true)
    assert.deepEqual(await loadKnowledgeCatalog(), {
      domains: [{ id: 'domain', name: '领域' }], systems: [], repositories: [{ id: 'repo', name: '代码库' }],
    })
    assert.ok(calls.some((url) => url.endsWith('/api/repos')))
  } finally { globalThis.fetch = previousFetch }
})

test('knowledge search rejects a code-only scope before requesting the platform', async () => {
  const { executeKnowledgeQuery } = await adapter()
  await assert.rejects(
    executeKnowledgeQuery('knowledge', 'question', { domainId: '', systemIds: [], repositoryIds: ['repo'] }, undefined, new AbortController().signal),
    { message: 'knowledge_scope_requires_domain' },
  )
})
