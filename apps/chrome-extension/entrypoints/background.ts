// Kept self-contained because focused background adapters evaluate this source
// as a data URL and production WXT bundles it as a single service worker.
import {
  CONNECTOR_CANCEL,
  CONNECTOR_REQUEST,
  CONNECTOR_RESPONSE,
  sameBrowserTarget,
  sameBrowserTargetList,
  sameUnavailableBrowserTargetList,
  validBrowserTarget as isBrowserTarget,
  validUnavailableBrowserTarget as isUnavailableBrowserTarget,
} from '../../native-server/src/connector-protocol.mjs'
import type {
  BrowserTarget,
  ConnectorCorrelation,
  UnavailableBrowserTarget,
} from '../../native-server/src/connector-protocol.mjs'
import { sameRuntimeReleaseIdentity, validRuntimeIdentitySummary } from '../../native-server/src/runtime-identity-contract.mjs'
import type { RuntimeIdentitySummary } from '../../native-server/src/runtime-identity-contract.mjs'
import {
  samePinnedTab,
  settingsFromUnknown,
} from './background/browser-target-state'
import type { BrowserTargetSettings } from './background/browser-target-state'
import { BrowserTargetRuntime } from './background/browser-target-runtime'
import type { BrowserTargetBinding, BrowserTargetTab } from './background/browser-target-runtime'
import {
  isLightDocumentResourceIdentity,
  isListWorkTabsRequest as isConnectorRequest,
  isOfficeDocumentRequest,
  isReadWorkTabRequest,
} from './background/office-request-contract'
import { MARKDOWN_REVIEW_PORT, isMarkdownReviewPortRequest } from './markdown-review/protocol'
import type { CommitWriteRequest, DeliverRequest, MarkdownReviewPortRequest, PrepareWriteRequest } from './markdown-review/protocol'
import type {
  LightDocumentResourceIdentity,
  ListWorkTabsRequest as ConnectorRequest,
  OfficeDocumentRequest,
  OfficeReadFailure,
  ReadWorkTabRequest,
} from './background/office-request-contract'
import {
  PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY,
  retainedPrototypeStudioAuthorizations,
  storedPrototypeStudioAuthorizations,
  validPrototypeStudioAuthorization,
} from '../src/prototype-studio-authorization'
import type { PrototypeStudioAuthorization } from '../src/prototype-studio-authorization'
const KNOWLEDGE_API_ORIGIN = 'https://anapi-uat.annto.com'
const KNOWLEDGE_BASE_URL = `${KNOWLEDGE_API_ORIGIN}/api-sse-kd`
const KNOWLEDGE_CATALOG_TIMEOUT_MS = 15_000
const KNOWLEDGE_CATALOG_CACHE_TTL_MS = 5 * 60_000
const KNOWLEDGE_TRANSPORT_RETRY_LIMIT = 2
const KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS = 250
const KNOWLEDGE_SCOPE_STORAGE_KEY = 'harnessKnowledgeScopesV1'
const KNOWLEDGE_SESSION_STORAGE_KEY = 'harnessKnowledgeSessionsV1'
const KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY = 'harnessKnowledgeEnabledPreferenceV1'
const KNOWLEDGE_LOGIN_URL = 'https://wb-uat.annto.com/'
const ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY = 'harnessAccountLocalSignOutV1'
const ACCOUNT_AUTH_COOKIE_NAMES = new Set(['MAS_TGC_UAT', 'midea_auth_uat', 'OAM_ID'])
const ACCOUNT_AUTH_COOKIE_DOMAIN = 'annto.com'
const COMPANY_PORTAL_TAB_URL_PATTERN = 'https://wb-uat.annto.com/*'
const COMPANY_PORTAL_RETURN_URL = 'https://wb-uat.annto.com'
const COMPANY_PORTAL_LOGOUT_API_URL = 'https://anapi-uat.annto.com/api-auth/ssoLogout'
const COMPANY_SSO_LOGIN_URL = `https://signinuat.midea.com/?service=${encodeURI(COMPANY_PORTAL_RETURN_URL)}`
const COMPANY_SSO_LOGOUT_URL = `http://signinuat.midea.com/logout?service=${encodeURI(COMPANY_SSO_LOGIN_URL)}`
const COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS = 15_000
const COMPANY_GATEWAY_BASE_URL = `${KNOWLEDGE_API_ORIGIN}/api-sse-anthropic/v1`
const COMPANY_GATEWAY_METADATA_STORAGE_KEY = 'harnessCompanyGatewayMetadataV1'
const COMPANY_GATEWAY_TIMEOUT_MS = 15_000
interface KnowledgeProxyConfig { url: string; token: string }
let knowledgeProxyConfig: KnowledgeProxyConfig | undefined
type KnowledgeKind = 'knowledge' | 'code'
interface KnowledgeScope { domainId: string; systemIds: string[]; repositoryIds: string[] }
interface AccountAccessSnapshot {
  status: 'guest' | 'authenticated' | 'unavailable'
  displayName?: string
  knowledgeAccess: boolean
  codeAccess: boolean
  modelMode: 'manual' | 'company-pending'
  gateway?: CompanyGatewayMetadata
  message?: string
}
interface CompanyGatewayModel { id: string; name: string; description?: string }
interface CompanyGatewayQuota { usagePercent: number | null; nextResetTime: string | null; resetCycle: 'daily' | 'weekly' | 'monthly' | 'unlimited' }
type CompanyGatewayProtocol = 'anthropic-messages' | 'openai-completions'
interface CompanyGatewayCapability { protocol: CompanyGatewayProtocol; modelId: string; tools: true }
interface CompanyGatewayMetadata { models: CompanyGatewayModel[]; quota: CompanyGatewayQuota; capability: CompanyGatewayCapability; checkedAt: string }

const LEGACY_KNOWLEDGE_SCOPE_PREFIX = 'knowledge-query:scope:session:'
function legacyKnowledgeScopeKey(sessionId: string): string { return `${LEGACY_KNOWLEDGE_SCOPE_PREFIX}${sessionId}` }
function migrateLegacyKnowledgeScope(value: unknown): { enabled: boolean; scope: KnowledgeScope; notice?: string } | undefined {
  const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
  const stringList = (item: unknown): item is string[] => Array.isArray(item) && item.every(entry => typeof entry === 'string')
  const state = isRecord(value) && 'scope' in value ? value : { enabled: true, scope: value }
  if (!isRecord(state.scope) || typeof state.scope.hasCommon !== 'boolean' || !isRecord(state.scope.domains)
    || (state.scope.repoKeys !== undefined && !stringList(state.scope.repoKeys))
    || (state.enabled !== undefined && typeof state.enabled !== 'boolean')) return undefined
  for (const selection of Object.values(state.scope.domains)) {
    if (!isRecord(selection) || typeof selection.self !== 'boolean' || !stringList(selection.systems)) return undefined
  }
  const unique = (items: string[]): string[] => [...new Set(items.map(item => item.trim()).filter(Boolean))]
  const selectedDomains = Object.entries(state.scope.domains)
    .filter(([, raw]) => (raw as { self: boolean; systems: string[] }).self || (raw as { systems: string[] }).systems.length > 0)
    .sort(([left], [right]) => left.localeCompare(right)) as [string, { self: boolean; systems: string[] }][]
  const repositoryIds = unique((state.scope.repoKeys as string[] | undefined) ?? [])
  if (selectedDomains.length > 1) return {
    enabled: (state.enabled as boolean | undefined) ?? true,
    scope: { domainId: '', systemIds: [], repositoryIds },
    notice: '旧版会话包含多个知识领域，请重新确认知识范围；已保留代码库选择。',
  }
  return {
    enabled: (state.enabled as boolean | undefined) ?? true,
    scope: { domainId: selectedDomains[0]?.[0] ?? '', systemIds: unique(selectedDomains[0]?.[1].systems ?? []), repositoryIds },
  }
}

function validSessionIdentity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) }
const SIDE_PANEL_HANDOFF_TTL_MS = 60_000
const pendingSidePanelHandoffs = new Map<number, { sessionId: string; tabId: number; expiresAt: number }>()
const WORKSPACE_REVIEW_SNAPSHOT_PATH = '/api/workspace-review/snapshot'
const WORKSPACE_REVIEW_SELECTION_PATH = '/api/workspace-review/selection'
const WORKSPACE_REVIEW_PROPOSALS_PATH = '/api/workspace-review/proposals'
const WORKSPACE_REVIEW_PREPARE_WRITE_PATH = '/api/workspace-review/prepare-write'
const WORKSPACE_REVIEW_COMMIT_WRITE_PATH = '/api/workspace-review/commit-write'
const MARKDOWN_REVIEW_STORAGE_KEY = 'harnessMarkdownReviewIdentitiesV1'

interface OpenMarkdownReview {
  v: 1
  reviewId: string
  harnessSessionId: string
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
  capability: string
}

interface MarkdownReviewRecord extends OpenMarkdownReview {
  tabId: number
  windowId: number
}
type PersistedMarkdownReview = Omit<MarkdownReviewRecord, 'capability' | 'v'>

const markdownReviews = new Map<string, MarkdownReviewRecord>()
const markdownReviewKeys = new Map<string, string>()
const markdownReviewPorts = new Map<number, chrome.runtime.Port>()

function boundedReviewText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim() !== '')
}

function reviewId(value: unknown): value is string {
  return boundedReviewText(value, 160) && /^[A-Za-z0-9._:-]+$/.test(value)
}

function isOpenMarkdownReview(value: unknown): value is OpenMarkdownReview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const review = value as Record<string, unknown>
  return review.v === 1
    && ['reviewId', 'harnessSessionId', 'resourceId', 'revision', 'fingerprint'].every(key => reviewId(review[key]))
    && boundedReviewText(review.displayPath, 2_048)
    && boundedReviewText(review.capability, 512)
}

function validScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null && ((value as KnowledgeScope).domainId === '' || validSessionIdentity((value as KnowledgeScope).domainId))
    && Array.isArray((value as KnowledgeScope).systemIds) && (value as KnowledgeScope).systemIds.every(validSessionIdentity)
    && Array.isArray((value as KnowledgeScope).repositoryIds) && (value as KnowledgeScope).repositoryIds.every(validSessionIdentity)
}
function normalizeScope(scope: KnowledgeScope): KnowledgeScope { return { domainId: scope.domainId, systemIds: [...new Set(scope.systemIds)], repositoryIds: [...new Set(scope.repositoryIds)] } }
function scopeFingerprint(scope: KnowledgeScope): string { return JSON.stringify([scope.domainId, [...scope.systemIds].sort(), [...scope.repositoryIds].sort()]) }
function knowledgeConversationOwner(harnessSessionId: string, harnessParentSessionId?: string): string {
  return harnessParentSessionId ?? harnessSessionId
}
function upstreamSessionKey(ownerSessionId: string, kind: KnowledgeKind, fingerprint: string): string {
  return `${ownerSessionId}\u0000${kind}\u0000${fingerprint}`
}
function planKnowledgeContinuation(sessions: Record<string, { sessionId: string; fingerprint: string }>, ownerSessionId: string, kind: KnowledgeKind, fingerprint: string): { key: string; priorSessionId?: string } {
  const key = upstreamSessionKey(ownerSessionId, kind, fingerprint)
  const priorSessionId = sessions[key]?.sessionId
  return priorSessionId === undefined || priorSessionId.trim() === '' ? { key } : { key, priorSessionId }
}
function payloadArray(value: unknown): unknown[] { return Array.isArray(value) ? value : Array.isArray((value as { data?: unknown } | undefined)?.data) ? (value as { data: unknown[] }).data : [] }
function field(value: unknown, key: string): string | undefined { const item = value as Record<string, unknown> | undefined; return typeof item?.[key] === 'string' && item[key].trim().length > 0 ? item[key].trim() : undefined }
function unwrapKnowledgeData(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.data ?? record.result ?? value
}
function isKnowledgeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function stringishField(value: unknown, keys: string[]): string | undefined {
  if (!isKnowledgeRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return undefined
}
function stringishList(value: unknown, keys: string[]): string[] {
  if (!isKnowledgeRecord(value)) return []
  for (const key of keys) {
    const candidate = value[key]
    if (!Array.isArray(candidate)) continue
    return [...new Set(candidate.flatMap((item) => typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : typeof item === 'number' && Number.isFinite(item) ? [String(item)] : []))]
  }
  return []
}
type KnowledgeRoleLevel = 'super_admin' | 'domain_admin' | 'member'
interface KnowledgeIdentity { roleLevel: KnowledgeRoleLevel; domainIds: string[] }
function knowledgeIdentity(value: unknown): KnowledgeIdentity {
  const data = unwrapKnowledgeData(value)
  const record = isKnowledgeRecord(data) ? data : {}
  const user = isKnowledgeRecord(record.user) ? record.user : record
  const rawRole = stringishField(user, ['roleLevel', 'role_level'])
  const roleLevel: KnowledgeRoleLevel = rawRole === 'super_admin' || rawRole === 'domain_admin' || rawRole === 'member' ? rawRole : 'member'
  return { roleLevel, domainIds: stringishList(user, ['domainIds', 'domain_ids']) }
}
function authorizedDomainIds(identity: KnowledgeIdentity, domains: Array<{ id: string }>): Set<string> {
  if (identity.roleLevel === 'super_admin') return new Set(domains.map((domain) => domain.id))
  return new Set(identity.domainIds)
}
function validKnowledgeProxyConfig(url: unknown, token: unknown): url is string {
  if (typeof url !== 'string' || typeof token !== 'string' || token.length < 32) return false
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '' && parsed.pathname === '/knowledge-proxy' } catch { return false }
}
function errorChain(value: unknown): string {
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const record = current as { message?: unknown; code?: unknown }
          const message = typeof record.message === 'string' ? record.message : undefined
          const code = typeof record.code === 'string' ? record.code : undefined
          if (message && code && !message.includes(code)) return `${message}: ${code}`
          if (message) return message
          if (code) return code
          try { return JSON.stringify(current) } catch { return Object.prototype.toString.call(current) }
        }
        return String(current)
      }
      const code = typeof (current as Error & { code?: unknown }).code === 'string' ? (current as Error & { code: string }).code : undefined
      let text = current.message || current.name
      if (code && !text.includes(code)) text = `${text}: ${code}`
      if (current.cause !== undefined) {
        const cause = render(current.cause)
        if (cause && cause !== text && !text.includes(cause)) text = `${text}: ${cause}`
      }
      return text
    } finally { path.delete(current) }
  }
  return render(value)
}
function knowledgeTransportCode(value: unknown): string | undefined {
  let current: unknown = value
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && typeof (current as { code?: unknown }).code === 'string') {
      const code = (current as { code: string }).code
      if (code.length > 0) return code
    }
    current = typeof current === 'object' && current !== null ? (current as { cause?: unknown }).cause : undefined
  }
  return undefined
}
function isRetryableKnowledgeTransport(error: unknown): boolean {
  const code = knowledgeTransportCode(error)
  if (code !== undefined && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code)) return true
  return /fetch failed|Failed to fetch|NetworkError|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|other side closed/i.test(errorChain(error))
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
function isKnowledgeStream(input: string): boolean {
  return /\/api\/rag\/(?:retrieval|repo-search)(?:\?|$)/.test(input)
}
function describeKnowledgeTransportError(error: unknown, process = ''): string {
  const detail = errorChain(error)
  const timeout = /UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|body timeout|headers timeout/i.test(detail)
  const transport = timeout || /fetch failed|Failed to fetch|NetworkError|socket hang up|ECONNRESET|other side closed/i.test(detail)
  const reason = timeout
    ? '远程检索流因传输层空闲超时中断（常见于仓库精搜超过约 5 分钟仍未结束）。'
    : transport
      ? '远程检索流在返回最终答案前因网络传输中断。'
      : '远程检索流在返回最终答案前中断。'
  const hint = process.trim() === '' ? '' : `\n已收到的远程检索过程：\n${process.trim().slice(-3_000)}`
  return `${reason}${detail}${hint}`
}
function proxyFailureText(status: number, text: string): boolean {
  return status === 502 && /Knowledge proxy failed|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|UND_ERR_/i.test(text)
}
async function knowledgeCookieHeader(): Promise<string> {
  if (typeof chrome === 'undefined' || chrome.cookies?.getAll === undefined) return ''
  const now = Date.now() / 1000
  const cookies = await chrome.cookies.getAll({ url: `${KNOWLEDGE_API_ORIGIN}/` })
  return cookies.filter((cookie) => cookie.expirationDate === undefined || cookie.expirationDate > now)
    .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
    .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}
