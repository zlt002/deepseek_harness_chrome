/** Browser-resident adapter for the Knowledge Platform. Cookies never cross this module's caller seam. */
export const KNOWLEDGE_BASE_URL = 'https://anapi-uat.annto.com/api-sse-kd'
export const KNOWLEDGE_SCOPE_STORAGE_KEY = 'harnessKnowledgeScopesV1'
export const KNOWLEDGE_SESSION_STORAGE_KEY = 'harnessKnowledgeSessionsV1'

export type KnowledgeKind = 'knowledge' | 'code'

export interface KnowledgeScope {
  domainSystems: Record<string, string[]>
  repositoryIds: string[]
}

export interface KnowledgeDomain { id: string; name: string }
export interface KnowledgeSystem { id: string; name: string; domainId: string }
export interface KnowledgeRepository { id: string; name: string; domainId?: string; systemId?: string }
export interface KnowledgeCatalog { domains: KnowledgeDomain[]; systems: KnowledgeSystem[]; repositories: KnowledgeRepository[] }
export interface KnowledgeResult {
  status: 'complete' | 'partial' | 'truncated'
  answer: string
  sources: Array<{ id: string; title: string }>
}

const MAX_ANSWER_CHARS = 16_000
const MAX_SOURCES = 20

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const candidate = asRecord(value)?.[key]
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
}

function dataArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  return Array.isArray(record?.data) ? record.data : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

export function validSessionIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

export function validScope(value: unknown): value is KnowledgeScope {
  const record = asRecord(value)
  return record !== undefined && asRecord(record.domainSystems) !== undefined
    && Object.entries(asRecord(record.domainSystems)!).every(([domainId, systemIds]) => validSessionIdentity(domainId) && Array.isArray(systemIds) && systemIds.every(validSessionIdentity))
    && Array.isArray(record.repositoryIds) && record.repositoryIds.every(validSessionIdentity)
}

export function normalizeScope(value: KnowledgeScope): KnowledgeScope {
  return { domainSystems: Object.fromEntries(Object.entries(value.domainSystems).flatMap(([domainId, systemIds]) => {
    const selected = unique(systemIds)
    return selected.length === 0 ? [] : [[domainId, selected]]
  })), repositoryIds: unique(value.repositoryIds) }
}

