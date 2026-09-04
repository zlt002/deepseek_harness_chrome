export type KnowledgeKind = 'knowledge' | 'code'

export interface KnowledgeScope {
  domainSystems: Record<string, string[]>
  repositoryIds: string[]
}

export interface KnowledgeCatalog {
  domains: Array<{ id: string; name: string }>
  systems: Array<{ id: string; name: string; domainId?: string }>
  repositories: Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }>
}

export interface KnowledgeQueryProgress {
  chars: number
  content: string
  eventType?: string
  process?: string
}

export interface KnowledgeQueryResult {
  result: { status: 'complete' | 'partial' | 'truncated'; answer: string; sources: Array<{ id: string; title: string }> }
  sessionId?: string
}

interface KnowledgeCookie { name: string; value: string; path?: string; expirationDate?: number }
interface ProxyConfig { url: string; token: string }

/**
 * The remote knowledge module's interface is deliberately small. Callers only
 * configure the local proxy, load a domain catalog, query it, and classify a
 * failure. Cookies, retry policy, JSON normalization, and SSE recovery stay
 * behind this seam.
 */
export interface KnowledgeTransport {
  configureProxy(url: unknown, token: unknown): boolean
  clearProxy(): void
  hasProxy(): boolean
  clearCatalog(): void
  loadCatalog(): Promise<KnowledgeCatalog>
  query(request: { kind: KnowledgeKind; question: string; scope: KnowledgeScope; priorSessionId?: string; signal: AbortSignal; onProgress?: (progress: KnowledgeQueryProgress) => void }): Promise<KnowledgeQueryResult>
  serviceState(error: unknown): 'unauthenticated' | 'unavailable'
}

export interface KnowledgeTransportAdapter {
  baseUrl: string
  fetch(input: string, init?: RequestInit): Promise<Response>
  cookies(): Promise<readonly KnowledgeCookie[]>
  delay?(ms: number): Promise<void>
  now?(): number
}

type KnowledgeIdentity = { roleLevel: 'super_admin' | 'domain_admin' | 'member'; domainIds: string[] }
const CATALOG_TIMEOUT_MS = 15_000
const CATALOG_CACHE_TTL_MS = 5 * 60_000
const RETRY_LIMIT = 2
const RETRY_DELAY_MS = 250
const PROCESS_TEXT_LIMIT = 32_000
const PROCESS_LINE_LIMIT = 400

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function payloadArray(value: unknown): unknown[] { const payload = unwrap(value); return Array.isArray(payload) ? payload : [] }
function field(value: unknown, key: string): string | undefined { const item = value as Record<string, unknown> | undefined; return typeof item?.[key] === 'string' && item[key].trim().length > 0 ? item[key].trim() : undefined }
function unwrap(value: unknown): unknown {
  if (!record(value)) return value
  return value.data ?? value.result ?? value.value ?? value
}
function stringishField(value: unknown, keys: string[]): string | undefined { if (!record(value)) return undefined; for (const key of keys) { const candidate = value[key]; if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim(); if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate) } return undefined }
function stringishList(value: unknown, keys: string[]): string[] { if (!record(value)) return []; for (const key of keys) { const candidate = value[key]; if (Array.isArray(candidate)) return [...new Set(candidate.flatMap((item) => typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : typeof item === 'number' && Number.isFinite(item) ? [String(item)] : []))] } return [] }