async function fetchWithRetry(input: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= KNOWLEDGE_TRANSPORT_RETRY_LIMIT; attempt += 1) {
    try { return await fetch(input, init) } catch (error) {
      lastError = error
      if (init.signal?.aborted || !isRetryableKnowledgeTransport(error) || attempt === KNOWLEDGE_TRANSPORT_RETRY_LIMIT) {
        throw new Error(errorChain(error), { cause: error instanceof Error ? error : undefined })
      }
      await delay(KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorChain(lastError))
}
async function knowledgeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const stream = isKnowledgeStream(input)
  const chromeInit: RequestInit = { ...init, credentials: init.credentials ?? 'include' }
  // Long repo-search SSE stays quiet while upstream Explore agents run.
  // Chrome fetch has no undici 300s bodyTimeout; AccrUI uses this path.
  if (stream) {
    try { return await fetchWithRetry(input, chromeInit) } catch (error) {
      if (init.signal?.aborted || knowledgeProxyConfig === undefined) throw error
    }
  }
  const proxy = knowledgeProxyConfig
  if (proxy === undefined) return fetchWithRetry(input, chromeInit)
  const target = new URL(input)
  if (target.origin !== new URL(KNOWLEDGE_BASE_URL).origin || !target.pathname.startsWith('/api-sse-kd/api/')) throw new Error('knowledge_proxy_target_rejected')
  const headers = new Headers(init.headers); headers.delete('cookie'); headers.delete('authorization')
  const cookie = await knowledgeCookieHeader()
  const proxyInit: RequestInit = {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${target.pathname}${target.search}`, method: init.method ?? 'GET', headers: [...headers], ...(typeof init.body === 'string' ? { body: init.body } : {}), cookie }),
    signal: init.signal,
  }
  try {
    const response = await fetchWithRetry(proxy.url, proxyInit)
    if (response.ok) return response
    const preview = await response.clone().text()
    if (proxyFailureText(response.status, preview)) return fetchWithRetry(input, chromeInit)
    return response
  } catch (error) {
    if (init.signal?.aborted) throw error
    if (!isRetryableKnowledgeTransport(error) && !/Knowledge proxy failed|fetch failed|Failed to fetch/i.test(errorChain(error))) throw error
    return fetchWithRetry(input, chromeInit)
  }
}
async function knowledgeJson(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), KNOWLEDGE_CATALOG_TIMEOUT_MS)
  let response: Response
  try {
    response = await knowledgeFetch(`${KNOWLEDGE_BASE_URL}${path}`, { credentials: 'include', signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('knowledge_catalog_timeout')
    throw new Error(errorChain(error), { cause: error instanceof Error ? error : undefined })
  } finally {
    clearTimeout(timeout)
  }
  const text = await response.text()
  const payload = (() => { try { return JSON.parse(text) as unknown } catch { return undefined } })()
  const finalUrl = response.headers.get('x-knowledge-final-url') ?? response.url
  const finalHost = (() => { try { return new URL(finalUrl).hostname } catch { return '' } })()
  const contentType = response.headers.get('content-type') ?? ''
  const message = typeof payload === 'object' && payload !== null
    ? [field(payload, 'error'), field(payload, 'message'), field(payload, 'msg')].filter(Boolean).join(' ')
    : text.slice(0, 1_000)
  const loginHtml = /text\/html/i.test(contentType) && /<form|password|登录|signin/i.test(text.slice(0, 8_000))
  if (response.status === 401 || response.status === 403 || finalHost === 'signinuat.annto.com' || loginHtml || /未登录|请先登录|登录失效|unauthenticated|unauthorized/i.test(message)) {
    throw new Error('knowledge_login_required')
  }
  if (!response.ok) throw new Error(`knowledge_platform_http_${response.status}`)
  if (payload === undefined) throw new Error('knowledge_platform_invalid_json')
  return payload
}
async function assertKnowledgeAuthenticated(): Promise<unknown> { return knowledgeJson('/api/auth/me') }
function knowledgeServiceState(error: unknown): 'unauthenticated' | 'unavailable' {
  return error instanceof Error && error.message === 'knowledge_login_required' ? 'unauthenticated' : 'unavailable'
}
function controlledVocabulary(value: unknown): { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string; domainId?: string }> } | undefined {
  const data = unwrapKnowledgeData(value)
  const rawDomains = Array.isArray(data)
    ? data
    : payloadArray((data as { domains?: unknown; items?: unknown; vocabulary?: unknown } | undefined)?.domains ?? (data as { items?: unknown } | undefined)?.items ?? (data as { vocabulary?: unknown } | undefined)?.vocabulary)
  const domains: Array<{ id: string; name: string }> = []
  const systems: Array<{ id: string; name: string; domainId?: string }> = []
  const seenDomains = new Set<string>()
  const seenSystems = new Set<string>()
  for (const item of rawDomains) {
    const id = stringishField(item, ['id', 'value', 'code', 'domainId', 'domain_id'])
    if (id === undefined || seenDomains.has(id)) continue
    seenDomains.add(id)
    domains.push({ id, name: stringishField(item, ['name', 'label', 'title', 'domainName', 'domain_name']) ?? id })
    const children = payloadArray((item as { systems?: unknown; children?: unknown; items?: unknown }).systems ?? (item as { children?: unknown }).children ?? (item as { items?: unknown }).items)
    for (const child of children) {
      const systemId = stringishField(child, ['id', 'value', 'code', 'systemId', 'system_id'])
      if (systemId === undefined || seenSystems.has(`${id}\u0000${systemId}`)) continue
      seenSystems.add(`${id}\u0000${systemId}`)
      systems.push({ id: systemId, name: stringishField(child, ['name', 'label', 'title', 'systemName', 'system_name']) ?? systemId, domainId: id })
    }
  }
  const rawSystems = isKnowledgeRecord(data) && Array.isArray(data.systems) ? data.systems : []
  for (const item of rawSystems) {
    const systemId = stringishField(item, ['id', 'value', 'code', 'systemId', 'system_id'])
    const domainId = stringishField(item, ['domain', 'domainId', 'domain_id'])
    if (systemId === undefined || domainId === undefined || !seenDomains.has(domainId) || seenSystems.has(`${domainId}\u0000${systemId}`)) continue
    seenSystems.add(`${domainId}\u0000${systemId}`)
    systems.push({ id: systemId, name: stringishField(item, ['name', 'label', 'title', 'systemName', 'system_name']) ?? systemId, domainId })
  }
  return domains.length > 0 ? { domains, systems } : undefined
}
function filterCatalogByIdentity<T extends { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string; domainId?: string }>; repositories: Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }> }>(catalog: T, identity: KnowledgeIdentity): T {
  const allowed = authorizedDomainIds(identity, catalog.domains)
  const domains = catalog.domains.filter((domain) => allowed.has(domain.id))
  const systems = catalog.systems.filter((system) => system.domainId !== undefined && allowed.has(system.domainId))
  const repositories = catalog.repositories.filter((repository) => repository.domainId !== undefined && allowed.has(repository.domainId))
  return { ...catalog, domains, systems, repositories }
}
function pruneScope(scope: KnowledgeScope, catalog: { domains: Array<{ id: string }>; systems: Array<{ id: string; domainId?: string }>; repositories: Array<{ id: string }> }): KnowledgeScope {
  const allowedDomains = new Set(catalog.domains.map((domain) => domain.id))
  const domainId = allowedDomains.has(scope.domainId) ? scope.domainId : ''
  const allowedSystems = new Set(catalog.systems.filter((system) => system.domainId === domainId).map((system) => system.id))
  const allowedRepositories = new Set(catalog.repositories.map((repository) => repository.id))
  return {
    domainId,
    systemIds: domainId === '' ? [] : scope.systemIds.filter((id) => allowedSystems.has(id)),
    repositoryIds: scope.repositoryIds.filter((id) => allowedRepositories.has(id)),
  }
}
let knowledgeCatalogCache: { at: number; value: { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string; domainId?: string }>; repositories: Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }> } } | undefined
async function loadKnowledgeCatalog(_domainId?: string): Promise<{ domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string; domainId?: string }>; repositories: Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }> }> {
  if (knowledgeCatalogCache !== undefined && Date.now() - knowledgeCatalogCache.at < KNOWLEDGE_CATALOG_CACHE_TTL_MS) return knowledgeCatalogCache.value
  const identityPayload = await assertKnowledgeAuthenticated()
  const identity = knowledgeIdentity(identityPayload)
  const [vocabularyResult, reposResult] = await Promise.allSettled([
    knowledgeJson('/api/tags/controlled-vocabulary'),
    knowledgeJson('/api/repos'),
  ])
  for (const result of [vocabularyResult, reposResult]) {
    if (result.status === 'rejected' && knowledgeServiceState(result.reason) === 'unauthenticated') throw result.reason
  }
  const vocabulary = vocabularyResult.status === 'fulfilled' ? controlledVocabulary(vocabularyResult.value) : undefined
  let rawDomains: unknown
  let domainsError: unknown
  if (vocabulary === undefined) {
    try { rawDomains = await knowledgeJson('/api/domains') } catch (error) {
      if (knowledgeServiceState(error) === 'unauthenticated') throw error
      domainsError = error
    }
  }
  if (vocabulary === undefined && rawDomains === undefined && reposResult.status === 'rejected') throw domainsError ?? reposResult.reason
  const domains = vocabulary?.domains ?? payloadArray(rawDomains).flatMap((item): Array<{ id: string; name: string }> => {
    const id = stringishField(item, ['id', 'value', 'code', 'domainId', 'domain_id'])
    if (id === undefined) return []
    return [{ id, name: stringishField(item, ['name', 'label', 'title', 'domainName', 'domain_name']) ?? id }]
  })
  const repositoriesFrom = (value: unknown) => payloadArray(value).flatMap((item): Array<{ id: string; name: string; domainId?: string; systemId?: string; type?: string }> => {
    const id = stringishField(item, ['id', 'key', 'repoKey', 'repo_key'])
    if (id === undefined) return []
    const itemDomainId = stringishField(item, ['domain', 'domainId', 'domain_id'])
    const systemId = stringishField(item, ['system_key', 'systemKey', 'systemId', 'system_id'])
    const type = stringishField(item, ['repo_type', 'repoType', 'type'])
    return [{ id, name: stringishField(item, ['name', 'repoName', 'repo_name']) ?? id, ...(itemDomainId === undefined ? {} : { domainId: itemDomainId }), ...(systemId === undefined ? {} : { systemId }), ...(type === undefined ? {} : { type }) }]
  })
  const repositories = reposResult.status === 'fulfilled' ? repositoriesFrom(reposResult.value) : []
  const rawSystems = vocabulary === undefined || (vocabulary.systems.length === 0 && vocabulary.domains.length > 0)
    ? await knowledgeJson('/api/domains/systems').catch(() => undefined)
    : undefined
  const systems = (vocabulary?.systems.length ? vocabulary.systems : payloadArray(rawSystems).flatMap((item): Array<{ id: string; name: string; domainId?: string }> => {
    const id = stringishField(item, ['id', 'value', 'code', 'systemId', 'system_id'])
    if (id === undefined) return []
    const itemDomain = stringishField(item, ['domain', 'domainId', 'domain_id'])
    return [{ id, name: stringishField(item, ['name', 'label', 'title', 'systemName', 'system_name']) ?? id, ...(itemDomain === undefined ? {} : { domainId: itemDomain }) }]
  }))
  const value = filterCatalogByIdentity({ domains, systems, repositories }, identity)
  knowledgeCatalogCache = { at: Date.now(), value }
  return value
}
function sseEvents(buffer: string, chunk: string): { events: string[]; remainder: string } { const parts = `${buffer}${chunk}`.replace(/\r\n/g, '\n').split('\n\n'); const remainder = parts.pop() ?? ''; return { events: parts.map((part) => part.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean), remainder } }
const PROCESS_TEXT_LIMIT = 32_000
const PROCESS_LINE_LIMIT = 400
function mergeStreamText(current: string, incoming: string): string {
  if (incoming.startsWith(current)) return incoming.slice(0, 16_000)
  if (current.endsWith(incoming)) return current
  const limit = Math.min(current.length, incoming.length)
  let overlap = limit
  while (overlap > 0 && current.slice(-overlap) !== incoming.slice(0, overlap)) overlap -= 1
  return `${current}${incoming.slice(overlap)}`.slice(0, 16_000)
}
function isProcessEvent(payload: Record<string, unknown>): boolean {
  return payload.type === 'reasoning' || payload.type === 'thinking' || payload.type === 'thought' || payload.type === 'agent_thought'
    || payload.type === 'tool' || payload.type === 'tool_call' || payload.type === 'search' || payload.type === 'status' || payload.type === 'progress'
    || payload.type === 'log' || payload.type === 'step'
}
function isAnswerDelta(payload: Record<string, unknown>): boolean {
  return !isProcessEvent(payload) && payload.type !== 'done' && payload.type !== 'citations' && payload.type !== 'error'
}
function compactProcessText(value: string): string {
  const normalized = value.slice(0, PROCESS_LINE_LIMIT * 4).replace(/\s+/g, ' ').replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^"'()\s,:]+[\\/]){3,}[^"'()\s,:]+/g, (path) => {
    const parts = path.split(/[\\/]/).filter(Boolean)
    return `…/${parts.slice(-4).join('/')}`
  }).trim()
  return normalized.length <= PROCESS_LINE_LIMIT ? normalized : `${normalized.slice(0, PROCESS_LINE_LIMIT - 1)}…`
}
function processEventText(payload: Record<string, unknown>): string | undefined {
  if (payload.type === 'reasoning' || payload.type === 'thinking' || payload.type === 'thought' || payload.type === 'agent_thought') {
    return '远程检索正在分析问题…'
  }
  if (payload.type === 'step') {
    const step = typeof payload.step === 'string' ? payload.step : 'retrieval'
    const status = typeof payload.status === 'string' ? payload.status : 'running'
    return `步骤：${step}（${status}）`
  }
  const source = typeof payload.source === 'string' ? payload.source.trim() : ''
  for (const candidate of [payload.message, payload.delta, payload.content, payload.text, payload.status, payload.detail]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const text = compactProcessText(candidate)
      return source === '' ? text : `${compactProcessText(source).slice(0, 80)} · ${text}`
    }
  }
  return undefined
}
function appendProcess(current: string, incoming: string): string {
  const line = incoming.trim()
  if (line === '') return current
  if (current === '') return line.slice(0, PROCESS_TEXT_LIMIT)
  const newline = current.lastIndexOf('\n')
  const last = newline === -1 ? current : current.slice(newline + 1)
  if (line === last) return current
  if (line.startsWith(last) || last.startsWith(line)) {
    const next = line.length >= last.length ? line : last
    return `${newline === -1 ? '' : current.slice(0, newline + 1)}${next}`.slice(0, PROCESS_TEXT_LIMIT)
  }
  return `${current}\n${line}`.slice(0, PROCESS_TEXT_LIMIT)
}
function retrievalQuestion(kind: KnowledgeKind, question: string, resumed = false): string {
  const instruction = resumed
    ? '这是同一远程检索会话的追问。请在已有上下文上继续回答，不要无必要地从头扫描仓库或知识库。'
    : kind === 'code'
      ? '请直接返回从所选远程代码仓库检索到的事实、文件路径和代码依据。'
      : '请直接返回从所选知识范围检索到的事实和引用依据。'
  const language = /[\u3400-\u9fff]/u.test(question)
    ? '所有面向用户的流式内容和最终答案都必须使用简体中文；工具名、代码标识符和文件路径可保留原文。即使转述后的问题包含英文，也不要用英文叙述。'
    : 'Use the same language as the user question for all user-visible streaming content and the final answer.'
  return `${instruction}${language}若用户要原文摘录，一次只返回一个文件或一个函数的核心片段；不要并行检索多个文件，也不要把多个大文件全文塞进同一次答案。最终答案只保留事实和引用，不要把思考过程写进最终答案。检索计划、当前正在查的仓库或知识、工具选择和进度可通过独立过程事件流式返回。用户问题：${question}`
}
async function executeKnowledgeQuery(kind: KnowledgeKind, question: string, scope: KnowledgeScope, priorSessionId: string | undefined, signal: AbortSignal, onProgress?: (progress: { chars: number; content: string; eventType?: string; process?: string }) => void): Promise<{ result: { status: 'complete' | 'partial' | 'truncated'; answer: string; sources: Array<{ id: string; title: string }> }; sessionId?: string }> {
  if (kind === 'knowledge' && scope.domainId === '') {
    throw new Error('当前会话没有选择知识范围。请在输入框上方点「选择知识范围」，先选一个领域再勾选知识库，然后重试。不要用已选代码库代替知识库检索。')
  }
  if (kind === 'code' && scope.repositoryIds.length === 0) {
    throw new Error('当前会话没有选择远程代码库。请在输入框上方点「选择代码库」并勾选仓库，然后重试。不要用本地工作区代替远程代码检索。')
  }
  const directedQuestion = retrievalQuestion(kind, question, priorSessionId !== undefined)
  const body = kind === 'knowledge' ? { question: directedQuestion, domain_system_config: { [scope.domainId]: { self: false, systems: scope.systemIds } }, forceRetrieval: true, include_third_party: false, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) } : { question: directedQuestion, repo_keys: scope.repositoryIds, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) }
  const emit = (eventType?: string, content = '', process = '') => onProgress?.({ chars: content.length, content, ...(eventType === undefined ? {} : { eventType }), ...(process === '' ? {} : { process }) })
  const response = await knowledgeFetch(`${KNOWLEDGE_BASE_URL}/api/rag/${kind === 'knowledge' ? 'retrieval' : 'repo-search'}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal })
  if (!response.ok || response.body === null) throw new Error(`knowledge_platform_http_${response.status}`)
  emit('connected')
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let answer = ''; let visualContent = ''; let process = ''; let sources: Array<{ id: string; title: string }> = []; let sessionId: string | undefined; let done = false; let marker = false; let stop = false
  const consume = (chunk: string): void => {
    const parsed = sseEvents(buffer, chunk)
    buffer = parsed.remainder
    for (const event of parsed.events) {
      if (event === '[DONE]') { marker = true; continue }
      let payload: Record<string, unknown>
      try { payload = JSON.parse(event) as Record<string, unknown> } catch { continue }
      if (payload.type === 'error') {
        if (answer.length > 0) { stop = true; break }
        throw new Error(typeof payload.error === 'string' ? payload.error : 'knowledge_platform_error')
      }
      if (payload.type === 'text_delta') continue
      if (isProcessEvent(payload)) {
        const incoming = processEventText(payload)
        if (incoming !== undefined) process = appendProcess(process, incoming)
        emit(typeof payload.type === 'string' ? payload.type : 'progress', visualContent, process)
      } else if (typeof payload.delta === 'string' && isAnswerDelta(payload)) {
        answer = mergeStreamText(answer, payload.delta)
        visualContent = answer
        emit(typeof payload.type === 'string' ? payload.type : undefined, visualContent, process)
      }
      if (payload.type === 'citations' || payload.type === 'done') {
        sources = (Array.isArray(payload.citations) ? payload.citations : []).flatMap((item): Array<{ id: string; title: string }> => {
          const id = field(item, 'page_id') ?? field(item, 'id')
          const title = field(item, 'page_title') ?? field(item, 'title') ?? id
          return id === undefined ? [] : [{ id, title: title ?? id }]
        }).slice(0, 20)
      }
      if (payload.type === 'done') {
        done = true
        sessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId
      }
    }
  }
  try {
    while (!stop) {
      const read = await reader.read()
      if (read.done) break
      consume(decoder.decode(read.value, { stream: true }))
    }
    consume(decoder.decode())
  } catch (error) {
    try { consume(decoder.decode()) } catch { /* keep the original transport error */ }
    if (answer.length === 0) throw new Error(describeKnowledgeTransportError(error, process), { cause: error instanceof Error ? error : undefined })
  } finally { reader.releaseLock() }
  if (answer.length === 0 && !done && !marker) throw new Error('knowledge_platform_incomplete_sse')
  const complete = (done || marker) && answer.length < 16_000
  return { result: { status: answer.length >= 16_000 ? 'truncated' : complete ? 'complete' : 'partial', answer, sources }, ...(sessionId === undefined ? {} : { sessionId }) }
}
function selectedScopeNames(ids: string[], entries: Array<{ id: string; name: string }>, fallbackToId = false): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry.name]))
  return ids.flatMap((id) => {
    const name = byId.get(id)
    if (typeof name === 'string' && name.trim().length > 0) return [name]
    return fallbackToId && id.trim().length > 0 ? [id] : []
  }).slice(0, 50)
}
function selectedSourceScopeEcho(record: { scope: KnowledgeScope; enabled: boolean }, catalog: { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string }>; repositories: Array<{ id: string; name: string }> }): { enabled: boolean; codeSelected: boolean; knowledgeSelected: boolean; repositories: string[]; knowledge: string[] } {
  const repositories = selectedScopeNames(record.scope.repositoryIds, catalog.repositories, true)
  const systems = selectedScopeNames(record.scope.systemIds, catalog.systems, true)
  const domainName = catalog.domains.find((domain) => domain.id === record.scope.domainId)?.name
    ?? (record.scope.domainId.trim().length > 0 ? record.scope.domainId : undefined)
  const knowledge = systems.length > 0 ? systems : domainName === undefined ? [] : [domainName]
  return { enabled: record.enabled, codeSelected: repositories.length > 0, knowledgeSelected: knowledge.length > 0, repositories, knowledge }
}

const NATIVE_HOST_NAME = 'com.deepseek.harness.chrome'
const START_TIMEOUT_MS = 30_000
const MAX_STORED_PROTOTYPE_REFERENCES = 3
const PROTOTYPE_STUDIO_OPEN_PATH = '/api/prototype-studio/open'
const PROTOTYPE_STUDIO_SNAPSHOT_PATH = '/api/prototype-studio/snapshot'
const PROTOTYPE_STUDIO_RESTORE_PATH = '/api/prototype-studio/restore'
const TRANSFER_TIMEOUT_MS = 15_000
const TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY = 'teamKnowledgeCreateCheckpointsV1'

interface NativeMessage {
  type?: unknown
  payload?: unknown
  error?: unknown
  requestId?: unknown
  runId?: unknown
  generation?: unknown
  browserTarget?: unknown
  browserTargets?: unknown
  unavailableBrowserTargets?: unknown
  tool?: unknown
  tab?: unknown
  url?: unknown
  range?: unknown
  values?: unknown
  resource?: unknown
  action?: unknown
  operation?: unknown
  offset?: unknown
  limit?: unknown
  query?: unknown
  phase?: unknown
  parent?: unknown
  idempotencyIdentity?: unknown
  name?: unknown
  body?: unknown
  recovery?: unknown
  harnessSessionId?: unknown
  harnessParentSessionId?: unknown
  question?: unknown
}

interface NativeStartPayload {
  url?: unknown
  runId?: unknown
  knowledgeProxyUrl?: unknown
  knowledgeProxyToken?: unknown
  runtimeIdentity?: unknown
}

interface NativeTransferPayload {
  runId?: unknown
  browserTarget?: unknown
  browserTargets?: unknown
  unavailableBrowserTargets?: unknown
}

let nativePort: chrome.runtime.Port | undefined
let nativeUrl: string | undefined
let nativeRuntimeIdentity: RuntimeIdentitySummary | undefined
let startPromise: Promise<string> | undefined
const boundBrowserTargets = new Map<string, BrowserTargetBinding>()
const pendingTargetTransfers = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()

function runtimeIdentitySummary(value: unknown): RuntimeIdentitySummary | undefined {
  return validRuntimeIdentitySummary(value) ? value : undefined
}

async function publishHarnessReady(url: string): Promise<void> {
  let extensionIdentity: RuntimeIdentitySummary | undefined
  try {
    const response = await fetch(chrome.runtime.getURL('/harness/runtime-manifest.json'), { cache: 'no-store' })
    if (response.ok) extensionIdentity = runtimeIdentitySummary(await response.json())
  } catch { /* an unpacked development shell may not have synced Harness assets yet */ }
  const nativeIdentity = nativeRuntimeIdentity
  const mismatch = nativeIdentity !== undefined && extensionIdentity !== undefined
    && !sameRuntimeReleaseIdentity(nativeIdentity, extensionIdentity)
  if (mismatch && nativeIdentity !== undefined && extensionIdentity !== undefined) {
    await chrome.runtime.sendMessage({
      type: 'harness-runtime-mismatch',
      error: `Loaded Native Host product/plugins ${nativeIdentity.productHash.slice(0, 8)}/${nativeIdentity.pluginHash?.slice(0, 8) ?? 'missing'} do not match extension product/plugins ${extensionIdentity.productHash.slice(0, 8)}/${extensionIdentity.pluginHash?.slice(0, 8) ?? 'missing'}. Run pnpm dev:refresh -- --fast, then reopen the side panel.`,
      nativeRuntimeIdentity: nativeIdentity,
      extensionRuntimeIdentity: extensionIdentity,
    }).catch(() => {})
    return
  }
  await chrome.runtime.sendMessage({
    type: 'harness-ready', url, nativeRuntimeIdentity: nativeIdentity, extensionRuntimeIdentity: extensionIdentity,
    identityStatus: nativeIdentity !== undefined && extensionIdentity !== undefined ? 'verified' : 'unavailable',
  }).catch(() => {})
}
let nativeLifecycle: Promise<void> = Promise.resolve()
const prototypeStudioAuthorizations = new Map<string, PrototypeStudioAuthorization>()
let prototypeStudioAuthorizationMutation: Promise<void> = Promise.resolve()

function asError(value: unknown): string {
  return errorChain(value)
}

/** Read-only Chrome tab metadata shown by the embedded Harness composer. */
interface ActiveTabSnapshot {
  windowId: number
  tabId: number
  title: string
  url: string
  favIconUrl?: string
}

const activeTabEpoch = crypto.randomUUID()
let activeTabSequence = 0
let activeTabSnapshot: ActiveTabSnapshot | undefined
let activeTabRefreshGeneration = 0

interface TeamDocParent {
  parentId: string
  bookId: string
  parentName: string
  canRead: true
  canCreate: true
  fingerprint: string
  parentType?: string
}

type TeamKnowledgeItemKind = 'light_document'
type TeamKnowledgeItemAction = 'inspect_parent' | 'create' | 'readback'

interface TeamKnowledgeUserConfirmation {
  itemIndex: number
  totalItems: number
}

interface TeamKnowledgeParent extends TeamDocParent { parentType: string }

interface TeamKnowledgeItemRequest extends ConnectorCorrelation {
  type: typeof CONNECTOR_REQUEST
  browserTarget: BrowserTarget
  tool: 'team_knowledge_batch'
  action: TeamKnowledgeItemAction
  parent?: TeamKnowledgeParent
  kind?: TeamKnowledgeItemKind
  name?: string
  body?: string
  catalogId?: string
  idempotencyIdentity?: string
  recovery?: { catalogId: string | null; stages: string[] }
  userConfirmation?: TeamKnowledgeUserConfirmation
}

type TeamDocStage = 'parent_inspected' | 'created' | 'rediscovered' | 'body_written' | 'readback_verified'

interface TeamDocPartialDelivery {
  status: 'partial_delivery'
  documentId: string | null
  stages: TeamDocStage[]
  readbackMatches: false
  failedAt: 'inspect' | 'create' | 'rediscover' | 'write' | 'readback'
  error: string
  diagnostic?: {
    stage?: string
    httpStatus: number
    errorCode: string | null
    attempts?: Array<{ stage: string; httpStatus: number; errorCode: string | null }>
  }
  observedBody?: string
}

const resourceWriteQueues = new Map<string, Promise<void>>()

interface KnowledgeQueryRequest extends ConnectorCorrelation {
  type: typeof CONNECTOR_REQUEST
  tool: 'knowledge_search' | 'code_search'
  harnessSessionId: string
  harnessParentSessionId?: string
  question: string
}

interface SelectedSourceScopeRequest extends ConnectorCorrelation {
  type: typeof CONNECTOR_REQUEST
  tool: 'selected_source_scope'
  harnessSessionId: string
  harnessParentSessionId?: string
}

interface KnowledgeScopeRecord { scope: KnowledgeScope; enabled: boolean; notice?: string }
interface KnowledgeEnabledPreference { remember: boolean; enabled: boolean }
interface KnowledgeSessionRecord { sessionId: string; fingerprint: string }
interface SearchProgressSnapshot { type: 'search-progress/v1'; requestId: string; harnessSessionId: string; harnessParentSessionId?: string; tool: 'knowledge_search' | 'code_search'; question: string; phase: 'querying' | 'streaming' | 'done' | 'error'; chars: number; content: string; eventType?: string; process?: string }
const activeKnowledgeQueries = new Map<string, AbortController>()
const searchProgressSnapshots = new Map<string, SearchProgressSnapshot>()

function isTeamDocParent(value: unknown): value is TeamDocParent {
  if (!value || typeof value !== 'object') return false
  const parent = value as Partial<TeamDocParent>
  return typeof parent.parentId === 'string' && /^\d+$/.test(parent.parentId)
    && typeof parent.bookId === 'string' && /^\d+$/.test(parent.bookId)
    && typeof parent.parentName === 'string' && parent.parentName.length > 0
    && parent.canRead === true && parent.canCreate === true
    && typeof parent.fingerprint === 'string' && parent.fingerprint.length > 0
}

function isTeamKnowledgeParent(value: unknown): value is TeamKnowledgeParent {
  return isTeamDocParent(value) && typeof (value as TeamKnowledgeParent).parentType === 'string' && (value as TeamKnowledgeParent).parentType.length > 0
}

function isTeamKnowledgeItemRequest(message: NativeMessage): message is TeamKnowledgeItemRequest {
  const candidate = message as NativeMessage & Partial<TeamKnowledgeItemRequest>
  if (!(message.type === CONNECTOR_REQUEST && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && message.tool === 'team_knowledge_batch' && isBrowserTarget(message.browserTarget)
    && ['inspect_parent', 'create', 'readback'].includes(String(candidate.action)))) return false
  if (candidate.action === 'inspect_parent') return candidate.parent === undefined && candidate.kind === undefined && candidate.name === undefined && candidate.body === undefined && candidate.catalogId === undefined && candidate.userConfirmation === undefined
  if (candidate.action === 'readback') return candidate.kind === 'light_document' && typeof candidate.catalogId === 'string' && /^\d+$/.test(candidate.catalogId) && candidate.userConfirmation === undefined
  const recovery = candidate.recovery
  return isTeamKnowledgeParent(candidate.parent) && candidate.kind === 'light_document'
    && typeof candidate.name === 'string' && candidate.name.trim().length > 0 && candidate.name.length <= 120
    && typeof candidate.body === 'string' && candidate.body.trim().length > 0 && candidate.body.length <= 100_000
    && typeof candidate.idempotencyIdentity === 'string' && candidate.idempotencyIdentity.length > 0 && candidate.idempotencyIdentity.length <= 128
    && (recovery === undefined || (typeof recovery === 'object' && recovery !== null && ((recovery.catalogId === null) || (typeof recovery.catalogId === 'string' && /^\d+$/.test(recovery.catalogId))) && Array.isArray(recovery.stages)))
    && (candidate.userConfirmation === undefined || (typeof candidate.userConfirmation === 'object' && candidate.userConfirmation !== null
      && Number.isSafeInteger(candidate.userConfirmation.itemIndex) && candidate.userConfirmation.itemIndex >= 1
      && Number.isSafeInteger(candidate.userConfirmation.totalItems) && candidate.userConfirmation.totalItems >= candidate.userConfirmation.itemIndex))
}

function isKnowledgeQueryRequest(message: NativeMessage): message is KnowledgeQueryRequest {
  return message.type === CONNECTOR_REQUEST && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && (message.tool === 'knowledge_search' || message.tool === 'code_search')
    && validSessionIdentity(message.harnessSessionId) && (message.harnessParentSessionId === undefined || validSessionIdentity(message.harnessParentSessionId))
    && typeof message.question === 'string' && message.question.trim().length > 0 && message.question.length <= 4000
}

function isSelectedSourceScopeRequest(message: NativeMessage): message is SelectedSourceScopeRequest {
  return message.type === CONNECTOR_REQUEST && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && message.tool === 'selected_source_scope'
    && validSessionIdentity(message.harnessSessionId) && (message.harnessParentSessionId === undefined || validSessionIdentity(message.harnessParentSessionId))
}

function isKnowledgeCancel(message: NativeMessage): message is NativeMessage & { type: typeof CONNECTOR_CANCEL; requestId: string; runId: string; generation: string } {
  return message.type === CONNECTOR_CANCEL && typeof message.requestId === 'string' && typeof message.runId === 'string' && typeof message.generation === 'string'
}

function isInternalHarnessPage(url: string): boolean {
  try {
    return new URL(url).origin === new URL(chrome.runtime.getURL('/')).origin
  } catch {
    return false
  }
}

function targetFromActionTab(tab: chrome.tabs.Tab): BrowserTarget | undefined {
  if (tab.id === undefined || tab.windowId === undefined || typeof tab.url !== 'string' || tab.url.length === 0) return undefined
  if (isInternalHarnessPage(tab.url)) return undefined
  return { browser: 'chrome', windowId: tab.windowId, tabId: tab.id, url: tab.url }
}

function snapshotFromActiveTab(tab: chrome.tabs.Tab): ActiveTabSnapshot | undefined {
  const target = targetFromActionTab(tab)
  if (target === undefined) return undefined
  return {
    windowId: target.windowId,
    tabId: target.tabId,
    title: tab.title ?? '',
    url: target.url,
    ...(typeof tab.favIconUrl === 'string' && tab.favIconUrl.length > 0 ? { favIconUrl: tab.favIconUrl } : {}),
  }
}

function sameActiveTab(left: ActiveTabSnapshot | undefined, right: ActiveTabSnapshot): boolean {
  return left?.windowId === right.windowId
    && left.tabId === right.tabId
    && left.title === right.title
    && left.url === right.url
    && left.favIconUrl === right.favIconUrl
}

function setActiveTabSnapshot(tab: chrome.tabs.Tab, broadcast: boolean): ActiveTabSnapshot | undefined {
  const snapshot = snapshotFromActiveTab(tab)
  if (snapshot === undefined) return undefined
  if (sameActiveTab(activeTabSnapshot, snapshot)) return activeTabSnapshot
  activeTabSequence += 1
  activeTabSnapshot = snapshot
  if (broadcast) {
    void chrome.runtime.sendMessage({
      type: 'active-tab-changed/v1',
      epoch: activeTabEpoch,
      sequence: activeTabSequence,
      tab: snapshot,
    }).catch(() => {})
  }
  return snapshot
}

async function refreshCurrentActiveTab(broadcast = true): Promise<ActiveTabSnapshot | undefined> {
  const generation = ++activeTabRefreshGeneration
  const window = await chrome.windows.getLastFocused()
  if (window.id === undefined || window.id < 0) return undefined
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
  if (generation !== activeTabRefreshGeneration || tab === undefined) return undefined
  return setActiveTabSnapshot(tab, broadcast)
}

function isNativeTransferPayload(value: unknown): value is { runId: string; browserTarget: BrowserTarget; browserTargets?: BrowserTarget[]; unavailableBrowserTargets?: UnavailableBrowserTarget[] } {
  const payload = value as NativeTransferPayload
  return typeof value === 'object' && value !== null
    && typeof payload.runId === 'string'
    && isBrowserTarget(payload.browserTarget)
    && (payload.browserTargets === undefined || (Array.isArray(payload.browserTargets)
      && payload.browserTargets.every(isBrowserTarget)))
    && (payload.unavailableBrowserTargets === undefined || (Array.isArray(payload.unavailableBrowserTargets)
      && payload.unavailableBrowserTargets.every(isUnavailableBrowserTarget)))
}

function targetStorage(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session ?? chrome.storage?.local
}

function knowledgeSessionStorage(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.local ?? chrome.storage?.session
}

async function knowledgeScopes(): Promise<Record<string, KnowledgeScopeRecord>> {
  const values = await targetStorage()?.get(KNOWLEDGE_SCOPE_STORAGE_KEY)
  const candidate = values?.[KNOWLEDGE_SCOPE_STORAGE_KEY]
  const scopes = !candidate || typeof candidate !== 'object' || Array.isArray(candidate) ? {} : Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([sessionId, value]) =>
    validSessionIdentity(sessionId) && typeof value === 'object' && value !== null && validScope((value as KnowledgeScopeRecord).scope)
      ? [[sessionId, { scope: normalizeScope((value as KnowledgeScopeRecord).scope), enabled: typeof (value as KnowledgeScopeRecord).enabled === 'boolean' ? (value as KnowledgeScopeRecord).enabled : true, ...(typeof (value as KnowledgeScopeRecord).notice === 'string' ? { notice: (value as KnowledgeScopeRecord).notice } : {}) }]] : [],
  ))
  const legacyValues = await chrome.storage.local.get(null)
  let changed = false
  for (const [key, value] of Object.entries(legacyValues)) {
    const prefix = legacyKnowledgeScopeKey('')
    if (!key.startsWith(prefix)) continue
    const sessionId = key.slice(prefix.length)
    if (!validSessionIdentity(sessionId) || scopes[sessionId] !== undefined) continue
    const migrated = migrateLegacyKnowledgeScope(value)
    if (migrated === undefined) continue
    scopes[sessionId] = { scope: normalizeScope(migrated.scope), enabled: migrated.enabled, ...(migrated.notice === undefined ? {} : { notice: migrated.notice }) }
    changed = true
  }
  if (changed) await targetStorage()?.set({ [KNOWLEDGE_SCOPE_STORAGE_KEY]: scopes })
  return scopes
}

