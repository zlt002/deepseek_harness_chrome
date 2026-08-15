// Kept self-contained because the extension's background test harness imports this
// file as a data URL. The focused adapter test evaluates this exact source block.
const KNOWLEDGE_BASE_URL = 'https://anapi-uat.annto.com/api-sse-kd'
const KNOWLEDGE_SCOPE_STORAGE_KEY = 'harnessKnowledgeScopesV1'
const KNOWLEDGE_SESSION_STORAGE_KEY = 'harnessKnowledgeSessionsV1'
type KnowledgeKind = 'knowledge' | 'code'
interface KnowledgeScope { domainId: string; systemIds: string[]; repositoryIds: string[] }

function validSessionIdentity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) }
function validScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null && ((value as KnowledgeScope).domainId === '' || validSessionIdentity((value as KnowledgeScope).domainId))
    && Array.isArray((value as KnowledgeScope).systemIds) && (value as KnowledgeScope).systemIds.every(validSessionIdentity)
    && Array.isArray((value as KnowledgeScope).repositoryIds) && (value as KnowledgeScope).repositoryIds.every(validSessionIdentity)
}
function normalizeScope(scope: KnowledgeScope): KnowledgeScope { return { domainId: scope.domainId, systemIds: [...new Set(scope.systemIds)], repositoryIds: [...new Set(scope.repositoryIds)] } }
function scopeFingerprint(scope: KnowledgeScope): string { return JSON.stringify([scope.domainId, [...scope.systemIds].sort(), [...scope.repositoryIds].sort()]) }
function payloadArray(value: unknown): unknown[] { return Array.isArray(value) ? value : Array.isArray((value as { data?: unknown } | undefined)?.data) ? (value as { data: unknown[] }).data : [] }
function field(value: unknown, key: string): string | undefined { const item = value as Record<string, unknown> | undefined; return typeof item?.[key] === 'string' && item[key].trim().length > 0 ? item[key].trim() : undefined }
async function knowledgeJson(path: string): Promise<unknown> {
  const response = await fetch(`${KNOWLEDGE_BASE_URL}${path}`, { credentials: 'include' })
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `knowledge_platform_http_${response.status}`)
  return payload
}
async function loadKnowledgeCatalog(domainId?: string): Promise<{ domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string }>; repositories: Array<{ id: string; name: string }> }> {
  const [rawDomains, initialRepos] = await Promise.all([knowledgeJson('/api/domains'), domainId === undefined ? knowledgeJson('/api/repos') : Promise.resolve(undefined)])
  const domains = payloadArray(rawDomains).flatMap((item): Array<{ id: string; name: string }> => { const id = field(item, 'id'); const name = field(item, 'name'); return id === undefined || name === undefined ? [] : [{ id, name }] })
  const repositoriesFrom = (value: unknown) => payloadArray(value).flatMap((item): Array<{ id: string; name: string }> => { const id = field(item, 'id'); return id === undefined ? [] : [{ id, name: field(item, 'name') ?? id }] })
  if (domainId === undefined) return { domains, systems: [], repositories: repositoriesFrom(initialRepos) }
  const [rawSystems, rawRepos] = await Promise.all([knowledgeJson(`/api/domains/systems?domain=${encodeURIComponent(domainId)}`), knowledgeJson(`/api/repos?domain=${encodeURIComponent(domainId)}`)])
  const systems = payloadArray(rawSystems).flatMap((item): Array<{ id: string; name: string }> => { const id = field(item, 'id'); const name = field(item, 'name'); return id === undefined || name === undefined ? [] : [{ id, name }] })
  const repositories = repositoriesFrom(rawRepos)
  return { domains, systems, repositories }
}
function sseEvents(buffer: string, chunk: string): { events: string[]; remainder: string } { const parts = `${buffer}${chunk}`.replace(/\r\n/g, '\n').split('\n\n'); const remainder = parts.pop() ?? ''; return { events: parts.map((part) => part.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean), remainder } }
async function executeKnowledgeQuery(kind: KnowledgeKind, question: string, scope: KnowledgeScope, priorSessionId: string | undefined, signal: AbortSignal): Promise<{ result: { status: 'complete' | 'partial' | 'truncated'; answer: string; sources: Array<{ id: string; title: string }> }; sessionId?: string }> {
  if (kind === 'knowledge' && scope.domainId === '') throw new Error('knowledge_scope_requires_domain')
  if (kind === 'code' && scope.repositoryIds.length === 0) throw new Error('knowledge_scope_requires_repository')
  const body = kind === 'knowledge' ? { question, domain_system_config: { [scope.domainId]: { self: false, systems: scope.systemIds } }, forceRetrieval: true, include_third_party: false, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) } : { question, repo_keys: scope.repositoryIds, stream: true, ...(priorSessionId === undefined ? {} : { session_id: priorSessionId }) }
  const response = await fetch(`${KNOWLEDGE_BASE_URL}/api/rag/${kind === 'knowledge' ? 'retrieval' : 'repo-search'}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal })
  if (!response.ok || response.body === null) throw new Error(`knowledge_platform_http_${response.status}`)
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let answer = ''; let sources: Array<{ id: string; title: string }> = []; let sessionId: string | undefined; let done = false; let marker = false
  try { while (true) { const read = await reader.read(); if (read.done) break; const parsed = sseEvents(buffer, decoder.decode(read.value, { stream: true })); buffer = parsed.remainder; for (const event of parsed.events) { if (event === '[DONE]') { marker = true; continue }; let payload: Record<string, unknown>; try { payload = JSON.parse(event) as Record<string, unknown> } catch { continue }; if (payload.type === 'error') throw new Error(typeof payload.error === 'string' ? payload.error : 'knowledge_platform_error'); if (typeof payload.delta === 'string') answer = `${answer}${payload.delta}`.slice(0, 16_000); if (payload.type === 'citations' || payload.type === 'done') sources = (Array.isArray(payload.citations) ? payload.citations : []).flatMap((item): Array<{ id: string; title: string }> => { const id = field(item, 'page_id') ?? field(item, 'id'); const title = field(item, 'page_title') ?? field(item, 'title'); return id === undefined || title === undefined ? [] : [{ id, title }] }).slice(0, 20); if (payload.type === 'done') { done = true; sessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId } } } } finally { reader.releaseLock() }
  if (!done || !marker) throw new Error('knowledge_platform_incomplete_sse')
  return { result: { status: answer.length >= 16_000 ? 'truncated' : 'complete', answer, sources }, ...(sessionId === undefined ? {} : { sessionId }) }
}

const NATIVE_HOST_NAME = 'com.deepseek.harness.chrome'
const START_TIMEOUT_MS = 30_000
const TARGET_SETTINGS_KEY = 'harnessBrowserTargetSettings'
const TRANSFER_TIMEOUT_MS = 15_000

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
  url?: unknown
  range?: unknown
  values?: unknown
  resource?: unknown
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
}

interface NativeTransferPayload {
  runId?: unknown
  browserTarget?: unknown
  browserTargets?: unknown
  unavailableBrowserTargets?: unknown
}

type BrowserTargetMode = 'follow-active-tab' | 'pinned-tabs' | 'none'

let nativePort: chrome.runtime.Port | undefined
let nativeUrl: string | undefined
let startPromise: Promise<string> | undefined
interface UnavailableBrowserTarget {
  browserTarget: BrowserTarget
  reason: 'closed_or_changed'
}

interface BrowserTargetBinding {
  browserTarget: BrowserTarget
  browserTargets: BrowserTarget[]
  unavailableBrowserTargets: UnavailableBrowserTarget[]
}

const boundBrowserTargets = new Map<string, BrowserTargetBinding>()
const pendingTargetTransfers = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
let settingsMutation: Promise<void> = Promise.resolve()
let nativeLifecycle: Promise<void> = Promise.resolve()

function asError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

interface BrowserTarget {
  browser: 'chrome'
  windowId: number
  tabId: number
  url: string
}

/** Read-only Chrome tab metadata shown by the embedded Harness composer. */
interface ActiveTabSnapshot {
  windowId: number
  tabId: number
  title: string
  url: string
  favIconUrl?: string
}

/** Read-only tab summary used by the Harness iframe target picker. */
interface BrowserTargetTab extends BrowserTarget {
  title: string
  favIconUrl?: string
}

const activeTabEpoch = crypto.randomUUID()
let activeTabSequence = 0
let activeTabSnapshot: ActiveTabSnapshot | undefined
let activeTabRefreshGeneration = 0

interface BrowserTargetSettings {
  mode: BrowserTargetMode
  pinnedTabs: BrowserTarget[]
  primaryTabId?: number
  candidate?: BrowserTarget
}

const defaultBrowserTargetSettings: BrowserTargetSettings = {
  mode: 'follow-active-tab',
  pinnedTabs: [],
}

interface ConnectorRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  browserTarget: BrowserTarget
  browserTargets?: BrowserTarget[]
  unavailableBrowserTargets?: UnavailableBrowserTarget[]
  tool: 'office_get_context'
}

interface OfficeReadRangeRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  browserTarget: BrowserTarget
  tool: 'office_read_range'
  range: string
}

interface OfficeResourceIdentity {
  kind: 'webedit_spreadsheet'
  origin: 'https://webedit.midea.com'
  workbookName: string | null
  sheetName: string | null
  fingerprint: string
}

interface OfficeWriteRangeRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  browserTarget: BrowserTarget
  tool: 'office_write_range'
  range: string
  values: Array<Array<string | number | boolean | null>>
  resource: OfficeResourceIdentity
}

interface OfficeReadFailure {
  code: 'unsupported' | 'preview' | 'readonly' | 'invalid_range' | 'navigation' | 'iframe_replaced' | 'timeout' | 'cancelled' | 'fingerprint_mismatch' | 'readback_mismatch' | 'runtime_error'
  message: string
}

interface TeamDocParent {
  parentId: string
  bookId: string
  parentName: string
  canRead: true
  canCreate: true
  fingerprint: string
}

interface TeamDocRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  browserTarget: BrowserTarget
  tool: 'team_doc_create'
  phase: 'inspect' | 'create'
  parent?: TeamDocParent
  idempotencyIdentity?: string
  name?: string
  body?: string
  recovery?: TeamDocRecovery
}

type TeamDocStage = 'parent_inspected' | 'created' | 'rediscovered' | 'body_written' | 'readback_verified'

interface TeamDocRecovery {
  documentId: string | null
  stages: TeamDocStage[]
}

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

interface BrowserOpenTabRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  tool: 'browser_open_tab'
  url: string
}

interface KnowledgeQueryRequest {
  type: 'connector_request'
  requestId: string
  runId: string
  generation: string
  tool: 'knowledge_search' | 'code_search'
  harnessSessionId: string
  harnessParentSessionId?: string
  question: string
}

interface KnowledgeScopeRecord { scope: KnowledgeScope }
interface KnowledgeSessionRecord { sessionId: string; fingerprint: string }
const activeKnowledgeQueries = new Map<string, AbortController>()

function isConnectorRequest(message: NativeMessage): message is ConnectorRequest {
  const target = message.browserTarget
  return message.type === 'connector_request'
    && typeof message.requestId === 'string'
    && typeof message.runId === 'string'
    && typeof message.generation === 'string'
    && message.tool === 'office_get_context'
    && typeof target === 'object' && target !== null
    && (target as BrowserTarget).browser === 'chrome'
    && Number.isInteger((target as BrowserTarget).windowId) && (target as BrowserTarget).windowId >= 0
    && Number.isInteger((target as BrowserTarget).tabId) && (target as BrowserTarget).tabId >= 0
    && typeof (target as BrowserTarget).url === 'string'
    && (message.browserTargets === undefined || (Array.isArray(message.browserTargets) && message.browserTargets.every(isBrowserTarget)))
    && (message.unavailableBrowserTargets === undefined || (Array.isArray(message.unavailableBrowserTargets)
      && message.unavailableBrowserTargets.every(isUnavailableBrowserTarget)))
}

function isOfficeReadRangeRequest(message: NativeMessage): message is OfficeReadRangeRequest {
  const target = message.browserTarget
  return message.type === 'connector_request' && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && message.tool === 'office_read_range' && typeof message.range === 'string'
    && message.range.trim().length > 0 && message.range.length <= 128 && isBrowserTarget(target)
}

function isOfficeResourceIdentity(value: unknown): value is OfficeResourceIdentity {
  return typeof value === 'object' && value !== null
    && (value as OfficeResourceIdentity).kind === 'webedit_spreadsheet'
    && (value as OfficeResourceIdentity).origin === 'https://webedit.midea.com'
    && (typeof (value as OfficeResourceIdentity).workbookName === 'string' || (value as OfficeResourceIdentity).workbookName === null)
    && (typeof (value as OfficeResourceIdentity).sheetName === 'string' || (value as OfficeResourceIdentity).sheetName === null)
    && typeof (value as OfficeResourceIdentity).fingerprint === 'string' && (value as OfficeResourceIdentity).fingerprint.length > 0
}

function isOfficeWriteRangeRequest(message: NativeMessage): message is OfficeWriteRangeRequest {
  const values = message.values
  if (!(message.type === 'connector_request' && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && message.tool === 'office_write_range' && typeof message.range === 'string'
    && message.range.trim().length > 0 && message.range.length <= 128 && isBrowserTarget(message.browserTarget)
    && Array.isArray(values) && values.length > 0 && values.length <= 100 && Array.isArray(values[0]) && values[0].length > 0 && values[0].length <= 50)) return false
  const width = values[0].length
  return values.every((row) => Array.isArray(row) && row.length === width
      && row.every((cell) => typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean' || cell === null))
    && isOfficeResourceIdentity(message.resource)
}

function isTeamDocParent(value: unknown): value is TeamDocParent {
  if (!value || typeof value !== 'object') return false
  const parent = value as Partial<TeamDocParent>
  return typeof parent.parentId === 'string' && /^\d+$/.test(parent.parentId)
    && typeof parent.bookId === 'string' && /^\d+$/.test(parent.bookId)
    && typeof parent.parentName === 'string' && parent.parentName.length > 0
    && parent.canRead === true && parent.canCreate === true
    && typeof parent.fingerprint === 'string' && parent.fingerprint.length > 0
}

function isTeamDocRequest(message: NativeMessage): message is TeamDocRequest {
  if (!(message.type === 'connector_request' && typeof message.requestId === 'string'
    && typeof message.runId === 'string' && typeof message.generation === 'string'
    && message.tool === 'team_doc_create' && isBrowserTarget(message.browserTarget)
    && (message.phase === 'inspect' || message.phase === 'create'))) return false
  if (message.phase === 'inspect') {
    return message.parent === undefined && message.idempotencyIdentity === undefined
      && message.name === undefined && message.body === undefined && message.recovery === undefined
  }
  const recovery = message.recovery
  const validRecovery = recovery === undefined || (typeof recovery === 'object' && recovery !== null
    && ((recovery as TeamDocRecovery).documentId === null
      || (typeof (recovery as TeamDocRecovery).documentId === 'string' && /^\d+$/.test((recovery as TeamDocRecovery).documentId!)))
    && validTeamDocStages((recovery as TeamDocRecovery).stages))
  return validRecovery && isTeamDocParent(message.parent)
    && typeof message.idempotencyIdentity === 'string' && message.idempotencyIdentity.length > 0 && message.idempotencyIdentity.length <= 128
    && typeof message.name === 'string' && message.name.trim().length > 0 && message.name.length <= 120
    && typeof message.body === 'string' && message.body.trim().length > 0 && message.body.length <= 100_000
}

const TEAM_DOC_STAGES: TeamDocStage[] = ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified']

function validTeamDocStages(value: unknown): value is TeamDocStage[] {
  if (!Array.isArray(value)) return false
  let previous = -1
  for (const stage of value) {
    const index = TEAM_DOC_STAGES.indexOf(stage as TeamDocStage)
    if (index <= previous) return false
    previous = index
  }
  return true
}

function isBrowserOpenTabRequest(message: NativeMessage): message is BrowserOpenTabRequest {
  if (message.type !== 'connector_request' || typeof message.requestId !== 'string' || typeof message.runId !== 'string'
    || typeof message.generation !== 'string' || message.tool !== 'browser_open_tab' || typeof (message as { url?: unknown }).url !== 'string') return false
  try {
    const url = new URL((message as { url: string }).url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isKnowledgeQueryRequest(message: NativeMessage): message is KnowledgeQueryRequest {
  return message.type === 'connector_request' && typeof message.requestId === 'string' && typeof message.runId === 'string'
    && typeof message.generation === 'string' && (message.tool === 'knowledge_search' || message.tool === 'code_search')
    && validSessionIdentity(message.harnessSessionId) && (message.harnessParentSessionId === undefined || validSessionIdentity(message.harnessParentSessionId))
    && typeof message.question === 'string' && message.question.trim().length > 0 && message.question.length <= 4000
}

function isKnowledgeCancel(message: NativeMessage): message is NativeMessage & { type: 'connector_cancel'; requestId: string; runId: string; generation: string } {
  return message.type === 'connector_cancel' && typeof message.requestId === 'string' && typeof message.runId === 'string' && typeof message.generation === 'string'
}

function sameBrowserTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.browser === right.browser
    && left.windowId === right.windowId
    && left.tabId === right.tabId
    && left.url === right.url
}

function targetFromActionTab(tab: chrome.tabs.Tab): BrowserTarget | undefined {
  if (tab.id === undefined || tab.windowId === undefined || typeof tab.url !== 'string' || tab.url.length === 0) return undefined
  return { browser: 'chrome', windowId: tab.windowId, tabId: tab.id, url: tab.url }
}

function snapshotFromActiveTab(tab: chrome.tabs.Tab): ActiveTabSnapshot | undefined {
  if (tab.id === undefined || tab.windowId === undefined || typeof tab.url !== 'string' || tab.url.length === 0) return undefined
  return {
    windowId: tab.windowId,
    tabId: tab.id,
    title: tab.title ?? '',
    url: tab.url,
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

function isBrowserTarget(value: unknown): value is BrowserTarget {
  return typeof value === 'object' && value !== null
    && (value as BrowserTarget).browser === 'chrome'
    && Number.isInteger((value as BrowserTarget).windowId) && (value as BrowserTarget).windowId >= 0
    && Number.isInteger((value as BrowserTarget).tabId) && (value as BrowserTarget).tabId >= 0
    && typeof (value as BrowserTarget).url === 'string' && (value as BrowserTarget).url.length > 0
}

function isUnavailableBrowserTarget(value: unknown): value is UnavailableBrowserTarget {
  return typeof value === 'object' && value !== null
    && (value as UnavailableBrowserTarget).reason === 'closed_or_changed'
    && isBrowserTarget((value as UnavailableBrowserTarget).browserTarget)
}

function sameBrowserTargetList(left: BrowserTarget[], right: BrowserTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => sameBrowserTarget(target, right[index]!))
}

function sameUnavailableBrowserTargetList(left: UnavailableBrowserTarget[], right: UnavailableBrowserTarget[]): boolean {
  return left.length === right.length && left.every((item, index) => item.reason === right[index]?.reason
    && sameBrowserTarget(item.browserTarget, right[index]!.browserTarget))
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

function isBrowserTargetMode(value: unknown): value is BrowserTargetMode {
  return value === 'follow-active-tab' || value === 'pinned-tabs' || value === 'none'
}

function uniqueBrowserTargets(targets: BrowserTarget[]): BrowserTarget[] {
  const seen = new Set<number>()
  return targets.filter((target) => {
    if (seen.has(target.tabId)) return false
    seen.add(target.tabId)
    return true
  })
}

function settingsFromUnknown(value: unknown): BrowserTargetSettings {
  if (!value || typeof value !== 'object') return { ...defaultBrowserTargetSettings }
  const settings = value as Partial<BrowserTargetSettings>
  const mode = isBrowserTargetMode(settings.mode) ? settings.mode : 'follow-active-tab'
  const pinnedTabs = Array.isArray(settings.pinnedTabs) ? uniqueBrowserTargets(settings.pinnedTabs.filter(isBrowserTarget)) : []
  const primaryTabId = Number.isInteger(settings.primaryTabId) && pinnedTabs.some((target) => target.tabId === settings.primaryTabId)
    ? settings.primaryTabId
    : undefined
  const candidate = isBrowserTarget(settings.candidate) ? settings.candidate : undefined
  return { mode, pinnedTabs, ...(primaryTabId === undefined ? {} : { primaryTabId }), ...(candidate === undefined ? {} : { candidate }) }
}

function targetStorage(): chrome.storage.StorageArea | undefined {
  return chrome.storage?.session ?? chrome.storage?.local
}

async function knowledgeScopes(): Promise<Record<string, KnowledgeScopeRecord>> {
  const values = await targetStorage()?.get(KNOWLEDGE_SCOPE_STORAGE_KEY)
  const candidate = values?.[KNOWLEDGE_SCOPE_STORAGE_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([sessionId, value]) =>
    validSessionIdentity(sessionId) && typeof value === 'object' && value !== null && validScope((value as KnowledgeScopeRecord).scope)
      ? [[sessionId, { scope: normalizeScope((value as KnowledgeScopeRecord).scope) }]] : [],
  ))
}

async function saveKnowledgeScope(sessionId: string, scope: KnowledgeScope): Promise<void> {
  const scopes = await knowledgeScopes()
  scopes[sessionId] = { scope: normalizeScope(scope) }
  await targetStorage()?.set({ [KNOWLEDGE_SCOPE_STORAGE_KEY]: scopes })
}

async function knowledgeSessions(): Promise<Record<string, KnowledgeSessionRecord>> {
  const values = await targetStorage()?.get(KNOWLEDGE_SESSION_STORAGE_KEY)
  const candidate = values?.[KNOWLEDGE_SESSION_STORAGE_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([key, value]) => {
    const record = value as Partial<KnowledgeSessionRecord>
    return typeof record?.sessionId === 'string' && typeof record?.fingerprint === 'string' ? [[key, { sessionId: record.sessionId, fingerprint: record.fingerprint }]] : []
  }))
}

function upstreamSessionKey(sessionId: string, kind: KnowledgeKind, fingerprint: string): string {
  return `${sessionId}\u0000${kind}\u0000${fingerprint}`
}

async function resolveKnowledgeScope(request: KnowledgeQueryRequest): Promise<KnowledgeScope | undefined> {
  const scopes = await knowledgeScopes()
  return scopes[request.harnessSessionId]?.scope ?? (request.harnessParentSessionId === undefined ? undefined : scopes[request.harnessParentSessionId]?.scope)
}

async function respondToKnowledge(port: chrome.runtime.Port, request: KnowledgeQueryRequest): Promise<void> {
  const controller = new AbortController()
  activeKnowledgeQueries.set(request.requestId, controller)
  try {
    const scope = await resolveKnowledgeScope(request)
    if (scope === undefined) throw new Error('knowledge_scope_missing')
    const kind: KnowledgeKind = request.tool === 'knowledge_search' ? 'knowledge' : 'code'
    const fingerprint = scopeFingerprint(scope)
    const sessions = await knowledgeSessions()
    const key = upstreamSessionKey(request.harnessSessionId, kind, fingerprint)
    const prior = sessions[key]?.sessionId
    const executed = await executeKnowledgeQuery(kind, request.question.trim(), scope, prior, controller.signal)
    if (executed.sessionId !== undefined) {
      sessions[key] = { sessionId: executed.sessionId, fingerprint }
      await targetStorage()?.set({ [KNOWLEDGE_SESSION_STORAGE_KEY]: sessions })
    }
    port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, result: executed.result })
  } catch (error) {
    port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, error: asError(error) })
  } finally {
    activeKnowledgeQueries.delete(request.requestId)
  }
}

async function readBrowserTargetSettings(): Promise<BrowserTargetSettings> {
  const storage = targetStorage()
  if (storage === undefined) return { ...defaultBrowserTargetSettings }
  const values = await storage.get(TARGET_SETTINGS_KEY)
  return settingsFromUnknown(values[TARGET_SETTINGS_KEY])
}

async function saveBrowserTargetSettings(settings: BrowserTargetSettings): Promise<BrowserTargetSettings> {
  return updateBrowserTargetSettings((latest) => ({
    ...settings,
    ...(settings.candidate === undefined && latest.candidate !== undefined ? { candidate: latest.candidate } : {}),
  }))
}

function updateBrowserTargetSettings(mutator: (latest: BrowserTargetSettings) => BrowserTargetSettings): Promise<BrowserTargetSettings> {
  const operation = settingsMutation.then(async () => {
    const latest = await readBrowserTargetSettings()
    const updated = settingsFromUnknown(mutator(latest))
    await targetStorage()?.set({ [TARGET_SETTINGS_KEY]: updated })
    return updated
  })
  settingsMutation = operation.then(() => undefined, () => undefined)
  return operation
}

async function activeBrowserTarget(windowId?: number): Promise<BrowserTarget> {
  const window = windowId === undefined ? await chrome.windows.getLastFocused() : { id: windowId }
  if (window.id === undefined) throw new Error('No Chrome window is available for the next Harness Run.')
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
  const target = tab === undefined ? undefined : targetFromActionTab(tab)
  if (target === undefined) throw new Error('The active Chrome tab cannot be used as a Browser Target.')
  return target
}

function bindingForTarget(browserTarget: BrowserTarget): BrowserTargetBinding {
  return { browserTarget, browserTargets: [browserTarget], unavailableBrowserTargets: [] }
}

function nativeBindingFields(binding: BrowserTargetBinding): Partial<Pick<BrowserTargetBinding, 'browserTargets' | 'unavailableBrowserTargets'>> {
  return binding.browserTargets.length > 1 || binding.unavailableBrowserTargets.length > 0
    ? { browserTargets: binding.browserTargets, unavailableBrowserTargets: binding.unavailableBrowserTargets }
    : {}
}

async function pinnedBrowserTargets(settings: BrowserTargetSettings): Promise<BrowserTargetBinding> {
  if (settings.pinnedTabs.length === 0) throw new Error('Select at least one pinned tab before starting a browser-bound Harness Run.')
  const available: BrowserTarget[] = []
  const unavailable: UnavailableBrowserTarget[] = []
  for (const target of settings.pinnedTabs) {
    try {
      const tab = await chrome.tabs.get(target.tabId)
      const refreshed = targetFromActionTab(tab)
      if (refreshed !== undefined && sameBrowserTarget(refreshed, target)) available.push(refreshed)
      else unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
    } catch {
      unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
    }
  }
  const browserTarget = available.find((target) => target.tabId === settings.primaryTabId) ?? available[0]
  if (browserTarget === undefined) throw new Error('None of the pinned Browser Targets is still available. Select it again before starting.')
  return { browserTarget, browserTargets: available, unavailableBrowserTargets: unavailable }
}

async function resolveBrowserTarget(settings: BrowserTargetSettings, preferredTarget?: BrowserTarget): Promise<BrowserTargetBinding | undefined> {
  if (settings.mode === 'none') return undefined
  if (settings.mode === 'pinned-tabs') return pinnedBrowserTargets(settings)
  return bindingForTarget(preferredTarget ?? await activeBrowserTarget())
}

async function startHarnessForSettings(preferredTarget?: BrowserTarget): Promise<string> {
  const settings = await readBrowserTargetSettings()
  const binding = await resolveBrowserTarget(settings, preferredTarget)
  return startHarness(binding)
}

async function restartHarnessForSettings(): Promise<string> {
  return queueNativeLifecycle(async () => {
    await settingsMutation
    const port = nativePort
    if (port !== undefined) {
      try {
        port.disconnect()
      } finally {
        disconnectNativePort(port)
      }
    }
    nativeUrl = undefined
    boundBrowserTargets.clear()
    return startHarnessForSettings()
  })
}

function queueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const queued = nativeLifecycle.then(operation)
  nativeLifecycle = queued.then(() => undefined, () => undefined)
  return queued
}

async function availableTabs(): Promise<BrowserTargetTab[]> {
  const window = await chrome.windows.getLastFocused()
  if (window.id === undefined) return []
  const tabs = await chrome.tabs.query({ windowId: window.id })
  return tabs.flatMap((tab): BrowserTargetTab[] => {
    const target = targetFromActionTab(tab)
    return target === undefined ? [] : [{ ...target, title: tab.title ?? '', ...(typeof tab.favIconUrl === 'string' && tab.favIconUrl.length > 0 ? { favIconUrl: tab.favIconUrl } : {}) }]
  })
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
      pages.push({ browserTarget: target, pageIdentity: { title: tab.title ?? '', url: target.url }, documentIdentity: null, isPrimary: sameBrowserTarget(target, binding.browserTarget) })
    } catch {
      unavailable.push({ browserTarget: target, reason: 'closed_or_changed' })
    }
  }
  const primaryPage = pages.find((page) => page.isPrimary === true)
  if (primaryPage === undefined) throw new Error('The primary Browser Target changed before Office context could be read.')
  // Office DOM/range adapters deliberately begin in Issue #3. This tracer
  // bullet proves the trusted target identity path without exposing cookies.
  return {
    status: 'browser_target_verified',
    pageIdentity: primaryPage.pageIdentity,
    documentIdentity: null,
    primaryBrowserTarget: binding.browserTarget,
    pages,
    unavailableBrowserTargets: unavailable,
  }
}

async function resolveOfficeBrowserTarget(request: ConnectorRequest): Promise<BrowserTargetBinding> {
  const settings = await readBrowserTargetSettings()
  if (settings.mode === 'none') throw new Error('Browser use is disabled for the next Office turn.')
  const binding = settings.mode === 'pinned-tabs'
    ? await pinnedBrowserTargets(settings)
    : bindingForTarget(settings.candidate ?? await activeBrowserTarget())
  const requestTargets = request.browserTargets ?? [request.browserTarget]
  const requestUnavailable = request.unavailableBrowserTargets ?? []
  if (!sameBrowserTarget(binding.browserTarget, request.browserTarget)
    || !sameBrowserTargetList(binding.browserTargets, requestTargets)
    || !sameUnavailableBrowserTargetList(binding.unavailableBrowserTargets, requestUnavailable)) {
    await transferBrowserTarget(request.runId, binding, request.requestId)
  }
  return binding
}

function respondToConnector(port: chrome.runtime.Port, request: ConnectorRequest): void {
  void queueNativeLifecycle(async () => {
    if (nativePort !== port) throw new Error('Connector request belongs to a stale Native connection.')
    const binding = await resolveOfficeBrowserTarget(request)
    if (nativePort !== port) throw new Error('Connector request became stale before Office context could be read.')
    const resolvedRequest = { ...request, ...binding }
    const result = await readOfficeContext(resolvedRequest)
    return { ...binding, result }
  })
    .then(({ browserTarget, browserTargets, unavailableBrowserTargets, result }) => {
      port.postMessage({
        type: 'connector_response',
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
        type: 'connector_response',
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

async function readOfficeRange(request: OfficeReadRangeRequest): Promise<Record<string, unknown>> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
    throw { code: 'navigation', message: 'The trusted Browser Target changed before the range could be read.' } satisfies OfficeReadFailure
  }
  const tab = await chrome.tabs.get(request.browserTarget.tabId)
  if (tab.windowId !== request.browserTarget.windowId || tab.url !== request.browserTarget.url) {
    throw { code: 'navigation', message: 'The trusted Browser Target navigated before the range could be read.' } satisfies OfficeReadFailure
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
  const frame = frames.find((candidate) => {
    try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false }
  })
  if (frame === undefined) throw { code: 'unsupported', message: 'The bound Browser Target has no supported WebEdit iframe.' } satisfies OfficeReadFailure
  try {
    const reply = await chrome.tabs.sendMessage(request.browserTarget.tabId, { type: 'office-read-range/v1', range: request.range }, { frameId: frame.frameId }) as { ok?: unknown; result?: unknown; error?: unknown }
    if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while reading.' }
    const latestFrames = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
    if (!latestFrames.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) {
      throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while reading.' } satisfies OfficeReadFailure
    }
    return reply.result as Record<string, unknown>
  } catch (error) {
    throw officeReadFailure(error)
  }
}

function respondToOfficeReadRange(port: chrome.runtime.Port, request: OfficeReadRangeRequest): void {
  void queueNativeLifecycle(async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const result = await readOfficeRange(request)
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return result
  }).then((result) => {
    port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result })
  }).catch((error: unknown) => {
    port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: officeReadFailure(error) })
  })
}

async function queueResourceWrite<T>(resource: OfficeResourceIdentity, action: () => Promise<T>): Promise<T> {
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

async function writeOfficeRange(request: OfficeWriteRangeRequest): Promise<Record<string, unknown>> {
  return queueResourceWrite(request.resource, async () => {
    const binding = boundBrowserTargets.get(request.runId)
    if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
      throw { code: 'navigation', message: 'The trusted Browser Target changed before the write could start.' } satisfies OfficeReadFailure
    }
    const tab = await chrome.tabs.get(request.browserTarget.tabId)
    if (tab.windowId !== request.browserTarget.windowId || tab.url !== request.browserTarget.url) {
      throw { code: 'navigation', message: 'The trusted Browser Target navigated before the write could start.' } satisfies OfficeReadFailure
    }
    const frames = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
    const frame = frames.find((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
    if (frame === undefined) throw { code: 'unsupported', message: 'The bound Browser Target has no supported WebEdit iframe.' } satisfies OfficeReadFailure
    try {
      const reply = await chrome.tabs.sendMessage(request.browserTarget.tabId, { type: 'office-write-range/v1', range: request.range, values: request.values, resource: request.resource }, { frameId: frame.frameId }) as { ok?: unknown; result?: unknown; error?: unknown }
      if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while writing.' }
      const latest = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
      if (!latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while writing.' } satisfies OfficeReadFailure
      return reply.result as Record<string, unknown>
    } catch (error) { throw officeReadFailure(error) }
  })
}

function respondToOfficeWriteRange(port: chrome.runtime.Port, request: OfficeWriteRangeRequest): void {
  void (async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const result = await writeOfficeRange(request)
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return result
  })().then((result) => port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
    .catch((error: unknown) => port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: officeReadFailure(error) }))
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

async function inspectTeamDocParentInPage(catalogId: string, documentDetail = false): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, error: 'team_doc_wrong_origin' }
  }
  type TeamDocAttempt = { stage: string; httpStatus: number; errorCode: string | null }
  type TeamDocReply = { response: Response; payload: Record<string, unknown> | null }
  type TeamDocStageResult = { reply: TeamDocReply | null; diagnostic: TeamDocAttempt }
  const parse = async (response: Response): Promise<TeamDocReply> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId)"\s*:\s*(\d+)/g, '"$1":"$2"')
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
  try {
    let resolvedCatalogId = catalogId
    let detailSourceBookId: string | null = null
    if (documentDetail) {
      const openApiAttempt = await stageRequest(
        `/team-knowledge-main/openApi/teamKnowledgeCatalog/get?catalogId=${encodeURIComponent(catalogId)}`,
        'source_openapi', { businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      )
      let selectedAttempt = openApiAttempt
      let requireFileType = true
      if (!successful(openApiAttempt)) {
        const internalAttempt = await stageRequest(
          `/team-knowledge-main/teamKnowledge/get?catalogId=${encodeURIComponent(catalogId)}`,
          'source_internal',
        )
        if (!successful(internalAttempt)) {
          return failedInspection(internalAttempt.diagnostic, [openApiAttempt.diagnostic, internalAttempt.diagnostic])
        }
        selectedAttempt = internalAttempt
        requireFileType = false
      }
      const sourceRecord = dataRecord(selectedAttempt) ?? {}
      const sourceId = typeof sourceRecord.catalogId === 'string' ? sourceRecord.catalogId : null
      const sourceParentId = typeof sourceRecord.parentId === 'string' ? sourceRecord.parentId : null
      detailSourceBookId = typeof sourceRecord.bookId === 'string' && /^\d+$/.test(sourceRecord.bookId) ? sourceRecord.bookId : null
      const fileType = sourceRecord.fileType
      if (sourceId !== catalogId || !sourceParentId || !/^\d+$/.test(sourceParentId) || sourceParentId === catalogId
        || (requireFileType && !((typeof fileType === 'string' && fileType.length > 0) || typeof fileType === 'number'))) {
        return { ok: false, error: 'team_doc_directory_required' }
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
        return failedInspection(openApiNodeAttempt.diagnostic, [nodeAttempt.diagnostic, openApiNodeAttempt.diagnostic])
      }
      nodeAttempt = openApiNodeAttempt
    }
    if (!successful(nodeAttempt)) return failedInspection(nodeAttempt.diagnostic)
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
    return { ok: true, parent: { parentId: resolvedCatalogId, bookId, parentName, canRead: true, canCreate: true, fingerprint: `team-doc-parent-v1-${(hash >>> 0).toString(16).padStart(8, '0')}` } }
  } catch {
    return { ok: false, error: 'team_doc_parent_inspection_failed' }
  }
}

async function createTeamDocInPage(input: { bookId: string; parentId: string; name: string }): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'create', error: 'team_doc_wrong_origin' }
  }
  const parse = async (response: Response): Promise<{ response: Response; payload: Record<string, unknown> | null }> => {
    const text = await response.text()
    try {
      const lossless = text.replace(/"(bookId|catalogId|parentId)"\s*:\s*(\d+)/g, '"$1":"$2"')
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
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
      }
    }
    return []
  }
  const listChildren = async () => {
    const reply = await parse(await fetch('/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
    }))
    return { reply, records: recordsFrom(reply.payload?.data) }
  }
  const recordId = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).catalogId === 'string' ? (value as Record<string, unknown>).catalogId as string : null
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
    const lightDoc = fileTypeRecords.find((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return /newword|lightdoc|轻文档/i.test([record.value, record.name, record.icon, record.format].filter((item) => typeof item === 'string').join(' '))
    }) as Record<string, unknown> | undefined
    const fileType = lightDoc?.type
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
    const documentId = typeof created.catalogId === 'string' ? created.catalogId : null
    if (!createReply.response.ok || createReply.payload?.errorCode !== '00000' || !documentId || !/^\d+$/.test(documentId)) {
      return { ok: false, failedAt: 'create', error: 'team_doc_create_failed', diagnostic: diagnostic(createReply) }
    }
    const children = await listChildren()
    const match = children.records.find((value) => recordId(value) === documentId && recordName(value) === input.name) as Record<string, unknown> | undefined
    if (!children.reply.response.ok || children.reply.payload?.errorCode !== '00000' || !match) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId, diagnostic: diagnostic(children.reply) }
    }
    const url = documentUrl(match, documentId, created.url)
    if (!url) return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId }
    return { ok: true, documentId, url }
  } catch {
    return { ok: false, failedAt: 'create', error: 'team_doc_create_failed' }
  }
}

async function rediscoverTeamDocInPage(input: { bookId: string; parentId: string; documentId: string }): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'doc.midea.com') {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_wrong_origin', documentId: input.documentId }
  }
  try {
    const response = await fetch('/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', businessSystem: 'TEAM_KNOWLEDGE_BOOK' },
      body: JSON.stringify({ bookId: input.bookId, parentId: input.parentId }),
    })
    const text = await response.text()
    const lossless = text.replace(/"(bookId|catalogId|parentId)"\s*:\s*(\d+)/g, '"$1":"$2"')
      .replace(/"data"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"data":"$1"')
    const parsed = JSON.parse(lossless) as unknown
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
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
        for (const value of Object.values(record)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) pending.push(value as Record<string, unknown>)
        }
      }
      return []
    }
    const records = recordsFrom(payload?.data)
    const match = records.find((value) => value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).catalogId === input.documentId) as Record<string, unknown> | undefined
    const diagnostic = { httpStatus: response.status, errorCode: typeof payload?.errorCode === 'string' ? payload.errorCode : null }
    if (!response.ok || payload?.errorCode !== '00000' || !match) {
      return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: input.documentId, diagnostic }
    }
    const rawUrl = typeof match.url === 'string' ? match.url : `/teamKnowledge/detail/docOnline/${input.documentId}?id=${input.documentId}`
    const url = new URL(rawUrl, 'https://doc.midea.com').href
    if (new URL(url).origin !== 'https://doc.midea.com') return { ok: false, failedAt: 'rediscover', error: 'team_doc_document_url_invalid', documentId: input.documentId }
    return { ok: true, recovered: true, documentId: input.documentId, url }
  } catch {
    return { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_failed', documentId: input.documentId }
  }
}

async function writeTeamDocInWebEdit(body: string): Promise<unknown> {
  if (location.protocol !== 'https:' || location.hostname !== 'webedit.midea.com') {
    return { ok: false, failedAt: 'write', error: 'team_doc_wrong_webedit_origin' }
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
      if (app?.openApi?.editor?.document?.selection?.insertContent && app?.openApi?.editor?.canvas?.getDocXml) break
      await wait(100)
    }
    const selection = app?.openApi?.editor?.document?.selection
    const canvas = app?.openApi?.editor?.canvas
    if (!selection?.insertContent || !canvas?.getDocXml) return { ok: false, failedAt: 'write', error: 'team_doc_webedit_runtime_unavailable' }
    const beforeXml = await canvas.getDocXml()
    await selection.insertContent({ markdown: body, insertBlow: false })
    let afterXml = await canvas.getDocXml()
    const changeDeadline = Date.now() + 3_000
    while (Date.now() < changeDeadline && (typeof afterXml !== 'string' || afterXml === beforeXml)) {
      await wait(50); afterXml = await canvas.getDocXml()
    }
    if (typeof afterXml !== 'string' || afterXml === beforeXml) return { ok: false, failedAt: 'write', error: 'team_doc_write_not_observed' }
    const observedBody = decodeXml(afterXml)
    const visibleFragments = body.replace(/<!--[\s\S]*?-->/g, '').split(/\n+/)
      .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').trim()).filter(Boolean)
    const readbackMatches = observedBody.length > 0 && visibleFragments.every((fragment) => observedBody.includes(fragment))
    return readbackMatches
      ? { ok: true, readbackMatches: true, observedBody }
      : { ok: false, failedAt: 'readback', error: 'team_doc_readback_mismatch', observedBody }
  } catch {
    return { ok: false, failedAt: 'write', error: 'team_doc_webedit_write_failed' }
  }
}

async function assertTeamDocTarget(request: TeamDocRequest): Promise<void> {
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

async function waitForTeamDocTab(tabId: number, expectedUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url === expectedUrl && tab.status === 'complete') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('team_doc_navigation_timeout')
}

function teamDocPartial(input: Partial<TeamDocPartialDelivery> & Pick<TeamDocPartialDelivery, 'failedAt' | 'error'>): TeamDocPartialDelivery {
  return {
    status: 'partial_delivery', documentId: input.documentId ?? null, stages: input.stages ?? [],
    readbackMatches: false, failedAt: input.failedAt, error: input.error,
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
    ...(typeof input.observedBody === 'string' ? { observedBody: input.observedBody } : {}),
  }
}

async function runTeamDocRequest(request: TeamDocRequest): Promise<object> {
  await assertTeamDocTarget(request)
  const parentId = extractTeamDocParentId(request.browserTarget.url)
  if (!parentId) return teamDocPartial({ failedAt: 'inspect', error: 'team_doc_parent_id_missing' })
  const documentDetail = /\/teamKnowledge\/detail\/docOnline\//i.test(request.browserTarget.url)
  const inspected = (await chrome.scripting.executeScript({
    target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: inspectTeamDocParentInPage, args: [parentId, documentDetail],
  }))[0]?.result as { ok?: unknown; parent?: unknown; error?: unknown; diagnostic?: unknown } | undefined
  if (inspected?.ok !== true || !isTeamDocParent(inspected.parent)) {
    return teamDocPartial({ failedAt: 'inspect', error: typeof inspected?.error === 'string' ? inspected.error : 'team_doc_parent_inspection_failed', diagnostic: inspected?.diagnostic as TeamDocPartialDelivery['diagnostic'] })
  }
  if (request.phase === 'inspect') return { parent: inspected.parent }
  if (!request.parent || inspected.parent.fingerprint !== request.parent.fingerprint
    || inspected.parent.parentId !== request.parent.parentId || inspected.parent.bookId !== request.parent.bookId) {
    return teamDocPartial({ failedAt: 'inspect', error: 'team_doc_parent_fingerprint_mismatch' })
  }
  const stages = TEAM_DOC_STAGES.filter((stage) => stage === 'parent_inspected' || request.recovery?.stages.includes(stage))
  const recoveryDocumentId = request.recovery?.documentId
  const resolution = recoveryDocumentId
    ? await chrome.scripting.executeScript({
      target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: rediscoverTeamDocInPage,
      args: [{ bookId: request.parent.bookId, parentId: request.parent.parentId, documentId: recoveryDocumentId }],
    })
    : await chrome.scripting.executeScript({
      target: { tabId: request.browserTarget.tabId }, world: 'MAIN', func: createTeamDocInPage,
      args: [{ bookId: request.parent.bookId, parentId: request.parent.parentId, name: request.name! }],
    })
  const created = resolution[0]?.result as { ok?: unknown; documentId?: unknown; url?: unknown; failedAt?: unknown; error?: unknown; diagnostic?: unknown } | undefined
  if (created?.ok !== true || typeof created.documentId !== 'string' || typeof created.url !== 'string') {
    return teamDocPartial({ documentId: typeof created?.documentId === 'string' ? created.documentId : null, stages,
      failedAt: created?.failedAt === 'rediscover' ? 'rediscover' : 'create', error: typeof created?.error === 'string' ? created.error : 'team_doc_create_failed', diagnostic: created?.diagnostic as TeamDocPartialDelivery['diagnostic'] })
  }
  for (const stage of ['created', 'rediscovered'] as TeamDocStage[]) {
    if (!stages.includes(stage)) stages.push(stage)
  }
  stages.sort((left, right) => TEAM_DOC_STAGES.indexOf(left) - TEAM_DOC_STAGES.indexOf(right))
  let writeResult: { ok?: unknown; failedAt?: unknown; error?: unknown; readbackMatches?: unknown; observedBody?: unknown } | undefined
  let restored = false
  try {
    await chrome.tabs.update(request.browserTarget.tabId, { url: created.url })
    await waitForTeamDocTab(request.browserTarget.tabId, created.url)
    const frameDeadline = Date.now() + 30_000
    let frame: chrome.webNavigation.GetAllFrameResultDetails | undefined
    while (Date.now() < frameDeadline) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
      frame = frames.find((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
      if (frame) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!frame) return teamDocPartial({ documentId: created.documentId, stages, failedAt: 'write', error: 'team_doc_webedit_frame_unavailable' })
    writeResult = (await chrome.scripting.executeScript({
      target: { tabId: request.browserTarget.tabId, frameIds: [frame.frameId] }, world: 'MAIN', func: writeTeamDocInWebEdit, args: [request.body!],
    }))[0]?.result as typeof writeResult
  } finally {
    try {
      await chrome.tabs.update(request.browserTarget.tabId, { url: request.browserTarget.url })
      await waitForTeamDocTab(request.browserTarget.tabId, request.browserTarget.url)
      restored = true
    } catch { restored = false }
  }
  if (writeResult?.ok !== true || writeResult.readbackMatches !== true || typeof writeResult.observedBody !== 'string') {
    const failedAt = writeResult?.failedAt === 'readback' ? 'readback' : 'write'
    return teamDocPartial({ documentId: created.documentId, stages, failedAt, error: typeof writeResult?.error === 'string' ? writeResult.error : 'team_doc_webedit_write_failed', observedBody: typeof writeResult?.observedBody === 'string' ? writeResult.observedBody : undefined })
  }
  for (const stage of ['body_written', 'readback_verified'] as TeamDocStage[]) {
    if (!stages.includes(stage)) stages.push(stage)
  }
  stages.sort((left, right) => TEAM_DOC_STAGES.indexOf(left) - TEAM_DOC_STAGES.indexOf(right))
  if (!restored) return teamDocPartial({ documentId: created.documentId, stages, failedAt: 'readback', error: 'team_doc_parent_restore_failed', observedBody: writeResult.observedBody })
  return { status: 'verified_write', documentId: created.documentId, stages, readbackMatches: true, observedBody: writeResult.observedBody }
}

function respondToTeamDoc(port: chrome.runtime.Port, request: TeamDocRequest): void {
  void queueNativeLifecycle(async () => {
    if (nativePort !== port) throw new Error('Team Doc request belongs to a stale Native connection.')
    const result = await runTeamDocRequest(request)
    if (nativePort !== port) throw new Error('Team Doc request became stale before completion.')
    return result
  }).then((result) => port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
    .catch((error: unknown) => port.postMessage({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: asError(error) }))
}

function respondToBrowserOpenTab(port: chrome.runtime.Port, request: BrowserOpenTabRequest): void {
  void queueNativeLifecycle(async () => {
    if (nativePort !== port) throw new Error('Browser-open request belongs to a stale Native connection.')
    const tab = await chrome.tabs.create({ url: request.url, active: true })
    if (nativePort !== port) throw new Error('Browser-open request became stale before its target could be transferred.')
    const browserTarget = targetFromActionTab(tab)
    if (browserTarget === undefined) throw new Error('Chrome did not return a Browser Target for the opened tab.')
    await transferBrowserTarget(request.runId, bindingForTarget(browserTarget), request.requestId)
    port.postMessage({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
      browserTarget, result: { pageIdentity: { title: tab.title ?? '', url: browserTarget.url } },
    })
  }).catch((error: unknown) => {
    port.postMessage({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
      error: asError(error),
    })
  })
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
    if (isOfficeReadRangeRequest(message)) {
      respondToOfficeReadRange(port, message)
      return
    }
    if (isOfficeWriteRangeRequest(message)) {
      respondToOfficeWriteRange(port, message)
      return
    }
    if (isTeamDocRequest(message)) {
      respondToTeamDoc(port, message)
      return
    }
    if (isKnowledgeQueryRequest(message)) {
      void respondToKnowledge(port, message)
      return
    }
    if (isKnowledgeCancel(message)) {
      activeKnowledgeQueries.get(message.requestId)?.abort()
      return
    }
    if (isBrowserOpenTabRequest(message)) {
      respondToBrowserOpenTab(port, message)
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
    nativeUrl = payload.url
    void chrome.runtime.sendMessage({ type: 'harness-ready', url: nativeUrl }).catch(() => {})
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

export default defineBackground(() => {
  const sidePanel = chrome.sidePanel
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

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false
    }
    const request = message as { type?: unknown; settings?: unknown; runId?: unknown; browserTarget?: unknown; sessionId?: unknown; scope?: unknown; refresh?: unknown }
    if (request.type === 'ensure-harness') {
      void startHarnessForSettings()
        .then((url) => sendResponse({ ok: true, url }))
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
    if (request.type === 'knowledge-scope/v1') {
      if (!validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: 'Invalid Harness session identity.' })
        return false
      }
      const sessionId = request.sessionId
      void (async () => {
        if (request.scope !== undefined) {
          if (!validScope(request.scope)) throw new Error('Invalid knowledge selection.')
          await saveKnowledgeScope(sessionId, request.scope)
        }
        const scope = (await knowledgeScopes())[sessionId]?.scope
        const catalog = await loadKnowledgeCatalog(scope?.domainId)
        sendResponse({ ok: true, scope, catalog })
      })().catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
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
      void refreshCurrentActiveTab().catch(() => {})
    }
  })
  chrome.tabs?.onRemoved?.addListener((tabId, _removeInfo) => {
    if (activeTabSnapshot?.tabId !== tabId) return
    void refreshCurrentActiveTab().catch(() => {})
  })
  chrome.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId < 0) return
    void refreshCurrentActiveTab().catch(() => {})
  })
})