function errorChain(value: unknown): string {
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (record(current)) { const message = typeof current.message === 'string' ? current.message : undefined; const code = typeof current.code === 'string' ? current.code : undefined; if (message && code && !message.includes(code)) return `${message}: ${code}`; return message ?? code ?? JSON.stringify(current) }
        return String(current)
      }
      const code = typeof (current as Error & { code?: unknown }).code === 'string' ? (current as Error & { code: string }).code : undefined
      let text = current.message || current.name
      if (code && !text.includes(code)) text = `${text}: ${code}`
      if (current.cause !== undefined) { const cause = render(current.cause); if (cause && cause !== text && !text.includes(cause)) text = `${text}: ${cause}` }
      return text
    } finally { path.delete(current) }
  }
  return render(value)
}
function transportCode(value: unknown): string | undefined { let current: unknown = value; for (let depth = 0; depth < 6 && current; depth += 1) { if (record(current) && typeof current.code === 'string' && current.code.length > 0) return current.code; current = record(current) ? current.cause : undefined } return undefined }
function retryable(error: unknown): boolean { const code = transportCode(error); if (code !== undefined && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code)) return true; return /fetch failed|Failed to fetch|NetworkError|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|other side closed/i.test(errorChain(error)) }
function isStream(input: string): boolean { return /\/api\/rag\/(?:retrieval|repo-search)(?:\?|$)/.test(input) }
function proxyFailure(status: number, text: string): boolean { return status === 502 && /Knowledge proxy failed|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|UND_ERR_/i.test(text) }
function state(error: unknown): 'unauthenticated' | 'unavailable' { return error instanceof Error && error.message === 'knowledge_login_required' ? 'unauthenticated' : 'unavailable' }
function loginResponse(response: Response, text = ''): boolean {
  const finalUrl = response.headers.get('x-knowledge-final-url') ?? response.url
  let finalHost = ''
  try { finalHost = new URL(finalUrl).hostname } catch { /* retain empty host */ }
  const contentType = response.headers.get('content-type') ?? ''
  return response.status === 401 || response.status === 403 || finalHost === 'signinuat.annto.com'
    || /text\/html/i.test(contentType) && /<form|password|登录|signin/i.test(text.slice(0, 8_000))
    || /未登录|请先登录|登录失效|unauthenticated|unauthorized/i.test(text.slice(0, 8_000))
}
function describeTransportError(error: unknown, process = ''): string { const detail = errorChain(error); const timeout = /UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|body timeout|headers timeout/i.test(detail); const transport = timeout || /fetch failed|Failed to fetch|NetworkError|socket hang up|ECONNRESET|other side closed/i.test(detail); const reason = timeout ? '远程检索流因传输层空闲超时中断（常见于仓库精搜超过约 5 分钟仍未结束）。' : transport ? '远程检索流在返回最终答案前因网络传输中断。' : '远程检索流在返回最终答案前中断。'; const hint = process.trim() === '' ? '' : `\n已收到的远程检索过程：\n${process.trim().slice(-3_000)}`; return `${reason}${detail}${hint}` }