async function knowledgeEnabledPreference(): Promise<KnowledgeEnabledPreference> {
  const values = await chrome.storage.local.get([KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY, 'knowledge-query:enabled-preference'])
  const value = values?.[KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY] as Partial<KnowledgeEnabledPreference> | undefined
  if (typeof value?.remember === 'boolean' && typeof value.enabled === 'boolean') return { remember: value.remember, enabled: value.enabled }
  const legacy = values?.['knowledge-query:enabled-preference'] as Partial<KnowledgeEnabledPreference> | undefined
  if (typeof legacy?.remember !== 'boolean' || typeof legacy.enabled !== 'boolean') return { remember: false, enabled: true }
  const migrated = { remember: legacy.remember, enabled: legacy.enabled }
  await chrome.storage.local.set({ [KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY]: migrated })
  return migrated
}

async function saveKnowledgeScope(sessionId: string, scope: KnowledgeScope, enabled?: boolean, remember?: boolean): Promise<KnowledgeScopeRecord> {
  const scopes = await knowledgeScopes()
  const previous = scopes[sessionId]
  const preference = await knowledgeEnabledPreference()
  const nextEnabled = enabled ?? previous?.enabled ?? (preference.remember ? preference.enabled : true)
  scopes[sessionId] = { scope: normalizeScope(scope), enabled: nextEnabled }
  await targetStorage()?.set({ [KNOWLEDGE_SCOPE_STORAGE_KEY]: scopes })
  if (remember !== undefined) await chrome.storage.local.set({ [KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY]: { remember, enabled: nextEnabled } })
  else if (preference.remember && enabled !== undefined) await chrome.storage.local.set({ [KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY]: { remember: true, enabled: nextEnabled } })
  return scopes[sessionId]
}

async function knowledgeSessions(): Promise<Record<string, KnowledgeSessionRecord>> {
  const values = await knowledgeSessionStorage()?.get(KNOWLEDGE_SESSION_STORAGE_KEY)
  const candidate = values?.[KNOWLEDGE_SESSION_STORAGE_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([key, value]) => {
    const record = value as Partial<KnowledgeSessionRecord>
    return typeof record?.sessionId === 'string' && typeof record?.fingerprint === 'string' ? [[key, { sessionId: record.sessionId, fingerprint: record.fingerprint }]] : []
  }))
}

async function accountLocallySignedOut(): Promise<boolean> {
  const value = (await chrome.storage.local.get(ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY))?.[ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY]
  return value === true
}

async function setAccountLocallySignedOut(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY]: value })
}

function companyGatewayQuota(value: unknown): CompanyGatewayQuota | undefined {
  if (!isKnowledgeRecord(value)) return undefined
  const usagePercent = value.usagePercent
  const nextResetTime = value.nextResetTime
  const resetCycle = value.resetCycle
  if ((usagePercent !== null && (typeof usagePercent !== 'number' || !Number.isFinite(usagePercent) || usagePercent < 0 || usagePercent > 100))
    || (nextResetTime !== null && typeof nextResetTime !== 'string')
    || (resetCycle !== 'daily' && resetCycle !== 'weekly' && resetCycle !== 'monthly' && resetCycle !== 'unlimited')) return undefined
  return { usagePercent, nextResetTime, resetCycle }
}

function companyGatewayModels(value: unknown): CompanyGatewayModel[] | undefined {
  if (!isKnowledgeRecord(value) || !Array.isArray(value.data)) return undefined
  const models = value.data.slice(0, 200).flatMap((item): CompanyGatewayModel[] => {
    if (!isKnowledgeRecord(item) || typeof item.id !== 'string') return []
    const id = item.id.trim()
    if (id.length === 0 || id.length > 160) return []
    const description = typeof item.description === 'string' && item.description.trim().length > 0
      ? item.description.trim().slice(0, 500)
      : typeof item.owned_by === 'string' && item.owned_by.trim().length > 0
        ? item.owned_by.trim().slice(0, 500)
        : undefined
    return [{ id, name: id, ...(description === undefined ? {} : { description }) }]
  })
  return [...new Map(models.map((model) => [model.id, model])).values()]
}

function validCompanyGatewayMetadata(value: unknown): value is CompanyGatewayMetadata {
  if (!isKnowledgeRecord(value) || !Array.isArray(value.models) || typeof value.checkedAt !== 'string') return false
  const capability = value.capability
  return companyGatewayQuota(value.quota) !== undefined && value.models.every((model) => isKnowledgeRecord(model)
    && typeof model.id === 'string' && typeof model.name === 'string'
    && (model.description === undefined || typeof model.description === 'string'))
    && isKnowledgeRecord(capability) && (capability.protocol === 'anthropic-messages' || capability.protocol === 'openai-completions')
    && typeof capability.modelId === 'string' && capability.tools === true
}

async function companyGatewayMetadata(): Promise<CompanyGatewayMetadata | undefined> {
  const value = (await chrome.storage.local.get(COMPANY_GATEWAY_METADATA_STORAGE_KEY))?.[COMPANY_GATEWAY_METADATA_STORAGE_KEY]
  return validCompanyGatewayMetadata(value) ? value : undefined
}

function usableCompanyGatewayKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[\x21-\x7E]+$/.test(value)
}

async function companyGatewayJson(path: '/models' | '/key/quota', apiKey: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMPANY_GATEWAY_TIMEOUT_MS)
  try {
    const response = await fetch(`${COMPANY_GATEWAY_BASE_URL}${path}`, {
      headers: path === '/models' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`公司网关${path === '/models' ? '模型列表' : '用量'}请求失败 (${String(response.status)})`)
    return await response.json()
  } catch (error) {
    if (controller.signal.aborted) throw new Error('公司网关请求超时，请稍后重试。')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

const COMPANY_GATEWAY_CAPABILITY_TOOL = 'accrui_capability_probe'
async function probeCompanyGatewayToolCapability(options: { apiKey: string; protocol: CompanyGatewayProtocol; modelId: string; signal?: AbortSignal }): Promise<CompanyGatewayCapability> {
  const endpoint = options.protocol === 'anthropic-messages'
    ? `${COMPANY_GATEWAY_BASE_URL}/messages`
    : `${COMPANY_GATEWAY_BASE_URL}/chat/completions`
  const headers: Record<string, string> = options.protocol === 'anthropic-messages'
    ? { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` }
  const tool = options.protocol === 'anthropic-messages'
    ? { name: COMPANY_GATEWAY_CAPABILITY_TOOL, description: 'Verifies Agent tool-call support.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }
    : { type: 'function', function: { name: COMPANY_GATEWAY_CAPABILITY_TOOL, description: 'Verifies Agent tool-call support.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
  const toolChoice = options.protocol === 'anthropic-messages'
    ? { type: 'tool', name: COMPANY_GATEWAY_CAPABILITY_TOOL }
    : { type: 'function', function: { name: COMPANY_GATEWAY_CAPABILITY_TOOL } }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal: options.signal,
    body: JSON.stringify({ model: options.modelId, max_tokens: 32, messages: [{ role: 'user', content: 'Call the capability probe tool exactly once.' }], tools: [tool], tool_choice: toolChoice }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000)
    throw new Error(`当前模型或协议不支持 Agent 工具调用：${detail || `HTTP ${String(response.status)}`}`)
  }
  const value = await response.json() as Record<string, unknown>
  const returned = options.protocol === 'anthropic-messages'
    ? Array.isArray(value.content) && value.content.some(block => isKnowledgeRecord(block) && block.type === 'tool_use' && block.name === COMPANY_GATEWAY_CAPABILITY_TOOL)
    : Array.isArray(value.choices) && value.choices.some((choice) => {
        if (!isKnowledgeRecord(choice) || !isKnowledgeRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) return false
        return choice.message.tool_calls.some(call => isKnowledgeRecord(call) && isKnowledgeRecord(call.function) && call.function.name === COMPANY_GATEWAY_CAPABILITY_TOOL)
      })
  if (!returned) throw new Error('当前模型没有返回测试工具，不能作为 Agent 模型。')
  return { protocol: options.protocol, modelId: options.modelId, tools: true }
}

async function probeCompanyGateway(apiKey: string, protocol: CompanyGatewayProtocol, requestedModelId?: string): Promise<CompanyGatewayMetadata> {
  const [rawModels, rawQuota] = await Promise.all([
    companyGatewayJson('/models', apiKey),
    companyGatewayJson('/key/quota', apiKey),
  ])
  const models = companyGatewayModels(rawModels)
  const quota = companyGatewayQuota(rawQuota)
  if (models === undefined || models.length === 0) throw new Error('公司网关没有返回可用模型。')
  if (quota === undefined) throw new Error('公司网关返回了无法识别的用量信息。')
  if (quota.usagePercent !== null && quota.usagePercent >= 100) throw new Error('公司网关额度已经耗尽，请补充额度或更换 Key。')
  const modelId = requestedModelId ?? models[0].id
  if (!models.some((model) => model.id === modelId)) throw new Error('所选模型不在公司网关返回的可用模型中。')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMPANY_GATEWAY_TIMEOUT_MS)
  let capability: CompanyGatewayCapability
  try {
    capability = await probeCompanyGatewayToolCapability({ apiKey, protocol, modelId, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('公司网关工具能力检测超时，请稍后重试。')
    throw error
  } finally {
    clearTimeout(timeout)
  }
  const metadata = { models, quota, capability, checkedAt: new Date().toISOString() }
  await chrome.storage.local.set({ [COMPANY_GATEWAY_METADATA_STORAGE_KEY]: metadata })
  return metadata
}

function isCompanyAuthenticationCookie(cookie: chrome.cookies.Cookie, now: number): boolean {
  return ACCOUNT_AUTH_COOKIE_NAMES.has(cookie.name)
    && (cookie.expirationDate === undefined || cookie.expirationDate > now)
}

async function companyAuthenticationCookies(): Promise<chrome.cookies.Cookie[]> {
  const now = Date.now() / 1000
  const cookies = await chrome.cookies.getAll({ domain: ACCOUNT_AUTH_COOKIE_DOMAIN })
  return cookies.filter((cookie) => isCompanyAuthenticationCookie(cookie, now))
}

function companyAuthenticationCookieUrl(cookie: chrome.cookies.Cookie): string {
  const domain = cookie.domain.replace(/^\./, '')
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`
}

function companyAuthenticationCookieDescription(cookie: chrome.cookies.Cookie): string {
  return `${cookie.name} @ ${cookie.domain}${cookie.path}`
}

type CompanyPortalLogoutResult = { ok: boolean; error?: string }

function companyLogoutNavigationTimeoutMs(): number {
  const value = (globalThis as { __ACCRUI_COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS?: unknown }).__ACCRUI_COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS
}

function waitForCompanySingleSignOnNavigation(tabId: number): { done: Promise<void>; cancel: () => void } {
  let cancel = () => {}
  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.webNavigation.onCommitted.removeListener(listener)
    }
    const succeed = () => { cleanup(); resolve() }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return
      try {
        const url = new URL(details.url)
        if (['signinuat.midea.com', 'signinuat.annto.com'].includes(url.hostname) && ['/logout', '/', '/login'].includes(url.pathname)) succeed()
      } catch { /* unrelated malformed navigation detail */ }
    }
    const timer = setTimeout(() => fail(new Error('统一登录退出跳转未发生，请保留安得工作台页面后重试。')), companyLogoutNavigationTimeoutMs())
    cancel = cleanup
    chrome.webNavigation.onCommitted.addListener(listener)
  })
  return { done, cancel }
}

async function logoutCompanyPortalInPage(logoutApiUrl: string, singleSignOnLogoutUrl: string): Promise<CompanyPortalLogoutResult> {
  try {
    const response = await fetch(logoutApiUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' },
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/\bapplication\/json\b/i.test(contentType)) {
      return { ok: false, error: /\btext\/html\b/i.test(contentType) ? '服务返回 HTML 页面，未进入退出接口。' : `服务返回非 JSON 响应（${contentType || '无 Content-Type'}）。` }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, error: '服务返回 JSON 解析失败。' }
    }
    if (typeof payload !== 'object' || payload === null || !('code' in payload) || (payload.code !== '0' && payload.code !== 0)) {
      return { ok: false, error: '服务未确认退出' }
    }
    window.location.assign(singleSignOnLogoutUrl)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function invalidateCompanyPortalSession(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: [COMPANY_PORTAL_TAB_URL_PATTERN] })
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0]
  if (tab?.id === undefined) throw new Error('公司账号退出失败：请先打开已登录的安得工作台页面。')
  const navigation = waitForCompanySingleSignOnNavigation(tab.id)
  let result: CompanyPortalLogoutResult | undefined
  try {
    result = (await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: logoutCompanyPortalInPage,
      args: [COMPANY_PORTAL_LOGOUT_API_URL, COMPANY_SSO_LOGOUT_URL],
    }))[0]?.result as CompanyPortalLogoutResult | undefined
  } catch (error) {
    navigation.cancel()
    throw new Error(`公司账号退出失败：门户会话未退出（${asError(error)}）。`)
  }
  if (result?.ok !== true) {
    navigation.cancel()
    throw new Error(`公司账号退出失败：门户会话未退出（${result?.error ?? '页面未确认退出'}）。`)
  }
  try {
    await navigation.done
  } catch (error) {
    throw new Error(`公司账号退出失败：统一登录状态未退出（${asError(error)}）。`)
  }
}

async function clearCompanyAuthenticationCookies(): Promise<void> {
  const cookies = await companyAuthenticationCookies()
  for (const cookie of cookies) {
    await chrome.cookies.remove({
      url: companyAuthenticationCookieUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
      ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
    })
  }
  const remaining = await companyAuthenticationCookies()
  if (remaining.length > 0) {
    throw new Error(`公司账号退出失败：认证 Cookie 仍存在（${remaining.map(companyAuthenticationCookieDescription).join('；')}）。`)
  }
}

async function companyBrowserAuthentication(): Promise<boolean> {
  return (await companyAuthenticationCookies()).length > 0
}

async function accountAccessSnapshot(): Promise<AccountAccessSnapshot> {
  const gateway = await companyGatewayMetadata()
  if (await accountLocallySignedOut()) {
    return { status: 'guest', knowledgeAccess: false, codeAccess: false, modelMode: 'manual', ...(gateway === undefined ? {} : { gateway }) }
  }
  try {
    if (!await companyBrowserAuthentication()) {
      return { status: 'guest', knowledgeAccess: false, codeAccess: false, modelMode: 'manual', ...(gateway === undefined ? {} : { gateway }) }
    }
    return {
      status: 'authenticated',
      knowledgeAccess: true,
      codeAccess: true,
      modelMode: 'company-pending',
      ...(gateway === undefined ? {} : { gateway }),
      message: '公司账号已登录；可使用个人 Key 配置公司网关模型。',
    }
  } catch (error) {
    if (knowledgeServiceState(error) === 'unauthenticated') {
      return { status: 'guest', knowledgeAccess: false, codeAccess: false, modelMode: 'manual' }
    }
    return {
      status: 'unavailable',
      knowledgeAccess: false,
      codeAccess: false,
      modelMode: 'manual',
      ...(gateway === undefined ? {} : { gateway }),
      message: asError(error),
    }
  }
}

async function assertAccountAccessForProtectedSource(): Promise<void> {
  const snapshot = await accountAccessSnapshot()
  if (snapshot.status === 'authenticated') return
  if (snapshot.status === 'unavailable') throw new Error('公司账号状态暂时无法验证，请稍后重试。')
  // Reuse the existing end-to-end Connector error code so the knowledge/code
  // tool row presents its established “重新登录” guidance instead of a raw
  // implementation detail.
  throw new Error('knowledge_login_required')
}

async function locallySignOutAccount(): Promise<AccountAccessSnapshot> {
  await invalidateCompanyPortalSession()
  await clearCompanyAuthenticationCookies()
  await setAccountLocallySignedOut(true)
  knowledgeCatalogCache = undefined
  for (const controller of activeKnowledgeQueries.values()) controller.abort()
  await knowledgeSessionStorage()?.remove(KNOWLEDGE_SESSION_STORAGE_KEY)
  return accountAccessSnapshot()
}

async function resolveKnowledgeScopeRecord(request: KnowledgeQueryRequest | SelectedSourceScopeRequest): Promise<KnowledgeScopeRecord | undefined> {
  const scopes = await knowledgeScopes()
  return scopes[request.harnessSessionId] ?? (request.harnessParentSessionId === undefined ? undefined : scopes[request.harnessParentSessionId])
}

async function respondToSelectedSourceScope(port: chrome.runtime.Port, request: SelectedSourceScopeRequest): Promise<void> {
  try {
    await assertAccountAccessForProtectedSource()
    const record = await resolveKnowledgeScopeRecord(request)
    const empty = { domainId: '', systemIds: [], repositoryIds: [] }
    const preference = await knowledgeEnabledPreference()
    const enabled = record?.enabled ?? (preference.remember ? preference.enabled : true)
    let scope = record?.scope ?? empty
    let catalog: { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string }>; repositories: Array<{ id: string; name: string }> } = { domains: [], systems: [], repositories: [] }
    try {
      catalog = await loadKnowledgeCatalog()
      scope = pruneScope(scope, catalog)
    } catch { /* names fall back to stored ids when the catalog is unavailable */ }
    port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, result: selectedSourceScopeEcho({ scope, enabled }, catalog) })
  } catch (error) {
    port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, error: asError(error) })
  }
}

async function respondToKnowledge(port: chrome.runtime.Port, request: KnowledgeQueryRequest): Promise<void> {
  const controller = new AbortController()
  activeKnowledgeQueries.set(request.requestId, controller)
  // Live search progress for the sidepanel UI; throttled because SSE deltas
  // arrive at answer speed. The callback form tolerates a missing listener.
  let lastProgressAt = 0
  const broadcast = (phase: 'querying' | 'streaming' | 'done' | 'error', chars = 0, content = '', eventType?: string, process?: string): void => {
    const now = Date.now()
    if (phase === 'streaming' && content !== '' && process === undefined && now - lastProgressAt < 120) return
    lastProgressAt = now
    const snapshot: SearchProgressSnapshot = { type: 'search-progress/v1', requestId: request.requestId, harnessSessionId: request.harnessSessionId, ...(request.harnessParentSessionId === undefined ? {} : { harnessParentSessionId: request.harnessParentSessionId }), tool: request.tool, question: request.question.trim(), phase, chars, content, ...(eventType === undefined ? {} : { eventType }), ...(process === undefined || process === '' ? {} : { process }) }
    searchProgressSnapshots.delete(request.requestId)
    searchProgressSnapshots.set(request.requestId, snapshot)
    while (searchProgressSnapshots.size > 12) searchProgressSnapshots.delete(searchProgressSnapshots.keys().next().value!)
    chrome.runtime.sendMessage(snapshot, () => { void chrome.runtime.lastError })
  }
  broadcast('querying')
  const keepAlive = typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo !== undefined
    ? setInterval(() => { void chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError }) }, 20_000)
    : undefined
  let lastProcess = ''
  try {
    await assertAccountAccessForProtectedSource()
    const record = await resolveKnowledgeScopeRecord(request)
    if (record === undefined) throw new Error('当前会话还没有知识/代码范围记录。请先在输入框上方选择知识范围或代码库，再发起检索。')
    if (!record.enabled) throw new Error('知识查询开关已关闭。请打开输入框上方的知识查询开关后再试。')
    let scope = record.scope
    try { scope = pruneScope(record.scope, await loadKnowledgeCatalog()) } catch { /* keep stored ids when the catalog is unavailable */ }
    const kind: KnowledgeKind = request.tool === 'knowledge_search' ? 'knowledge' : 'code'
    const fingerprint = scopeFingerprint(scope)
    const sessions = await knowledgeSessions()
    const owner = knowledgeConversationOwner(request.harnessSessionId, request.harnessParentSessionId)
    const continuation = planKnowledgeContinuation(sessions, owner, kind, fingerprint)
    const executed = await executeKnowledgeQuery(kind, request.question.trim(), scope, continuation.priorSessionId, controller.signal, (progress) => {
      if (progress.process !== undefined && progress.process !== '') lastProcess = progress.process
      broadcast('streaming', progress.chars, progress.content, progress.eventType, progress.process)
    })
    if (executed.sessionId !== undefined) {
      sessions[continuation.key] = { sessionId: executed.sessionId, fingerprint }
      await knowledgeSessionStorage()?.set({ [KNOWLEDGE_SESSION_STORAGE_KEY]: sessions })
    }
    broadcast('done', executed.result.answer.length, executed.result.answer, 'done', lastProcess)
    port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, result: executed.result })
  } catch (error) {
    const text = asError(error)
    broadcast('error', text.length, text, 'error', lastProcess)
    port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, error: text })
  } finally {
    if (keepAlive !== undefined) clearInterval(keepAlive)
    activeKnowledgeQueries.delete(request.requestId)
  }
}

const browserTargetRuntime = new BrowserTargetRuntime({ storage: targetStorage, targetFromTab: targetFromActionTab })
const readBrowserTargetSettings = (): Promise<BrowserTargetSettings> => browserTargetRuntime.readSettings()
const saveBrowserTargetSettings = (settings: BrowserTargetSettings): Promise<BrowserTargetSettings> => browserTargetRuntime.saveSettings(settings)
const updateBrowserTargetSettings = (mutator: (latest: BrowserTargetSettings) => BrowserTargetSettings): Promise<BrowserTargetSettings> => browserTargetRuntime.updateSettings(mutator)
const activeBrowserTarget = (windowId?: number): Promise<BrowserTarget> => browserTargetRuntime.active(windowId)
const bindingForTarget = (target: BrowserTarget): BrowserTargetBinding => browserTargetRuntime.binding(target)
const nativeBindingFields = (binding: BrowserTargetBinding): Partial<Pick<BrowserTargetBinding, 'browserTargets' | 'unavailableBrowserTargets'>> => browserTargetRuntime.nativeFields(binding)
const pinnedBrowserTargets = (settings: BrowserTargetSettings): Promise<BrowserTargetBinding> => browserTargetRuntime.pinned(settings)
const resolveBrowserTarget = (settings: BrowserTargetSettings, preferredTarget?: BrowserTarget): Promise<BrowserTargetBinding | undefined> => browserTargetRuntime.resolve(settings, preferredTarget)

async function startHarnessForSettings(preferredTarget?: BrowserTarget): Promise<string> {
  const settings = await readBrowserTargetSettings()
  const binding = await resolveBrowserTarget(settings, preferredTarget)
  return startHarness(binding)
}

async function restartHarnessForSettings(): Promise<string> {
  return queueNativeLifecycle(async () => {
    await browserTargetRuntime.settled()
    const port = nativePort
    if (port !== undefined) {
      try {
        port.disconnect()
      } finally {
        disconnectNativePort(port)
      }
    }
    nativeUrl = undefined
    nativeRuntimeIdentity = undefined
    boundBrowserTargets.clear()
    return startHarnessForSettings()
  })
}

function queueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const queued = nativeLifecycle.then(operation)
  nativeLifecycle = queued.then(() => undefined, () => undefined)
  return queued
}

const availableTabs = (): Promise<BrowserTargetTab[]> => browserTargetRuntime.availableTabs()

interface StoredPrototypeReferences {
  v: 1
  references: Record<string, unknown>
}

function storedPrototypeReferences(value: unknown): StoredPrototypeReferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { v: 1, references: {} }
  const record = value as Partial<StoredPrototypeReferences>
  return record.v === 1 && typeof record.references === 'object' && record.references !== null && !Array.isArray(record.references)
    ? { v: 1, references: record.references as Record<string, unknown> }
    : { v: 1, references: {} }
}

async function prototypeHostRequest(authorization: PrototypeStudioAuthorization, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = nativeUrl ?? await startHarnessForSettings()
  const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization.capability}` }, body: JSON.stringify({ projectId: authorization.projectId, ...body }) })
  const payload = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Prototype Studio request failed: HTTP ${String(response.status)}`)
  return payload
}

function replaceRememberedPrototypeStudios(authorizations: Iterable<unknown>, now = Date.now()): PrototypeStudioAuthorization[] {
  const retained = retainedPrototypeStudioAuthorizations(authorizations, now)
  prototypeStudioAuthorizations.clear()
  for (const item of retained) prototypeStudioAuthorizations.set(item.projectId, item)
  return retained
}

function queuePrototypeStudioAuthorizationMutation(operation: () => Promise<void>): Promise<void> {
  const queued = prototypeStudioAuthorizationMutation.then(operation)
  prototypeStudioAuthorizationMutation = queued.then(() => undefined, () => undefined)
  return queued
}

async function rememberPrototypeStudio(authorization: PrototypeStudioAuthorization): Promise<void> {
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const storage = chrome.storage?.session
    const persisted = storage === undefined
      ? []
      : Object.values(storedPrototypeStudioAuthorizations((await storage.get(PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY))[PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY]).authorizations)
    const retained = replaceRememberedPrototypeStudios([...prototypeStudioAuthorizations.values(), ...persisted, authorization])
    if (storage !== undefined) {
      await storage.set({ [PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY]: { v: 1, authorizations: Object.fromEntries(retained.map(item => [item.projectId, item])) } })
    }
  })
}

async function prototypeStudioAuthorization(projectId: string): Promise<PrototypeStudioAuthorization | undefined> {
  const remembered = prototypeStudioAuthorizations.get(projectId)
  if (remembered !== undefined && validPrototypeStudioAuthorization(remembered)) return remembered
  const storage = chrome.storage?.session
  if (storage === undefined) return undefined
  let restored: PrototypeStudioAuthorization | undefined
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const stored = storedPrototypeStudioAuthorizations((await storage.get(PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY))[PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY])
    const retained = replaceRememberedPrototypeStudios([...prototypeStudioAuthorizations.values(), ...Object.values(stored.authorizations)])
    // Remove malformed, expired, and surplus records as part of recovery so a
    // hostile session-store value cannot be selected on a later restart.
    await storage.set({ [PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY]: { v: 1, authorizations: Object.fromEntries(retained.map(item => [item.projectId, item])) } })
    restored = prototypeStudioAuthorizations.get(projectId)
  })
  return restored
}