export function scopeFingerprint(scope: KnowledgeScope): string {
  return JSON.stringify([Object.entries(scope.domainSystems).map(([domainId, systemIds]) => [domainId, [...systemIds].sort()]).sort(([left], [right]) => String(left).localeCompare(String(right))), [...scope.repositoryIds].sort()])
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${KNOWLEDGE_BASE_URL}${path}`, { credentials: 'include', ...init })
  const text = await response.text()
  let payload: unknown
  try { payload = text.length === 0 ? undefined : JSON.parse(text) } catch { payload = text }
  if (!response.ok) throw new Error(typeof asRecord(payload)?.error === 'string' ? asRecord(payload)!.error as string : `knowledge_platform_http_${response.status}`)
  return payload
}

/** Fetch only display metadata; all execution continues to use canonical IDs. */
export async function loadKnowledgeCatalog(domainId?: string): Promise<KnowledgeCatalog> {
  const domains = dataArray(await api('/api/domains')).flatMap((item): KnowledgeDomain[] => {
    const id = stringField(item, 'id'); const name = stringField(item, 'name')
    return id === undefined || name === undefined ? [] : [{ id, name }]
  })
  if (domainId === undefined) return { domains, systems: [], repositories: [] }
  const [systemsRaw, reposRaw] = await Promise.all([
    api(`/api/domains/systems?domain=${encodeURIComponent(domainId)}`),
    api(`/api/repos?domain=${encodeURIComponent(domainId)}`),
  ])
  const systems = dataArray(systemsRaw).flatMap((item): KnowledgeSystem[] => {
    const id = stringField(item, 'id'); const name = stringField(item, 'name')
    const domain = stringField(item, 'domain') ?? domainId
    return id === undefined || name === undefined ? [] : [{ id, name, domainId: domain }]
  })
  const repositories = dataArray(reposRaw).flatMap((item): KnowledgeRepository[] => {
    const id = stringField(item, 'id')
    if (id === undefined) return []
    const name = stringField(item, 'name') ?? id
    const itemDomain = stringField(item, 'domain')
    const systemId = stringField(item, 'system_key')
    return [{ id, name, ...(itemDomain === undefined ? {} : { domainId: itemDomain }), ...(systemId === undefined ? {} : { systemId }) }]
  })
  return { domains, systems, repositories }
}

type SseEvent = { data: string }

/** Split an SSE stream only on complete blank-line-delimited events. */
export function consumeSseChunk(buffer: string, chunk: string): { events: SseEvent[]; remainder: string } {
  const complete = `${buffer}${chunk}`.replace(/\r\n/g, '\n')
  const parts = complete.split('\n\n')
  const remainder = parts.pop() ?? ''
  return { events: parts.map((part) => ({ data: part.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n') })).filter((event) => event.data.length > 0), remainder }
}

function sources(value: unknown): Array<{ id: string; title: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): Array<{ id: string; title: string }> => {
    const id = stringField(item, 'page_id') ?? stringField(item, 'id')
    const title = stringField(item, 'page_title') ?? stringField(item, 'title')
    return id === undefined || title === undefined ? [] : [{ id, title }]
  }).slice(0, MAX_SOURCES)
}

/** Execute a bounded, cancellable Knowledge Platform SSE request with browser cookies. */
export async function executeKnowledgeQuery(
  kind: KnowledgeKind,
  question: string,
  scope: KnowledgeScope,
  priorSessionId: string | undefined,
  signal: AbortSignal,
): Promise<{ result: KnowledgeResult; sessionId?: string }> {
  const body = kind === 'knowledge'
    ? { question, domain_system_config: Object.fromEntries(Object.entries(scope.domainSystems).map(([domainId, systems]) => [domainId, { self: false, systems }])), forceRetrieval: true, include_third_party: false, stream: true, ...(scope.repositoryIds.length === 0 ? {} : { repo_keys: scope.repositoryIds }), ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) }
    : { question, repo_keys: scope.repositoryIds, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) }
  if (kind === 'knowledge' && Object.keys(scope.domainSystems).length === 0) throw new Error('knowledge_scope_requires_knowledge')
  if (kind === 'code' && scope.repositoryIds.length === 0) throw new Error('knowledge_scope_requires_repository')
  const response = await fetch(`${KNOWLEDGE_BASE_URL}/api/rag/${kind === 'knowledge' ? 'retrieval' : 'repo-search'}`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal,
  })
  if (!response.ok || response.body === null) throw new Error(`knowledge_platform_http_${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let remainder = ''; let answer = ''; let resultSources: Array<{ id: string; title: string }> = []; let sessionId: string | undefined; let done = false; let sawDoneMarker = false
  try {
    while (true) {
      const read = await reader.read()
      if (read.done) break
      const parsed = consumeSseChunk(remainder, decoder.decode(read.value, { stream: true }))
      remainder = parsed.remainder
      for (const event of parsed.events) {
        if (event.data === '[DONE]') { sawDoneMarker = true; continue }
        let payload: Record<string, unknown>
        try { payload = JSON.parse(event.data) as Record<string, unknown> } catch { continue }
        if (payload.type === 'error') throw new Error(typeof payload.error === 'string' ? payload.error : 'knowledge_platform_error')
        if (typeof payload.delta === 'string') answer = `${answer}${payload.delta}`.slice(0, MAX_ANSWER_CHARS)
        if (payload.type === 'citations' || payload.type === 'done') resultSources = sources(payload.citations ?? payload.references)
        if (payload.type === 'done') { done = true; sessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId }
      }
    }
  } finally { reader.releaseLock() }
  if (!done || !sawDoneMarker) throw new Error('knowledge_platform_incomplete_sse')
  return { result: { status: answer.length >= MAX_ANSWER_CHARS ? 'truncated' : 'complete', answer, sources: resultSources }, ...(sessionId === undefined ? {} : { sessionId }) }
}