function identity(value: unknown): KnowledgeIdentity { const data = unwrap(value); const source = record(data) && record(data.user) ? data.user : record(data) ? data : {}; const role = stringishField(source, ['roleLevel', 'role_level']); return { roleLevel: role === 'super_admin' || role === 'domain_admin' || role === 'member' ? role : 'member', domainIds: stringishList(source, ['domainIds', 'domain_ids']) } }
function controlledVocabulary(value: unknown): Pick<KnowledgeCatalog, 'domains' | 'systems'> | undefined {
  const data = unwrap(value)
  const rawDomains = Array.isArray(data) ? data : payloadArray((data as { domains?: unknown; items?: unknown; vocabulary?: unknown } | undefined)?.domains ?? (data as { items?: unknown } | undefined)?.items ?? (data as { vocabulary?: unknown } | undefined)?.vocabulary)
  const domains: KnowledgeCatalog['domains'] = []; const systems: KnowledgeCatalog['systems'] = []; const domainIds = new Set<string>(); const systemIds = new Set<string>()
  for (const item of rawDomains) { const id = stringishField(item, ['id', 'value', 'code', 'domainId', 'domain_id']); if (id === undefined || domainIds.has(id)) continue; domainIds.add(id); domains.push({ id, name: stringishField(item, ['name', 'label', 'title', 'domainName', 'domain_name']) ?? id }); for (const child of payloadArray((item as { systems?: unknown; children?: unknown; items?: unknown }).systems ?? (item as { children?: unknown }).children ?? (item as { items?: unknown }).items)) { const systemId = stringishField(child, ['id', 'value', 'code', 'systemId', 'system_id']); if (systemId === undefined || systemIds.has(`${id}\u0000${systemId}`)) continue; systemIds.add(`${id}\u0000${systemId}`); systems.push({ id: systemId, name: stringishField(child, ['name', 'label', 'title', 'systemName', 'system_name']) ?? systemId, domainId: id }) } }
  for (const item of record(data) && Array.isArray(data.systems) ? data.systems : []) { const systemId = stringishField(item, ['id', 'value', 'code', 'systemId', 'system_id']); const domainId = stringishField(item, ['domain', 'domainId', 'domain_id']); if (systemId === undefined || domainId === undefined || !domainIds.has(domainId) || systemIds.has(`${domainId}\u0000${systemId}`)) continue; systemIds.add(`${domainId}\u0000${systemId}`); systems.push({ id: systemId, name: stringishField(item, ['name', 'label', 'title', 'systemName', 'system_name']) ?? systemId, domainId }) }
  return domains.length > 0 ? { domains, systems } : undefined
}
function filterCatalog(catalog: KnowledgeCatalog, user: KnowledgeIdentity): KnowledgeCatalog { const allowed = user.roleLevel === 'super_admin' ? new Set(catalog.domains.map((domain) => domain.id)) : new Set(user.domainIds); return { domains: catalog.domains.filter((item) => allowed.has(item.id)), systems: catalog.systems.filter((item) => item.domainId !== undefined && allowed.has(item.domainId)), repositories: catalog.repositories.filter((item) => item.domainId !== undefined && allowed.has(item.domainId)) } }
function sseEvents(buffer: string, chunk: string): { events: string[]; remainder: string } { const parts = `${buffer}${chunk}`.replace(/\r\n/g, '\n').split('\n\n'); const remainder = parts.pop() ?? ''; return { events: parts.map((part) => part.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean), remainder } }
function mergeText(current: string, incoming: string): string { if (incoming.startsWith(current)) return incoming.slice(0, 16_000); if (current.endsWith(incoming)) return current; let overlap = Math.min(current.length, incoming.length); while (overlap > 0 && current.slice(-overlap) !== incoming.slice(0, overlap)) overlap -= 1; return `${current}${incoming.slice(overlap)}`.slice(0, 16_000) }
function processEvent(payload: Record<string, unknown>): boolean { return payload.type === 'reasoning' || payload.type === 'thinking' || payload.type === 'thought' || payload.type === 'agent_thought' || payload.type === 'tool' || payload.type === 'tool_call' || payload.type === 'search' || payload.type === 'status' || payload.type === 'progress' || payload.type === 'log' || payload.type === 'step' }
function answerDelta(payload: Record<string, unknown>): boolean { return typeof payload.delta === 'string' && payload.type !== 'reasoning' && payload.type !== 'thinking' && payload.type !== 'thought' && payload.type !== 'agent_thought' && payload.type !== 'text_delta' }
function compact(value: string): string { return value.slice(0, PROCESS_LINE_LIMIT * 4).replace(/\s+/g, ' ').replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^"'()\s,:]+[\\/]){3,}[^"'()\s,:]+/g, (path) => { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path }).slice(0, PROCESS_TEXT_LIMIT) }
function processText(payload: Record<string, unknown>): string | undefined {
  if (payload.type === 'reasoning' || payload.type === 'thinking' || payload.type === 'thought' || payload.type === 'agent_thought') return '远程检索正在分析问题…'
  const detail = [payload.text, payload.message, payload.delta, payload.content, payload.detail].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
  const source = typeof payload.source === 'string' ? payload.source.trim() : ''
  const visible = detail === undefined ? undefined : source === '' ? compact(detail) : `${compact(source).slice(0, 80)} · ${compact(detail)}`
  const step = typeof payload.step === 'string' && payload.step.trim() !== '' ? payload.step.trim() : undefined
  const status = typeof payload.status === 'string' && payload.status.trim() !== '' ? payload.status.trim() : undefined
  const state = step === undefined && status === undefined ? undefined : `${step ?? 'retrieval'} · ${status ?? 'running'}`
  return visible === undefined ? state : state === undefined ? visible : `${visible} · ${state}`
}
function appendProcess(current: string, incoming: string): string { const line = incoming.trim(); if (line === '') return current; if (current === '') return line.slice(0, PROCESS_TEXT_LIMIT); const newline = current.lastIndexOf('\n'); const last = newline === -1 ? current : current.slice(newline + 1); if (line === last) return current; if (line.startsWith(last) || last.startsWith(line)) { const next = line.length >= last.length ? line : last; return `${newline === -1 ? '' : current.slice(0, newline + 1)}${next}`.slice(0, PROCESS_TEXT_LIMIT) } return `${current}\n${line}`.slice(0, PROCESS_TEXT_LIMIT) }
function directedQuestion(kind: KnowledgeKind, question: string, resumed: boolean): string { const instruction = resumed ? '这是同一远程检索会话的追问。请在已有上下文上继续回答，不要无必要地从头扫描仓库或知识库。' : kind === 'code' ? '请直接返回从所选远程代码仓库检索到的事实、文件路径和代码依据。' : '请直接返回从所选知识范围和代码库检索到的事实、文件路径与引用依据。'; const language = /[\u3400-\u9fff]/u.test(question) ? '所有面向用户的流式内容和最终答案都必须使用简体中文；工具名、代码标识符和文件路径可保留原文。即使转述后的问题包含英文，也不要用英文叙述。' : 'Use the same language as the user question for all user-visible streaming content and the final answer.'; return `${instruction}${language}若用户要原文摘录，一次只返回一个文件或一个函数的核心片段；不要并行检索多个文件，也不要把多个大文件全文塞进同一次答案。最终答案只保留事实和引用，不要把思考过程写进最终答案。检索计划、当前正在查的仓库或知识、工具选择和进度可通过独立过程事件流式返回。用户问题：${question}` }

export function createKnowledgeTransport(adapter: KnowledgeTransportAdapter): KnowledgeTransport {
  let proxy: ProxyConfig | undefined
  let catalogCache: { at: number; value: KnowledgeCatalog } | undefined
  const now = adapter.now ?? (() => Date.now())
  const pause = adapter.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryFetch = async (input: string, init: RequestInit = {}): Promise<Response> => { let last: unknown; for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) { try { return await adapter.fetch(input, init) } catch (error) { last = error; if (init.signal?.aborted || !retryable(error) || attempt === RETRY_LIMIT) throw new Error(errorChain(error), { cause: error instanceof Error ? error : undefined }); await pause(RETRY_DELAY_MS * (attempt + 1)) } } throw last instanceof Error ? last : new Error(errorChain(last)) }
  const cookieHeader = async (): Promise<string> => (await adapter.cookies()).filter((cookie) => cookie.expirationDate === undefined || cookie.expirationDate > now() / 1000).sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  const request = async (input: string, init: RequestInit = {}): Promise<Response> => { const stream = isStream(input); const direct = { ...init, credentials: init.credentials ?? 'include' }; if (stream) { try { return await retryFetch(input, direct) } catch (error) { if (init.signal?.aborted || proxy === undefined) throw error } } if (proxy === undefined) return retryFetch(input, direct); const target = new URL(input); if (target.origin !== new URL(adapter.baseUrl).origin || !target.pathname.startsWith('/api-sse-kd/api/')) throw new Error('knowledge_proxy_target_rejected'); const headers = new Headers(init.headers); headers.delete('cookie'); headers.delete('authorization'); const proxyInit: RequestInit = { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: `${target.pathname}${target.search}`, method: init.method ?? 'GET', headers: [...headers], ...(typeof init.body === 'string' ? { body: init.body } : {}), cookie: await cookieHeader() }), signal: init.signal }; try { const response = await retryFetch(proxy.url, proxyInit); if (response.ok) return response; if (proxyFailure(response.status, await response.clone().text())) return retryFetch(input, direct); return response } catch (error) { if (init.signal?.aborted || (!retryable(error) && !/Knowledge proxy failed|fetch failed|Failed to fetch/i.test(errorChain(error)))) throw error; return retryFetch(input, direct) } }
  const json = async (path: string): Promise<unknown> => { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS); let response: Response; try { response = await request(`${adapter.baseUrl}${path}`, { credentials: 'include', signal: controller.signal }) } catch (error) { if (controller.signal.aborted) throw new Error('knowledge_catalog_timeout'); throw new Error(errorChain(error), { cause: error instanceof Error ? error : undefined }) } finally { clearTimeout(timeout) } const text = await response.text(); const payload = (() => { try { return JSON.parse(text) as unknown } catch { return undefined } })(); const message = record(payload) ? [field(payload, 'error'), field(payload, 'message'), field(payload, 'msg')].filter(Boolean).join(' ') : text.slice(0, 1_000); if (loginResponse(response, message)) throw new Error('knowledge_login_required'); if (!response.ok) throw new Error(`knowledge_platform_http_${response.status}`); if (payload === undefined) throw new Error('knowledge_platform_invalid_json'); return payload }
  const loadCatalog = async (): Promise<KnowledgeCatalog> => { if (catalogCache !== undefined && now() - catalogCache.at < CATALOG_CACHE_TTL_MS) return catalogCache.value; const user = identity(await json('/api/auth/me')); const [vocabularyResult, reposResult] = await Promise.allSettled([json('/api/tags/controlled-vocabulary'), json('/api/repos')]); for (const result of [vocabularyResult, reposResult]) if (result.status === 'rejected' && state(result.reason) === 'unauthenticated') throw result.reason; const vocabulary = vocabularyResult.status === 'fulfilled' ? controlledVocabulary(vocabularyResult.value) : undefined; let rawDomains: unknown; let domainError: unknown; if (vocabulary === undefined) { try { rawDomains = await json('/api/domains') } catch (error) { if (state(error) === 'unauthenticated') throw error; domainError = error } } if (vocabulary === undefined && rawDomains === undefined && reposResult.status === 'rejected') throw domainError ?? reposResult.reason; const domains = vocabulary?.domains ?? payloadArray(rawDomains).flatMap((item): KnowledgeCatalog['domains'] => { const id = stringishField(item, ['id', 'value', 'code', 'domainId', 'domain_id']); return id === undefined ? [] : [{ id, name: stringishField(item, ['name', 'label', 'title', 'domainName', 'domain_name']) ?? id }] }); const repositories = reposResult.status === 'fulfilled' ? payloadArray(reposResult.value).flatMap((item): KnowledgeCatalog['repositories'] => { const id = stringishField(item, ['id', 'key', 'repoKey', 'repo_key']); if (id === undefined) return []; const domainId = stringishField(item, ['domain', 'domainId', 'domain_id']); const systemId = stringishField(item, ['system_key', 'systemKey', 'systemId', 'system_id']); const type = stringishField(item, ['repo_type', 'repoType', 'type']); return [{ id, name: stringishField(item, ['name', 'repoName', 'repo_name']) ?? id, ...(domainId === undefined ? {} : { domainId }), ...(systemId === undefined ? {} : { systemId }), ...(type === undefined ? {} : { type }) }] }) : []; const rawSystems = vocabulary === undefined || (vocabulary.systems.length === 0 && vocabulary.domains.length > 0) ? await json('/api/domains/systems').catch(() => undefined) : undefined; const systems = vocabulary?.systems.length ? vocabulary.systems : payloadArray(rawSystems).flatMap((item): KnowledgeCatalog['systems'] => { const id = stringishField(item, ['id', 'value', 'code', 'systemId', 'system_id']); if (id === undefined) return []; const domainId = stringishField(item, ['domain', 'domainId', 'domain_id']); return [{ id, name: stringishField(item, ['name', 'label', 'title', 'systemName', 'system_name']) ?? id, ...(domainId === undefined ? {} : { domainId }) }] }); const value = filterCatalog({ domains, systems, repositories }, user); catalogCache = { at: now(), value }; return value }
  const query = async ({ kind, question, scope, priorSessionId, signal, onProgress }: Parameters<KnowledgeTransport['query']>[0]): Promise<KnowledgeQueryResult> => { if (kind === 'knowledge' && Object.keys(scope.domainSystems).length === 0) throw new Error('当前会话没有选择知识范围。只有代码库时请使用远程代码检索。'); if (kind === 'code' && scope.repositoryIds.length === 0) throw new Error('当前会话没有选择远程代码库。请在输入框上方点「选择代码库」并勾选仓库，然后重试。不要用本地工作区代替远程代码检索。'); const directed = directedQuestion(kind, question, priorSessionId !== undefined); const body = kind === 'knowledge' ? { question: directed, domain_system_config: Object.fromEntries(Object.entries(scope.domainSystems).map(([domainId, systems]) => [domainId, { self: false, systems }])), forceRetrieval: true, include_third_party: false, stream: true, ...(scope.repositoryIds.length === 0 ? {} : { repo_keys: scope.repositoryIds }), ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) } : { question: directed, repo_keys: scope.repositoryIds, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) }; const emit = (eventType?: string, content = '', process = '') => onProgress?.({ chars: content.length, content, ...(eventType === undefined ? {} : { eventType }), ...(process === '' ? {} : { process }) }); const response = await request(`${adapter.baseUrl}/api/rag/${kind === 'knowledge' ? 'retrieval' : 'repo-search'}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal }); let responseText = ''; if (response.status === 401 || response.status === 403 || response.headers.get('x-knowledge-final-url') !== null || /text\/html/i.test(response.headers.get('content-type') ?? '')) { try { responseText = await response.clone().text() } catch { /* retain empty body */ } } if (loginResponse(response, responseText)) throw new Error('knowledge_login_required'); if (!response.ok) throw new Error(`knowledge_platform_http_${response.status}`); if (response.body === null) throw new Error('knowledge_platform_invalid_sse'); if (/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('knowledge_platform_invalid_sse'); emit('connected'); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let answer = ''; let visual = ''; let process = ''; let sources: Array<{ id: string; title: string }> = []; let sessionId: string | undefined; let done = false; let marker = false; let stop = false; const consume = (chunk: string): void => { const parsed = sseEvents(buffer, chunk); buffer = parsed.remainder; for (const event of parsed.events) { if (event === '[DONE]') { marker = true; continue } let payload: Record<string, unknown>; try { payload = JSON.parse(event) as Record<string, unknown> } catch { continue } if (payload.type === 'error') { if (answer.length > 0) { stop = true; break } throw new Error(typeof payload.error === 'string' ? payload.error : 'knowledge_platform_error') } if (payload.type === 'text_delta') continue; if (processEvent(payload)) { const incoming = processText(payload); if (incoming !== undefined) process = appendProcess(process, incoming); emit(typeof payload.type === 'string' ? payload.type : 'progress', visual, process) } else if (answerDelta(payload)) { answer = mergeText(answer, payload.delta as string); visual = answer; emit(typeof payload.type === 'string' ? payload.type : undefined, visual, process) } if (payload.type === 'citations' || payload.type === 'done') sources = (Array.isArray(payload.citations) ? payload.citations : []).flatMap((item): Array<{ id: string; title: string }> => { const id = field(item, 'page_id') ?? field(item, 'id'); const title = field(item, 'page_title') ?? field(item, 'title') ?? id; return id === undefined ? [] : [{ id, title: title ?? id }] }).slice(0, 20); if (payload.type === 'done') { done = true; sessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId } } }; try { while (!stop) { const read = await reader.read(); if (read.done) break; consume(decoder.decode(read.value, { stream: true })) } consume(decoder.decode()) } catch (error) { try { consume(decoder.decode()) } catch { /* retain initial error */ } if (answer.length === 0) throw new Error(describeTransportError(error, process), { cause: error instanceof Error ? error : undefined }) } finally { reader.releaseLock() } if (answer.length === 0 && !done && !marker) throw new Error('knowledge_platform_incomplete_sse'); const complete = (done || marker) && answer.length < 16_000; return { result: { status: answer.length >= 16_000 ? 'truncated' : complete ? 'complete' : 'partial', answer, sources }, ...(sessionId === undefined ? {} : { sessionId }) } }
  return { configureProxy(url, token) { if (typeof url !== 'string' || typeof token !== 'string' || token.length < 32) return false; try { const parsed = new URL(url); if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '' || parsed.pathname !== '/knowledge-proxy') return false } catch { return false } proxy = { url, token }; return true }, clearProxy() { proxy = undefined }, hasProxy() { return proxy !== undefined }, clearCatalog() { catalogCache = undefined }, loadCatalog, query, serviceState: state }
}