async function captureDesignReference(browserTarget: BrowserTarget, sessionId: string): Promise<{ referenceId: string; projectId: string }> {
  const before = await chrome.tabs.get(browserTarget.tabId)
  const liveBefore = targetFromActionTab(before)
  if (liveBefore === undefined || !sameBrowserTarget(liveBefore, browserTarget)) {
    throw new Error('The selected reference page changed or closed. Refresh Browser Target and try again.')
  }
  if (before.status !== 'complete') throw new Error('The selected reference page is still loading. Wait for it to finish and try again.')
  await chrome.tabs.update(browserTarget.tabId, { active: true })
  const [active] = await chrome.tabs.query({ active: true, windowId: browserTarget.windowId })
  const activeTarget = active === undefined ? undefined : targetFromActionTab(active)
  if (activeTarget === undefined || !sameBrowserTarget(activeTarget, browserTarget)) {
    throw new Error('Chrome could not make the selected reference page active for visual capture.')
  }

  const captureModule = await import('../src/design-reference-capture')
  const executions = await chrome.scripting.executeScript({
    target: { tabId: browserTarget.tabId },
    world: 'ISOLATED',
    func: captureModule.captureDesignReferencePage,
  })
  const raw = executions[0]?.result
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(browserTarget.windowId, { format: 'jpeg', quality: 60 })
  const after = await chrome.tabs.get(browserTarget.tabId)
  const liveAfter = targetFromActionTab(after)
  if (liveAfter === undefined || !sameBrowserTarget(liveAfter, browserTarget)) {
    throw new Error('The reference page changed during capture. Nothing was saved; try again on the stable page.')
  }
  const evidence = await captureModule.buildReferenceEvidence(raw, screenshotDataUrl)
  const storageKey = captureModule.PROTOTYPE_REFERENCE_STORAGE_KEY
  const current = storedPrototypeReferences((await chrome.storage.local.get(storageKey))[storageKey])
  const references = { ...current.references, [evidence.id]: evidence }
  const retained = Object.entries(references)
    .sort((left, right) => {
      const leftTime = Date.parse(((left[1] as { source?: { capturedAt?: unknown } }).source?.capturedAt as string | undefined) ?? '') || 0
      const rightTime = Date.parse(((right[1] as { source?: { capturedAt?: unknown } }).source?.capturedAt as string | undefined) ?? '') || 0
      return rightTime - leftTime
    })
    .slice(0, MAX_STORED_PROTOTYPE_REFERENCES)
  await chrome.storage.local.set({ [storageKey]: { v: 1, references: Object.fromEntries(retained) } })
  const readback = storedPrototypeReferences((await chrome.storage.local.get(storageKey))[storageKey]).references[evidence.id] as { fingerprint?: unknown; screenshotFingerprint?: unknown } | undefined
  if (readback?.fingerprint !== evidence.fingerprint || readback.screenshotFingerprint !== evidence.screenshotFingerprint) {
    throw new Error('Chrome could not verify the saved design reference.')
  }
  const authorization: PrototypeStudioAuthorization = { projectId: `prototype-${crypto.randomUUID()}`, referenceId: evidence.id, sessionId, capability: `${crypto.randomUUID()}${crypto.randomUUID()}`, openedAt: Date.now() }
  const { screenshotDataUrl: _screenshot, ...hostEvidence } = evidence
  await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_OPEN_PATH, { sessionId, evidence: [hostEvidence] })
  await rememberPrototypeStudio(authorization)
  const studioUrl = new URL(chrome.runtime.getURL('prototype-studio.html'))
  studioUrl.searchParams.set('referenceId', evidence.id)
  studioUrl.searchParams.set('projectId', authorization.projectId)
  await chrome.tabs.create({ windowId: browserTarget.windowId, active: true, url: studioUrl.toString() })
  return { referenceId: evidence.id, projectId: authorization.projectId }
}

async function readOfficeContext(request: ConnectorRequest): Promise<Record<string, unknown>> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined) throw new Error('No Browser Target is bound to this Run by the Extension.')
  const requestTargets = request.browserTargets ?? [request.browserTarget]
  const requestUnavailable = request.unavailableBrowserTargets ?? []
  if (!sameBrowserTarget(request.browserTarget, binding.browserTarget)
    || !sameBrowserTargetList(requestTargets, binding.browserTargets)
    || !sameUnavailableBrowserTargetList(requestUnavailable, binding.unavailableBrowserTargets)) {
    throw new Error('Connector Browser Target does not match the Extension binding.')
  }
  const pages: Array<Record<string, unknown>> = []
  const unavailable = [...binding.unavailableBrowserTargets]
  for (const target of binding.browserTargets) {
    try {
      const tab = await chrome.tabs.get(target.tabId)
      if (tab.windowId !== target.windowId || tab.url !== target.url) {
        unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
        continue
      }
      pages.push({ browserTarget: target, pageIdentity: { title: tab.title ?? '', url: target.url }, documentIdentity: await probeDocumentIdentity(target.tabId), isPrimary: sameBrowserTarget(target, binding.browserTarget) })
    } catch {
      unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
    }
  }
  const primaryPage = pages.find((page) => page.isPrimary === true)
  if (primaryPage === undefined) throw new Error('The primary Browser Target changed before Office context could be read.')
  // The primary page's probed WebEdit identity rides along so downstream models
  // can route to read_work_tab / light_document_read without guessing from the
  // tab title; null now means no webedit frame answered ready on either channel.
  return {
    status: 'browser_target_verified',
    pageIdentity: primaryPage.pageIdentity,
    documentIdentity: primaryPage.documentIdentity ?? null,
    primaryBrowserTarget: binding.browserTarget,
    pages,
    unavailableBrowserTargets: unavailable,
  }
}

async function resolveOfficeBrowserTarget(request: ConnectorRequest): Promise<BrowserTargetBinding> {
  // Tab-update candidate persistence and Connector dispatch can arrive in the
  // same event turn. Read settings only after that serialized update settles.
  await browserTargetRuntime.settled()
  const settings = await readBrowserTargetSettings()
  if (settings.mode === 'none') throw new Error('Browser use is disabled for the next Office turn.')
  const binding = settings.mode === 'pinned-tabs'
    ? await pinnedBrowserTargets(settings)
    // The follow-active-tab policy is resolved from Chrome at request time.
    // A candidate is only a next-Run hint and can be stale when a single tab
    // navigates between Team Knowledge documents without firing onActivated.
    : bindingForTarget(await activeBrowserTarget())
  const requestTargets = request.browserTargets ?? [request.browserTarget]
  const requestUnavailable = request.unavailableBrowserTargets ?? []
  if (!sameBrowserTarget(binding.browserTarget, request.browserTarget)
    || !sameBrowserTargetList(binding.browserTargets, requestTargets)
    || !sameUnavailableBrowserTargetList(binding.unavailableBrowserTargets, requestUnavailable)) {
    await transferBrowserTarget(request.runId, binding, request.requestId)
  }
  return binding
}

const WORK_TAB_CONTENT_LIMIT = 12_000

function pageFromRoster(binding: BrowserTargetBinding, tab: number): BrowserTarget {
  const page = binding.browserTargets[tab - 1]
  if (page === undefined) {
    throw new Error(`list_work_tabs currently has ${binding.browserTargets.length} available page(s). Call list_work_tabs again, then pass a tab from 1 to ${Math.max(binding.browserTargets.length, 1)}.`)
  }
  return page
}

async function liveRosterPage(page: BrowserTarget): Promise<BrowserTarget> {
  try {
    const tab = await chrome.tabs.get(page.tabId)
    const live = targetFromActionTab(tab)
    if (live === undefined || !samePinnedTab(live, page)) {
      throw { code: 'navigation', message: 'That work tab closed or was replaced. Call list_work_tabs again.' } satisfies OfficeReadFailure
    }
    return live
  } catch (error) {
    if (error && typeof error === 'object' && (error as OfficeReadFailure).code === 'navigation') throw error
    throw { code: 'navigation', message: 'That work tab closed or was replaced. Call list_work_tabs again.' } satisfies OfficeReadFailure
  }
}

function webeditFramesOf(frames: chrome.webNavigation.GetAllFrameResultDetails[]): chrome.webNavigation.GetAllFrameResultDetails[] {
  return frames.filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
}

function clipWorkTabContent(text: string, maxChars = WORK_TAB_CONTENT_LIMIT): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false }
  return { content: text.slice(0, maxChars), truncated: true }
}

function textFromLightDocument(result: Record<string, unknown>): string {
  const document = result.document
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ''
  const body = document as Record<string, unknown>
  if (Array.isArray(body.blocks)) {
    return body.blocks.flatMap((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return []
      const item = block as Record<string, unknown>
      if (typeof item.text === 'string' && item.text.length > 0) return [item.text]
      if (Array.isArray(item.items)) return [item.items.filter((entry): entry is string => typeof entry === 'string').join('\n')]
      if (Array.isArray(item.rows)) {
        return [item.rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? '')).join('\t') : '').join('\n')]
      }
      return []
    }).join('\n')
  }
  const title = body.title
  if (title && typeof title === 'object' && !Array.isArray(title) && typeof (title as { text?: unknown }).text === 'string') {
    return (title as { text: string }).text
  }
  return ''
}

function textFromSpreadsheet(result: Record<string, unknown>): string {
  const usedRange = result.usedRange
  if (usedRange && typeof usedRange === 'object' && !Array.isArray(usedRange)) {
    const range = usedRange as { address?: unknown; text?: unknown; value2?: unknown }
    if (typeof range.text === 'string' && range.text.length > 0) return range.text
    if (typeof range.address === 'string') return JSON.stringify(usedRange)
  }
  return JSON.stringify(result)
}

const VISIBLE_PAGE_TEXT_BUDGET_MS = 4_000

function asChromeError(error: unknown): string {
  const runtime = chrome.runtime.lastError?.message
  if (typeof runtime === 'string' && runtime.length > 0) return runtime
  return asError(error)
}

function missingHostPermission(error: unknown): boolean {
  return /Cannot access contents of (the page|url)|Missing host permission|Cannot access a chrome:|Extension manifest must request permission/i.test(asChromeError(error))
}

async function readVisiblePageText(tabId: number): Promise<{ content: string; truncated: boolean }> {
  try {
    const injected = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        injectImmediately: true,
        func: () => (document.body?.innerText ?? document.documentElement?.innerText ?? '').replace(/[ \t]+\n/g, '\n').trim(),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error(`Visible-text capture exceeded ${VISIBLE_PAGE_TEXT_BUDGET_MS / 1000}s.`), { code: 'timeout' })), VISIBLE_PAGE_TEXT_BUDGET_MS)
      }),
    ])
    const text = typeof injected[0]?.result === 'string' ? injected[0].result : ''
    return clipWorkTabContent(text)
  } catch (error) {
    if (missingHostPermission(error)) {
      throw { code: 'unsupported', message: 'This page is outside the extension host permission, so visible text cannot be captured. Reload the extension after granting all-sites access, then retry read_work_tab.' } satisfies OfficeReadFailure
    }
    throw { code: 'timeout', message: asChromeError(error) } satisfies OfficeReadFailure
  }
}

async function readWorkTabContent(request: ReadWorkTabRequest): Promise<Record<string, unknown>> {
  const binding = await resolveOfficeBrowserTarget({
    type: CONNECTOR_REQUEST,
    requestId: request.requestId,
    runId: request.runId,
    generation: request.generation,
    browserTarget: request.browserTarget,
    browserTargets: request.browserTargets,
    unavailableBrowserTargets: request.unavailableBrowserTargets,
    tool: 'list_work_tabs',
  })
  const live = await liveRosterPage(pageFromRoster(binding, request.tab))
  const tab = await chrome.tabs.get(live.tabId)
  const pageIdentity = { title: tab.title ?? '', url: live.url }
  const isPrimary = samePinnedTab(live, binding.browserTarget)
  const identity = await probeDocumentIdentity(live.tabId)
  const offset = request.offset ?? 0
  const limit = request.limit ?? 80
  if (identity?.kind === 'webedit_light_document' || identity?.kind === 'webedit_spreadsheet') {
    const frames = webeditFramesOf(await chrome.webNavigation.getAllFrames({ tabId: live.tabId }) ?? [])
    if (frames.length === 0) throw { code: 'unsupported', message: 'That work tab has no supported WebEdit iframe.' } satisfies OfficeReadFailure
    const message = identity.kind === 'webedit_light_document'
      ? { type: 'office-document/v1', action: 'read', offset, limit }
      : { type: 'office-spreadsheet/v1', action: 'used_range' }
    const { reply, frame } = await sendToWebEditFrame(live.tabId, frames, message)
    if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while reading that work tab.' }
    const latest = await chrome.webNavigation.getAllFrames({ tabId: live.tabId }) ?? []
    if (!latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) {
      throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while reading that work tab.' } satisfies OfficeReadFailure
    }
    const raw = reply.result as Record<string, unknown>
    const extracted = identity.kind === 'webedit_light_document' ? textFromLightDocument(raw) : textFromSpreadsheet(raw)
    const clipped = clipWorkTabContent(extracted)
    return { status: 'ok', tab: request.tab, page: live, pageIdentity, kind: identity.kind, ...clipped, isPrimary }
  }
  const clipped = await readVisiblePageText(live.tabId)
  return { status: 'ok', tab: request.tab, page: live, pageIdentity, kind: 'web_page', ...clipped, isPrimary }
}

function respondToReadWorkTab(port: chrome.runtime.Port, request: ReadWorkTabRequest): void {
  // Roster and page reads must not share the Native start/stop queue. A hung
  // iframe or executeScript on one checked tab would otherwise stall every
  // later list_work_tabs until Native times out the whole peer.
  void (async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const binding = await resolveOfficeBrowserTarget({
      type: CONNECTOR_REQUEST,
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget: request.browserTarget,
      browserTargets: request.browserTargets,
      unavailableBrowserTargets: request.unavailableBrowserTargets,
      tool: 'list_work_tabs',
    })
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const result = await readWorkTabContent({ ...request, ...binding })
    return { ...binding, result }
  })().then(({ browserTarget, browserTargets, unavailableBrowserTargets, result }) => {
    port.postMessage({
      type: CONNECTOR_RESPONSE,
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget,
      browserTargets,
      unavailableBrowserTargets,
      result,
    })
  }).catch((error: unknown) => {
    port.postMessage({
      type: CONNECTOR_RESPONSE,
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget: request.browserTarget,
      error: officeReadFailure(error),
    })
  })
}

function respondToConnector(port: chrome.runtime.Port, request: ConnectorRequest): void {
  void (async () => {
    if (nativePort !== port) throw new Error('Connector request belongs to a stale Native connection.')
    const binding = await resolveOfficeBrowserTarget(request)
    if (nativePort !== port) throw new Error('Connector request became stale before Office context could be read.')
    const resolvedRequest = { ...request, ...binding }
    const result = await readOfficeContext(resolvedRequest)
    return { ...binding, result }
  })()
    .then(({ browserTarget, browserTargets, unavailableBrowserTargets, result }) => {
      port.postMessage({
        type: CONNECTOR_RESPONSE,
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget,
        browserTargets,
        unavailableBrowserTargets,
        result,
      })
    })
    .catch((error: unknown) => {
      port.postMessage({
        type: CONNECTOR_RESPONSE,
        requestId: request.requestId,
        runId: request.runId,
        generation: request.generation,
        browserTarget: request.browserTarget,
        error: asError(error),
      })
    })
}

function officeReadFailure(error: unknown): OfficeReadFailure {
  const source = error && typeof error === 'object' ? error as Partial<OfficeReadFailure> : undefined
  const code = source?.code
  const allowed = ['unsupported', 'preview', 'readonly', 'invalid_range', 'navigation', 'iframe_replaced', 'timeout', 'cancelled', 'fingerprint_mismatch', 'readback_mismatch', 'runtime_error']
  return {
    code: allowed.includes(code ?? '') ? code as OfficeReadFailure['code'] : 'runtime_error',
    message: typeof source?.message === 'string' ? source.message : asError(error),
  }
}

const OFFICE_CONTENT_SCRIPT_FILES = ['content-scripts/office-read.js']

function isMissingReceivingEnd(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}

function probeMessageFor(message: Record<string, unknown>): Record<string, unknown> {
  const type = String(message.type)
  if (type === 'office-spreadsheet/v1') return { type, action: 'probe' }
  if (type === 'office-document/v1') return { type, action: 'probe' }
  if (type === 'office-read-range/v1') return { type, action: 'probe' }
  return { type: 'office-read-range/v1', action: 'probe' }
}

/**
 * A "none ready within 8s" failure is ambiguous downstream: the doc.midea.com
 * page can host a spreadsheet iframe while the caller probed the light-document
 * channel (or vice versa), and the model then tells the user "the editor is
 * still loading" when the frames simply host the other document type. When the
 * requested channel stays silent, ask the sibling channel once: a ready answer
 * turns the error into an actionable "this Browser Target hosts a spreadsheet /
 * document, call the other tool" instead of a wrong diagnosis.
 */
function siblingProbeType(type: string): string | null {
  if (type === 'office-document/v1') return 'office-spreadsheet/v1'
  if (type === 'office-spreadsheet/v1') return 'office-document/v1'
  return null
}

function channelReadyLabel(type: string): string {
  if (type === 'office-document/v1') return 'light-document editor'
  if (type === 'office-spreadsheet/v1') return 'spreadsheet runtime'
  return 'editor runtime'
}

function probeSucceeded(reply: { ok?: unknown; result?: unknown } | undefined): boolean {
  if (reply?.ok !== true) return false
  const result = reply.result as { status?: unknown; ready?: unknown } | undefined
  return result?.status === 'probe' && result?.ready === true
}

const OFFICE_PROBE_WAIT_MS_DEFAULT = 8_000
const OFFICE_PROBE_RETRY_MS = 250
const OFFICE_FRAME_OPERATION_MS_DEFAULT = 8_000

function officeFrameOperationBudgetMs(): number {
  const configured = Number((globalThis as typeof globalThis & { __DSH_OFFICE_FRAME_OPERATION_MS?: unknown }).__DSH_OFFICE_FRAME_OPERATION_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : OFFICE_FRAME_OPERATION_MS_DEFAULT
}

/**
 * Chrome never re-injects content scripts into already-loaded frames, so every
 * extension reload orphans WebEdit iframes in pages opened before it: the frame
 * still exists but nobody answers. On that exact failure, re-inject the
 * registered content script into the frame once and retry, instead of failing
 * until the user manually refreshes the page.
 *
 * A doc.midea.com page can host several webedit.midea.com iframes (ad,
 * footer, hidden bridges) whose editor never finishes mounting — WebEdit can
 * reset iframes without notice, so getAllFrames order is not stable. Like
 * accr-ui's MCP-server probe, ask every candidate frame whether its editor
 * runtime is ready, then talk to the ready one instead of the first match.
 *
 * Editor boot is not instant: the in-frame runtimes themselves poll for the
 * editor global for up to 8s, and accr-ui budgets 30s. A single instant probe
 * would permanently skip every still-booting frame, so keep sweeping all
 * candidates within the same 8s budget before declaring none ready. The final
 * error names the frame count so "no iframe at all" and "iframes exist but no
 * editor inside" stay distinguishable downstream, and when the sibling channel
 * answers ready it names the actual document type so the caller switches tools
 * instead of misreading "wrong document type" as "editor still loading".
 *
 * Several frames can be ready at once (a preloaded blank editor beside the
 * user's real document), so each sweep collects every ready candidate and its
 * probe identity, then picks by framePreference below instead of the first
 * match.
 *
 * Returns the frame that actually answered so callers can verify that exact
 * frame afterwards.
 */
type ProbeIdentity = { path?: unknown; workbookName?: unknown; sheetName?: unknown; hasContent?: unknown }

function identityPath(identity: ProbeIdentity | undefined): string {
  return typeof identity?.path === 'string' ? identity.path.toLowerCase() : ''
}

function pathLooksLikeSpreadsheet(path: string): boolean {
  return path.includes('/weboffice/office/s/') || path.includes('/moewebv7/document-cloud')
}

function pathLooksLikeLightDocument(path: string): boolean {
  return path.includes('/weboffice/office/o/')
}

function substantialSpreadsheet(identity: ProbeIdentity | undefined): boolean {
  return identity?.hasContent === true
    || (typeof identity?.workbookName === 'string' && identity.workbookName.length > 0)
}

function probeIdentityOf(reply: { ok?: unknown; result?: unknown } | undefined): ProbeIdentity | undefined {
  const identity = (reply?.result as { status?: unknown; identity?: unknown } | undefined)?.identity
  return identity && typeof identity === 'object' && !Array.isArray(identity) ? identity as ProbeIdentity : undefined
}

/**
 * Rank a ready frame for the "which document did the user mean" choice.
 * A doc.midea.com page can preload a blank editor iframe (workbookName null,
 * fresh Sheet1, nothing typed) beside the user's real document, so a blind
 * "first ready frame wins" reads the wrong spreadsheet and every cell comes
 * back null. Prefer frames that prove content, then named workbooks; only
 * fall back to iteration order when nothing better distinguishes them.
 * Lower rank wins; ties keep getAllFrames order.
 */
/**
 * One quick identity sweep for list_work_tabs: ask every webedit frame on
 * both editor channels (spreadsheet + light document), without the 8s wait or
 * healing budget that real operations use. A hardcoded documentIdentity:null
 * made downstream models read "no WebEdit document here" out of a page whose
 * spreadsheet editor answers in milliseconds, so report the best ready frame's
 * kind and identity instead; null now genuinely means "nothing answered".
 *
 * accr-ui classifies /weboffice/office/o/ as a light document and /office/s/
 * as a spreadsheet. A Team Knowledge light-document page also preloads a
 * blank spreadsheet iframe; prefer the ready light document over that blank
 * sheet so light_document_read is used instead of a spreadsheet read.
 */
async function probeDocumentIdentity(tabId: number): Promise<Record<string, unknown> | null> {
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }) ?? [])
      .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
    if (frames.length === 0) return null
    const spreadsheetCandidates: ProbeIdentity[] = []
    const lightDocumentCandidates: ProbeIdentity[] = []
    await Promise.all(frames.flatMap((frame) => (['office-spreadsheet/v1', 'office-document/v1'] as const).map(async (channel) => {
      try {
        const reply = await sendMessageWithBudget(tabId, { type: channel, action: 'probe' }, frame.frameId, 250)
        if (!probeSucceeded(reply)) return
        const identity = probeIdentityOf(reply) ?? {}
        const path = identityPath(identity)
        // accr-ui: /weboffice/office/o/ is a light document, /office/s/ is a
        // spreadsheet. A Team Knowledge light-document page also preloads a
        // blank spreadsheet iframe; never let that blank frame steal identity.
        if (channel === 'office-spreadsheet/v1') {
          if (pathLooksLikeLightDocument(path)) return
          spreadsheetCandidates.push(identity)
        } else {
          if (pathLooksLikeSpreadsheet(path)) return
          lightDocumentCandidates.push(identity)
        }
      } catch { /* diagnostic-only probe: an unreachable frame simply does not count */ }
    })))
    const lightDocumentReady = lightDocumentCandidates.length > 0
    const substantial = spreadsheetCandidates.filter(substantialSpreadsheet)
    const spreadsheetKind = (best: ProbeIdentity) => ({
      kind: 'webedit_spreadsheet',
      workbookName: typeof best.workbookName === 'string' ? best.workbookName : null,
      sheetName: typeof best.sheetName === 'string' ? best.sheetName : null,
      hasContent: best.hasContent === true ? true : best.hasContent === false ? false : null,
      webeditFrames: frames.length,
    })
    if (substantial.length > 0) {
      const best = substantial.reduce((leader, candidate) => framePreference(candidate) < framePreference(leader) ? candidate : leader)
      return spreadsheetKind(best)
    }
    if (lightDocumentReady) return { kind: 'webedit_light_document', workbookName: null, sheetName: null, hasContent: null, webeditFrames: frames.length }
    if (spreadsheetCandidates.length > 0) {
      const best = spreadsheetCandidates.reduce((leader, candidate) => framePreference(candidate) < framePreference(leader) ? candidate : leader)
      return spreadsheetKind(best)
    }
    return null
  } catch { /* a failed context probe must never break list_work_tabs itself */ return null }
}

function framePreference(identity: ProbeIdentity | undefined): number {  if (identity?.hasContent === true) return 0
  if (typeof identity?.workbookName === 'string' && identity.workbookName.length > 0) return 1
  return 2
}

function isProbeTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'probe_timeout')
}

