import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function transportModule() {
  const result = await build({
    entryPoints: ['apps/chrome-extension/entrypoints/background/knowledge-transport.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Date.now()}`)
}

test('Knowledge transport hides proxy fallback, cookie forwarding, and catalog parsing behind its interface', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const calls = []
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async (input, init) => {
      calls.push([String(input), init])
      if (String(input) === 'http://127.0.0.1:43123/knowledge-proxy') {
        const { path } = JSON.parse(init.body)
        if (path.endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { roleLevel: 'super_admin' } }))
        if (path.endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }))
        if (path.endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '仓库', domainId: 'domain' }] }))
      }
      if (String(input).endsWith('/api/auth/me')) return new Response(JSON.stringify({ data: { roleLevel: 'super_admin' } }))
      if (String(input).endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ data: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }))
      if (String(input).endsWith('/api/repos')) return new Response(JSON.stringify({ data: [{ id: 'repo', name: '仓库', domainId: 'domain' }] }))
      throw new Error(`unexpected request: ${String(input)}`)
    },
    cookies: async () => [{ name: 'session', value: 'cookie', path: '/', expirationDate: undefined }],
    delay: async () => {},
  })

  assert.equal(transport.configureProxy('http://127.0.0.1:43123/knowledge-proxy', 'x'.repeat(32)), true)
  const catalog = await transport.loadCatalog()

  assert.deepEqual(catalog, {
    domains: [{ id: 'domain', name: '领域' }],
    systems: [{ id: 'system', name: '系统', domainId: 'domain' }],
    repositories: [{ id: 'repo', name: '仓库', domainId: 'domain' }],
  })
  assert.equal(calls.some(([input, init]) => input === 'http://127.0.0.1:43123/knowledge-proxy' && JSON.parse(init.body).cookie === 'session=cookie'), true)
})

test('Knowledge transport preserves partial SSE answers when the upstream stream ends without a done marker', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"answer","delta":"第一段"}\n\n'))
      controller.close()
    },
  })
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async () => new Response(body),
    cookies: async () => [],
    delay: async () => {},
  })

  const result = await transport.query({
    kind: 'knowledge',
    question: '问题',
    scope: { domainSystems: { domain: ['system'] }, repositoryIds: [] },
    signal: new AbortController().signal,
  })

  assert.deepEqual(result.result, { status: 'partial', answer: '第一段', sources: [] })
})

test('Knowledge retrieval combines a knowledge selection and repository ids through repo_keys', async () => {
  const { createKnowledgeTransport } = await transportModule()
  let request
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"answer","delta":"代码事实"}\n\ndata: {"type":"done","citations":[]}\n\ndata: [DONE]\n\n'))
      controller.close()
    },
  })
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async (input, init) => {
      request = { input: String(input), body: JSON.parse(init.body) }
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
    cookies: async () => [],
  })

  const result = await transport.query({
    kind: 'knowledge', question: '任务列表怎么实现', scope: { domainSystems: { logistics: ['task'] }, repositoryIds: ['H5_frontend'] }, signal: new AbortController().signal,
  })

  assert.equal(request.input, 'https://anapi-uat.annto.com/api-sse-kd/api/rag/retrieval')
  assert.deepEqual(request.body.repo_keys, ['H5_frontend'])
  assert.deepEqual(request.body.domain_system_config, { logistics: { self: false, systems: ['task'] } })
  assert.deepEqual(result.result, { status: 'complete', answer: '代码事实', sources: [] })
})

test('Knowledge retrieval rejects a code-only selection so it uses the remote-code route', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd', fetch: async () => { throw new Error('must not fetch') }, cookies: async () => [],
  })

  await assert.rejects(transport.query({
    kind: 'knowledge', question: '任务列表怎么实现', scope: { domainSystems: {}, repositoryIds: ['H5_frontend'] }, signal: new AbortController().signal,
  }), { message: '当前会话没有选择知识范围。只有代码库时请使用远程代码检索。' })
})

test('Knowledge transport classifies query auth failures and login redirects without treating HTML as an answer', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const scope = { domainSystems: { domain: ['system'] }, repositoryIds: [] }
  const cases = [
    new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    new Response('<html><form><input type="password"></form></html>', { status: 200, headers: { 'content-type': 'text/html', 'x-knowledge-final-url': 'https://signinuat.annto.com/login' } }),
  ]
  for (const response of cases) {
    const transport = createKnowledgeTransport({ baseUrl: 'https://anapi-uat.annto.com/api-sse-kd', fetch: async () => response, cookies: async () => [] })
    await assert.rejects(transport.query({ kind: 'knowledge', question: '问题', scope, signal: new AbortController().signal }), { message: 'knowledge_login_required' })
  }
})

test('Knowledge transport keeps non-auth query failures specific and transparent', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async () => new Response('upstream exploded', { status: 502, headers: { 'content-type': 'text/plain' } }),
    cookies: async () => [],
  })
  await assert.rejects(transport.query({ kind: 'knowledge', question: '问题', scope: { domainSystems: { domain: ['system'] }, repositoryIds: [] }, signal: new AbortController().signal }), { message: 'knowledge_platform_http_502' })
})

test('Knowledge transport unwraps data, result, and value catalog envelopes', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async (input) => {
      if (String(input).endsWith('/api/auth/me')) return new Response(JSON.stringify({ result: { roleLevel: 'super_admin' } }))
      if (String(input).endsWith('/api/tags/controlled-vocabulary')) return new Response(JSON.stringify({ value: [{ id: 'domain', name: '领域', systems: [{ id: 'system', name: '系统' }] }] }))
      if (String(input).endsWith('/api/repos')) return new Response(JSON.stringify({ result: [{ id: 'repo', name: '仓库', domainId: 'domain' }] }))
      throw new Error(`unexpected request: ${String(input)}`)
    },
    cookies: async () => [],
    delay: async () => {},
  })

  assert.deepEqual(await transport.loadCatalog(), {
    domains: [{ id: 'domain', name: '领域' }],
    systems: [{ id: 'system', name: '系统', domainId: 'domain' }],
    repositories: [{ id: 'repo', name: '仓库', domainId: 'domain' }],
  })
})

test('Knowledge transport exposes SSE text together with step and status progress', async () => {
  const { createKnowledgeTransport } = await transportModule()
  const events = []
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"tool","text":"正在检索仓库","step":"repository_search","status":"running"}

data: {"type":"answer","delta":"答案"}

data: [DONE]

`))
      controller.close()
    },
  })
  const transport = createKnowledgeTransport({
    baseUrl: 'https://anapi-uat.annto.com/api-sse-kd',
    fetch: async () => new Response(body),
    cookies: async () => [],
    delay: async () => {},
  })

  await transport.query({
    kind: 'knowledge', question: '问题', scope: { domainSystems: { domain: ['system'] }, repositoryIds: [] }, signal: new AbortController().signal,
    onProgress: (event) => events.push(event),
  })

  assert.equal(events.some((event) => event.process?.includes('正在检索仓库') && event.process.includes('repository_search') && event.process.includes('running')), true)
})