async function sendMessageWithBudget(tabId: number, message: Record<string, unknown>, frameId: number, budgetMs: number): Promise<{ ok?: unknown; result?: unknown; error?: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<{ ok?: unknown; result?: unknown; error?: unknown } | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('office probe timed out'), { code: 'probe_timeout' })), Math.max(0, budgetMs))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function sendToWebEditFrame(tabId: number, frames: chrome.webNavigation.GetAllFrameResultDetails[], message: Record<string, unknown>): Promise<{ reply: { ok?: unknown; result?: unknown; error?: unknown } | undefined; frame: chrome.webNavigation.GetAllFrameResultDetails }> {
  const configuredWaitMs = Number((globalThis as typeof globalThis & { __DSH_OFFICE_PROBE_WAIT_MS?: unknown }).__DSH_OFFICE_PROBE_WAIT_MS)
  const waitBudgetMs = Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0 ? configuredWaitMs : OFFICE_PROBE_WAIT_MS_DEFAULT
  const deadline = Date.now() + waitBudgetMs
  let lastMissingReceiver: unknown
  const healedFrameIds = new Set<number>()
  // A Team Knowledge spreadsheet page hosts two webedit iframes. Probing them
  // one-by-one lets a hung preload/light-document APP eat the whole 8s budget
  // before the ready sheet is asked. Probe every candidate in parallel. A
  // content-bearing ready frame wins immediately; otherwise wait out this
  // sweep so a slower real document can still beat a blank preload.
  for (;;) {
    const remainingMs = Math.max(0, deadline - Date.now())
    const perFrameMs = Math.min(1_000, remainingMs)
    const readyByFrameId = new Map<number, { frame: chrome.webNavigation.GetAllFrameResultDetails; identity: ProbeIdentity | undefined }>()
    let pending = frames.length
    let settleSweep!: () => void
    const sweepDone = new Promise<void>((resolve) => { settleSweep = resolve })
    const finishSweep = (): void => { pending = 0; settleSweep() }
    const considerReady = (): void => {
      if ([...readyByFrameId.values()].some((candidate) => framePreference(candidate.identity) === 0) || pending <= 0) finishSweep()
    }
    const timer = setTimeout(finishSweep, perFrameMs)
    let sweepError: unknown
    try {
      void Promise.all(frames.map(async (frame) => {
        let probeReply: { ok?: unknown; result?: unknown; error?: unknown } | undefined
        try {
          probeReply = await sendMessageWithBudget(tabId, probeMessageFor(message), frame.frameId, perFrameMs)
        } catch (error) {
          if (isProbeTimeout(error)) { pending -= 1; considerReady(); return }
          if (!isMissingReceivingEnd(error)) { sweepError = error; finishSweep(); return }
          if (healedFrameIds.has(frame.frameId)) { lastMissingReceiver = error; pending -= 1; considerReady(); return }
          healedFrameIds.add(frame.frameId)
          try {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: OFFICE_CONTENT_SCRIPT_FILES })
            probeReply = await sendMessageWithBudget(tabId, probeMessageFor(message), frame.frameId, Math.max(0, deadline - Date.now()))
          } catch (retryError) {
            if (isProbeTimeout(retryError)) { pending -= 1; considerReady(); return }
            if (!isMissingReceivingEnd(retryError)) { sweepError = retryError; finishSweep(); return }
            lastMissingReceiver = retryError
            pending -= 1
            considerReady()
            return
          }
        }
        if (probeSucceeded(probeReply)) readyByFrameId.set(frame.frameId, { frame, identity: probeIdentityOf(probeReply) })
        pending -= 1
        considerReady()
      }))
      await sweepDone
      if (sweepError !== undefined) throw sweepError
    } finally {
      clearTimeout(timer)
    }
    const readyCandidates = frames.flatMap((frame) => {
      const candidate = readyByFrameId.get(frame.frameId)
      return candidate ? [candidate] : []
    })
    if (readyCandidates.length > 0) {
      const chosen = readyCandidates.reduce((best, candidate) => framePreference(candidate.identity) < framePreference(best.identity) ? candidate : best)
      const operationBudgetMs = officeFrameOperationBudgetMs()
      try {
        const reply = await sendMessageWithBudget(tabId, message, chosen.frame.frameId, operationBudgetMs)
        return { reply, frame: chosen.frame }
      } catch (error) {
        if (isProbeTimeout(error)) {
          throw { code: 'timeout', message: `The WebEdit iframe did not finish the ${channelReadyLabel(String(message.type))} operation within ${Math.round(operationBudgetMs / 100) / 10}s.` } satisfies OfficeReadFailure
        }
        throw error
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(OFFICE_PROBE_RETRY_MS, Math.max(0, deadline - Date.now()))))
  }
  if (lastMissingReceiver !== undefined) throw lastMissingReceiver
  const channel = String(message.type)
  const siblingType = siblingProbeType(channel)
  let siblingReadyCount = 0
  if (siblingType !== null) {
    const siblingBudgetMs = 250
    await Promise.all(frames.map(async (frame) => {
      try {
        const siblingReply = await sendMessageWithBudget(tabId, { type: siblingType, action: 'probe' }, frame.frameId, siblingBudgetMs)
        if (probeSucceeded(siblingReply)) siblingReadyCount += 1
      } catch { /* diagnostic-only probe: an unreachable frame simply does not count */ }
    }))
  }
  const hint = siblingType === null || siblingReadyCount === 0
    ? ''
    : siblingType === 'office-spreadsheet/v1'
      ? ` ${siblingReadyCount} of them expose a ready WebEdit spreadsheet runtime instead — this Browser Target hosts a spreadsheet, so call read_work_tab.`
      : ` ${siblingReadyCount} of them expose a ready WebEdit light-document editor instead — this Browser Target hosts a document, so call light_document_read.`
  throw { code: 'unsupported', message: `The bound Browser Target has ${frames.length} WebEdit iframe(s), but none exposed a ready ${channelReadyLabel(channel)} within ${Math.round(waitBudgetMs / 100) / 10}s.${hint}` } satisfies OfficeReadFailure
}

async function waitForTeamDocWritableFrame(tabId: number, timeoutMs = 30_000): Promise<chrome.webNavigation.GetAllFrameResultDetails | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }) ?? [])
      .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
    if (frames.length > 0) {
      try {
        const { reply, frame } = await sendToWebEditFrame(tabId, frames, { type: 'office-document/v1', action: 'probe' })
        const latest = await chrome.webNavigation.getAllFrames({ tabId }) ?? []
        if (reply?.ok === true && latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) return frame
      } catch { /* the editor is still mounting or its iframe was rebuilt; retry within the write budget */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

async function readOfficeDocument(request: OfficeDocumentRequest): Promise<Record<string, unknown>> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
    throw { code: 'navigation', message: 'The trusted Browser Target changed before the light document could be read.' } satisfies OfficeReadFailure
  }
  const tab = await chrome.tabs.get(request.browserTarget.tabId)
  if (tab.windowId !== request.browserTarget.windowId || tab.url !== request.browserTarget.url) {
    throw { code: 'navigation', message: 'The trusted Browser Target navigated before the light document could be read.' } satisfies OfficeReadFailure
  }
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? [])
    .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
  if (frames.length === 0) throw { code: 'unsupported', message: 'The bound Browser Target has no supported WebEdit iframe.' } satisfies OfficeReadFailure
  try {
    const { reply, frame } = await sendToWebEditFrame(request.browserTarget.tabId, frames, {
      type: 'office-document/v1', action: request.action,
      ...(request.offset === undefined ? {} : { offset: request.offset }), ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.query === undefined ? {} : { query: request.query }), ...(request.operation === undefined ? {} : { operation: request.operation }),
      ...(request.payload === undefined ? {} : { payload: request.payload }), ...(request.resource === undefined ? {} : { resource: request.resource }),
    })
    if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while handling the light document.' }
    const latest = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
    if (!latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) {
      throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while handling the light document.' } satisfies OfficeReadFailure
    }
    return reply.result as Record<string, unknown>
  } catch (error) { throw officeReadFailure(error) }
}

function respondToOfficeDocument(port: chrome.runtime.Port, request: OfficeDocumentRequest): void {
  // ADR-0006: reads may run concurrently, but writes against one Resource
  // Identity pass through a Write Fence. A write
  // leaves the global lifecycle chain and is serialized per resource
  // fingerprint, so two documents edit in parallel while the same document's
  // read-patch-readback cycles can never interleave.
  const execute = async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const result = request.action === 'write' && request.resource ? await queueResourceWrite(request.resource, () => readOfficeDocument(request)) : await readOfficeDocument(request)
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return result
  }
  const respond = (settled: Promise<Record<string, unknown>>) => settled
    .then((result) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
    .catch((error: unknown) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: officeReadFailure(error) }))
  if (request.action === 'write' && request.resource) void respond(execute())
  else void respond(queueNativeLifecycle(execute))
}

async function queueResourceWrite<T>(resource: { origin: string; fingerprint: string }, action: () => Promise<T>): Promise<T> {
  const key = `${resource.origin}|${resource.fingerprint}`
  const prior = resourceWriteQueues.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => { release = resolve })
  resourceWriteQueues.set(key, prior.then(() => current))
  await prior
  try {
    return await action()
  } finally {
    release()
    if (resourceWriteQueues.get(key) === current) resourceWriteQueues.delete(key)
  }
}

function extractTeamDocParentId(url: string): string | null {
  try {
    const parsed = new URL(url)
    for (const candidate of [parsed.pathname, parsed.hash.replace(/^#/, '')]) {
      const documentMatch = /\/teamKnowledge\/detail\/docOnline\/(\d+)(?:[/?]|$)/i.exec(candidate)
      if (documentMatch?.[1]) return documentMatch[1]
      if (/\/docOnline\//i.test(candidate)) continue
      const directoryMatch = /\/teamKnowledge\/(?:detail\/)?(?:catalog|directory|folder)\/(\d+)(?:[/?]|$)/i.exec(candidate)
      if (directoryMatch?.[1]) return directoryMatch[1]
      const query = candidate.split('?')[1]
      const hashCatalogId = query ? new URLSearchParams(query).get('catalogId')?.trim() : null
      if (hashCatalogId && /^\d+$/.test(hashCatalogId)) return hashCatalogId
    }
    if (/\/teamKnowledge(?:\/|$)/i.test(parsed.pathname + parsed.hash)) {
      const catalogId = parsed.searchParams.get('catalogId')?.trim()
      if (catalogId && /^\d+$/.test(catalogId)) return catalogId
    }
    return null
  } catch {
    return null
  }
}

async function inspectTeamDocParentInPage(catalogId: string, documentDetail = false, trustedLightDocument = false): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, error: 'team_doc_wrong_origin' }
  }
  type TeamDocAttempt = { stage: string; httpStatus: number; errorCode: string | null }
  type TeamDocReply = { response: Response; payload: Record<string, unknown> | null }
  type TeamDocStageResult = { reply: TeamDocReply | null; diagnostic: TeamDocAttempt }
  const parse = async (response: Response): Promise<TeamDocReply> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const payload = JSON.parse(lossless) as unknown
      return { response, payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null }
    } catch { return { response, payload: null } }
  }
  const stageRequest = async (path: string, stage: string, headers?: Record<string, string>): Promise<TeamDocStageResult> => {
    try {
      const reply = await parse(await fetch(`/g-kmp${path}`, { credentials: 'include', ...(headers ? { headers } : {}) }))
      return { reply, diagnostic: { stage, httpStatus: reply.response.status, errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null } }
    } catch {
      return { reply: null, diagnostic: { stage, httpStatus: 0, errorCode: null } }
    }
  }
  const stagePost = async (path: string, stage: string, body: Record<string, string>, headers?: Record<string, string>): Promise<TeamDocStageResult> => {
    try {
      const reply = await parse(await fetch(`/g-kmp${path}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      }))
      return { reply, diagnostic: { stage, httpStatus: reply.response.status, errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null } }
    } catch {
      return { reply: null, diagnostic: { stage, httpStatus: 0, errorCode: null } }
    }
  }
  const successful = (result: TeamDocStageResult | null): result is TeamDocStageResult & { reply: TeamDocReply } =>
    result !== null && result.reply !== null && result.reply.response.ok && result.reply.payload?.errorCode === '00000'
  const dataRecord = (result: TeamDocStageResult | null): Record<string, unknown> | null => {
    const data = result?.reply?.payload?.data
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  }
  const bookIdFromData = (result: TeamDocStageResult | null): string | null => {
    const data = result?.reply?.payload?.data
    if (typeof data === 'string' && /^\d+$/.test(data)) return data
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).bookId === 'string'
      && /^\d+$/.test((data as Record<string, unknown>).bookId as string)) return (data as Record<string, unknown>).bookId as string
    return null
  }
  const failedInspection = (diagnostic: TeamDocAttempt, attempts?: TeamDocAttempt[]) => ({
    ok: false, error: 'team_doc_parent_inspection_failed', diagnostic: { ...diagnostic, ...(attempts ? { attempts } : {}) },
  })
  const capabilities = async (): Promise<Record<string, unknown>> => {
    const attempt = await stageRequest('/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', 'capabilities')
    if (!successful(attempt)) return { diagnostic: attempt.diagnostic }
    const records = Array.isArray(attempt.reply.payload?.data) ? attempt.reply.payload.data : null
    if (records === null) return { diagnostic: attempt.diagnostic }
    const supports = (pattern: RegExp) => records.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return [record.value, record.name, record.icon, record.format]
        .filter((item): item is string => typeof item === 'string')
        .join(' ')
        .match(pattern) !== null
    })
    return { light_document: supports(/newword|lightdoc|轻文档/i), spreadsheet: supports(/newexcel|excel|spreadsheet|表格|xlsx/i) }
  }
  try {
    let resolvedCatalogId = catalogId
    let detailSourceBookId: string | null = null
    const sourceAttempts: TeamDocAttempt[] = []
    if (documentDetail) {
      const openApiAttempt = await stageRequest(
        `/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(catalogId)}`,
        'source_openapi', { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      )
      sourceAttempts.push(openApiAttempt.diagnostic)
      let selectedAttempt = openApiAttempt
      let requireFileType = true
      if (!successful(openApiAttempt)) {
        const catalogAttempt = await stageRequest(
          `/team-knowledge-main/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(catalogId)}`,
          'source_catalog',
        )
        sourceAttempts.push(catalogAttempt.diagnostic)
        if (successful(catalogAttempt)) {
          selectedAttempt = catalogAttempt
        } else {
          const internalAttempt = await stageRequest(
            `/team-knowledge-main/teamKnowledge/get?catalogId=${encodeURIComponent(catalogId)}`,
            'source_internal',
          )
          sourceAttempts.push(internalAttempt.diagnostic)
          if (!successful(internalAttempt)) {
            return failedInspection(internalAttempt.diagnostic, sourceAttempts)
          }
          selectedAttempt = internalAttempt
          requireFileType = false
        }
      }
      const sourceRecord = dataRecord(selectedAttempt) ?? {}
      const sourceId = typeof sourceRecord.catalogId === 'string' ? sourceRecord.catalogId : null
      const sourceParentId = typeof sourceRecord.parentId === 'string' ? sourceRecord.parentId : null
      detailSourceBookId = typeof sourceRecord.bookId === 'string' && /^\d+$/.test(sourceRecord.bookId) ? sourceRecord.bookId : null
      const fileType = sourceRecord.fileType
      if (sourceId !== catalogId || !sourceParentId || !/^\d+$/.test(sourceParentId) || sourceParentId === catalogId
        || (requireFileType && !trustedLightDocument && !((typeof fileType === 'string' && fileType.length > 0) || typeof fileType === 'number'))) {
        return { ok: false, error: 'team_doc_directory_required' }
      }
      const sourceName = [sourceRecord.name, sourceRecord.catalogName, sourceRecord.title]
        .find((value) => typeof value === 'string' && value.trim())
      // `teamKnowledge/get` is the authenticated document-identity fallback
      // for a docOnline URL. Its successful exact catalogId/parentId response
      // does not always expose fileType, so do not discard that verified
      // document merely because the directory-node APIs reject its parent.
      // Permission, bookId and document-children readback still gate use.
      const isLightDocument = trustedLightDocument || !requireFileType || fileType === 4 || (typeof fileType === 'string' && /^(4|newword)$/i.test(fileType.trim()))
      let currentDocumentBookId = detailSourceBookId
      if (currentDocumentBookId === null) {
        const sourceBookAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getBookId?catalogId=${encodeURIComponent(catalogId)}`, 'source_book')
        sourceAttempts.push(sourceBookAttempt.diagnostic)
        if (successful(sourceBookAttempt)) currentDocumentBookId = bookIdFromData(sourceBookAttempt)
      }
      if (isLightDocument && currentDocumentBookId !== null && typeof sourceName === 'string') {
        const permissionAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getPermission?catalogId=${encodeURIComponent(catalogId)}`, 'source_permission')
        sourceAttempts.push(permissionAttempt.diagnostic)
        const sourcePermission = permissionAttempt.reply?.payload?.data
        const sourcePermissionRecord = sourcePermission && typeof sourcePermission === 'object' && !Array.isArray(sourcePermission) ? sourcePermission as Record<string, unknown> : {}
        const sourceCanRead = sourcePermissionRecord.canRead === true
        const sourceCanCreate = sourcePermissionRecord.canAddOrUpload === true
        if (successful(permissionAttempt) && sourceCanRead && sourceCanCreate) {
          const childrenAttempt = await stagePost(
            '/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId', 'source_children',
            { bookId: currentDocumentBookId, parentId: catalogId },
          )
          sourceAttempts.push(childrenAttempt.diagnostic)
          if (successful(childrenAttempt)) {
            const fingerprintSource = `${location.href}|${currentDocumentBookId}|${catalogId}|${sourceName}|${sourceCanRead}|${sourceCanCreate}`
            let hash = 2166136261
            for (let index = 0; index < fingerprintSource.length; index += 1) {
              hash ^= fingerprintSource.charCodeAt(index); hash = Math.imul(hash, 16777619)
            }
            return { ok: true, parent: {
              parentId: catalogId, bookId: currentDocumentBookId, parentName: sourceName, canRead: true, canCreate: true, parentType: 'document',
              fingerprint: `team-doc-parent-v2-${(hash >>> 0).toString(16).padStart(8, '0')}`,
            }, capabilities: await capabilities() }
          }
        }
      }
      resolvedCatalogId = sourceParentId
    }
    let nodeAttempt = await stageRequest(`/team-knowledge-main/teamKnowledge/get?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'node_internal')
    if (!successful(nodeAttempt) && documentDetail) {
      const openApiNodeAttempt = await stageRequest(
        `/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(resolvedCatalogId)}`,
        'node_openapi', { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      )
      if (!successful(openApiNodeAttempt)) {
        const attempts = [...sourceAttempts, nodeAttempt.diagnostic, openApiNodeAttempt.diagnostic]
        return failedInspection(openApiNodeAttempt.diagnostic, documentDetail ? attempts : undefined)
      }
      nodeAttempt = openApiNodeAttempt
    }
    if (!successful(nodeAttempt)) {
      const attempts = [...sourceAttempts, nodeAttempt.diagnostic]
      return failedInspection(nodeAttempt.diagnostic, documentDetail ? attempts : undefined)
    }
    const nodeRecord = dataRecord(nodeAttempt) ?? {}
    const nodeId = typeof nodeRecord.catalogId === 'string' ? nodeRecord.catalogId : resolvedCatalogId
    const parentName = [nodeRecord.name, nodeRecord.catalogName, nodeRecord.title].find((value) => typeof value === 'string' && value.trim())
    const sourceBookId = typeof nodeRecord.bookId === 'string' && /^\d+$/.test(nodeRecord.bookId) ? nodeRecord.bookId : null
    if (nodeId !== resolvedCatalogId || typeof parentName !== 'string') {
      return { ok: false, error: 'team_doc_parent_identity_missing' }
    }
    if (detailSourceBookId !== null && sourceBookId !== null && detailSourceBookId !== sourceBookId) {
      return { ok: false, error: 'team_doc_parent_book_id_mismatch', diagnostic: { ...nodeAttempt.diagnostic, attempts: [nodeAttempt.diagnostic] } }
    }
    const permissionAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getPermission?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'permission')
    if (!successful(permissionAttempt)) return failedInspection(permissionAttempt.diagnostic)
    const permission = permissionAttempt.reply.payload?.data
    const permissionRecord = permission && typeof permission === 'object' && !Array.isArray(permission) ? permission as Record<string, unknown> : {}
    const canRead = permissionRecord.canRead !== false
    const canCreate = permissionRecord.canAddOrUpload === true
    if (!canRead || !canCreate) return { ok: false, error: 'team_doc_parent_permission_denied' }
    const bookAttempt = await stageRequest(`/team-knowledge-main/teamKnowledgeCatalog/getBookId?catalogId=${encodeURIComponent(resolvedCatalogId)}`, 'book_internal')
    let bookId = successful(bookAttempt) ? bookIdFromData(bookAttempt) : null
    if (successful(bookAttempt) && bookId !== null
      && ((sourceBookId !== null && bookId !== sourceBookId) || (detailSourceBookId !== null && bookId !== detailSourceBookId))) {
      return { ok: false, error: 'team_doc_parent_book_id_mismatch', diagnostic: { ...bookAttempt.diagnostic, attempts: [bookAttempt.diagnostic] } }
    }
    if (bookId === null && sourceBookId !== null) bookId = sourceBookId
    if (bookId === null) {
      const derivationDiagnostic: TeamDocAttempt = { stage: 'book_derived', httpStatus: 0, errorCode: null }
      return failedInspection(derivationDiagnostic, [bookAttempt.diagnostic, derivationDiagnostic])
    }
    const fingerprintSource = `${location.href}|${bookId}|${resolvedCatalogId}|${parentName}|${canRead}|${canCreate}`
    let hash = 2166136261
    for (let index = 0; index < fingerprintSource.length; index += 1) {
      hash ^= fingerprintSource.charCodeAt(index); hash = Math.imul(hash, 16777619)
    }
    // Creation is deliberately limited to an existing catalog directory. A
    // document-detail URL is resolved to its parent above; do not treat the
    // document itself, or an untyped catalog response, as a creatable parent.
    const nodeType = [nodeRecord.fileType, nodeRecord.nodeType, nodeRecord.type, nodeRecord.format]
      .find((value) => (typeof value === 'string' && value.trim().length > 0) || typeof value === 'number')
    const isDirectory = nodeType === 11
      || (typeof nodeType === 'string' && /^(11|directory|folder)$/i.test(nodeType.trim()))
    if (!isDirectory) return { ok: false, error: 'team_doc_directory_required' }
    return { ok: true, parent: {
      parentId: resolvedCatalogId, bookId, parentName, canRead: true, canCreate: true,
      parentType: typeof nodeType === 'number' ? String(nodeType) : typeof nodeType === 'string' ? nodeType : 'catalog',
      fingerprint: `team-doc-parent-v2-${(hash >>> 0).toString(16).padStart(8, '0')}`,
    }, capabilities: await capabilities() }
  } catch {
    return { ok: false, error: 'team_doc_parent_inspection_failed' }
  }
}

async function createTeamDocInPage(input: { bookId: string; parentId: string; name: string; kind?: TeamKnowledgeItemKind; parentType?: string }): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'create', error: 'team_doc_wrong_origin' }
  }
  const parse = async (response: Response): Promise<{ response: Response; payload: Record<string, unknown> | null }> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const payload = JSON.parse(lossless) as unknown
      return { response, payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null }
    } catch { return { response, payload: null } }
  }
  const diagnostic = (reply: { response: Response; payload: Record<string, unknown> | null }) => ({
    httpStatus: reply.response.status,
    errorCode: typeof reply.payload?.errorCode === 'string' ? reply.payload.errorCode : null,
  })
  const recordsFrom = (data: unknown): unknown[] => {
    if (Array.isArray(data)) return data
    const pending = data && typeof data === 'object' ? [data as Record<string, unknown>] : []
    const seen = new Set<object>()
    while (pending.length > 0 && seen.size < 32) {
      const record = pending.shift()!
      if (seen.has(record)) continue
      seen.add(record)
      for (const key of ['records', 'list', 'items', 'content', 'rows', 'page']) {
        const value = record[key]
        if (Array.isArray(value)) return value
        if (value && typeof value === 'object') pending.push(value as Record<string, unknown>)
      }
      if (typeof record.catalogId === 'string') return [record]
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
      }
    }
    return []
  }
  const listChildren = async () => {
    const documentParent = input.parentType === 'document'
    const reply = await parse(await fetch(documentParent ? '/g-kmp/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId' : '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(documentParent ? {} : { businessSystem: 'TEAM_KNOWLEDGE_BOOK' }) },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
    }))
    return { reply, records: recordsFrom(reply.payload?.data) }
  }
  const exactId = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? [
        (value as Record<string, unknown>).catalogId,
        (value as Record<string, unknown>).id,
        (value as Record<string, unknown>).pid,
      ].find((candidate): candidate is string => typeof candidate === 'string' && /^\d+$/.test(candidate)) ?? null
    : null
  const recordName = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const name = [record.name, record.fileName, record.catalogName, record.title].find((candidate) => typeof candidate === 'string')
    return typeof name === 'string' ? name : null
  }
  const documentUrl = (record: Record<string, unknown>, documentId: string, fallback?: unknown) => {
    const rawUrl = typeof record.url === 'string' ? record.url : typeof fallback === 'string' ? fallback : `/teamKnowledge/detail/docOnline/${documentId}?id=${documentId}`
    const url = new URL(rawUrl, 'https://doc.midea.com').href
    return new URL(url).origin === 'https://doc.midea.com' ? url : null
  }
  const lightDocumentRecordStatus = (value: unknown): boolean | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const values = [record.fileType, record.fileTypeName, record.fileTypeValue, record.type, record.format, record.fileFormat, record.kind, record.value]
    for (const candidate of values) {
      if (candidate === 4 || candidate === '4') return true
      if (candidate === 8 || candidate === '8') return false
      if (typeof candidate !== 'string') continue
      const normalized = candidate.trim().toLowerCase()
      if (/^(newword|lightdoc|light_document|light-document|轻文档)$/.test(normalized)) return true
      if (/^(newexcel|spreadsheet|excel|xlsx|表格)$/.test(normalized)) return false
    }
    return null
  }
  const exactTypeRecord = async (documentId: string): Promise<Record<string, unknown> | null> => {
    try {
      const reply = await parse(await fetch(`/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(documentId)}`, {
        credentials: 'include', headers: { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      }))
      const record = reply.payload?.data
      return reply.response.ok && reply.payload?.errorCode === '00000' && exactId(record) === documentId && record && typeof record === 'object' && !Array.isArray(record)
        ? record as Record<string, unknown>
        : null
    } catch { return null }
  }
  try {
    const initialChildren = await listChildren()
    if (!initialChildren.reply.response.ok || initialChildren.reply.payload?.errorCode !== '00000') {
      return { ok: false, failedAt: 'create', error: 'team_doc_name_check_failed', diagnostic: diagnostic(initialChildren.reply) }
    }
    const exactName = initialChildren.records.find((value) => recordName(value) === input.name)
    if (exactName) {
      return { ok: false, failedAt: 'create', error: 'team_doc_exact_name_conflict', documentId: null, diagnostic: diagnostic(initialChildren.reply) }
    }
    const fileTypes = await parse(await fetch('/g-kmp/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', { credentials: 'include' }))
    const fileTypeRecords = Array.isArray(fileTypes.payload?.data) ? fileTypes.payload.data : []
    const selectedType = fileTypeRecords.find((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      const descriptor = [record.value, record.name, record.icon, record.format].filter((item) => typeof item === 'string').join(' ')
      return /newword|lightdoc|轻文档/i.test(descriptor)
    }) as Record<string, unknown> | undefined
    const fileType = selectedType?.type
    if (!fileTypes.response.ok || fileTypes.payload?.errorCode !== '00000' || (typeof fileType !== 'number' && typeof fileType !== 'string')) {
      return { ok: false, failedAt: 'create', error: 'team_doc_file_type_unavailable', diagnostic: diagnostic(fileTypes) }
    }
    const createReply = await parse(await fetch('https://apiprod.midea.com/g-kmp/team-knowledge-main/teamKnowledge/add', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-cache', 'X-Original-Referer': document.referrer, 'x-app-id': '' },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId, fileName: input.name, fileType }),
    }))
    const data = createReply.payload?.data
    const created = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
    const documentId = exactId(created)
    if (!createReply.response.ok || createReply.payload?.errorCode !== '00000' || !documentId || !/^\d+$/.test(documentId)) {
      return { ok: false, failedAt: 'create', error: 'team_doc_create_failed', diagnostic: diagnostic(createReply) }
    }
    let children = await listChildren()
    let match = children.records.find((value) => exactId(value) === documentId && recordName(value) === input.name) as Record<string, unknown> | undefined
    if (!match && children.reply.response.ok && children.reply.payload?.errorCode === '00000') {
      const renamed = await parse(await fetch('/g-kmp/team-knowledge-main/teamKnowledgeCatalog/rename', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: documentId, name: input.name }),
      }))
      if (!renamed.response.ok || renamed.payload?.errorCode !== '00000') {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rename_failed', documentId, diagnostic: diagnostic(renamed) }
      }
      children = await listChildren()
      match = children.records.find((value) => exactId(value) === documentId && recordName(value) === input.name) as Record<string, unknown> | undefined
    }
    if (!children.reply.response.ok || children.reply.payload?.errorCode !== '00000' || !match) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId, diagnostic: diagnostic(children.reply) }
    }
    const url = documentUrl(match, documentId, created.url)
    if (!url) return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId }
    // A document-parent listing may omit its child's file type or expose a
    // symbolic alias (for example `newword`). Keep the exact same-parent
    // lookup, then use the exact child record when the listing cannot identify
    // the dynamically created light-document kind.
    const actualIsLightDocument = lightDocumentRecordStatus(match) ?? lightDocumentRecordStatus(await exactTypeRecord(documentId))
    if (actualIsLightDocument === null) {
      return { ok: true, documentId, catalogId: documentId, kind: 'light_document', provisionalKind: true, url }
    }
    if (!actualIsLightDocument) {
      return { ok: false, failedAt: 'rediscover', error: 'team_knowledge_item_type_mismatch', documentId, catalogId: documentId, url, diagnostic: diagnostic(children.reply) }
    }
    return { ok: true, documentId, catalogId: documentId, kind: 'light_document', url }
  } catch {
    return { ok: false, failedAt: 'create', error: 'team_doc_create_failed' }
  }
}

async function rediscoverTeamDocInPage(input: {
  bookId: string
  parentId: string
  documentId: string
  name?: string
  kind?: TeamKnowledgeItemKind
  parentType?: string
  renameOnMismatch?: boolean
}): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_wrong_origin', documentId: input.documentId }
  }
  try {
    const documentParent = input.parentType === 'document'
    const recordsFrom = (data: unknown): unknown[] => {
      if (Array.isArray(data)) return data
      const pending = data && typeof data === 'object' ? [data as Record<string, unknown>] : []
      const seen = new Set<object>()
      while (pending.length > 0 && seen.size < 32) {
        const record = pending.shift()!
        if (seen.has(record)) continue
        seen.add(record)
      for (const key of ['records', 'list', 'items', 'content', 'rows', 'page']) {
        const value = record[key]
        if (Array.isArray(value)) return value
        if (value && typeof value === 'object') pending.push(value as Record<string, unknown>)
      }
      if (typeof record.catalogId === 'string') return [record]
      for (const value of Object.values(record)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
        }
      }
      return []
    }
    const readChildren = async () => {
      const response = await fetch(documentParent ? '/g-kmp/team-knowledge-main/teamKnowledgeCatalog/getDataByParentId' : '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(documentParent ? {} : { businessSystem: 'TEAM_KNOWLEDGE_BOOK' }) },
        body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
      })
      const text = await response.text()
      const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
        .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
      const parsed = JSON.parse(lossless) as unknown
      const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      return { response, payload, records: recordsFrom(payload?.data), diagnostic: { httpStatus: response.status, errorCode: typeof payload?.errorCode === 'string' ? payload.errorCode : null } }
    }
    const recordName = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      return [record.name, record.fileName, record.catalogName, record.title]
        .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0) ?? null
    }
    const requestedName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name : null
    const matchingRecord = (records: unknown[]) => records.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && [
        (value as Record<string, unknown>).catalogId,
        (value as Record<string, unknown>).id,
        (value as Record<string, unknown>).pid,
      ].some((candidate) => candidate === input.documentId)
      && (requestedName === null || recordName(value) === requestedName)) as Record<string, unknown> | undefined
    const lightDocumentStatus = (value: unknown): boolean | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      const values = [record.fileType, record.fileTypeName, record.fileTypeValue, record.type, record.format, record.fileFormat, record.kind, record.value]
      for (const candidate of values) {
        if (candidate === 4 || candidate === '4') return true
        if (candidate === 8 || candidate === '8') return false
        if (typeof candidate !== 'string') continue
        const normalized = candidate.trim().toLowerCase()
        if (/^(newword|lightdoc|light_document|light-document|轻文档)$/.test(normalized)) return true
        if (/^(newexcel|spreadsheet|excel|xlsx|表格)$/.test(normalized)) return false
      }
      return null
    }
    const exactTypeRecord = async (): Promise<Record<string, unknown> | null> => {
      try {
        const response = await fetch(`/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(input.documentId)}`, {
          credentials: 'include', headers: { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
        })
        const text = await response.text()
        const lossless = text.replace(/"(bookId|catalogId|parentId|id|pid)"\s*:\s*(\d+)/g, '"$1":"$2"')
          .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
        const payload = JSON.parse(lossless) as { errorCode?: unknown; data?: unknown }
        const record = payload.data
        const recordId = record && typeof record === 'object' && !Array.isArray(record)
          ? [(record as Record<string, unknown>).catalogId, (record as Record<string, unknown>).id, (record as Record<string, unknown>).pid]
            .find((candidate): candidate is string => candidate === input.documentId)
          : null
        return response.ok && payload.errorCode === '00000' && recordId && record && typeof record === 'object' && !Array.isArray(record)
          ? record as Record<string, unknown>
          : null
      } catch { return null }
    }
    let children = await readChildren()
    if (!children.response.ok || children.payload?.errorCode !== '00000') {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
    }
    const located = children.records.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && [(value as Record<string, unknown>).catalogId, (value as Record<string, unknown>).id, (value as Record<string, unknown>).pid]
        .some((candidate) => candidate === input.documentId)) as Record<string, unknown> | undefined
    if (!located) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
    }
    let match = matchingRecord(children.records)
    if (!match) {
      // A readback is strictly read-only. It may identify the child by
      // catalogId alone, but it must never rename a remotely stored item just
      // to satisfy a stale or omitted caller-provided name.
      if (input.renameOnMismatch !== true || requestedName === null) {
        return {
          ok: false,
          failedAt: 'rediscover',
          error: requestedName === null ? 'team_doc_rediscover_mismatch' : 'team_doc_name_mismatch',
          documentId: input.documentId,
          name: recordName(located),
          diagnostic: children.diagnostic,
        }
      }
      const renameResponse = await fetch('/g-kmp/team-knowledge-main/teamKnowledgeCatalog/rename', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: input.documentId, name: input.name }),
      })
      const renameText = await renameResponse.text()
      const renamePayload = JSON.parse(renameText) as { errorCode?: unknown }
      const renameDiagnostic = { httpStatus: renameResponse.status, errorCode: typeof renamePayload?.errorCode === 'string' ? renamePayload.errorCode : null }
      if (!renameResponse.ok || renamePayload?.errorCode !== '00000') {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rename_failed', documentId: input.documentId, diagnostic: renameDiagnostic }
      }
      children = await readChildren()
      match = matchingRecord(children.records)
      if (!children.response.ok || children.payload?.errorCode !== '00000' || !match) {
        return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
      }
    }
    const rawUrl = typeof match.url === 'string' ? match.url : `/teamKnowledge/detail/docOnline/${input.documentId}?id=${input.documentId}`
    const url = new URL(rawUrl, 'https://doc.midea.com').href
    if (new URL(url).origin !== 'https://doc.midea.com') return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId: input.documentId }
    if (input.kind !== undefined) {
      const fileTypesResponse = await fetch('/g-kmp/team-knowledge-main/teamKnowledge/getAllFileType?createFlag=true', { credentials: 'include' })
      const fileTypesText = await fileTypesResponse.text()
      const fileTypesPayload = JSON.parse(fileTypesText) as { errorCode?: unknown; data?: unknown }
      const fileTypes = Array.isArray(fileTypesPayload.data) ? fileTypesPayload.data : []
      const expected = fileTypes.find((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const record = value as Record<string, unknown>
        const descriptor = [record.value, record.name, record.icon, record.format].filter((item) => typeof item === 'string').join(' ')
        return /newword|lightdoc|轻文档/i.test(descriptor)
      }) as Record<string, unknown> | undefined
      if (!fileTypesResponse.ok || fileTypesPayload.errorCode !== '00000' || !expected) {
        return { ok: true, recovered: true, documentId: input.documentId, catalogId: input.documentId, kind: input.kind, name: recordName(match) ?? recordName(located), provisionalKind: true, url }
      }
      const actualIsLightDocument = lightDocumentStatus(match) ?? lightDocumentStatus(await exactTypeRecord())
      if (actualIsLightDocument === null) return { ok: true, recovered: true, documentId: input.documentId, catalogId: input.documentId, kind: input.kind, name: recordName(match) ?? recordName(located), provisionalKind: true, url }
      if (!actualIsLightDocument) {
        return { ok: false, failedAt: 'rediscover', error: 'team_knowledge_item_type_mismatch', documentId: input.documentId, diagnostic: children.diagnostic }
      }
    }
    return {
      ok: true,
      recovered: true,
      documentId: input.documentId,
      catalogId: input.documentId,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      name: recordName(match) ?? recordName(located),
      url,
    }
  } catch {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_failed', documentId: input.documentId }
  }
}

async function writeTeamDocInWebEdit(body: string, readOnly = false): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'webedit.midea.com') {
    return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_wrong_origin' : 'team_doc_wrong_webedit_origin' }
  }
  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const decodeXml = (xml: string) => {
    const text = xml.replace(/<codeBlock\b[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/codeBlock>/gi, '$1\n')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<\/(t[dh])>/gi, '</$1>')
      .replace(/<\/t[dh]>/gi, '\t').replace(/<\/tr>/gi, '\n')
      .replace(/<\/(p|outlineTitle|li|table|blockquote|pre|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/\t+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
    const decoder = document.createElement('textarea'); decoder.innerHTML = text
    return decoder.value
  }
  try {
    let app: any = null
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      app = (globalThis as typeof globalThis & { APP?: unknown }).APP
      if (app?.openApi?.editor?.canvas?.getDocXml && (readOnly || app?.openApi?.editor?.document?.selection?.insertContent)) break
      await wait(100)
    }
    const selection = app?.openApi?.editor?.document?.selection
    const canvas = app?.openApi?.editor?.canvas
    if (!canvas?.getDocXml || (!readOnly && !selection?.insertContent)) return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_unavailable' : 'team_doc_webedit_runtime_unavailable' }
    const beforeXml = await canvas.getDocXml()
    let afterXml = beforeXml
    if (!readOnly) {
      // Match the public WebEdit Markdown call shape. Explicit false
      // positioning flags can move editor selection state without inserting
      // the content, which is observable only through the strict readback.
      await selection!.insertContent({ markdown: body })
    }
    const visibleText = (value: string) => value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .trim()
    const visibleFragments = body.replace(/<!--[\s\S]*?-->/g, '').split(/\n+/).flatMap((sourceLine) => {
      const line = sourceLine.trim()
      if (!line) return []
      if (/^(?:`{3,}|~{3,}|-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return []
      if (/^\|.*\|$/.test(line)) {
        const cells = line.slice(1, -1).split('|').map((cell) => visibleText(cell))
        if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return []
        return [cells.join('\t')]
      }
      const heading = /^#{1,6}\s+/.test(line)
      const withoutBlockPrefix = line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '')
        .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      const withoutHeadingNumber = heading
        ? withoutBlockPrefix.replace(/^\d+(?:\.\d+)*[.)、．]?\s+/, '')
        : withoutBlockPrefix
      const fragment = visibleText(withoutHeadingNumber)
      return fragment ? [fragment] : []
    }).filter(Boolean)
    // WebEdit serializes a large insert in several XML updates. A first XML
    // change proves only that serialization started, not that every visible
    // fragment (including tables and Mermaid text) can be read back.
    const readbackStartedAt = Date.now()
    const readbackDeadline = readbackStartedAt + 15_000
    const minimumObservationMs = 5_000
    const stableXmlMs = 2_000
    let lastXml: string | undefined
    let lastXmlChangedAt = readbackStartedAt
    let observedBody = ''
    let readbackMatches = false
    while (Date.now() <= readbackDeadline) {
      afterXml = await canvas.getDocXml()
      if (typeof afterXml === 'string') {
        if (afterXml !== lastXml) {
          lastXml = afterXml
          lastXmlChangedAt = Date.now()
        }
        observedBody = decodeXml(afterXml)
        readbackMatches = observedBody.length > 0 && visibleFragments.length > 0 && visibleFragments.every((fragment) => observedBody.includes(fragment))
        if (readbackMatches) break
      }
      const elapsed = Date.now() - readbackStartedAt
      if (elapsed >= minimumObservationMs && Date.now() - lastXmlChangedAt >= stableXmlMs) break
      await wait(100)
    }
    if (typeof afterXml !== 'string') return { ok: false, failedAt: 'readback', error: readOnly ? 'team_knowledge_document_persisted_readback_unavailable' : 'team_doc_readback_mismatch' }
    if (!readOnly && afterXml === beforeXml) return { ok: false, failedAt: 'write', error: 'team_doc_write_not_observed' }
    if (readbackMatches && !readOnly) {
      // An XML change proves only the editor's in-memory state. Give WebEdit's
      // asynchronous save/sync cycle a bounded chance to settle before the
      // caller leaves this page. The caller still reopens the same catalogId
      // and performs a fresh read, which remains the authoritative gate.
      const configuredSettleMs = Number((globalThis as typeof globalThis & { __DSH_TEAM_DOC_PERSISTENCE_SETTLE_MS?: unknown }).__DSH_TEAM_DOC_PERSISTENCE_SETTLE_MS)
      const minimumSettleMs = Number.isFinite(configuredSettleMs) && configuredSettleMs >= 0 ? Math.min(configuredSettleMs, 10_000) : 1_500
      const settleStartedAt = Date.now()
      const settleDeadline = settleStartedAt + Math.max(minimumSettleMs, 10_000)
      const booleanSignal = async (names: string[]) => {
        for (const name of names) {
          const candidate = app?.[name]
          try {
            const value = typeof candidate === 'function' ? await candidate.call(app) : candidate
            if (typeof value === 'boolean') return value
          } catch { /* an optional save signal must not replace reopen readback */ }
        }
        return undefined
      }
      while (Date.now() < settleDeadline) {
        const saving = await booleanSignal(['isSaving', 'getIsSaving', 'IsSaving'])
        const syncing = await booleanSignal(['isSyncing', 'getIsSyncing', 'IsSyncing'])
        const busy = saving === true || syncing === true
        if (!busy && Date.now() - settleStartedAt >= minimumSettleMs) break
        await wait(100)
      }
    }
    return readbackMatches
      ? { ok: true, readbackMatches: true, observedBody }
      : { ok: false, failedAt: 'readback', error: readOnly ? 'team_knowledge_document_persisted_readback_mismatch' : 'team_doc_readback_mismatch', observedBody }
  } catch {
    return { ok: false, failedAt: readOnly ? 'readback' : 'write', error: readOnly ? 'team_knowledge_document_persisted_readback_failed' : 'team_doc_webedit_write_failed' }
  }
}

async function assertTeamDocTarget(request: { runId: string; browserTarget: BrowserTarget }): Promise<void> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
    throw new Error('The trusted Browser Target changed before Team Doc execution.')
  }
  const tab = await chrome.tabs.get(request.browserTarget.tabId)
  const actual = targetFromActionTab(tab)
  if (actual === undefined || !sameBrowserTarget(actual, request.browserTarget)) {
    throw new Error('The trusted Browser Target navigated before Team Doc execution.')
  }
}

async function waitForTrustedLightDocumentIdentity(browserTarget: BrowserTarget): Promise<boolean> {
  const configuredWaitMs = Number((globalThis as typeof globalThis & { __DSH_TEAM_DOC_PROBE_WAIT_MS?: unknown }).__DSH_TEAM_DOC_PROBE_WAIT_MS)
  const deadline = Date.now() + (Number.isFinite(configuredWaitMs) && configuredWaitMs >= 0 ? configuredWaitMs : 2_500)
  do {
    const tab = await chrome.tabs.get(browserTarget.tabId)
    const actual = targetFromActionTab(tab)
    if (actual === undefined || !sameBrowserTarget(actual, browserTarget)) {
      throw new Error('The trusted Browser Target navigated before Team Doc inspection.')
    }
    if ((await probeDocumentIdentity(browserTarget.tabId))?.kind === 'webedit_light_document') return true
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return false
}

async function waitForTeamDocTab(tabId: number, expectedUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url === expectedUrl && tab.status === 'complete') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('team_doc_navigation_timeout')
}

function teamKnowledgeItemPartial(input: {
  failedAt: 'inspect' | 'create' | 'rediscover' | 'write' | 'readback' | 'unsupported' | 'confirmation'
  error: string
  stages?: string[]
  item?: { catalogId: string; kind: TeamKnowledgeItemKind; name: string; url: string; fingerprint: string }
  diagnostic?: TeamDocPartialDelivery['diagnostic']
}): object {
  return {
    status: 'partial_delivery', item: input.item ?? null, stages: input.stages ?? [], failedAt: input.failedAt, error: input.error,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
  }
}

function teamKnowledgeItemFingerprint(kind: TeamKnowledgeItemKind, catalogId: string, url: string): string {
  let hash = 2166136261
  const source = `${kind}|${catalogId}|${url}`
  for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16777619) }
  return `team-knowledge-item-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function teamKnowledgeItemUrlMatchesCatalogId(url: string, catalogId: string): boolean {
  try {
    const parsed = new URL(url)
    const pathCatalogId = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '')
    const queryCatalogId = parsed.searchParams.get('id')
    return parsed.origin === 'https://doc.midea.com' && pathCatalogId === catalogId && (queryCatalogId === null || queryCatalogId === catalogId)
  } catch { return false }
}

interface TeamKnowledgeCreateCheckpoint {
  contractHash: string
  catalogId: string
  updatedAt: number
}

async function teamKnowledgeContractHash(request: TeamKnowledgeItemRequest, parent: TeamKnowledgeParent): Promise<string> {
  const source = JSON.stringify({ parentFingerprint: parent.fingerprint, parentId: parent.parentId, bookId: parent.bookId, kind: request.kind, name: request.name, body: request.body })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function loadTeamKnowledgeCreateCheckpoint(idempotencyIdentity: string, contractHash: string): Promise<TeamKnowledgeCreateCheckpoint | null> {
  const stored = (await chrome.storage.local.get(TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY))?.[TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY] as Record<string, TeamKnowledgeCreateCheckpoint> | undefined
  const checkpoint = stored?.[idempotencyIdentity]
  if (!checkpoint) return null
  if (checkpoint.contractHash !== contractHash || typeof checkpoint.catalogId !== 'string' || !/^\d+$/.test(checkpoint.catalogId)) throw new Error('team_knowledge_create_checkpoint_conflict')
  return checkpoint
}

async function saveTeamKnowledgeCreateCheckpoint(idempotencyIdentity: string, checkpoint: TeamKnowledgeCreateCheckpoint): Promise<void> {
  const stored = (await chrome.storage.local.get(TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY))?.[TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY] as Record<string, TeamKnowledgeCreateCheckpoint> | undefined
  const next = { ...(stored ?? {}), [idempotencyIdentity]: checkpoint }
  const ordered = Object.entries(next).sort((left, right) => Number(left[1]?.updatedAt ?? 0) - Number(right[1]?.updatedAt ?? 0))
  while (ordered.length > 256) { const [oldest] = ordered.shift()!; delete next[oldest] }
  await chrome.storage.local.set({ [TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY]: next })
}

async function readCreatedTeamKnowledgeItem(request: TeamKnowledgeItemRequest, item: { catalogId: string; kind: TeamKnowledgeItemKind; name: string; url: string }): Promise<Record<string, unknown>> {
  const frame = await waitForTeamDocWritableFrame(request.browserTarget.tabId)
  if (!frame) throw new Error('team_knowledge_webedit_frame_unavailable')
  const { reply } = await sendToWebEditFrame(request.browserTarget.tabId, [frame], { type: 'office-document/v1', action: 'read', offset: 0, limit: 200 })
  const result = reply?.result as { status?: unknown; resource?: unknown; document?: unknown } | undefined
  if (reply?.ok !== true || result?.status !== 'ok' || !isLightDocumentResourceIdentity(result.resource) || !result.document || typeof result.document !== 'object') throw new Error('team_knowledge_document_readback_unavailable')
  return { resource: result.resource, document: result.document }
}

async function waitForTeamKnowledgeUserConfirmation(input: TeamKnowledgeUserConfirmation & { name: string }): Promise<{ status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded' | 'unavailable' }> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com' || !document.body) return { status: 'unavailable' }
  const stateKey = '__dshTeamKnowledgeUserConfirmation'
  type ConfirmationState = { finish: (status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded') => void }
  const hostWindow = window as Window & { [stateKey]?: ConfirmationState }
  hostWindow[stateKey]?.finish('unloaded')

  return new Promise((resolve) => {
    const previous = document.querySelector('[data-dsh-team-knowledge-confirmation="card"]')
    previous?.remove()
    const card = document.createElement('section')
    card.dataset.dshTeamKnowledgeConfirmation = 'card'
    card.setAttribute('role', 'status')
    card.setAttribute('aria-live', 'polite')
    card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:14px 16px;border:1px solid #d9e2f2;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 12px 32px rgba(15,23,42,.18);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    const title = document.createElement('strong')
    title.dataset.dshTeamKnowledgeConfirmation = 'title'
    title.textContent = `第 ${input.itemIndex} 份 / 共 ${input.totalItems} 份已写入`
    const description = document.createElement('div')
    description.dataset.dshTeamKnowledgeConfirmation = 'document-name'
    description.style.cssText = 'margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    description.textContent = input.name
    const hint = document.createElement('div')
    hint.dataset.dshTeamKnowledgeConfirmation = 'hint'
    hint.style.cssText = 'margin-top:8px;color:#52606d;font-size:12px;'
    hint.textContent = '请确认内容；编辑器会继续自动保存。'
    const actions = document.createElement('div')
    actions.dataset.dshTeamKnowledgeConfirmation = 'actions'
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;'
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.dataset.dshTeamKnowledgeConfirmationAction = 'stop'
    stop.textContent = '停止并留在此文档'
    stop.style.cssText = 'border:0;background:transparent;color:#52606d;cursor:pointer;padding:6px 8px;'
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.dataset.dshTeamKnowledgeConfirmationAction = 'confirm'
    confirm.textContent = '已确认并继续'
    confirm.style.cssText = 'border:0;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;padding:6px 10px;'
    actions.append(stop, confirm)
    card.append(title, description, hint, actions)
    document.body.append(card)

    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('beforeunload', onPageHide)
      stop.removeEventListener('click', onStop)
      confirm.removeEventListener('click', onConfirm)
      card.remove()
      if (hostWindow[stateKey]?.finish === finish) delete hostWindow[stateKey]
    }
    const finish = (status: 'confirmed' | 'stopped' | 'timeout' | 'unloaded') => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ status })
    }
    const onStop = () => finish('stopped')
    const onConfirm = () => finish('confirmed')
    const onPageHide = () => finish('unloaded')
    const timeout = setTimeout(() => finish('timeout'), 10 * 60 * 1_000)
    hostWindow[stateKey] = { finish }
    stop.addEventListener('click', onStop)
    confirm.addEventListener('click', onConfirm)
    window.addEventListener('pagehide', onPageHide, { once: true })
    window.addEventListener('beforeunload', onPageHide, { once: true })
  })
}

function showTeamKnowledgeReadbackFailure(input: { name: string; error: string }): { shown: boolean } {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com' || !document.body) return { shown: false }
  document.querySelector('[data-dsh-team-knowledge-readback-failure="card"]')?.remove()
  const card = document.createElement('section')
  card.dataset.dshTeamKnowledgeReadbackFailure = 'card'
  card.setAttribute('role', 'alert')
  card.setAttribute('aria-live', 'assertive')
  card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:14px 16px;border:1px solid #f0c9c4;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 12px 32px rgba(15,23,42,.18);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
  const title = document.createElement('strong')
  title.textContent = '内容尚未完成验证'
  const description = document.createElement('div')
  description.style.cssText = 'margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  description.textContent = input.name
  const hint = document.createElement('div')
  hint.style.cssText = 'margin-top:8px;color:#8a3b32;font-size:12px;'
  hint.textContent = '文档已保留在当前页，但未能完整回读；检查后请返回原目录，再在侧边栏重试此项。'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '知道了'
  dismiss.style.cssText = 'display:block;margin:12px 0 0 auto;border:0;border-radius:6px;background:#1677ff;color:#fff;cursor:pointer;padding:6px 10px;'
  dismiss.addEventListener('click', () => card.remove())
  card.append(title, description, hint, dismiss)
  document.body.append(card)
  return { shown: true }
}

type TeamDocWebEditReadback = { ok?: unknown; readbackMatches?: unknown; observedBody?: unknown; failedAt?: unknown; error?: unknown }

function teamDocWebEditReadbackMatches(result: TeamDocWebEditReadback | undefined): result is TeamDocWebEditReadback & { ok: true; readbackMatches: true; observedBody: string } {
  return result?.ok === true && result.readbackMatches === true && typeof result.observedBody === 'string'
}

async function pollTeamDocWebEditReadback(tabId: number, frameId: number, body: string, first: TeamDocWebEditReadback | undefined): Promise<TeamDocWebEditReadback | undefined> {
  let result = first
  const deadline = Date.now() + 10_000
  while (true) {
    if (teamDocWebEditReadbackMatches(result)) return result
    if (result?.failedAt !== 'readback' || Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
    result = (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', func: writeTeamDocInWebEdit, args: [body, true] }))[0]?.result as TeamDocWebEditReadback | undefined
  }
}

async function runTeamKnowledgeItemRequest(request: TeamKnowledgeItemRequest): Promise<object> {
  await assertTeamDocTarget(request)
  const parentId = extractTeamDocParentId(request.browserTarget.url)
  if (!parentId) return teamKnowledgeItemPartial({ failedAt: 'inspect', error: 'team_knowledge_parent_id_missing' })
  const documentDetail = /\/teamKnowledge\/detail\/docOnline\//i.test(request.browserTarget.url)
  const trustedLightDocument = documentDetail ? await waitForTrustedLightDocumentIdentity(request.browserTarget) : false
  const inspected = (await chrome.scripting.executeScript({
    target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: inspectTeamDocParentInPage, args: [parentId, documentDetail, trustedLightDocument],
  }))[0]?.result as { ok?: unknown; parent?: unknown; capabilities?: unknown; error?: unknown; diagnostic?: unknown } | undefined
  if (inspected?.ok !== true || !isTeamKnowledgeParent(inspected.parent)) {
    return teamKnowledgeItemPartial({ failedAt: 'inspect', error: typeof inspected?.error === 'string' ? inspected.error : 'team_knowledge_parent_inspection_failed', diagnostic: inspected?.diagnostic as TeamDocPartialDelivery['diagnostic'] })
  }
  const parent = inspected.parent
  if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: inspected.capabilities && typeof inspected.capabilities === 'object' && !Array.isArray(inspected.capabilities) ? inspected.capabilities : {} }
  if (request.action === 'readback') {
    const catalogId = request.catalogId
    if (typeof catalogId !== 'string' || !/^\d+$/.test(catalogId)) return teamKnowledgeItemPartial({ failedAt: 'rediscover', error: 'team_knowledge_item_catalog_id_invalid' })
    if (request.kind !== 'light_document') return teamKnowledgeItemPartial({ failedAt: 'unsupported', error: 'team_knowledge_kind_unsupported' })
    const kind: TeamKnowledgeItemKind = 'light_document'
    const recovered = (await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: rediscoverTeamDocInPage, args: [{ bookId: parent.bookId, parentId: parent.parentId, documentId: catalogId, kind, parentType: parent.parentType, renameOnMismatch: false }] }))[0]?.result as { ok?: unknown; documentId?: unknown; url?: unknown; name?: unknown; error?: unknown } | undefined
    if (recovered?.ok !== true || recovered.documentId !== catalogId || typeof recovered.url !== 'string') return teamKnowledgeItemPartial({ failedAt: 'rediscover', error: typeof recovered?.error === 'string' ? recovered.error : 'team_knowledge_item_rediscover_mismatch' })
    let readback: Record<string, unknown>
    try {
      await chrome.tabs.update(request.browserTarget.tabId, { url: recovered.url }); await waitForTeamDocTab(request.browserTarget.tabId, recovered.url)
      readback = await readCreatedTeamKnowledgeItem(request, { catalogId, kind, name: typeof recovered.name === 'string' ? recovered.name : request.name ?? '', url: recovered.url })
    } catch (error) { return teamKnowledgeItemPartial({ failedAt: 'readback', error: error instanceof Error ? error.message : 'team_knowledge_item_readback_failed' }) }
    finally { try { await chrome.tabs.update(request.browserTarget.tabId, { url: request.browserTarget.url }); await waitForTeamDocTab(request.browserTarget.tabId, request.browserTarget.url) } catch {} }
    const itemName = typeof recovered.name === 'string' ? recovered.name : request.name ?? ''
    const item = { catalogId, kind, name: itemName, url: recovered.url, fingerprint: teamKnowledgeItemFingerprint(kind, catalogId, recovered.url) }
    return { status: 'ok', item, readback }
  }
  if (!request.parent || parent.fingerprint !== request.parent.fingerprint || parent.parentId !== request.parent.parentId || parent.bookId !== request.parent.bookId || parent.parentType !== request.parent.parentType) {
    return teamKnowledgeItemPartial({ failedAt: 'inspect', error: 'team_knowledge_parent_fingerprint_mismatch' })
  }
  if (request.kind !== 'light_document') return teamKnowledgeItemPartial({ failedAt: 'unsupported', error: 'team_knowledge_kind_unsupported' })
  const kind: TeamKnowledgeItemKind = 'light_document'
  const priorStages = request.recovery?.stages ?? []
  const stages = ['parent_inspected', ...priorStages.filter((stage) => stage !== 'parent_inspected')]
  const checkpointContractHash = await teamKnowledgeContractHash(request, parent)
  let checkpoint: TeamKnowledgeCreateCheckpoint | null
  try { checkpoint = await loadTeamKnowledgeCreateCheckpoint(request.idempotencyIdentity!, checkpointContractHash) } catch (error) {
    return teamKnowledgeItemPartial({ failedAt: 'create', error: error instanceof Error ? error.message : 'team_knowledge_create_checkpoint_conflict', stages })
  }
  const recoveryCatalogId = request.recovery?.catalogId ?? checkpoint?.catalogId
  const creatingNewItem = !recoveryCatalogId
  const resolution = recoveryCatalogId
    ? await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: rediscoverTeamDocInPage, args: [{ bookId: parent.bookId, parentId: parent.parentId, documentId: recoveryCatalogId, name: request.name!, kind, parentType: parent.parentType, renameOnMismatch: true }] })
    : await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: createTeamDocInPage, args: [{ bookId: parent.bookId, parentId: parent.parentId, name: request.name!, kind, parentType: parent.parentType }] })
  const created = resolution[0]?.result as { ok?: unknown; documentId?: unknown; catalogId?: unknown; kind?: unknown; provisionalKind?: unknown; url?: unknown; failedAt?: unknown; error?: unknown; diagnostic?: unknown } | undefined
  const catalogId = typeof created?.catalogId === 'string' ? created.catalogId : typeof created?.documentId === 'string' ? created.documentId : null
  const returnedIdsAgree = created?.catalogId === undefined || created?.documentId === undefined || created.catalogId === created.documentId
  const uncertainUrl = typeof created?.url === 'string'
    ? created.url
    : created?.failedAt === 'rediscover' && catalogId && /^\d+$/.test(catalogId)
      ? `https://doc.midea.com/teamKnowledge/detail/docOnline/${catalogId}?id=${catalogId}`
      : null
  const uncertainItem = catalogId && /^\d+$/.test(catalogId) && uncertainUrl !== null && returnedIdsAgree
    ? { catalogId, kind, name: request.name!, url: uncertainUrl, fingerprint: teamKnowledgeItemFingerprint(kind, catalogId, uncertainUrl) }
    : undefined
  if (creatingNewItem && catalogId && /^\d+$/.test(catalogId)) {
    try { await saveTeamKnowledgeCreateCheckpoint(request.idempotencyIdentity!, { contractHash: checkpointContractHash, catalogId, updatedAt: Date.now() }) } catch {
      return teamKnowledgeItemPartial({ item: uncertainItem, stages, failedAt: 'create', error: 'team_knowledge_create_checkpoint_failed' })
    }
  }
  if (created?.ok !== true || !catalogId || !/^\d+$/.test(catalogId) || typeof created.url !== 'string'
    || !returnedIdsAgree
    || (creatingNewItem && created.kind !== kind)
    || (!creatingNewItem && created.kind !== undefined && created.kind !== kind)) {
    return teamKnowledgeItemPartial({ item: uncertainItem, stages, failedAt: created?.failedAt === 'unsupported' ? 'unsupported' : created?.failedAt === 'rediscover' ? 'rediscover' : 'create', error: typeof created?.error === 'string' ? created.error : 'team_knowledge_create_failed', diagnostic: created?.diagnostic as TeamDocPartialDelivery['diagnostic'] })
  }
  for (const stage of ['created', 'rediscovered']) if (!stages.includes(stage)) stages.push(stage)
  const item = { catalogId, kind, name: request.name!, url: created.url, fingerprint: teamKnowledgeItemFingerprint(kind, catalogId, created.url) }
  if (!teamKnowledgeItemUrlMatchesCatalogId(created.url, catalogId)) {
    return teamKnowledgeItemPartial({ item, stages, failedAt: 'readback', error: 'team_knowledge_item_url_catalog_mismatch' })
  }
  let readback: Record<string, unknown>
  let restoreParentAfterLightDocument = true
  try {
    await chrome.tabs.update(request.browserTarget.tabId, { url: created.url }); await waitForTeamDocTab(request.browserTarget.tabId, created.url)
    // A same-parent catalog entry can be authoritative for identity but not
    // its file type. In that narrowly bounded case, obtain the existing
    // WebEdit resource identity before any body mutation.
    if (created.provisionalKind === true) await readCreatedTeamKnowledgeItem(request, item)
    const frame = await waitForTeamDocWritableFrame(request.browserTarget.tabId)
    if (!frame) throw new Error('team_knowledge_webedit_frame_unavailable')
    const initialWrite = (await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId, frameIds: [frame.frameId] }, world: 'MAIN', func: writeTeamDocInWebEdit, args: [request.body!] }))[0]?.result as TeamDocWebEditReadback | undefined
    const write = await pollTeamDocWebEditReadback(request.browserTarget.tabId, frame.frameId, request.body!, initialWrite)
    if (!teamDocWebEditReadbackMatches(write)) throw new Error(typeof write?.error === 'string' ? write.error : 'team_knowledge_document_readback_mismatch')
    if (!stages.includes('body_written')) stages.push('body_written')
    if (request.userConfirmation) {
      // The in-memory XML readback above is complete, but must not be
      // mistaken for persistent delivery. Keep the document open while the
      // user reviews it; only an explicit confirmation permits navigation.
      restoreParentAfterLightDocument = false
      let confirmation: { status?: unknown } | undefined
      try {
        confirmation = (await chrome.scripting.executeScript({
          target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: waitForTeamKnowledgeUserConfirmation,
          args: [{ ...request.userConfirmation, name: request.name! }],
        }))[0]?.result as { status?: unknown } | undefined
      } catch {
        return teamKnowledgeItemPartial({ item, stages, failedAt: 'confirmation', error: 'team_knowledge_user_confirmation_page_unloaded' })
      }
      if (confirmation?.status !== 'confirmed') {
        const error = confirmation?.status === 'stopped'
          ? 'team_knowledge_user_confirmation_stopped'
          : confirmation?.status === 'timeout'
            ? 'team_knowledge_user_confirmation_timeout'
            : confirmation?.status === 'unloaded'
              ? 'team_knowledge_user_confirmation_page_unloaded'
              : 'team_knowledge_user_confirmation_unavailable'
        return teamKnowledgeItemPartial({ item, stages, failedAt: 'confirmation', error })
      }
      restoreParentAfterLightDocument = true
    }
    await chrome.tabs.update(request.browserTarget.tabId, { url: request.browserTarget.url }); await waitForTeamDocTab(request.browserTarget.tabId, request.browserTarget.url)
    await chrome.tabs.update(request.browserTarget.tabId, { url: created.url }); await waitForTeamDocTab(request.browserTarget.tabId, created.url)
    const reopenedFrame = await waitForTeamDocWritableFrame(request.browserTarget.tabId)
    if (!reopenedFrame) throw new Error('team_knowledge_webedit_frame_unavailable')
    const persistedReadback = (await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId, frameIds: [reopenedFrame.frameId] }, world: 'MAIN', func: writeTeamDocInWebEdit, args: [request.body!, true] }))[0]?.result as TeamDocWebEditReadback | undefined
    if (!teamDocWebEditReadbackMatches(persistedReadback)) throw new Error(typeof persistedReadback?.error === 'string' ? persistedReadback.error : 'team_knowledge_document_persisted_readback_mismatch')
    readback = { body: persistedReadback.observedBody }
    if (!stages.includes('readback_verified')) stages.push('readback_verified')
  } catch (error) {
    restoreParentAfterLightDocument = false
    try {
      await chrome.scripting.executeScript({
        target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: showTeamKnowledgeReadbackFailure,
        args: [{ name: request.name!, error: error instanceof Error ? error.message : 'team_knowledge_item_readback_failed' }],
      })
    } catch { /* The verified-write failure is still returned when the page prompt cannot be injected. */ }
    return teamKnowledgeItemPartial({ item, stages, failedAt: 'readback', error: error instanceof Error ? error.message : 'team_knowledge_item_readback_failed' })
  } finally {
    if (restoreParentAfterLightDocument) {
      try { await chrome.tabs.update(request.browserTarget.tabId, { url: request.browserTarget.url }); await waitForTeamDocTab(request.browserTarget.tabId, request.browserTarget.url) } catch {}
    }
  }
  const expected = ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified']
  stages.sort((left, right) => expected.indexOf(left) - expected.indexOf(right))
  return { status: 'verified_write', item, stages, readback }
}

function respondToTeamKnowledgeItem(port: chrome.runtime.Port, request: TeamKnowledgeItemRequest): void {
  void queueNativeLifecycle(async () => {
    if (nativePort !== port) throw new Error('Team Knowledge item request belongs to a stale Native connection.')
    // Team Knowledge batch/item calls may be the first tool after the user
    // selects another document in the same tab. Resolve and migrate the live
    // Browser Target here instead of requiring an list_work_tabs preflight.
    const binding = await resolveOfficeBrowserTarget({
      type: request.type,
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      browserTarget: request.browserTarget,
      tool: 'list_work_tabs',
    })
    const resolvedRequest = { ...request, browserTarget: binding.browserTarget }
    const result = await runTeamKnowledgeItemRequest(resolvedRequest)
    if (nativePort !== port) throw new Error('Team Knowledge item request became stale before completion.')
    return { browserTarget: binding.browserTarget, result }
  }).then(({ browserTarget, result }) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget, result }))
    .catch((error: unknown) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: asError(error) }))
}

function settleTargetTransfer(requestId: unknown, payload: NativeTransferPayload): void {
  if (typeof requestId !== 'string') return
  if (!isNativeTransferPayload(payload)) return
  const pending = pendingTargetTransfers.get(requestId)
  if (pending === undefined) return
  clearTimeout(pending.timeout)
  pendingTargetTransfers.delete(requestId)
  boundBrowserTargets.set(payload.runId, {
    browserTarget: payload.browserTarget,
    browserTargets: payload.browserTargets ?? [payload.browserTarget],
    unavailableBrowserTargets: payload.unavailableBrowserTargets ?? [],
  })
  pending.resolve()
}

function rejectTargetTransfer(requestId: unknown, error: unknown): void {
  if (typeof requestId !== 'string') return
  const pending = pendingTargetTransfers.get(requestId)
  if (pending === undefined) return
  clearTimeout(pending.timeout)
  pendingTargetTransfers.delete(requestId)
  pending.reject(new Error(typeof error === 'string' ? error : 'Native rejected Browser Target transfer.'))
}

function rejectTargetTransfers(error: Error): void {
  for (const pending of pendingTargetTransfers.values()) {
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  pendingTargetTransfers.clear()
}

function disconnectNativePort(port: chrome.runtime.Port): void {
  if (nativePort !== port) return
  const runtimeError = chrome.runtime.lastError
  const error = runtimeError?.message ?? 'Native server disconnected.'
  console.error('[deepseek-harness] Native Messaging disconnected:', error)
  nativeUrl = undefined
  nativeRuntimeIdentity = undefined
  knowledgeProxyConfig = undefined
  nativePort = undefined
  boundBrowserTargets.clear()
  rejectTargetTransfers(new Error(error))
  void chrome.runtime.sendMessage({
    type: 'harness-disconnected',
    error,
  }).catch(() => {})
}

function connectNativePort(): chrome.runtime.Port {
  if (nativePort !== undefined) return nativePort
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  port.onDisconnect.addListener(() => disconnectNativePort(port))
  port.onMessage.addListener((message: NativeMessage) => {
    if (isConnectorRequest(message)) {
      respondToConnector(port, message)
      return
    }
    if (isReadWorkTabRequest(message)) {
      respondToReadWorkTab(port, message)
      return
    }
    if (isOfficeDocumentRequest(message)) {
      respondToOfficeDocument(port, message)
      return
    }
    if (isTeamKnowledgeItemRequest(message)) {
      respondToTeamKnowledgeItem(port, message)
      return
    }
    if (isKnowledgeQueryRequest(message)) {
      void respondToKnowledge(port, message)
      return
    }
    if (isSelectedSourceScopeRequest(message)) {
      void respondToSelectedSourceScope(port, message)
      return
    }
    if (isKnowledgeCancel(message)) {
      activeKnowledgeQueries.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'browser_target_transferred') {
      settleTargetTransfer(message.requestId, message.payload as NativeTransferPayload)
      return
    }
    if (message.type === 'browser_target_transfer_failed') {
      rejectTargetTransfer(message.requestId, message.error)
      return
    }
    if (message.type !== 'server_started') return
    const payload = message.payload as NativeStartPayload | undefined
    if (typeof payload?.url !== 'string') return
    if (validKnowledgeProxyConfig(payload.knowledgeProxyUrl, payload.knowledgeProxyToken)) knowledgeProxyConfig = { url: payload.knowledgeProxyUrl, token: payload.knowledgeProxyToken as string }
    nativeRuntimeIdentity = runtimeIdentitySummary(payload.runtimeIdentity)
    nativeUrl = payload.url
    void publishHarnessReady(nativeUrl)
  })
  nativePort = port
  return port
}

async function transferBrowserTarget(runId: unknown, binding: BrowserTargetBinding, requestId: string = crypto.randomUUID()): Promise<void> {
  if (typeof runId !== 'string' || runId.length === 0 || !isBrowserTarget(binding.browserTarget)
    || binding.browserTargets.length === 0 || !binding.browserTargets.every(isBrowserTarget)) {
    throw new Error('transfer-browser-target requires a Run id and an explicit Chrome Browser Target.')
  }
  if (nativePort === undefined) throw new Error('Harness is not connected; no running Run can be migrated.')
  const tab = await chrome.tabs.get(binding.browserTarget.tabId)
  const verifiedTarget = targetFromActionTab(tab)
  if (verifiedTarget === undefined || !sameBrowserTarget(verifiedTarget, binding.browserTarget)) {
    throw new Error('Browser Target changed before transfer. Select an available tab and retry.')
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTargetTransfers.delete(requestId)
      reject(new Error('Timed out waiting for Native to confirm Browser Target transfer.'))
    }, TRANSFER_TIMEOUT_MS)
    pendingTargetTransfers.set(requestId, { resolve, reject, timeout })
    try {
      nativePort?.postMessage({ type: 'transfer-browser-target', requestId, runId, browserTarget: binding.browserTarget, ...nativeBindingFields(binding) })
    } catch (error) {
      clearTimeout(timeout)
      pendingTargetTransfers.delete(requestId)
      reject(new Error(asError(error)))
    }
  })
}

function startHarness(binding?: BrowserTargetBinding): Promise<string> {
  // A live Native Host owns the current Run. Settings and ambient tab changes
  // are candidates for a later Run, never an implicit migration of this one.
  if (nativeUrl !== undefined) return Promise.resolve(nativeUrl)
  if (startPromise !== undefined) return startPromise
  startPromise = new Promise<string>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const port = connectNativePort()
    const cleanup = (): void => {
      port.onDisconnect.removeListener(onDisconnect)
      port.onMessage.removeListener(onMessage)
      if (timeout !== undefined) clearTimeout(timeout)
    }
    const onDisconnect = (): void => {
      if (settled) return
      settled = true
      cleanup()
      const runtimeError = chrome.runtime.lastError
      reject(new Error(runtimeError?.message ?? 'Native Messaging disconnected before native-server was ready.'))
    }
    const onMessage = (message: NativeMessage): void => {
      if (message.type === 'server_started') {
        const payload = message.payload as NativeStartPayload | undefined
        if (typeof payload?.url === 'string') {
          if (typeof payload.runId !== 'string' || payload.runId.length === 0) {
            settled = true
            cleanup()
            reject(new Error('Native server did not confirm a trusted Harness Run.'))
            return
          }
          nativeUrl = payload.url
          nativeRuntimeIdentity = runtimeIdentitySummary(payload.runtimeIdentity)
          if (validKnowledgeProxyConfig(payload.knowledgeProxyUrl, payload.knowledgeProxyToken)) knowledgeProxyConfig = { url: payload.knowledgeProxyUrl, token: payload.knowledgeProxyToken as string }
          if (binding !== undefined) boundBrowserTargets.set(payload.runId, binding)
          settled = true
          cleanup()
          resolve(payload.url)
        }
        return
      }
      if (message.type === 'error') {
        settled = true
        cleanup()
        reject(new Error(typeof message.error === 'string' ? message.error : 'Native server failed to start.'))
      }
    }
    port.onDisconnect.addListener(onDisconnect)
    port.onMessage.addListener(onMessage)
    try {
      port.postMessage({ type: 'start', ...(binding === undefined ? { browserTarget: undefined } : { browserTarget: binding.browserTarget, ...nativeBindingFields(binding) }) })
    } catch (error) {
      settled = true
      cleanup()
      reject(new Error(asError(error)))
    }
    timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      port.onMessage.removeListener(onMessage)
      reject(new Error('Timed out waiting for native-server.'))
    }, START_TIMEOUT_MS)
  }).finally(() => {
    startPromise = undefined
  })
  return startPromise
}

function markdownReviewKey(sessionId: string, resourceId: string): string {
  return `${sessionId}\u0000${resourceId}`
}

function isMarkdownReviewTabUrl(value: unknown, expectedReviewId?: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const actual = new URL(value)
    const expected = new URL(chrome.runtime.getURL('markdown-review.html'))
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && (expectedReviewId === undefined || actual.searchParams.get('reviewId') === expectedReviewId)
  } catch { return false }
}

function isMarkdownReviewSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab?.id !== undefined && isMarkdownReviewTabUrl(sender.url)
}

function isSidePanelSender(sender: chrome.runtime.MessageSender): boolean {
  if (typeof sender.url !== 'string') return false
  try {
    const actual = new URL(sender.url)
    const expected = new URL(chrome.runtime.getURL('sidepanel.html'))
    return actual.origin === expected.origin && actual.pathname === expected.pathname
  } catch { return false }
}

function isPrototypeStudioSender(sender: chrome.runtime.MessageSender, projectId?: string): boolean {
  if (sender.tab?.id === undefined || typeof sender.url !== 'string') return false
  try {
    const actual = new URL(sender.url); const expected = new URL(chrome.runtime.getURL('prototype-studio.html'))
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && (projectId === undefined || actual.searchParams.get('projectId') === projectId)
  } catch { return false }
}

async function persistedMarkdownReviews(): Promise<Record<string, PersistedMarkdownReview>> {
  const storage = chrome.storage?.session
  if (storage === undefined) return {}
  const value = (await storage.get(MARKDOWN_REVIEW_STORAGE_KEY))[MARKDOWN_REVIEW_STORAGE_KEY]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, PersistedMarkdownReview> : {}
}

async function persistMarkdownReview(record: MarkdownReviewRecord): Promise<void> {
  const storage = chrome.storage?.session
  if (storage === undefined) return
  const reviews = await persistedMarkdownReviews()
  reviews[record.reviewId] = {
    reviewId: record.reviewId,
    harnessSessionId: record.harnessSessionId,
    resourceId: record.resourceId,
    displayPath: record.displayPath,
    revision: record.revision,
    fingerprint: record.fingerprint,
    tabId: record.tabId,
    windowId: record.windowId,
  }
  await storage.set({ [MARKDOWN_REVIEW_STORAGE_KEY]: reviews })
}

async function forgetPersistedMarkdownReview(reviewIdValue: string): Promise<void> {
  const storage = chrome.storage?.session
  if (storage === undefined) return
  const reviews = await persistedMarkdownReviews()
  if (reviews[reviewIdValue] === undefined) return
  delete reviews[reviewIdValue]
  await storage.set({ [MARKDOWN_REVIEW_STORAGE_KEY]: reviews })
}

async function recoverMarkdownReview(reviewIdValue: string, tabId: number): Promise<MarkdownReviewRecord | undefined> {
  const persisted = (await persistedMarkdownReviews())[reviewIdValue]
  if (persisted === undefined || persisted.reviewId !== reviewIdValue || persisted.tabId !== tabId
    || !reviewId(persisted.harnessSessionId) || !reviewId(persisted.resourceId)) return undefined
  const requestId = crypto.randomUUID()
  const response = await chrome.runtime.sendMessage({
    type: 'markdown-review-rehydrate-forward/v1',
    requestId,
    review: { reviewId: persisted.reviewId, harnessSessionId: persisted.harnessSessionId, resourceId: persisted.resourceId },
  }) as { ok?: boolean; review?: unknown; error?: string } | undefined
  if (response?.ok !== true || !isOpenMarkdownReview(response.review)) return undefined
  const review = response.review
  if (review.reviewId !== persisted.reviewId || review.harnessSessionId !== persisted.harnessSessionId || review.resourceId !== persisted.resourceId) return undefined
  const tab = await chrome.tabs.get(tabId)
  if (tab.id !== tabId || tab.windowId !== persisted.windowId) return undefined
  const record = { ...review, tabId, windowId: tab.windowId } satisfies MarkdownReviewRecord
  markdownReviews.set(record.reviewId, record)
  markdownReviewKeys.set(markdownReviewKey(record.harnessSessionId, record.resourceId), record.reviewId)
  await persistMarkdownReview(record)
  return record
}

async function openMarkdownReviewTab(review: OpenMarkdownReview): Promise<MarkdownReviewRecord> {
  const key = markdownReviewKey(review.harnessSessionId, review.resourceId)
  const existingId = markdownReviewKeys.get(key)
  const existing = existingId === undefined ? undefined : markdownReviews.get(existingId)
  if (existing !== undefined) {
    try {
      const tab = await chrome.tabs.get(existing.tabId)
      if (tab.id === existing.tabId && review.reviewId === existing.reviewId && isMarkdownReviewTabUrl(tab.url, existing.reviewId)) {
        const updated = { ...existing, ...review, tabId: existing.tabId, windowId: tab.windowId } satisfies MarkdownReviewRecord
        markdownReviews.delete(existing.reviewId)
        markdownReviews.set(review.reviewId, updated)
        markdownReviewKeys.set(key, review.reviewId)
        await chrome.tabs.update?.(existing.tabId, { active: true })
        markdownReviewPorts.get(existing.tabId)?.postMessage({ v: 1, type: 'markdown-review-target-updated', requestId: crypto.randomUUID(), reviewId: review.reviewId })
        await persistMarkdownReview(updated)
        return updated
      }
    } catch { /* stale registry entry; create a replacement below */ }
  }

  const window = await chrome.windows.getLastFocused()
  if (window.id === undefined || window.id < 0) throw new Error('Chrome could not identify the window for Markdown review.')
  try {
    const target = await activeBrowserTarget(window.id)
    await updateBrowserTargetSettings(settings => ({ ...settings, candidate: target }))
  } catch { /* opening review remains allowed when Browser Target mode is none */ }
  const url = new URL(chrome.runtime.getURL('markdown-review.html'))
  url.searchParams.set('reviewId', review.reviewId)
  const tab = await chrome.tabs.create({ windowId: window.id, active: true, url: url.toString() })
  if (tab.id === undefined) throw new Error('Chrome did not return the Markdown Review Tab identity.')
  const record = { ...review, tabId: tab.id, windowId: tab.windowId } satisfies MarkdownReviewRecord
  markdownReviews.set(record.reviewId, record)
  markdownReviewKeys.set(key, record.reviewId)
  await persistMarkdownReview(record)
  return record
}

async function workspaceReviewSnapshot(record: MarkdownReviewRecord): Promise<{ v: 1; type: 'markdown-review-snapshot'; reviewId: string; harnessSessionId: string; resource: { resourceId: string; displayPath: string; revision: string; fingerprint: string }; content: string; truncated: boolean; readOnly: true }> {
  const base = nativeUrl ?? await startHarnessForSettings()
  const endpoint = new URL(WORKSPACE_REVIEW_SNAPSHOT_PATH, base)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.capability}` },
    body: JSON.stringify({ reviewId: record.reviewId }),
  })
  const payload = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `workspace review snapshot failed: HTTP ${String(response.status)}`)
  const resource = payload.resource as Record<string, unknown> | undefined
  if (payload.v !== 1 || payload.type !== 'markdown-review-snapshot' || payload.reviewId !== record.reviewId
    || resource === undefined || resource.resourceId !== record.resourceId || resource.displayPath !== record.displayPath
    || !reviewId(resource.revision) || !reviewId(resource.fingerprint)
    || !boundedReviewText(payload.content, 2_000_000, true) || typeof payload.truncated !== 'boolean' || payload.readOnly !== true) {
    throw new Error('Harness returned an invalid Markdown review snapshot.')
  }
  record.revision = resource.revision
  record.fingerprint = resource.fingerprint
  return {
    v: 1,
    type: 'markdown-review-snapshot',
    reviewId: record.reviewId,
    harnessSessionId: record.harnessSessionId,
    resource: { resourceId: record.resourceId, displayPath: record.displayPath, revision: record.revision, fingerprint: record.fingerprint },
    content: payload.content,
    truncated: payload.truncated,
    readOnly: true,
  }
}

async function workspaceReviewHostRequest(record: MarkdownReviewRecord, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = nativeUrl ?? await startHarnessForSettings()
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.capability}` },
    body: JSON.stringify({ reviewId: record.reviewId, ...body }),
  })
  const payload = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `workspace review request failed: HTTP ${String(response.status)}`)
  return payload
}

async function workspaceReviewProposals(record: MarkdownReviewRecord, afterSequence: number): Promise<Record<string, unknown>> {
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_PROPOSALS_PATH, { afterSequence })
  if (payload.v !== 1 || payload.reviewId !== record.reviewId || !Array.isArray(payload.proposals) || payload.proposals.length > 20) throw new Error('Harness returned invalid Markdown proposals.')
  for (const raw of payload.proposals) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Harness returned an invalid Markdown proposal.')
    const proposal = raw as Record<string, unknown>
    const document = proposal.kind === 'document' && boundedReviewText(proposal.candidateMarkdown, 2_000_000, true)
      && Object.keys(proposal).every(key => ['proposalId', 'selectionId', 'sequence', 'baseFingerprint', 'kind', 'candidateMarkdown', 'summary'].includes(key))
    const selection = proposal.kind === 'selection' && boundedReviewText(proposal.replacementMarkdown, 100_000, true)
      && Number.isSafeInteger(proposal.editorRevision) && (proposal.editorRevision as number) >= 0 && Number.isSafeInteger(proposal.from) && Number.isSafeInteger(proposal.to)
      && (proposal.from as number) >= 0 && (proposal.to as number) > (proposal.from as number)
      && Object.keys(proposal).every(key => ['proposalId', 'selectionId', 'sequence', 'baseFingerprint', 'kind', 'replacementMarkdown', 'editorRevision', 'from', 'to', 'summary'].includes(key))
    if (!reviewId(proposal.proposalId) || !reviewId(proposal.selectionId) || !Number.isSafeInteger(proposal.sequence) || (proposal.sequence as number) <= afterSequence
      || !reviewId(proposal.baseFingerprint) || !boundedReviewText(proposal.summary, 1_000, true) || (!document && !selection)) {
      throw new Error('Harness returned an invalid Markdown proposal.')
    }
  }
  return payload
}

async function prepareMarkdownWrite(record: MarkdownReviewRecord, request: PrepareWriteRequest): Promise<Record<string, unknown>> {
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_PREPARE_WRITE_PATH, { expected: request.expected, content: request.content })
  const prepared = payload.status === 'prepared' && Object.keys(payload).every(key => ['status', 'approval', 'contentHash', 'expiresAt'].includes(key))
    && reviewId(payload.approval) && reviewId(payload.contentHash) && Number.isSafeInteger(payload.expiresAt) && (payload.expiresAt as number) > Date.now()
  if (!prepared && !(payload.status === 'conflict' && Object.keys(payload).every(key => ['status', 'latest'].includes(key)) && isHostMarkdownSnapshot(payload.latest, record))) {
    throw new Error('Harness returned an invalid Markdown write preparation.')
  }
  return payload
}

async function commitMarkdownWrite(record: MarkdownReviewRecord, request: CommitWriteRequest): Promise<Record<string, unknown>> {
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_COMMIT_WRITE_PATH, {
    approval: request.approval, idempotencyKey: request.idempotencyKey, content: request.content,
  })
  const verified = payload.status === 'verified_write' && Object.keys(payload).every(key => ['status', 'resource', 'contentHash'].includes(key))
    && reviewId(payload.contentHash) && validWriteResource(payload.resource, record)
  const conflict = payload.status === 'conflict' && Object.keys(payload).every(key => ['status', 'latest'].includes(key)) && isHostMarkdownSnapshot(payload.latest, record)
  const uncertain = payload.status === 'uncertain' && Object.keys(payload).every(key => ['status', 'message'].includes(key)) && boundedReviewText(payload.message, 4_000)
  if (!verified && !conflict && !uncertain) throw new Error('Harness returned an invalid Markdown write result.')
  if (payload.status === 'verified_write') {
    const resource = payload.resource as Record<string, unknown> | undefined
    if (resource === undefined || resource.resourceId !== record.resourceId || !reviewId(resource.revision) || !reviewId(resource.fingerprint)) throw new Error('Harness returned an invalid Markdown readback identity.')
    record.revision = resource.revision as string; record.fingerprint = resource.fingerprint as string
    await persistMarkdownReview(record)
  }
  return payload
}

function validWriteResource(value: unknown, record: MarkdownReviewRecord): value is { resourceId: string; displayPath: string; revision: string; fingerprint: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const resource = value as Record<string, unknown>
  return Object.keys(resource).every(key => ['resourceId', 'displayPath', 'revision', 'fingerprint'].includes(key))
    && resource.resourceId === record.resourceId && resource.displayPath === record.displayPath
    && reviewId(resource.revision) && reviewId(resource.fingerprint)
}

function isHostMarkdownSnapshot(value: unknown, record: MarkdownReviewRecord): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  return Object.keys(snapshot).every(key => ['v', 'type', 'reviewId', 'resource', 'content', 'truncated', 'readOnly'].includes(key))
    && snapshot.v === 1 && snapshot.type === 'markdown-review-snapshot' && snapshot.reviewId === record.reviewId
    && validWriteResource(snapshot.resource, record) && boundedReviewText(snapshot.content, 2_000_000, true)
    && typeof snapshot.truncated === 'boolean' && snapshot.readOnly === true
}

function markdownReviewError(error: unknown, code: 'snapshot_unavailable' | 'delivery_rejected'): { code: string; message: string; reopenRequired?: boolean } {
  const message = asError(error)
  const reopenRequired = /capability|authorization|reopen|not found|unavailable/i.test(message)
  return { code, message, ...(reopenRequired ? { reopenRequired: true } : {}) }
}

async function deliverMarkdownReview(record: MarkdownReviewRecord, request: DeliverRequest): Promise<string> {
  if (request.harnessSessionId !== record.harnessSessionId || request.annotation.id !== request.deliveryId) {
    throw new Error('Markdown review delivery does not match its bound Harness session.')
  }
  const snapshot = await workspaceReviewSnapshot(record)
  const anchor = request.annotation.anchor
  if (anchor.sourceFingerprint !== snapshot.resource.fingerprint || (anchor.version === 1
    && (anchor.endUtf16 > snapshot.content.length || snapshot.content.slice(anchor.startUtf16, anchor.endUtf16) !== anchor.quote))) {
    throw new Error('Markdown selection is stale. Re-read the file and select the text again.')
  }
  const feedback = {
    id: request.annotation.id,
    harnessSessionId: record.harnessSessionId,
    reviewId: record.reviewId,
    resourceId: record.resourceId,
    displayPath: record.displayPath,
    revision: snapshot.resource.revision,
    fingerprint: snapshot.resource.fingerprint,
    anchorKind: anchor.version === 2 ? 'visual' : 'source',
    quote: anchor.quote,
    comment: request.annotation.comment,
    selectionId: request.annotation.id,
    ...(anchor.version === 1
      ? { startUtf16: anchor.startUtf16, endUtf16: anchor.endUtf16, prefix: anchor.prefix, suffix: anchor.suffix }
      : { editorRevision: anchor.editorRevision, from: anchor.from, to: anchor.to, blocks: anchor.blocks }),
  }
  await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_SELECTION_PATH, { selection: { id: request.annotation.id, ...anchor } })
  const response = await chrome.runtime.sendMessage({ type: 'markdown-review-feedback-forward/v1', feedback }) as { ok?: boolean; error?: string } | undefined
  if (response?.ok !== true) throw new Error(response?.error ?? 'The bound Harness Side Panel is unavailable. Reopen it and resend the annotation.')
  return request.annotation.id
}

export default defineBackground(() => {
  const sidePanel = chrome.sidePanel
  chrome.runtime.onConnect?.addListener((port) => {
    if (port.name !== MARKDOWN_REVIEW_PORT || !isMarkdownReviewSender(port.sender ?? {})) {
      port.disconnect()
      return
    }
    const tabId = port.sender?.tab?.id
    if (tabId === undefined) { port.disconnect(); return }
    markdownReviewPorts.set(tabId, port)
    port.onMessage.addListener((message: unknown) => {
      if (!isMarkdownReviewPortRequest(message)) return
      void (async () => {
        const current = markdownReviews.get(message.reviewId)
        const record = current?.tabId === tabId ? current : await recoverMarkdownReview(message.reviewId, tabId)
        if (record === undefined) {
          port.postMessage({ v: 1, type: `${message.type.replace(/-request$/, '')}-response`, requestId: message.requestId, ok: false, error: { code: 'review_not_found', message: '审阅授权已失效。请从文件树重新打开。', reopenRequired: true } })
          return
        }
        if (message.type === 'markdown-review-snapshot-request') {
          const snapshot = await workspaceReviewSnapshot(record)
          port.postMessage({ v: 1, type: 'markdown-review-snapshot-response', requestId: message.requestId, ok: true, snapshot })
          return
        }
        if (message.type === 'markdown-review-proposals-request') {
          const proposals = await workspaceReviewProposals(record, message.afterSequence as number)
          port.postMessage({ v: 1, type: 'markdown-review-proposals-response', requestId: message.requestId, ok: true, ...proposals })
          return
        }
        if (message.type === 'markdown-review-prepare-write-request') {
          const preparation = await prepareMarkdownWrite(record, message)
          port.postMessage({ v: 1, type: 'markdown-review-prepare-write-response', requestId: message.requestId, ok: true, preparation })
          return
        }
        if (message.type === 'markdown-review-commit-write-request') {
          const result = await commitMarkdownWrite(record, message)
          port.postMessage({ v: 1, type: 'markdown-review-commit-write-response', requestId: message.requestId, ok: true, result })
          return
        }
        const deliveryId = await deliverMarkdownReview(record, message)
        port.postMessage({ v: 1, type: 'markdown-review-deliver-response', requestId: message.requestId, ok: true, deliveryId })
      })().catch(error => port.postMessage({
        v: 1,
        type: `${message.type.replace(/-request$/, '')}-response`,
        requestId: message.requestId,
        ok: false,
        error: markdownReviewError(error, message.type === 'markdown-review-snapshot-request' ? 'snapshot_unavailable' : 'delivery_rejected'),
      }))
    })
    port.onDisconnect.addListener(() => { if (markdownReviewPorts.get(tabId) === port) markdownReviewPorts.delete(tabId) })
  })
  chrome.action?.onClicked.addListener((tab) => {
    const browserTarget = targetFromActionTab(tab)
    if (browserTarget === undefined) {
      console.error('[deepseek-harness] Action click had no explicit Browser Target.')
      return
    }
    if (sidePanel?.open === undefined) return
    void (async () => {
      const settings = await readBrowserTargetSettings()
      await saveBrowserTargetSettings({ ...settings, candidate: browserTarget })
      const binding = await resolveBrowserTarget(settings, browserTarget)
      await startHarness(binding)
    })().catch((error: unknown) => {
      console.error('[deepseek-harness] Failed to bind Browser Target and start Harness:', error)
    })
    void sidePanel.open({ windowId: browserTarget.windowId }).catch((error: unknown) => {
      console.error('[deepseek-harness] Failed to open side panel:', error)
    })
  })

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false
    }
    const request = message as { type?: unknown; surface?: unknown; windowId?: unknown; tabId?: unknown; settings?: unknown; runId?: unknown; browserTarget?: unknown; sessionId?: unknown; scope?: unknown; enabled?: unknown; remember?: unknown; action?: unknown; refresh?: unknown; review?: unknown; command?: unknown; requestId?: unknown; apiKey?: unknown; protocol?: unknown; requestedModelId?: unknown; projectId?: unknown; prompt?: unknown; selection?: unknown; targetRevisionId?: unknown; expectedCurrentRevisionId?: unknown }
    if (request.type === 'open-markdown-review/v1') {
      if (!isSidePanelSender(sender) || !isOpenMarkdownReview(request.review)) {
        sendResponse({ ok: false, error: 'Invalid Markdown review handoff.' })
        return false
      }
      void openMarkdownReviewTab(request.review)
        .then(record => sendResponse({ ok: true, reviewId: record.reviewId, tabId: record.tabId }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'ensure-harness') {
      void startHarnessForSettings()
        .then((url) => sendResponse({ ok: true, url }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'switch-harness-surface/v1') {
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0 || (request.sessionId !== undefined && !validSessionIdentity(request.sessionId))) {
        sendResponse({ ok: false, error: 'Chrome could not switch the Harness Workspace to a Tab.' })
        return false
      }
      const windowId = request.windowId as number
      if (request.surface === 'fullscreen-tab') {
        if (chrome.tabs?.create === undefined || chrome.sidePanel?.close === undefined) {
          sendResponse({ ok: false, error: 'Chrome could not switch the Harness Workspace to a Tab.' })
          return false
        }
        void (async () => {
          const url = new URL(chrome.runtime.getURL('sidepanel.html'))
          url.searchParams.set('dshHarnessSurface', 'fullscreen-tab')
          if (typeof request.sessionId === 'string') url.searchParams.set('dshHarnessSessionId', request.sessionId)
          const tab = await chrome.tabs.create({ windowId, active: true, url: url.toString() })
          try {
            await chrome.sidePanel.close({ windowId })
          } catch (error) {
            if (tab.id !== undefined && chrome.tabs.remove !== undefined) await chrome.tabs.remove(tab.id).catch(() => {})
            throw error
          }
        })()
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
        return true
      }
      if (request.surface === 'sidepanel') {
        sendResponse({ ok: false, error: 'The full-screen Harness Tab must open the side panel from its user click.' })
        return false
      }
      sendResponse({ ok: false, error: 'Chrome could not switch the Harness Workspace to the side panel.' })
      return false
    }
    if (request.type === 'prepare-sidepanel-handoff/v1') {
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0 || !Number.isInteger(request.tabId) || (request.tabId as number) < 0 || !validSessionIdentity(request.sessionId) || chrome.tabs?.get === undefined) {
        sendResponse({ ok: false, error: 'Chrome could not prepare the Harness side-panel handoff.' })
        return false
      }
      const windowId = request.windowId as number
      const tabId = request.tabId as number
      const sessionId = request.sessionId
      pendingSidePanelHandoffs.set(windowId, { sessionId, tabId, expiresAt: Date.now() + SIDE_PANEL_HANDOFF_TTL_MS })
      void (async () => {
        try {
          const tab = await chrome.tabs.get(tabId)
          if (tab?.windowId !== windowId) throw new Error('The full-screen Harness Tab is no longer in this browser window.')
        } catch (error) {
          const handoff = pendingSidePanelHandoffs.get(windowId)
          if (handoff?.tabId === tabId && handoff.sessionId === sessionId) pendingSidePanelHandoffs.delete(windowId)
          throw error
        }
      })()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'get-sidepanel-handoff/v1') {
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0) {
        sendResponse({ ok: false, error: 'Chrome could not identify the side-panel window.' })
        return false
      }
      const windowId = request.windowId as number
      const handoff = pendingSidePanelHandoffs.get(windowId)
      if (handoff === undefined || handoff.expiresAt <= Date.now()) {
        pendingSidePanelHandoffs.delete(windowId)
        sendResponse({ ok: true })
        return false
      }
      sendResponse({ ok: true, sessionId: handoff.sessionId, tabId: handoff.tabId })
      return false
    }
    if (request.type === 'session-handoff-applied/v1') {
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0 || !Number.isInteger(request.tabId) || (request.tabId as number) < 0 || !validSessionIdentity(request.sessionId) || chrome.tabs?.get === undefined || chrome.tabs?.remove === undefined) {
        sendResponse({ ok: false, error: 'Chrome could not complete the Harness side-panel handoff.' })
        return false
      }
      const windowId = request.windowId as number
      const tabId = request.tabId as number
      const handoff = pendingSidePanelHandoffs.get(windowId)
      if (handoff !== undefined && handoff.expiresAt <= Date.now()) {
        pendingSidePanelHandoffs.delete(windowId)
      }
      const activeHandoff = pendingSidePanelHandoffs.get(windowId)
      if (activeHandoff !== undefined && (activeHandoff.tabId !== tabId || activeHandoff.sessionId !== request.sessionId)) {
        sendResponse({ ok: false, error: 'The Harness side-panel handoff does not match the restored session.' })
        return false
      }
      void (async () => {
        const tab = await chrome.tabs.get(tabId)
        if (tab?.windowId !== windowId) throw new Error('The full-screen Harness Tab is no longer in this browser window.')
        // The full-screen Tab configures the replacement Side Panel's local
        // path in its click task. That URL is an exact fallback if the panel
        // starts before this worker has recorded its advisory pending entry.
        if (activeHandoff === undefined) {
          const url = new URL(tab.url ?? '')
          if (url.origin !== new URL(chrome.runtime.getURL('/')).origin
            || url.searchParams.get('dshHarnessSurface') !== 'fullscreen-tab') {
            throw new Error('The Harness side-panel handoff is no longer current.')
          }
        }
        await chrome.tabs.remove(tabId)
        pendingSidePanelHandoffs.delete(windowId)
        await chrome.sidePanel?.setOptions({ path: 'sidepanel.html' })
      })()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'get-active-tab/v1') {
      void refreshCurrentActiveTab(false)
        .then((tab) => tab === undefined
          ? sendResponse({ ok: false, error: 'The active Chrome tab cannot be read.' })
          : sendResponse({ ok: true, epoch: activeTabEpoch, sequence: activeTabSequence, tab }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'search-progress-snapshot/v1') {
      sendResponse({ ok: true, progress: [...searchProgressSnapshots.values()] })
      return false
    }
    if (request.type === 'company-gateway-probe/v1') {
      if (!isSidePanelSender(sender) || typeof request.requestId !== 'string' || request.requestId.length === 0 || request.requestId.length > 160 || !usableCompanyGatewayKey(request.apiKey)
        || (request.protocol !== 'anthropic-messages' && request.protocol !== 'openai-completions')
        || (request.requestedModelId !== undefined && (typeof request.requestedModelId !== 'string' || request.requestedModelId.length === 0 || request.requestedModelId.length > 160))) {
        sendResponse({ ok: false, error: 'Invalid company gateway probe.' })
        return false
      }
      const requestId = request.requestId
      const apiKey = request.apiKey
      const protocol = request.protocol
      const modelId = request.requestedModelId as string | undefined
      void probeCompanyGateway(apiKey, protocol, modelId)
        .then((gateway) => sendResponse({ ok: true, requestId, gateway }))
        .catch((error: unknown) => sendResponse({ ok: false, requestId, error: asError(error) }))
      return true
    }
    if (request.type === 'account-access/v1') {
      if (request.command !== 'refresh' && request.command !== 'login' && request.command !== 'logout') {
        sendResponse({ ok: false, error: 'Invalid account command.' })
        return false
      }
      const command = request.command
      void (async () => {
        if (command === 'logout') return locallySignOutAccount()
        if (command === 'login') {
          await setAccountLocallySignedOut(false)
          knowledgeCatalogCache = undefined
          await chrome.tabs.create({ url: KNOWLEDGE_LOGIN_URL, active: true })
        }
        return accountAccessSnapshot()
      })()
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'knowledge-scope/v1') {
      if (!validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: 'Invalid Harness session identity.' })
        return false
      }
      const sessionId = request.sessionId
      void (async () => {
        if (knowledgeProxyConfig === undefined) await startHarnessForSettings()
        if (request.action === 'login' || request.action === 'retry') {
          knowledgeCatalogCache = undefined
        }
        if (request.action === 'login') {
          await setAccountLocallySignedOut(false)
          await chrome.tabs.create({ url: KNOWLEDGE_LOGIN_URL, active: true })
        }
        if (request.scope !== undefined || typeof request.enabled === 'boolean' || typeof request.remember === 'boolean') {
          const existing = (await knowledgeScopes())[sessionId]?.scope
          const nextScope = request.scope ?? existing ?? { domainId: '', systemIds: [], repositoryIds: [] }
          if (!validScope(nextScope)) throw new Error('Invalid knowledge selection.')
          await saveKnowledgeScope(sessionId, nextScope, typeof request.enabled === 'boolean' ? request.enabled : undefined, typeof request.remember === 'boolean' ? request.remember : undefined)
        }
        const record = (await knowledgeScopes())[sessionId]
        const preference = await knowledgeEnabledPreference()
        const savedScope = record?.scope
        try {
          const catalog = await loadKnowledgeCatalog()
          const scope = savedScope === undefined ? savedScope : pruneScope(savedScope, catalog)
          sendResponse({ ok: true, scope, enabled: record?.enabled ?? (preference.remember ? preference.enabled : true), remember: preference.remember, notice: record?.notice, serviceState: 'ready', catalog })
        } catch (error) {
          const text = asError(error)
          sendResponse({ ok: false, scope: savedScope, enabled: record?.enabled, remember: preference.remember, notice: record?.notice, serviceState: knowledgeServiceState(error), error: text })
        }
      })().catch(async (error: unknown) => {
        const record = (await knowledgeScopes())[sessionId]
        const preference = await knowledgeEnabledPreference()
        sendResponse({
          ok: false,
          scope: record?.scope,
          enabled: record?.enabled ?? (preference.remember ? preference.enabled : true),
          remember: preference.remember,
          notice: record?.notice,
          serviceState: knowledgeServiceState(error),
          error: asError(error),
        })
      })
      return true
    }
    if (request.type === 'restart-harness') {
      void restartHarnessForSettings()
        .then((url) => sendResponse({ ok: true, url }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'get-browser-target-settings') {
      void Promise.all([readBrowserTargetSettings(), availableTabs()])
        .then(([settings, tabs]) => sendResponse({ ok: true, settings, tabs }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'capture-design-reference/v1') {
      if (!isSidePanelSender(sender) || !isBrowserTarget(request.browserTarget) || !validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: 'A trusted Side Panel, Harness session, and explicit Browser Target are required.' })
        return false
      }
      void captureDesignReference(request.browserTarget, request.sessionId)
        .then(({ referenceId, projectId }) => sendResponse({ ok: true, referenceId, projectId }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-snapshot/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId)) { sendResponse({ ok: false, error: 'Invalid Prototype Studio snapshot request.' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('Prototype Studio authorization expired. Capture the reference page again.')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
      })
        .then(snapshot => sendResponse({ ok: true, snapshot }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-restore/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.targetRevisionId !== 'string' || typeof request.expectedCurrentRevisionId !== 'string') { sendResponse({ ok: false, error: 'Invalid Prototype Studio restore request.' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('Prototype Studio authorization expired. Capture the reference page again.')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_RESTORE_PATH, { targetRevisionId: request.targetRevisionId, expectedCurrentRevisionId: request.expectedCurrentRevisionId })
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-prompt/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.prompt !== 'string' || request.prompt.trim().length === 0 || request.prompt.length > 4_000) { sendResponse({ ok: false, error: 'Invalid Prototype Studio AI request.' }); return false }
      const selection = request.selection === undefined ? undefined : request.selection
      if (selection !== undefined && (typeof selection !== 'object' || selection === null || Array.isArray(selection))) { sendResponse({ ok: false, error: 'Invalid Prototype Studio selection.' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('Prototype Studio authorization expired. Capture the reference page again.')
        const snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
        const payload = { projectId: authorization.projectId, sessionId: authorization.sessionId, request: request.prompt, ...(selection === undefined ? {} : { selection }), evidence: snapshot.evidence, revisions: snapshot.revisions, currentRevisionId: snapshot.currentRevisionId, designSpec: snapshot.designSpec, document: snapshot.document }
        if (JSON.stringify(payload).length > 260_000) throw new Error('Prototype Studio AI request is too large.')
        const response = await chrome.runtime.sendMessage({ type: 'prototype-studio-prompt-forward/v1', payload }) as { ok?: boolean; error?: string } | undefined
        if (response?.ok !== true) throw new Error(response?.error ?? 'The Harness Workspace did not accept the prototype request.')
        return response
      }).then(() => sendResponse({ ok: true })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'save-browser-target-settings') {
      const settings = settingsFromUnknown(request.settings)
      void saveBrowserTargetSettings(settings)
        .then((saved) => sendResponse({ ok: true, settings: saved }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'transfer-browser-target') {
      if (!isBrowserTarget(request.browserTarget)) {
        sendResponse({ ok: false, error: 'A Browser Target is required.' })
        return false
      }
      void transferBrowserTarget(request.runId, bindingForTarget(request.browserTarget))
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    return false
  })

  const saveCandidate = (tab: chrome.tabs.Tab): void => {
    const candidate = targetFromActionTab(tab)
    if (candidate === undefined) return
    void updateBrowserTargetSettings((settings) => ({ ...settings, candidate }))
      .catch((error: unknown) => console.error('[deepseek-harness] Failed to save next Browser Target candidate:', error))
  }
  chrome.tabs?.onActivated?.addListener(({ tabId }) => {
    void chrome.tabs.get(tabId).then(saveCandidate).catch(() => {})
    void refreshCurrentActiveTab().catch(() => {})
  })
  chrome.tabs?.onCreated?.addListener(saveCandidate)
  chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.favIconUrl !== undefined)) {
      saveCandidate(tab)
      void refreshCurrentActiveTab().catch(() => {})
    }
  })
  chrome.tabs?.onRemoved?.addListener((tabId, _removeInfo) => {
    markdownReviewPorts.delete(tabId)
    for (const [id, record] of markdownReviews) {
      if (record.tabId !== tabId) continue
      markdownReviews.delete(id)
      markdownReviewKeys.delete(markdownReviewKey(record.harnessSessionId, record.resourceId))
      void forgetPersistedMarkdownReview(id).catch(() => {})
    }
    if (activeTabSnapshot?.tabId !== tabId) return
    void refreshCurrentActiveTab().catch(() => {})
  })
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId < 0) return
    void refreshCurrentActiveTab().catch(() => {})
  })
})
