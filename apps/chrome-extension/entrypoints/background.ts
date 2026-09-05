import { inspectTeamDocParentInPage, createTeamDocInPage, rediscoverTeamDocInPage, writeTeamDocInWebEdit, waitForTeamKnowledgeUserConfirmation, showTeamKnowledgeReadbackFailure } from './background/team-knowledge/page-scripts'
import type { TeamKnowledgeItemKind, TeamKnowledgeUserConfirmation } from './background/team-knowledge/page-scripts'
import { probeDocumentIdentity, presentationResourceFromProbe, spreadsheetResourceFromResult, sendToWebEditFrame, waitForTeamDocWritableFrame } from './background/office/frame-routing'
import type { SpreadsheetFrameBinding, PresentationFrameBinding, PresentationFrameSelection, SpreadsheetFrameSelection } from './background/office/frame-routing'
import { sameRuntimeReleaseIdentity, validRuntimeIdentitySummary } from '../../native-server/src/runtime/runtime-identity-contract.mjs'
import type { RuntimeIdentitySummary } from '../../native-server/src/runtime/runtime-identity-contract.mjs'
import { ACCRUI_NATIVE_HOST_NAME } from '../../native-server/src/runtime/product-runtime-identity.mjs'
import {
  CONNECTOR_CANCEL,
  CONNECTOR_REQUEST,
  CONNECTOR_RESPONSE,
  sameBrowserTarget,
  sameBrowserTargetList,
  sameUnavailableBrowserTargetList,
  validBrowserTarget,
  validUnavailableBrowserTarget,
} from '../../native-server/src/transport/connector-protocol.mjs'
import type {
  BrowserTarget,
  ConnectorCorrelation,
  UnavailableBrowserTarget,
} from '../../native-server/src/transport/connector-protocol.mjs'
import { createKnowledgeTransport } from './background/knowledge-transport'
import type { KnowledgeKind, KnowledgeScope } from './background/knowledge-transport'
import {
  samePinnedTab,
  settingsFromUnknown,
} from './background/browser-target-state'
import type { BrowserTargetSettings } from './background/browser-target-state'
import { BrowserTargetRuntime } from './background/browser-target-runtime'
import { preserveFullscreenBrowserTarget } from './background/fullscreen-target-handoff'
import { WorkspaceDesktopNotifications, validWorkspaceDesktopNotification } from './background/workspace-desktop-notifications'
import type { BrowserTargetBinding, BrowserTargetTab } from './background/browser-target-runtime'
import {
  isLightDocumentResourceIdentity,
  isListWorkTabsRequest as isConnectorRequest,
  isOfficeDocumentRequest,
  isOfficePresentationRequest,
  isOfficeReadFailureDetails,
  isOfficeSpreadsheetRequest,
  isReadWorkTabRequest,
} from './background/office-request-contract'

type HtmlWorkbenchStylesheetFingerprint = { url: string; fingerprint: string }
type HtmlWorkbenchRequest = ConnectorCorrelation & { type: 'connector_request'; browserTarget: BrowserTarget; harnessSessionId?: string; tool: 'html_workbench'; action: 'read' | 'preflight' | 'refresh_readback'; expectedSourceFingerprint?: string; expectedStylesheets?: HtmlWorkbenchStylesheetFingerprint[]; expectedAnchorSelectors?: string[] }
type HtmlWorkbenchPicker = { nonce: string; sessionId: string; url: string; anchors: unknown[] }
const htmlWorkbenchPickers = new Map<number, HtmlWorkbenchPicker>()
function validHtmlWorkbenchStylesheetFingerprints(value: unknown): value is HtmlWorkbenchStylesheetFingerprint[] {
  return Array.isArray(value) && value.length <= 20 && value.every(item => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && typeof (item as Record<string, unknown>).url === 'string' && String((item as Record<string, unknown>).url).startsWith('file:')
    && typeof (item as Record<string, unknown>).fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(String((item as Record<string, unknown>).fingerprint)))
}
function validHtmlWorkbenchAnchorSelectors(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 12 && value.every(selector => typeof selector === 'string' && selector.length > 0 && selector.length <= 2_000)
}
function isHtmlWorkbenchRequest(value: unknown): value is HtmlWorkbenchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.type === 'connector_request' && item.tool === 'html_workbench' && typeof item.requestId === 'string' && typeof item.runId === 'string' && typeof item.generation === 'string' && validBrowserTarget(item.browserTarget)
    && (item.action === 'read' || item.action === 'preflight' || item.action === 'refresh_readback')
    && (item.expectedSourceFingerprint === undefined || (typeof item.expectedSourceFingerprint === 'string' && /^[a-f0-9]{64}$/i.test(item.expectedSourceFingerprint)))
    && (item.expectedStylesheets === undefined || validHtmlWorkbenchStylesheetFingerprints(item.expectedStylesheets))
    && (item.expectedAnchorSelectors === undefined || validHtmlWorkbenchAnchorSelectors(item.expectedAnchorSelectors))
    && (item.action !== 'refresh_readback' || (typeof item.expectedSourceFingerprint === 'string' && validHtmlWorkbenchStylesheetFingerprints(item.expectedStylesheets) && validHtmlWorkbenchAnchorSelectors(item.expectedAnchorSelectors)))
}
function validHtmlWorkbenchAnchor(value: unknown): boolean { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).selector === 'string' && String((value as Record<string, unknown>).selector).length > 0 && String((value as Record<string, unknown>).selector).length <= 2_000 && Array.isArray((value as Record<string, unknown>).structurePath) && ((value as Record<string, unknown>).structurePath as unknown[]).length > 0 && ((value as Record<string, unknown>).structurePath as unknown[]).length <= 64 && ((value as Record<string, unknown>).structurePath as unknown[]).every(part => typeof part === 'string' && part.length <= 256) && typeof (value as Record<string, unknown>).fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(String((value as Record<string, unknown>).fingerprint)) && typeof (value as Record<string, unknown>).text === 'string' && String((value as Record<string, unknown>).text).length <= 4_000 && typeof (value as Record<string, unknown>).outerHTML === 'string' && String((value as Record<string, unknown>).outerHTML).length <= 16_000 }
import { MARKDOWN_REVIEW_PORT, isMarkdownReviewPortRequest, isPrdRating } from './markdown-review/protocol'
import type { CommitWriteRequest, DeliverRequest, MarkdownReviewPortRequest, PrepareWriteRequest, PrdRating, RatingRequest } from './markdown-review/protocol'
import type {
  LightDocumentResourceIdentity,
  ListWorkTabsRequest as ConnectorRequest,
  OfficeDocumentRequest,
  OfficePresentationRequest,
  OfficeReadFailure,
  OfficeSpreadsheetRequest,
  ReadWorkTabRequest,
} from './background/office-request-contract'
import {
  PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY,
  retainedPrototypeStudioAuthorizations,
  storedPrototypeStudioAuthorizations,
  validPrototypeStudioAuthorization,
} from '../src/prototype-studio-authorization'
import type { PrototypeStudioAuthorization } from '../src/prototype-studio-authorization'
import {
  PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY,
  PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY,
  retainedPrototypeStudioPendingRecoveries,
  retainedPrototypeStudioRecoveryBindings,
  storedPrototypeStudioPendingRecoveries,
  storedPrototypeStudioRecoveries,
  validPrototypeStudioPendingRecovery,
  validPrototypeStudioRecoveryBinding,
} from '../src/prototype-studio-recovery'
import type { PrototypeStudioPendingRecovery, PrototypeStudioRecoveryBinding } from '../src/prototype-studio-recovery'
import { retainedPrototypeReferences } from '../src/prototype-reference-storage'
import { sha256Fingerprint, validateReferenceEvidence, verifyReferenceEvidenceFingerprint } from '../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { productBrief } from '../../../packages/harness-ui-prototype-studio/src/product-brief.mjs'
import { releaseUpdateNativeMessage, releaseUpdateResult } from '../src/release-update-wire'
import { NATIVE_UPDATE_HANDOFF_GRACE_MS, shouldConsumeReleaseUpdateReload } from '../src/native-reconnect-policy'
const KNOWLEDGE_API_ORIGIN = 'https://anapi-uat.annto.com'
const KNOWLEDGE_BASE_URL = `${KNOWLEDGE_API_ORIGIN}/api-sse-kd`
const KNOWLEDGE_CATALOG_TIMEOUT_MS = 15_000
const KNOWLEDGE_CATALOG_CACHE_TTL_MS = 5 * 60_000
const KNOWLEDGE_TRANSPORT_RETRY_LIMIT = 2
const KNOWLEDGE_TRANSPORT_RETRY_DELAY_MS = 250
const KNOWLEDGE_SCOPE_STORAGE_KEY = 'harnessKnowledgeScopesV1'
const KNOWLEDGE_SCOPE_DEFAULT_STORAGE_KEY = 'harnessKnowledgeScopeDefaultV1'
const KNOWLEDGE_SESSION_STORAGE_KEY = 'harnessKnowledgeSessionsV1'
const KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY = 'harnessKnowledgeEnabledPreferenceV1'
const KNOWLEDGE_LOGIN_URL = 'https://wb-uat.annto.com/'
const ACCOUNT_LOCAL_SIGN_OUT_STORAGE_KEY = 'harnessAccountLocalSignOutV1'
const ACCOUNT_AUTH_COOKIE_NAMES = new Set(['MAS_TGC_UAT', 'midea_auth_uat', 'OAM_ID'])
const ACCOUNT_AUTH_COOKIE_DOMAIN = 'annto.com'
const COMPANY_PORTAL_TAB_URL_PATTERN = 'https://wb-uat.annto.com/*'
const COMPANY_PORTAL_RETURN_URL = 'https://wb-uat.annto.com'
const COMPANY_PORTAL_LOGOUT_API_URL = 'https://anapi-uat.annto.com/api-auth/ssoLogout'
const COMPANY_LOGIN_IDENTITY_API_URL = 'https://anapi-uat.annto.com/api-auth/userInfo/getLogIn'
const COMPANY_SSO_LOGIN_URL = `https://signinuat.midea.com/?service=${encodeURI(COMPANY_PORTAL_RETURN_URL)}`
const COMPANY_SSO_LOGOUT_URL = `http://signinuat.midea.com/logout?service=${encodeURI(COMPANY_SSO_LOGIN_URL)}`
const COMPANY_LOGOUT_NAVIGATION_TIMEOUT_MS = 15_000
const COMPANY_GATEWAY_BASE_URL = `${KNOWLEDGE_API_ORIGIN}/api-sse-anthropic/v1`
const COMPANY_GATEWAY_METADATA_STORAGE_KEY = 'harnessCompanyGatewayMetadataV1'
const COMPANY_GATEWAY_TIMEOUT_MS = 15_000
const knowledgeTransport = createKnowledgeTransport({
  baseUrl: KNOWLEDGE_BASE_URL,
  fetch: (input, init) => fetch(input, init),
  cookies: async () => typeof chrome === 'undefined' || chrome.cookies?.getAll === undefined
    ? []
    : chrome.cookies.getAll({ url: `${KNOWLEDGE_API_ORIGIN}/` }),
})
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
interface CompanyGatewayMetadata { models: CompanyGatewayModel[]; quota: CompanyGatewayQuota; checkedAt: string }

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
  return {
    enabled: (state.enabled as boolean | undefined) ?? true,
    scope: { domainSystems: Object.fromEntries(selectedDomains.map(([domainId, selection]) => [domainId, unique(selection.systems)])), repositoryIds },
  }
}

function validSessionIdentity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) }
const SIDE_PANEL_HANDOFF_TTL_MS = 60_000
const SIDE_PANEL_HANDOFF_STORAGE_KEY = 'harnessSidePanelHandoffsV1'
const workspaceDesktopNotifications = new WorkspaceDesktopNotifications(chrome, chrome.storage?.session)
type SidePanelHandoff = { sessionId: string; tabId: number; nonce: string; expiresAt: number }
const pendingSidePanelHandoffs = new Map<number, SidePanelHandoff>()
function validHandoffNonce(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{32,160}$/.test(value) }
async function readPersistedSidePanelHandoff(windowId: number): Promise<SidePanelHandoff | undefined> {
  const storage = chrome.storage?.session
  if (storage?.get === undefined) return undefined
  const raw = (await storage.get(SIDE_PANEL_HANDOFF_STORAGE_KEY))[SIDE_PANEL_HANDOFF_STORAGE_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = (raw as Record<string, unknown>)[String(windowId)]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  return validSessionIdentity(item.sessionId) && Number.isInteger(item.tabId) && (item.tabId as number) >= 0 && validHandoffNonce(item.nonce) && typeof item.expiresAt === 'number'
    ? { sessionId: item.sessionId, tabId: item.tabId as number, nonce: item.nonce, expiresAt: item.expiresAt }
    : undefined
}
async function persistSidePanelHandoff(windowId: number, handoff: SidePanelHandoff | undefined): Promise<void> {
  const storage = chrome.storage?.session
  if (storage?.get === undefined || storage.set === undefined) return
  const values = (await storage.get(SIDE_PANEL_HANDOFF_STORAGE_KEY))[SIDE_PANEL_HANDOFF_STORAGE_KEY]
  const records = values && typeof values === 'object' && !Array.isArray(values) ? { ...(values as Record<string, unknown>) } : {}
  if (handoff === undefined) delete records[String(windowId)]
  else records[String(windowId)] = handoff
  await storage.set({ [SIDE_PANEL_HANDOFF_STORAGE_KEY]: records })
}
const WORKSPACE_REVIEW_SNAPSHOT_PATH = '/api/workspace-review/snapshot'
const WORKSPACE_REVIEW_SELECTION_PATH = '/api/workspace-review/selection'
const WORKSPACE_REVIEW_PROPOSALS_PATH = '/api/workspace-review/proposals'
const WORKSPACE_REVIEW_PREPARE_WRITE_PATH = '/api/workspace-review/prepare-write'
const WORKSPACE_REVIEW_COMMIT_WRITE_PATH = '/api/workspace-review/commit-write'
const WORKSPACE_REVIEW_REQUEST_TIMEOUT_MS = 15_000
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
  /** This flag only comes from the narrow /pmd-prd tool-call provenance. */
  pmdPrd?: true
}

interface MarkdownReviewRecord extends OpenMarkdownReview {
  tabId: number
  windowId: number
  /** Browser Target active before its dedicated Markdown Review Tab opened. */
  sourceTabId?: number
  /** Latest rating; persisted with this review rather than creating another PRD. */
  rating?: PrdRating
  /** Generated once per successful /pmd-prd output; survives a tab/service-worker reopen. */
  prdGenerationId?: string
}
type PersistedMarkdownReview = Omit<MarkdownReviewRecord, 'capability' | 'v'>

const markdownReviews = new Map<string, MarkdownReviewRecord>()
const markdownReviewKeys = new Map<string, string>()
const markdownReviewPorts = new Map<number, chrome.runtime.Port>()
const markdownReviewRehydrates = new Map<string, Promise<void>>()

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
    && (review.pmdPrd === undefined || review.pmdPrd === true)
}

function validScope(value: unknown): value is KnowledgeScope {
  return typeof value === 'object' && value !== null
    && (('domainSystems' in value && typeof (value as KnowledgeScope).domainSystems === 'object' && (value as KnowledgeScope).domainSystems !== null
      && Object.entries((value as KnowledgeScope).domainSystems).every(([domainId, systemIds]) => validSessionIdentity(domainId) && Array.isArray(systemIds) && systemIds.every(validSessionIdentity)))
      || ((value as { domainId?: unknown }).domainId === '' || validSessionIdentity((value as { domainId?: unknown }).domainId))
        && Array.isArray((value as { systemIds?: unknown }).systemIds) && (value as { systemIds: unknown[] }).systemIds.every(validSessionIdentity))
    && Array.isArray((value as KnowledgeScope).repositoryIds) && (value as KnowledgeScope).repositoryIds.every(validSessionIdentity)
}
function normalizeScope(scope: KnowledgeScope | { domainId: string; systemIds: string[]; repositoryIds: string[] }): KnowledgeScope {
  const domainSystems = 'domainSystems' in scope
    ? Object.fromEntries(Object.entries(scope.domainSystems).flatMap(([domainId, systemIds]) => {
      const selected = [...new Set(systemIds)]
      return selected.length === 0 ? [] : [[domainId, selected]]
    }))
    : scope.domainId === '' || scope.systemIds.length === 0 ? {} : { [scope.domainId]: [...new Set(scope.systemIds)] }
  return { domainSystems, repositoryIds: [...new Set(scope.repositoryIds)] }
}
function scopeFingerprint(scope: KnowledgeScope): string { return JSON.stringify([Object.entries(scope.domainSystems).map(([domainId, systemIds]) => [domainId, [...systemIds].sort()]).sort(([left], [right]) => String(left).localeCompare(String(right))), [...scope.repositoryIds].sort()]) }
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
function pruneScope(scope: KnowledgeScope, catalog: { domains: Array<{ id: string }>; systems: Array<{ id: string; domainId?: string }>; repositories: Array<{ id: string }> }): KnowledgeScope {
  const allowedDomains = new Set(catalog.domains.map((domain) => domain.id))
  const domainSystems = Object.fromEntries(Object.entries(scope.domainSystems).flatMap(([domainId, systemIds]) => {
    if (!allowedDomains.has(domainId)) return []
    const allowed = new Set(catalog.systems.filter((system) => system.domainId === domainId).map((system) => system.id))
    const selected = systemIds.filter((systemId) => allowed.has(systemId))
    return selected.length === 0 ? [] : [[domainId, selected]]
  }))
  const allowedRepositories = new Set(catalog.repositories.map((repository) => repository.id))
  return { domainSystems, repositoryIds: scope.repositoryIds.filter((id) => allowedRepositories.has(id)) }
}
function selectedScopeNames(ids: string[], entries: Array<{ id: string; name: string }>, fallbackToId = false): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry.name]))
  return ids.flatMap((id) => {
    const name = byId.get(id)
    if (typeof name === 'string' && name.trim().length > 0) return [name]
    return fallbackToId && id.trim().length > 0 ? [id] : []
  }).slice(0, 50)
}
function selectedSourceScopeEcho(record: { scope: KnowledgeScope; enabled: boolean }, catalog: { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string; domainId?: string }>; repositories: Array<{ id: string; name: string }> }): { enabled: boolean; codeSelected: boolean; knowledgeSelected: boolean; repositories: string[]; knowledge: string[] } {
  const repositories = selectedScopeNames(record.scope.repositoryIds, catalog.repositories, true)
  const systems = Object.entries(record.scope.domainSystems).flatMap(([domainId, systemIds]) => systemIds.flatMap((systemId) => selectedScopeNames([systemId], catalog.systems.filter((system) => system.domainId === domainId), true)))
  const knowledge = systems
  return { enabled: record.enabled, codeSelected: repositories.length > 0, knowledgeSelected: knowledge.length > 0, repositories, knowledge }
}

const NATIVE_HOST_NAME = ACCRUI_NATIVE_HOST_NAME
const START_TIMEOUT_MS = 30_000
const PROTOTYPE_STUDIO_OPEN_PATH = '/api/prototype-studio/open'
const PROTOTYPE_STUDIO_RECOVER_PATH = '/api/prototype-studio/recover'
const PROTOTYPE_STUDIO_REBIND_SESSION_PATH = '/api/prototype-studio/rebind-session'
const PROTOTYPE_STUDIO_RENAME_PATH = '/api/prototype-studio/rename'
const PROTOTYPE_STUDIO_DELETE_PATH = '/api/prototype-studio/delete'
const PROTOTYPE_STUDIO_CONFIRM_DESIGN_PATH = '/api/prototype-studio/confirm-design'
const PROTOTYPE_STUDIO_CONFIRM_BRIEF_PATH = '/api/prototype-studio/confirm-brief'
const PROTOTYPE_STUDIO_BEGIN_BRIEF_SUGGESTION_PATH = '/api/prototype-studio/begin-brief-suggestion'
const PROTOTYPE_STUDIO_REOPEN_DESIGN_PATH = '/api/prototype-studio/reopen-design'
const PROTOTYPE_STUDIO_SNAPSHOT_PATH = '/api/prototype-studio/snapshot'
const PROTOTYPE_STUDIO_REVISION_PREVIEW_PATH = '/api/prototype-studio/revision-preview'
const PROTOTYPE_STUDIO_RESTORE_PATH = '/api/prototype-studio/restore'
const PROTOTYPE_STUDIO_BEGIN_GENERATION_PATH = '/api/prototype-studio/begin-generation'
const PROTOTYPE_STUDIO_CANCEL_GENERATION_PATH = '/api/prototype-studio/cancel-generation'
const PROTOTYPE_STUDIO_CONFIRM_CANDIDATE_PATH = '/api/prototype-studio/confirm-candidate'
const PROTOTYPE_STUDIO_CANCEL_CANDIDATE_PATH = '/api/prototype-studio/cancel-candidate'
const PROTOTYPE_HOST_TIMEOUT_MS = 12_000
const PROTOTYPE_RECOVERY_LATE_COMMIT_MAX_MS = 15_000
const PROTOTYPE_RECOVERY_LATE_COMMIT_POLL_MS = 100
const TRANSFER_TIMEOUT_MS = 15_000
const TEAM_KNOWLEDGE_CREATE_CHECKPOINTS_KEY = 'teamKnowledgeCreateCheckpointsV1'
const TEAM_KNOWLEDGE_BATCH_LEASES_KEY = 'teamKnowledgeBatchLeasesV1'

interface NativeMessage {
  type?: unknown
  payload?: unknown
  error?: unknown
  update?: unknown
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
  precondition?: unknown
  sheetName?: unknown
  matchCase?: unknown
  matchEntireCell?: unknown
  searchBy?: unknown
  slideIndex?: unknown
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
  assertion?: unknown
  signature?: unknown
}

interface NativeStartPayload {
  url?: unknown
  runId?: unknown
  nativeVersion?: unknown
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
let releaseUpdateReconnectBlockedUntil = 0
const pendingReleaseUpdates = new Map<string, { resolve: (value: { ok: boolean, update?: unknown, error?: string }) => void, timer: ReturnType<typeof setTimeout>, cancelResolve?: (value: { ok: boolean, error?: string, status?: string }) => void, cancelTimer?: ReturnType<typeof setTimeout>, cancelling?: boolean }>()
const RELEASE_UPDATE_RELOAD_GUARD_KEY = 'accrui:release-update-reload-guard:v1'
const RELEASE_UPDATE_RELOAD_GUARD_MS = 5 * 60_000
let nativeUrl: string | undefined
let nativeRuntimeIdentity: RuntimeIdentitySummary | undefined
let startPromise: Promise<string> | undefined

async function rememberReleaseUpdateReload(version: unknown): Promise<void> {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return
  const storage = chrome.storage?.local
  if (storage === undefined) return
  await storage.set({ [RELEASE_UPDATE_RELOAD_GUARD_KEY]: { version, requestedAt: Date.now(), reloadedAt: undefined } })
}

async function reloadExtensionAfterReleaseUpdate(nativeVersion: unknown): Promise<void> {
  const storage = chrome.storage?.local
  if (storage === undefined || typeof chrome.runtime.reload !== 'function') return
  const guard = (await storage.get(RELEASE_UPDATE_RELOAD_GUARD_KEY))[RELEASE_UPDATE_RELOAD_GUARD_KEY] as { version?: unknown, requestedAt?: unknown, reloadedAt?: unknown } | undefined
  if (typeof guard?.version !== 'string' || typeof guard.requestedAt !== 'number' || Date.now() - guard.requestedAt > RELEASE_UPDATE_RELOAD_GUARD_MS || typeof guard.reloadedAt === 'number' || !shouldConsumeReleaseUpdateReload(guard.version, nativeVersion)) return
  await storage.set({ [RELEASE_UPDATE_RELOAD_GUARD_KEY]: { ...guard, reloadedAt: Date.now() } })
  try {
    chrome.runtime.reload()
  } catch (error) {
    await storage.set({ [RELEASE_UPDATE_RELOAD_GUARD_KEY]: { ...guard, reloadedAt: undefined } })
    throw error
  }
}
// A Run exists even when it began in none mode, so keep its identity separate
// from the optional Browser Target binding.
let currentNativeRunId: string | undefined
const boundBrowserTargets = new Map<string, BrowserTargetBinding>()
interface BrowserTargetRunLock {
  sessionId: string
  submissionId: string
  binding: BrowserTargetBinding
  port: chrome.runtime.Port
  state: 'pending' | 'active'
  observedActivity: boolean
  canceled: boolean
  resolve: (locked: boolean) => void
  reject: (error: Error) => void
  promise: Promise<boolean>
}
const runBrowserTargetLocks = new Map<string, Map<string, BrowserTargetRunLock>>()
const cancelledBrowserTargetSubmissions = new Set<string>()
const pendingRunBrowserTargetTransfers = new Map<string, { browserTarget: BrowserTarget; promise: Promise<void> }>()
const pendingRunBrowserTargetCaptures = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
const MAX_ACTIVE_BROWSER_TARGET_LOCKS = 32
let browserTargetRequestQueue: Promise<void> = Promise.resolve()

function locksForRun(runId: string): Map<string, BrowserTargetRunLock> {
  let locks = runBrowserTargetLocks.get(runId)
  if (locks === undefined) {
    locks = new Map()
    runBrowserTargetLocks.set(runId, locks)
  }
  return locks
}

function removeRunBrowserTargetLock(runId: string, submissionId: string, expected?: BrowserTargetRunLock): void {
  const locks = runBrowserTargetLocks.get(runId)
  if (locks === undefined) return
  if (expected !== undefined && locks.get(submissionId) !== expected) return
  locks.delete(submissionId)
  if (locks.size === 0) runBrowserTargetLocks.delete(runId)
}

function activeRunBrowserTargetLocks(runId: string | undefined): BrowserTargetRunLock[] {
  if (runId === undefined) return []
  return [...(runBrowserTargetLocks.get(runId)?.values() ?? [])]
    .filter(lock => lock.state === 'active' && !lock.canceled && lock.port === nativePort)
}

function rejectBrowserTargetRunLocks(error: Error): void {
  for (const locks of runBrowserTargetLocks.values()) for (const lock of locks.values()) lock.reject(error)
  runBrowserTargetLocks.clear()
  for (const [requestId, pending] of pendingRunBrowserTargetCaptures) {
    clearTimeout(pending.timeout)
    pendingRunBrowserTargetCaptures.delete(requestId)
    pending.reject(error)
  }
}

/** A Browser Target becomes exclusive only while one Connector request is using it. */
function queueBrowserTargetRequest<T>(work: () => Promise<T>): Promise<T> {
  const queued = browserTargetRequestQueue.catch(() => undefined).then(work)
  browserTargetRequestQueue = queued.then(() => undefined, () => undefined)
  return queued
}

const presentationFrameBindings = new Map<string, PresentationFrameBinding>()

const spreadsheetFrameBindings = new Map<string, SpreadsheetFrameBinding>()
const pendingTargetTransfers = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
interface PrototypeRecoverySignature {
  assertion: Record<string, unknown>
  signature: string
}
const pendingPrototypeRecoverySignatures = new Map<string, { resolve: (value: PrototypeRecoverySignature) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
const pendingPmdPrdReviewAdoptions = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
const pendingPrdEventReports = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
let prototypeStudioRecoveryMutation: Promise<void> = Promise.resolve()
// A project lifecycle operation may rotate the Host capability, read its
// snapshot, or promote a session-only candidate. Keep these operations on one
// per-project lane; otherwise a snapshot can mistake a pre-commit candidate's
// temporary 401 for a final rejection and delete it under a live recovery.
const pendingPrototypeStudioProjectFlows = new Map<string, Promise<unknown>>()
const pendingPrototypeStudioRecoveryFlows = new Map<string, Promise<Record<string, unknown>>>()

function queuePrototypeStudioProjectFlow<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingPrototypeStudioProjectFlows.get(projectId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  pendingPrototypeStudioProjectFlows.set(projectId, next)
  void next.then(
    () => { if (pendingPrototypeStudioProjectFlows.get(projectId) === next) pendingPrototypeStudioProjectFlows.delete(projectId) },
    () => { if (pendingPrototypeStudioProjectFlows.get(projectId) === next) pendingPrototypeStudioProjectFlows.delete(projectId) },
  )
  return next
}

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

function isKnowledgeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asError(value: unknown): string {
  if (value instanceof Error) return value.message
  if (isKnowledgeRecord(value) && typeof value.message === 'string') return value.message
  return String(value)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function recordPmdPrdReviewAdoption(review: { harnessSessionId: string; reviewId: string; resourceId: string; displayPath: string; revision: string; fingerprint: string }, content: string): Promise<void> {
  const port = nativePort ?? connectNativePort()
  const requestId = crypto.randomUUID()
  const contentHash = await sha256Hex(content)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pendingPmdPrdReviewAdoptions.delete(requestId); reject(new Error('PRD 采纳记录超时；请重试。')) }, 5_000)
    pendingPmdPrdReviewAdoptions.set(requestId, { resolve, reject, timeout })
    try { port.postMessage({ type: 'record-pmd-prd-review-adoption', requestId, payload: { ...review, contentHash } }) }
    catch (error) { clearTimeout(timeout); pendingPmdPrdReviewAdoptions.delete(requestId); reject(error instanceof Error ? error : new Error(asError(error))) }
  })
}

/** Resolves only after Native confirms the event reached its durable outbox. */
function reportPrdEvent(payload: Record<string, unknown>): Promise<void> {
  const port = nativePort ?? connectNativePort()
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPrdEventReports.delete(requestId)
      reject(new Error('PRD 埋点记录超时；请重试。'))
    }, 5_000)
    pendingPrdEventReports.set(requestId, { resolve, reject, timeout })
    try {
      port.postMessage({ type: 'report-prd-event', requestId, payload })
    } catch (error) {
      clearTimeout(timeout)
      pendingPrdEventReports.delete(requestId)
      reject(error instanceof Error ? error : new Error(asError(error)))
    }
  })
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

type TeamKnowledgeItemAction = 'inspect_parent' | 'create' | 'readback' | 'release'
type TeamKnowledgeBatchLeaseAction = 'acquire' | 'reuse' | 'release'

interface TeamKnowledgeParent extends TeamDocParent { parentType: string }

interface TeamKnowledgeItemRequest extends ConnectorCorrelation {
  type: typeof CONNECTOR_REQUEST
  browserTarget: BrowserTarget
  harnessSessionId?: string
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
  batchId?: string
  lease?: TeamKnowledgeBatchLeaseAction
  pmdReviewAdoption?: { harnessSessionId: string; reviewId: string; resourceId: string; displayPath: string; revision: string; fingerprint: string; contentHash: string }
}

interface TeamKnowledgeBatchLease {
  runId: string
  batchId: string
  browserTarget: BrowserTarget
  parentFingerprint: string
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
let knowledgeScopeMutation: Promise<void> = Promise.resolve()

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
    && typeof message.generation === 'string' && message.tool === 'team_knowledge_batch' && validBrowserTarget(message.browserTarget)
    && ['inspect_parent', 'create', 'readback', 'release'].includes(String(candidate.action)))) return false
  const hasBatchLease = typeof candidate.batchId === 'string' && candidate.batchId.length > 0 && candidate.batchId.length <= 128
    && (candidate.lease === 'acquire' || candidate.lease === 'reuse' || candidate.lease === 'release')
  if ((candidate.batchId !== undefined || candidate.lease !== undefined) && !hasBatchLease) return false
  if (candidate.action === 'release') return hasBatchLease && candidate.lease === 'release' && isTeamKnowledgeParent(candidate.parent)
  if (candidate.action === 'inspect_parent') return candidate.parent === undefined && candidate.kind === undefined && candidate.name === undefined && candidate.body === undefined && candidate.catalogId === undefined && candidate.userConfirmation === undefined
    && (candidate.pmdReviewAdoption === undefined || isPmdReviewAdoption(candidate.pmdReviewAdoption))
    && (!hasBatchLease || candidate.lease === 'acquire' || candidate.lease === 'reuse')
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
    && (!hasBatchLease || candidate.lease === 'reuse')
}

function isPmdReviewAdoption(value: unknown): value is NonNullable<TeamKnowledgeItemRequest['pmdReviewAdoption']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 7 && ['harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'contentHash'].every(key => key in item)
    && ['harnessSessionId', 'reviewId', 'resourceId', 'revision'].every(key => reviewId(item[key]))
    && boundedReviewText(item.displayPath, 2_048) && /^[a-f0-9]{64}$/i.test(String(item.fingerprint)) && /^[a-f0-9]{64}$/i.test(String(item.contentHash))
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
    && validBrowserTarget(payload.browserTarget)
    && (payload.browserTargets === undefined || (Array.isArray(payload.browserTargets)
      && payload.browserTargets.every(validBrowserTarget)))
    && (payload.unavailableBrowserTargets === undefined || (Array.isArray(payload.unavailableBrowserTargets)
      && payload.unavailableBrowserTargets.every(validUnavailableBrowserTarget)))
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
  for (const [key, value] of Object.entries(legacyValues)) {
    const prefix = legacyKnowledgeScopeKey('')
    if (!key.startsWith(prefix)) continue
    const sessionId = key.slice(prefix.length)
    if (!validSessionIdentity(sessionId) || scopes[sessionId] !== undefined) continue
    const migrated = migrateLegacyKnowledgeScope(value)
    if (migrated === undefined) continue
    scopes[sessionId] = { scope: normalizeScope(migrated.scope), enabled: migrated.enabled, ...(migrated.notice === undefined ? {} : { notice: migrated.notice }) }
  }
  return scopes
}

function enqueueKnowledgeScopeMutation<T>(work: () => Promise<T>): Promise<T> {
  const mutation = knowledgeScopeMutation.then(work)
  knowledgeScopeMutation = mutation.then(() => undefined, () => undefined)
  return mutation
}

function mutateKnowledgeScopes<T>(work: (scopes: Record<string, KnowledgeScopeRecord>) => Promise<T>): Promise<T> {
  return enqueueKnowledgeScopeMutation(async () => {
    const scopes = await knowledgeScopes()
    const value = await work(scopes)
    await targetStorage()?.set({ [KNOWLEDGE_SCOPE_STORAGE_KEY]: scopes })
    return value
  })
}

function clearKnowledgeScopeStorage(): Promise<void> {
  return enqueueKnowledgeScopeMutation(async () => {
    const localValues = await chrome.storage.local.get(null)
    const legacyScopeKeys = Object.keys(localValues).filter(key => key.startsWith(legacyKnowledgeScopeKey('')))
    await chrome.storage.session?.remove(KNOWLEDGE_SCOPE_STORAGE_KEY)
    await chrome.storage.local.remove([KNOWLEDGE_SCOPE_STORAGE_KEY, KNOWLEDGE_SCOPE_DEFAULT_STORAGE_KEY, ...legacyScopeKeys])
  })
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

async function knowledgeDefaultScope(): Promise<KnowledgeScope | undefined> {
  const values = await chrome.storage.local.get(KNOWLEDGE_SCOPE_DEFAULT_STORAGE_KEY)
  const candidate = values?.[KNOWLEDGE_SCOPE_DEFAULT_STORAGE_KEY]
  return validScope(candidate) ? normalizeScope(candidate) : undefined
}

async function saveKnowledgeScope(sessionId: string, scope: KnowledgeScope, enabled?: boolean, remember?: boolean): Promise<KnowledgeScopeRecord> {
  return mutateKnowledgeScopes(async (scopes) => {
    if (await accountLocallySignedOut()) throw new Error('knowledge_login_required')
    const previous = scopes[sessionId]
    const preference = await knowledgeEnabledPreference()
    const nextEnabled = enabled ?? previous?.enabled ?? (preference.remember ? preference.enabled : true)
    scopes[sessionId] = { scope: normalizeScope(scope), enabled: nextEnabled, ...(previous?.notice === undefined ? {} : { notice: previous.notice }) }
    await chrome.storage.local.set({ [KNOWLEDGE_SCOPE_DEFAULT_STORAGE_KEY]: scopes[sessionId].scope })
    if (remember !== undefined) await chrome.storage.local.set({ [KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY]: { remember, enabled: nextEnabled } })
    else if (preference.remember && enabled !== undefined) await chrome.storage.local.set({ [KNOWLEDGE_ENABLED_PREFERENCE_STORAGE_KEY]: { remember: true, enabled: nextEnabled } })
    return scopes[sessionId]
  })
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
  return companyGatewayQuota(value.quota) !== undefined && value.models.every((model) => isKnowledgeRecord(model)
    && typeof model.id === 'string' && typeof model.name === 'string'
    && (model.description === undefined || typeof model.description === 'string'))
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

async function probeCompanyGateway(apiKey: string): Promise<CompanyGatewayMetadata> {
  const [rawModels, rawQuota] = await Promise.all([
    companyGatewayJson('/models', apiKey),
    companyGatewayJson('/key/quota', apiKey),
  ])
  const models = companyGatewayModels(rawModels)
  const quota = companyGatewayQuota(rawQuota)
  if (models === undefined || models.length === 0) throw new Error('公司网关没有返回可用模型。')
  if (quota === undefined) throw new Error('公司网关返回了无法识别的用量信息。')
  if (quota.usagePercent !== null && quota.usagePercent >= 100) throw new Error('公司网关额度已经耗尽，请补充额度或更换 Key。')
  const metadata = { models, quota, checkedAt: new Date().toISOString() }
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

type CompanyLoginIdentity = { userCode: string; employeeId: string }
let companyLoginIdentityReport: Promise<void> | undefined
let lastCompanyLoginIdentityFingerprint: string | undefined

function parseCompanyLoginIdentity(value: unknown): CompanyLoginIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  if ('code' in root && root.code !== '0' && root.code !== 0) return undefined
  const nested = root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined
  const payload = nested ?? root
  const userCode = typeof payload.userCode === 'string' ? payload.userCode.trim() : ''
  const employeeId = typeof payload.employeeId === 'string' || typeof payload.employeeId === 'number'
    ? String(payload.employeeId).trim()
    : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(userCode) || !/^\d{1,32}$/.test(employeeId)) return undefined
  return { userCode, employeeId }
}

async function reportCompanyLoginIdentityBestEffort(): Promise<void> {
  if (companyLoginIdentityReport !== undefined) return companyLoginIdentityReport
  companyLoginIdentityReport = (async () => {
    try {
      const response = await fetch(COMPANY_LOGIN_IDENTITY_API_URL, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return
      const identity = parseCompanyLoginIdentity(await response.json())
      if (identity === undefined) return
      const fingerprint = `${identity.userCode}\0${identity.employeeId}`
      if (lastCompanyLoginIdentityFingerprint === fingerprint) return
      const port = nativePort ?? connectNativePort()
      port.postMessage({
        type: 'report-user-identity',
        payload: { ...identity, observedAt: new Date().toISOString() },
      })
      lastCompanyLoginIdentityFingerprint = fingerprint
    } catch {
      // Identity telemetry is best effort and must never block account access.
    }
  })().finally(() => { companyLoginIdentityReport = undefined })
  return companyLoginIdentityReport
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
    void reportCompanyLoginIdentityBestEffort()
    return {
      status: 'authenticated',
      knowledgeAccess: true,
      codeAccess: true,
      modelMode: 'company-pending',
      ...(gateway === undefined ? {} : { gateway }),
      message: '公司账号已登录；可使用个人 Key 配置公司网关模型。',
    }
  } catch (error) {
    if (knowledgeTransport.serviceState(error) === 'unauthenticated') {
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
  knowledgeTransport.clearCatalog()
  for (const controller of activeKnowledgeQueries.values()) controller.abort()
  await clearKnowledgeScopeStorage()
  await knowledgeSessionStorage()?.remove(KNOWLEDGE_SESSION_STORAGE_KEY)
  return accountAccessSnapshot()
}

async function resolveKnowledgeScopeRecord(request: KnowledgeQueryRequest | SelectedSourceScopeRequest): Promise<KnowledgeScopeRecord | undefined> {
  return mutateKnowledgeScopes(async (scopes) => {
    const current = scopes[request.harnessSessionId]
    if (current !== undefined) return current
    const inherited = request.harnessParentSessionId === undefined ? undefined : scopes[request.harnessParentSessionId]
    const defaultScope = inherited?.scope ?? await knowledgeDefaultScope()
    if (defaultScope === undefined) return undefined
    const preference = await knowledgeEnabledPreference()
    const record = inherited ?? { scope: defaultScope, enabled: preference.remember ? preference.enabled : true }
    scopes[request.harnessSessionId] = record
    return record
  })
}

async function respondToSelectedSourceScope(port: chrome.runtime.Port, request: SelectedSourceScopeRequest): Promise<void> {
  try {
    await assertAccountAccessForProtectedSource()
    const record = await resolveKnowledgeScopeRecord(request)
    const empty = { domainSystems: {}, repositoryIds: [] }
    const preference = await knowledgeEnabledPreference()
    const enabled = record?.enabled ?? (preference.remember ? preference.enabled : true)
    let scope = record?.scope ?? empty
    let catalog: { domains: Array<{ id: string; name: string }>; systems: Array<{ id: string; name: string }>; repositories: Array<{ id: string; name: string }> } = { domains: [], systems: [], repositories: [] }
    try {
      catalog = await knowledgeTransport.loadCatalog()
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
    try { scope = pruneScope(record.scope, await knowledgeTransport.loadCatalog()) } catch { /* catalog failure must not erase the exact stored domain-system pairs */ }
    const kind: KnowledgeKind = request.tool === 'knowledge_search' ? 'knowledge' : 'code'
    const fingerprint = scopeFingerprint(scope)
    const sessions = await knowledgeSessions()
    const owner = knowledgeConversationOwner(request.harnessSessionId, request.harnessParentSessionId)
    const continuation = planKnowledgeContinuation(sessions, owner, kind, fingerprint)
    const executed = await knowledgeTransport.query({ kind, question: request.question.trim(), scope, priorSessionId: continuation.priorSessionId, signal: controller.signal, onProgress: (progress) => {
      if (progress.process !== undefined && progress.process !== '') lastProcess = progress.process
      broadcast('streaming', progress.chars, progress.content, progress.eventType, progress.process)
    } })
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
    currentNativeRunId = undefined
    boundBrowserTargets.clear()
    rejectBrowserTargetRunLocks(new Error('Harness restarted before the Browser Target lock completed.'))
    presentationFrameBindings.clear()
    spreadsheetFrameBindings.clear()
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

class PrototypeHostTimeoutError extends Error {}
function prototypeHostTimeoutMs(): number {
  const override = (globalThis as { __ACCRUI_PROTOTYPE_HOST_TIMEOUT_MS?: unknown }).__ACCRUI_PROTOTYPE_HOST_TIMEOUT_MS
  return typeof override === 'number' && Number.isFinite(override) && override > 0 && override <= 60_000 ? override : PROTOTYPE_HOST_TIMEOUT_MS
}
function prototypeRecoveryLateCommitWindowMs(): number {
  return Math.max(500, Math.min(PROTOTYPE_RECOVERY_LATE_COMMIT_MAX_MS, prototypeHostTimeoutMs() * 2))
}
function delayPrototypeRecoveryReadback(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
async function requestPrototypeHost(base: string, authorization: PrototypeStudioAuthorization, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), prototypeHostTimeoutMs())
  try {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization.capability}` }, body: JSON.stringify({ projectId: authorization.projectId, ...body }), signal: controller.signal })
    const text = await response.text(); let payload: Record<string, unknown> = {}
    try { payload = text === '' ? {} : JSON.parse(text) as Record<string, unknown> } catch { /* preserve the HTTP status below */ }
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Prototype Studio request failed: HTTP ${String(response.status)}`)
    return payload
  } catch (error) {
    if (controller.signal.aborted) throw new PrototypeHostTimeoutError('Prototype Studio Host request timed out.', { cause: error })
    throw error
  } finally { clearTimeout(timeout) }
}
async function requestPrototypeRecovery(base: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), prototypeHostTimeoutMs())
  try {
    const response = await fetch(new URL(PROTOTYPE_STUDIO_RECOVER_PATH, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    const text = await response.text(); let payload: Record<string, unknown> = {}
    try { payload = text === '' ? {} : JSON.parse(text) as Record<string, unknown> } catch { /* preserve the HTTP status below */ }
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Prototype Studio recovery failed: HTTP ${String(response.status)}`)
    return payload
  } catch (error) {
    if (controller.signal.aborted) throw new PrototypeHostTimeoutError('Prototype Studio recovery timed out.', { cause: error })
    throw error
  } finally { clearTimeout(timeout) }
}

function settlePrototypeRecoverySignature(message: NativeMessage): void {
  if (typeof message.requestId !== 'string') return
  const pending = pendingPrototypeRecoverySignatures.get(message.requestId)
  if (pending === undefined) return
  clearTimeout(pending.timeout)
  pendingPrototypeRecoverySignatures.delete(message.requestId)
  if (message.type === 'prototype_recovery_sign_failed') {
    pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Native Host refused Prototype Studio recovery signing.'))
    return
  }
  if (message.type !== 'prototype_recovery_signed' || message.assertion === null || typeof message.assertion !== 'object' || Array.isArray(message.assertion) || typeof message.signature !== 'string') {
    pending.reject(new Error('Native Host returned an invalid Prototype Studio recovery signature.'))
    return
  }
  pending.resolve({ assertion: message.assertion as Record<string, unknown>, signature: message.signature })
}

function rejectPrototypeRecoverySignatures(error: Error): void {
  for (const pending of pendingPrototypeRecoverySignatures.values()) {
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  pendingPrototypeRecoverySignatures.clear()
}

async function requestPrototypeRecoverySignature(payload: Pick<PrototypeStudioRecoveryBinding, 'projectId' | 'referenceId' | 'sessionId' | 'evidenceFingerprint' | 'recoveryEpoch'> & { capabilityFingerprint: string }): Promise<PrototypeRecoverySignature> {
  await (nativeUrl === undefined ? startHarnessForSettings() : Promise.resolve(nativeUrl))
  const port = nativePort
  if (port === undefined) throw new Error('可信恢复通道尚未准备好，请重试；原型和历史版本仍保留。')
  const requestId = crypto.randomUUID()
  return new Promise<PrototypeRecoverySignature>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPrototypeRecoverySignatures.delete(requestId)
      reject(new Error('等待本机恢复授权签名超时，请重试。'))
    }, prototypeHostTimeoutMs())
    pendingPrototypeRecoverySignatures.set(requestId, { resolve, reject, timeout })
    try {
      port.postMessage({
        type: 'sign-prototype-recovery', requestId,
        payload: {
          projectId: payload.projectId,
          expectedSessionId: payload.sessionId,
          referenceId: payload.referenceId,
          evidenceFingerprint: payload.evidenceFingerprint,
          capabilityFingerprint: payload.capabilityFingerprint,
          expectedRecoveryEpoch: payload.recoveryEpoch,
        },
      })
    } catch (error) {
      clearTimeout(timeout)
      pendingPrototypeRecoverySignatures.delete(requestId)
      reject(new Error(asError(error)))
    }
  })
}
async function prototypeHostRequest(authorization: PrototypeStudioAuthorization, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = nativeUrl ?? await startHarnessForSettings()
  try { return await requestPrototypeHost(base, authorization, path, body) } catch (error) {
    if (!(error instanceof PrototypeHostTimeoutError)) throw error
    const restarted = await restartHarnessForSettings()
    try { return await requestPrototypeHost(restarted, authorization, path, body) } catch (retryError) {
      if (retryError instanceof PrototypeHostTimeoutError) throw new Error('原型服务连接超时，请稍后重试。', { cause: retryError })
      throw retryError
    }
  }
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

async function forgetPrototypeStudio(projectId: string): Promise<void> {
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const storage = chrome.storage?.session
    const persisted = storage === undefined ? [] : Object.values(storedPrototypeStudioAuthorizations((await storage.get(PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY))[PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY]).authorizations)
    const retained = replaceRememberedPrototypeStudios([...prototypeStudioAuthorizations.values(), ...persisted].filter(item => item.projectId !== projectId))
    if (storage !== undefined) {
      await storage.set({ [PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY]: { v: 1, authorizations: Object.fromEntries(retained.map(item => [item.projectId, item])) } })
      const readback = storedPrototypeStudioAuthorizations((await storage.get(PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY))[PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY])
      if (readback.authorizations[projectId] !== undefined) throw new Error('浏览器未能回读并确认原型临时授权已清理。')
    }
  })
}

function queuePrototypeStudioRecoveryMutation(operation: () => Promise<void>): Promise<void> {
  const queued = prototypeStudioRecoveryMutation.then(operation)
  prototypeStudioRecoveryMutation = queued.then(() => undefined, () => undefined)
  return queued
}

function recoveryBindingFromSnapshot(snapshot: Record<string, unknown>, projectId: string, referenceId: string): PrototypeStudioRecoveryBinding | undefined {
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence[0] as { id?: unknown; fingerprint?: unknown; source?: { title?: unknown; url?: unknown } } | undefined : undefined
  const referenceTitle = typeof evidence?.source?.title === 'string' ? evidence.source.title.trim().slice(0, 240) : undefined
  const referenceUrl = typeof evidence?.source?.url === 'string' ? evidence.source.url : undefined
  const document = snapshot.document !== null && typeof snapshot.document === 'object' && !Array.isArray(snapshot.document) ? snapshot.document as { title?: unknown } : undefined
  const projectName = typeof snapshot.projectName === 'string' && snapshot.projectName.trim() !== '' ? snapshot.projectName.trim().slice(0, 160) : typeof document?.title === 'string' && document.title.trim() !== '' ? document.title.trim().slice(0, 160) : undefined
  const revisions = Array.isArray(snapshot.revisions) ? snapshot.revisions : []
  const currentRevisionId = typeof snapshot.currentRevisionId === 'string' ? snapshot.currentRevisionId : undefined
  const candidate: PrototypeStudioRecoveryBinding = {
    projectId,
    referenceId,
    sessionId: typeof snapshot.sessionId === 'string' ? snapshot.sessionId : '',
    evidenceFingerprint: typeof evidence?.fingerprint === 'string' ? evidence.fingerprint : '',
    recoveryEpoch: typeof snapshot.recoveryEpoch === 'number' ? snapshot.recoveryEpoch : -1,
    updatedAt: Date.now(),
    ...(referenceTitle === undefined ? {} : { referenceTitle }),
    ...(referenceUrl === undefined ? {} : { referenceUrl }),
    ...(projectName === undefined ? {} : { projectName }),
    ...(currentRevisionId === undefined ? {} : { currentRevisionId }),
    revisionCount: revisions.length,
  }
  return evidence?.id === referenceId && validPrototypeStudioRecoveryBinding(candidate) ? candidate : undefined
}

async function rememberPrototypeStudioRecoveryBinding(binding: PrototypeStudioRecoveryBinding): Promise<void> {
  await queuePrototypeStudioRecoveryMutation(async () => {
    const storage = chrome.storage?.local
    if (storage === undefined) return
    const current = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
    // Snapshots created by older Host builds may omit source metadata. Keep
    // the previously verified non-secret title/URL in that case so the Side
    // Panel can still identify a project after local screenshot eviction.
    const previous = current.projects[binding.projectId]
    const enriched: PrototypeStudioRecoveryBinding = {
      ...binding,
      ...(binding.referenceTitle === undefined && previous?.referenceTitle !== undefined ? { referenceTitle: previous.referenceTitle } : {}),
      ...(binding.referenceUrl === undefined && previous?.referenceUrl !== undefined ? { referenceUrl: previous.referenceUrl } : {}),
      ...(binding.projectName === undefined && previous?.projectName !== undefined ? { projectName: previous.projectName } : {}),
      ...(binding.currentRevisionId === undefined && previous?.currentRevisionId !== undefined ? { currentRevisionId: previous.currentRevisionId } : {}),
      ...(binding.revisionCount === undefined && previous?.revisionCount !== undefined ? { revisionCount: previous.revisionCount } : {}),
    }
    const retained = retainedPrototypeStudioRecoveryBindings([...Object.values(current.projects), enriched])
    const next = { v: 1 as const, projects: Object.fromEntries(retained.map(item => [item.projectId, item])) }
    await storage.set({ [PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY]: next })
    const readback = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
    const stored = readback.projects[binding.projectId]
    if (stored === undefined || stored.referenceId !== enriched.referenceId || stored.sessionId !== enriched.sessionId || stored.evidenceFingerprint !== enriched.evidenceFingerprint || stored.recoveryEpoch !== enriched.recoveryEpoch
      || stored.referenceTitle !== enriched.referenceTitle || stored.referenceUrl !== enriched.referenceUrl || stored.projectName !== enriched.projectName || stored.currentRevisionId !== enriched.currentRevisionId || stored.revisionCount !== enriched.revisionCount) {
      throw new Error('浏览器未能回读并确认项目恢复绑定，请重试。')
    }
  })
}

async function forgetPrototypeStudioRecoveryBinding(projectId: string): Promise<void> {
  await queuePrototypeStudioRecoveryMutation(async () => {
    const storage = chrome.storage?.local
    if (storage === undefined) return
    const current = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
    const retained = Object.values(current.projects).filter(item => item.projectId !== projectId)
    await storage.set({ [PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY]: { v: 1, projects: Object.fromEntries(retained.map(item => [item.projectId, item])) } })
    const readback = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
    if (readback.projects[projectId] !== undefined) throw new Error('浏览器未能回读并确认最近原型已删除。')
  })
}

async function prototypeStudioRecoveryBinding(projectId: string, referenceId: string): Promise<PrototypeStudioRecoveryBinding | undefined> {
  const storage = chrome.storage?.local
  if (storage === undefined) return undefined
  let selected: PrototypeStudioRecoveryBinding | undefined
  await queuePrototypeStudioRecoveryMutation(async () => {
    const current = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
    // Sanitise persisted values while reading. Local storage intentionally has
    // no capability, private key, or Browser Connector credential.
    await storage.set({ [PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY]: current })
    const candidate = current.projects[projectId]
    selected = candidate?.referenceId === referenceId && validPrototypeStudioRecoveryBinding(candidate) ? candidate : undefined
  })
  return selected
}

type RecentPrototypeStudio = Pick<PrototypeStudioRecoveryBinding, 'projectId' | 'referenceId' | 'referenceTitle' | 'referenceUrl' | 'projectName' | 'currentRevisionId' | 'revisionCount' | 'updatedAt'> & { authorizationActive: boolean; boundToCurrentSession?: boolean }

async function recentPrototypeStudios(currentSessionId?: string): Promise<RecentPrototypeStudio[]> {
  const storage = chrome.storage?.local
  if (storage === undefined) return []
  const stored = storedPrototypeStudioRecoveries((await storage.get(PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY])
  // Readback sanitises old/malformed records, but never writes capabilities,
  // screenshots, credentials, or private keys to local storage.
  await storage.set({ [PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY]: stored })
  const authorizations = await Promise.all(Object.values(stored.projects).map(async binding => ({
    binding,
    authorizationActive: (await prototypeStudioAuthorization(binding.projectId)) !== undefined,
  })))
  return authorizations
    .sort((left, right) => right.binding.updatedAt - left.binding.updatedAt || left.binding.projectId.localeCompare(right.binding.projectId))
    .map(({ binding, authorizationActive }) => ({
      projectId: binding.projectId,
      referenceId: binding.referenceId,
      ...(binding.referenceTitle === undefined ? {} : { referenceTitle: binding.referenceTitle }),
      ...(binding.referenceUrl === undefined ? {} : { referenceUrl: binding.referenceUrl }),
      ...(binding.projectName === undefined ? {} : { projectName: binding.projectName }),
      ...(binding.currentRevisionId === undefined ? {} : { currentRevisionId: binding.currentRevisionId }),
      ...(binding.revisionCount === undefined ? {} : { revisionCount: binding.revisionCount }),
      updatedAt: binding.updatedAt,
      authorizationActive,
      ...(currentSessionId === undefined ? {} : { boundToCurrentSession: binding.sessionId === currentSessionId }),
    }))
}

async function openRecentPrototypeStudio(projectId: string): Promise<void> {
  const projects = await recentPrototypeStudios()
  const project = projects.find(item => item.projectId === projectId)
  if (project === undefined) throw new Error('这个最近原型已不存在或未通过安全校验。')
  const url = new URL(chrome.runtime.getURL('prototype-studio.html'))
  url.searchParams.set('referenceId', project.referenceId)
  url.searchParams.set('projectId', project.projectId)
  const window = await chrome.windows?.getLastFocused().catch(() => undefined)
  await chrome.tabs.create({ active: true, ...(Number.isInteger(window?.id) ? { windowId: window!.id } : {}), url: url.toString() })
}

async function continueRecentPrototypeStudioInSession(projectId: string, sessionId: string): Promise<void> {
  const project = (await recentPrototypeStudios()).find(item => item.projectId === projectId)
  if (project === undefined) throw new Error('这个最近原型已不存在或未通过安全校验。')
  let authorization = await prototypeStudioAuthorization(projectId)
  if (authorization === undefined) {
    await recoverPrototypeStudio(projectId, project.referenceId)
    authorization = await prototypeStudioAuthorization(projectId)
  }
  if (authorization === undefined) throw new Error('原型恢复后仍无法取得临时授权，请重试。')
  const before = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
  if (!recoveredPrototypeSnapshot(before, projectId, project.referenceId, (await prototypeStudioRecoveryBinding(projectId, project.referenceId))?.evidenceFingerprint ?? '') || before.sessionId !== authorization.sessionId) throw new Error('继续项目之前无法确认原项目身份，请重试。')
  if (authorization.sessionId !== sessionId) {
    const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_REBIND_SESSION_PATH, { expectedSessionId: authorization.sessionId, sessionId })
    const snapshot = result.snapshot
    if (result.status !== 'verified_write' || result.projectId !== projectId || result.previousSessionId !== authorization.sessionId || result.sessionId !== sessionId || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || (snapshot as Record<string, unknown>).sessionId !== sessionId) throw new Error('原型没有完成当前对话绑定和回读，请重试。')
    authorization = { ...authorization, sessionId, openedAt: Date.now() }
    await rememberPrototypeStudio(authorization)
    const binding = recoveryBindingFromSnapshot(snapshot as Record<string, unknown>, projectId, project.referenceId)
    if (binding === undefined || binding.sessionId !== sessionId) throw new Error('原型对话绑定没有生成可恢复记录，请重试。')
    await rememberPrototypeStudioRecoveryBinding(binding)
  } else {
    const binding = recoveryBindingFromSnapshot(before, projectId, project.referenceId)
    if (binding !== undefined) await rememberPrototypeStudioRecoveryBinding(binding)
  }
  await openRecentPrototypeStudio(projectId)
}

async function authorizedRecentPrototypeStudio(projectId: string): Promise<{ project: RecentPrototypeStudio; authorization: PrototypeStudioAuthorization }> {
  const project = (await recentPrototypeStudios()).find(item => item.projectId === projectId)
  if (project === undefined) throw new Error('这个最近原型已不存在或未通过安全校验。')
  let authorization = await prototypeStudioAuthorization(projectId)
  if (authorization === undefined) { await recoverPrototypeStudio(projectId, project.referenceId); authorization = await prototypeStudioAuthorization(projectId) }
  if (authorization === undefined) throw new Error('原型恢复后仍无法取得临时授权，请重试。')
  return { project, authorization }
}

async function renameRecentPrototypeStudio(projectId: string, projectName: string): Promise<void> {
  const { project, authorization } = await authorizedRecentPrototypeStudio(projectId)
  const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_RENAME_PATH, { projectName })
  const snapshot = result.snapshot
  if (result.status !== 'verified_write' || result.projectId !== projectId || result.projectName !== projectName.trim() || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('原型名称没有完成保存和回读，请重试。')
  const binding = recoveryBindingFromSnapshot(snapshot as Record<string, unknown>, projectId, project.referenceId)
  if (binding === undefined || binding.projectName !== projectName.trim()) throw new Error('原型名称没有同步到最近项目，请重试。')
  await rememberPrototypeStudioRecoveryBinding(binding)
}

async function deleteRecentPrototypeStudio(projectId: string, confirmationProjectId: string): Promise<void> {
  const { authorization } = await authorizedRecentPrototypeStudio(projectId)
  const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_DELETE_PATH, { confirmationProjectId })
  if (result.status !== 'verified_delete' || result.projectId !== projectId) throw new Error('原型项目没有完成删除回读，请重试。')
  await forgetPrototypeStudio(projectId)
  await forgetPrototypeStudioRecoveryBinding(projectId)
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

function samePendingPrototypeRecovery(left: PrototypeStudioPendingRecovery, right: PrototypeStudioPendingRecovery): boolean {
  return left.projectId === right.projectId && left.referenceId === right.referenceId && left.sessionId === right.sessionId
    && left.evidenceFingerprint === right.evidenceFingerprint && left.expectedRecoveryEpoch === right.expectedRecoveryEpoch
    && left.capability === right.capability && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt && left.nonce === right.nonce
}

async function writePendingPrototypeStudioRecoveries(storage: chrome.storage.StorageArea, values: Iterable<unknown>, expected?: PrototypeStudioPendingRecovery): Promise<void> {
  const retained = retainedPrototypeStudioPendingRecoveries(values)
  const next = { v: 1 as const, projects: Object.fromEntries(retained.map(item => [item.projectId, item])) }
  await storage.set({ [PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY]: next })
  const readback = storedPrototypeStudioPendingRecoveries((await storage.get(PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY])
  if (expected !== undefined) {
    const persisted = readback.projects[expected.projectId]
    if (persisted === undefined || !samePendingPrototypeRecovery(persisted, expected)) throw new Error('浏览器未能回读并确认待恢复授权，请重试。')
  }
}

async function rememberPendingPrototypeStudioRecovery(pending: PrototypeStudioPendingRecovery): Promise<void> {
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const storage = chrome.storage?.session
    if (storage === undefined) throw new Error('浏览器不支持临时恢复授权保存，请重试。')
    const current = storedPrototypeStudioPendingRecoveries((await storage.get(PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY])
    await writePendingPrototypeStudioRecoveries(storage, [...Object.values(current.projects), pending], pending)
  })
}

async function pendingPrototypeStudioRecovery(projectId: string, referenceId?: string): Promise<PrototypeStudioPendingRecovery | undefined> {
  const storage = chrome.storage?.session
  if (storage === undefined) return undefined
  let selected: PrototypeStudioPendingRecovery | undefined
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const current = storedPrototypeStudioPendingRecoveries((await storage.get(PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY])
    await writePendingPrototypeStudioRecoveries(storage, Object.values(current.projects))
    const candidate = current.projects[projectId]
    selected = candidate !== undefined && validPrototypeStudioPendingRecovery(candidate) && (referenceId === undefined || candidate.referenceId === referenceId) ? candidate : undefined
  })
  return selected
}

async function clearPendingPrototypeStudioRecovery(pending: PrototypeStudioPendingRecovery): Promise<void> {
  await queuePrototypeStudioAuthorizationMutation(async () => {
    const storage = chrome.storage?.session
    if (storage === undefined) return
    const current = storedPrototypeStudioPendingRecoveries((await storage.get(PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY])
    const retained = Object.values(current.projects).filter(item => !samePendingPrototypeRecovery(item, pending))
    await writePendingPrototypeStudioRecoveries(storage, retained)
    const readback = storedPrototypeStudioPendingRecoveries((await storage.get(PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY))[PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY])
    const remaining = readback.projects[pending.projectId]
    if (remaining !== undefined && samePendingPrototypeRecovery(remaining, pending)) throw new Error('浏览器未能清理已完成的待恢复授权，请重试。')
  })
}

async function sha256TextFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function recoveredPrototypeSnapshot(value: Record<string, unknown>, projectId: string, referenceId: string, evidenceFingerprint: string): value is Record<string, unknown> & { sessionId: string } {
  return value.projectId === projectId && validSessionIdentity(value.sessionId)
    && Array.isArray(value.evidence) && (value.evidence[0] as { id?: unknown; fingerprint?: unknown } | undefined)?.id === referenceId
    && (value.evidence[0] as { fingerprint?: unknown } | undefined)?.fingerprint === evidenceFingerprint
}
function advancedRecoveryEpoch(value: unknown, expectedRecoveryEpoch: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > expectedRecoveryEpoch
}

function definitelyRejectedPendingRecovery(error: unknown): boolean {
  const message = asError(error)
  return /capability is invalid|authorization.*invalid|HTTP (?:401|403|404|409)|does not exist|recovery authority does not match/i.test(message)
}

async function promotePendingPrototypeStudioRecoveryFlow(projectId: string, referenceId?: string): Promise<Record<string, unknown> | undefined> {
  const pending = await pendingPrototypeStudioRecovery(projectId, referenceId)
  if (pending === undefined) return undefined
  const authorization: PrototypeStudioAuthorization = {
    projectId: pending.projectId,
    referenceId: pending.referenceId,
    sessionId: pending.sessionId,
    capability: pending.capability,
    openedAt: pending.createdAt,
  }
  let snapshot: Record<string, unknown>
  try {
    snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
  } catch (error) {
    // Preserve an ambiguous candidate for the next worker wake-up. A definite
    // Host rejection proves the Host did not commit this candidate, so remove
    // it before asking Native Host to sign a fresh recovery assertion.
    if (definitelyRejectedPendingRecovery(error)) {
      await clearPendingPrototypeStudioRecovery(pending)
      return undefined
    }
    throw error
  }
  if (!recoveredPrototypeSnapshot(snapshot, pending.projectId, pending.referenceId, pending.evidenceFingerprint)
    || snapshot.sessionId !== pending.sessionId || !advancedRecoveryEpoch(snapshot.recoveryEpoch, pending.expectedRecoveryEpoch)) {
    await clearPendingPrototypeStudioRecovery(pending)
    return undefined
  }
  const binding = recoveryBindingFromSnapshot(snapshot, pending.projectId, pending.referenceId)
  if (binding === undefined || binding.sessionId !== pending.sessionId || binding.evidenceFingerprint !== pending.evidenceFingerprint || !advancedRecoveryEpoch(binding.recoveryEpoch, pending.expectedRecoveryEpoch)) {
    await clearPendingPrototypeStudioRecovery(pending)
    return undefined
  }
  // Promotion precedes cleanup. If MV3 stops between these two writes, the
  // active authorization is already usable; the harmless pending candidate is
  // removed during a later successful readback.
  await rememberPrototypeStudio(authorization)
  await rememberPrototypeStudioRecoveryBinding(binding)
  await clearPendingPrototypeStudioRecovery(pending)
  return snapshot
}

function promotePendingPrototypeStudioRecovery(projectId: string, referenceId?: string): Promise<Record<string, unknown> | undefined> {
  const activeRecovery = pendingPrototypeStudioRecoveryFlows.get(projectId)
  if (activeRecovery !== undefined) return activeRecovery
  return queuePrototypeStudioProjectFlow(projectId, () => promotePendingPrototypeStudioRecoveryFlow(projectId, referenceId))
}

async function prototypeStudioSnapshotFlow(projectId: string): Promise<Record<string, unknown> | undefined> {
  const authorization = await prototypeStudioAuthorization(projectId)
  if (authorization === undefined) return promotePendingPrototypeStudioRecoveryFlow(projectId)
  try {
    const snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
    const binding = recoveryBindingFromSnapshot(snapshot, authorization.projectId, authorization.referenceId)
    if (binding !== undefined) await rememberPrototypeStudioRecoveryBinding(binding)
    const pending = await pendingPrototypeStudioRecovery(projectId, authorization.referenceId)
    if (pending?.capability === authorization.capability) await clearPendingPrototypeStudioRecovery(pending)
    return snapshot
  } catch (error) {
    if (!definitelyRejectedPendingRecovery(error)) throw error
    // An old active capability can be invalid precisely because the Host
    // committed the pending rotation immediately before MV3 stopped. Check
    // that candidate before treating the project as normally expired.
    return promotePendingPrototypeStudioRecoveryFlow(projectId)
  }
}

function prototypeStudioSnapshot(projectId: string): Promise<Record<string, unknown> | undefined> {
  const activeRecovery = pendingPrototypeStudioRecoveryFlows.get(projectId)
  if (activeRecovery !== undefined) return activeRecovery
  return queuePrototypeStudioProjectFlow(projectId, () => prototypeStudioSnapshotFlow(projectId))
}

async function readLateRecoveredPrototypeSnapshot(base: string, authorization: PrototypeStudioAuthorization, binding: PrototypeStudioRecoveryBinding): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + prototypeRecoveryLateCommitWindowMs()
  while (true) {
    const snapshot = await requestPrototypeHost(base, authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {}).catch(() => undefined)
    if (snapshot !== undefined && recoveredPrototypeSnapshot(snapshot, authorization.projectId, authorization.referenceId, binding.evidenceFingerprint) && snapshot.sessionId === binding.sessionId && advancedRecoveryEpoch(snapshot.recoveryEpoch, binding.recoveryEpoch)) return snapshot
    if (Date.now() >= deadline) return undefined
    await delayPrototypeRecoveryReadback(PROTOTYPE_RECOVERY_LATE_COMMIT_POLL_MS)
  }
}

async function recoverPrototypeStudioFlow(projectId: string, referenceId: string): Promise<Record<string, unknown>> {
  const resumed = await promotePendingPrototypeStudioRecoveryFlow(projectId, referenceId)
  if (resumed !== undefined) return resumed
  const binding = await prototypeStudioRecoveryBinding(projectId, referenceId)
  if (binding === undefined) throw new Error('恢复所需的项目绑定不存在或校验失败，请重新提取设计规范。')
  const authorization: PrototypeStudioAuthorization = { projectId, referenceId, sessionId: binding.sessionId, capability: `${crypto.randomUUID()}${crypto.randomUUID()}`, openedAt: Date.now() }
  const capabilityFingerprint = await sha256TextFingerprint(authorization.capability)
  const base = nativeUrl ?? await startHarnessForSettings()
  const signed = await requestPrototypeRecoverySignature({ ...binding, capabilityFingerprint })
  const assertion = signed.assertion
  const pending: PrototypeStudioPendingRecovery = {
    projectId,
    referenceId,
    sessionId: binding.sessionId,
    evidenceFingerprint: binding.evidenceFingerprint,
    expectedRecoveryEpoch: binding.recoveryEpoch,
    capability: authorization.capability,
    createdAt: Date.now(),
    expiresAt: typeof assertion.expiresAt === 'number' ? assertion.expiresAt : Number.NaN,
    nonce: typeof assertion.nonce === 'string' ? assertion.nonce : '',
  }
  if (assertion.projectId !== projectId || assertion.expectedSessionId !== binding.sessionId || assertion.referenceId !== referenceId
    || assertion.evidenceFingerprint !== binding.evidenceFingerprint || assertion.expectedRecoveryEpoch !== binding.recoveryEpoch
    || assertion.capabilityFingerprint !== capabilityFingerprint || !validPrototypeStudioPendingRecovery(pending)) {
    throw new Error('本机恢复授权签名与项目绑定不一致，请重试。')
  }
  // This durable candidate is written before the Host request. It never
  // replaces the working grant, and makes a Host commit recoverable if MV3 is
  // suspended between `/recover` and the active-authorization write.
  await rememberPendingPrototypeStudioRecovery(pending)
  const recoveryBody = { assertion: signed.assertion, signature: signed.signature, capability: authorization.capability }
  // This is deliberately only a local candidate until both the Host's
  // Verified Write and the new-capability snapshot readback succeed. In
  // particular, it must not replace an already-working authorization if this
  // request later loses an epoch race or arrives after another tab's recovery.
  let recovery: Record<string, unknown> | undefined
  try {
    recovery = await requestPrototypeRecovery(base, recoveryBody)
  } catch (error) {
    // Only a client timeout is ambiguous: the Host may have committed after
    // the browser stopped waiting. A definite HTTP rejection (for example an
    // epoch conflict from a late second tab) must fail immediately and leave
    // the current authorization untouched.
    if (!(error instanceof PrototypeHostTimeoutError)) {
      await clearPendingPrototypeStudioRecovery(pending)
      throw error
    }
    // A timed-out client can race a Host write that is still committing. Poll
    // with the new session capability, then safely retry the exact signed
    // request once: Host-side nonce handling makes that retry idempotent.
    let uncertainReadback = await readLateRecoveredPrototypeSnapshot(base, authorization, binding)
    if (uncertainReadback === undefined) {
      try { recovery = await requestPrototypeRecovery(base, recoveryBody) } catch (retryError) {
        uncertainReadback = await readLateRecoveredPrototypeSnapshot(base, authorization, binding)
        if (uncertainReadback === undefined) {
          if (definitelyRejectedPendingRecovery(retryError)) await clearPendingPrototypeStudioRecovery(pending)
          throw retryError
        }
      }
    }
    if (uncertainReadback !== undefined) recovery = { status: 'verified_write', projectId, sessionId: uncertainReadback.sessionId, referenceId, evidenceFingerprint: binding.evidenceFingerprint, capabilityFingerprint, recoveryEpoch: uncertainReadback.recoveryEpoch }
    else if (recovery === undefined) throw error
  }
  if (recovery === undefined || recovery.status !== 'verified_write' || recovery.projectId !== projectId || recovery.sessionId !== binding.sessionId || recovery.referenceId !== referenceId || recovery.evidenceFingerprint !== binding.evidenceFingerprint || recovery.capabilityFingerprint !== capabilityFingerprint || !advancedRecoveryEpoch(recovery.recoveryEpoch, binding.recoveryEpoch)) throw new Error('原型恢复结果没有通过身份和指纹校验，请重试。')
  authorization.sessionId = recovery.sessionId
  const snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
  if (!recoveredPrototypeSnapshot(snapshot, projectId, referenceId, binding.evidenceFingerprint) || snapshot.sessionId !== authorization.sessionId || snapshot.recoveryEpoch !== recovery.recoveryEpoch) throw new Error('原型恢复后未能完成同项目回读，请勿继续操作并重试。')
  await rememberPrototypeStudio(authorization)
  const rebound = recoveryBindingFromSnapshot(snapshot, projectId, referenceId)
  if (rebound === undefined) throw new Error('原型恢复后未能确认项目绑定，请勿继续操作并重试。')
  await rememberPrototypeStudioRecoveryBinding(rebound)
  await clearPendingPrototypeStudioRecovery(pending)
  return snapshot
}

function recoverPrototypeStudio(projectId: string, referenceId: string): Promise<Record<string, unknown>> {
  const active = pendingPrototypeStudioRecoveryFlows.get(projectId)
  if (active !== undefined) return active
  const flow = queuePrototypeStudioProjectFlow(projectId, () => recoverPrototypeStudioFlow(projectId, referenceId))
  pendingPrototypeStudioRecoveryFlows.set(projectId, flow)
  void flow.then(
    () => { if (pendingPrototypeStudioRecoveryFlows.get(projectId) === flow) pendingPrototypeStudioRecoveryFlows.delete(projectId) },
    () => { if (pendingPrototypeStudioRecoveryFlows.get(projectId) === flow) pendingPrototypeStudioRecoveryFlows.delete(projectId) },
  )
  return flow
}

/** Read an explicitly selected Browser Target without changing the user's tab.
 * Chrome only permits a visible screenshot of the already active tab; inactive
 * pages retain verified DOM/CSS evidence and are clearly shown without a shot.
 */
async function captureDesignReferenceEvidence(browserTarget: BrowserTarget) {
  const before = await chrome.tabs.get(browserTarget.tabId)
  const liveBefore = targetFromActionTab(before)
  if (liveBefore === undefined || !sameBrowserTarget(liveBefore, browserTarget)) {
    throw new Error('参考网页已经切换或关闭。请刷新 Browser Target 后重试。')
  }
  if (before.status !== 'complete') throw new Error('参考网页仍在加载，请等待页面加载完成后重试。')
  const captureModule = await import('../src/design-reference-capture')
  const executions = await chrome.scripting.executeScript({
    target: { tabId: browserTarget.tabId },
    world: 'ISOLATED',
    func: captureModule.captureDesignReferencePage,
  })
  const raw = executions[0]?.result
  const [visibleBeforeScreenshot] = await chrome.tabs.query({ active: true, windowId: browserTarget.windowId })
  const visibleTargetBeforeScreenshot = visibleBeforeScreenshot === undefined ? undefined : targetFromActionTab(visibleBeforeScreenshot)
  // Older single-reference builds rejected "截图前参考网页被切换" here. Multi-reference capture deliberately skips the screenshot instead, so it never activates another tab.
  let screenshotDataUrl: string | undefined
  if (visibleTargetBeforeScreenshot !== undefined && sameBrowserTarget(visibleTargetBeforeScreenshot, browserTarget)) {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(browserTarget.windowId, { format: 'jpeg', quality: 60 })
    const [visibleAfterScreenshot] = await chrome.tabs.query({ active: true, windowId: browserTarget.windowId })
    const visibleTargetAfterScreenshot = visibleAfterScreenshot === undefined ? undefined : targetFromActionTab(visibleAfterScreenshot)
    if (visibleTargetAfterScreenshot === undefined || !sameBrowserTarget(visibleTargetAfterScreenshot, browserTarget)) throw new Error('截图期间参考网页被切换，本次没有保存。请保持该标签页不动后重试。')
  }
  const after = await chrome.tabs.get(browserTarget.tabId)
  const liveAfter = targetFromActionTab(after)
  if (liveAfter === undefined || !sameBrowserTarget(liveAfter, browserTarget)) {
    throw new Error('提取过程中参考网页发生变化，本次没有保存。请等待页面稳定后重试。')
  }
  const evidence = await captureModule.buildReferenceEvidence(raw, screenshotDataUrl)
  return evidence
}

async function persistCapturedReferenceEvidence(evidence: Awaited<ReturnType<typeof captureDesignReferenceEvidence>>[]): Promise<{ storageKey: string; previous: unknown }> {
  const captureModule = await import('../src/design-reference-capture')
  const storageKey = captureModule.PROTOTYPE_REFERENCE_STORAGE_KEY
  const before = await chrome.storage.local.get(storageKey)
  const previous = before[storageKey]
  const current = storedPrototypeReferences(previous)
  const references = { ...current.references, ...Object.fromEntries(evidence.map(item => [item.id, item])) }
  const retained = retainedPrototypeReferences(references)
  await chrome.storage.local.set({ [storageKey]: { v: 1, references: retained } })
  const readback = storedPrototypeReferences((await chrome.storage.local.get(storageKey))[storageKey]).references
  for (const item of evidence) {
    const stored = readback[item.id] as { fingerprint?: unknown; screenshotFingerprint?: unknown } | undefined
    if (stored?.fingerprint !== item.fingerprint || stored.screenshotFingerprint !== item.screenshotFingerprint) throw new Error('浏览器未能回读并确认刚才保存的设计规范，请重试。')
  }
  return { storageKey, previous }
}

async function restoreCapturedReferenceEvidence(snapshot: { storageKey: string; previous: unknown }): Promise<void> {
  if (snapshot.previous === undefined) await chrome.storage.local.remove(snapshot.storageKey)
  else await chrome.storage.local.set({ [snapshot.storageKey]: snapshot.previous })
  const readback = (await chrome.storage.local.get(snapshot.storageKey))[snapshot.storageKey]
  if (JSON.stringify(readback) !== JSON.stringify(snapshot.previous)) throw new Error('合并提取失败后无法恢复原有参考网页存储，请停止重试并检查浏览器存储。')
}

async function openCapturedPrototype(evidence: Awaited<ReturnType<typeof captureDesignReferenceEvidence>>[], sessionId: string, windowId: number): Promise<{ referenceId: string; projectId: string }> {
  const primary = evidence[0]
  if (primary === undefined) throw new Error('没有可用于创建原型项目的参考网页。')
  const storageSnapshot = await persistCapturedReferenceEvidence(evidence)
  const authorization: PrototypeStudioAuthorization = { projectId: `prototype-${crypto.randomUUID()}`, referenceId: primary.id, sessionId, capability: `${crypto.randomUUID()}${crypto.randomUUID()}`, openedAt: Date.now() }
  const hostEvidence = evidence
  let opened: Record<string, unknown>
  try { opened = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_OPEN_PATH, { sessionId, evidence: hostEvidence }) } catch (error) {
    await restoreCapturedReferenceEvidence(storageSnapshot)
    throw error
  }
  await rememberPrototypeStudio(authorization)
  const binding = recoveryBindingFromSnapshot(opened, authorization.projectId, authorization.referenceId)
  if (binding === undefined) throw new Error('原型项目未能确认恢复绑定，请重试。')
  await rememberPrototypeStudioRecoveryBinding(binding)
  const studioUrl = new URL(chrome.runtime.getURL('prototype-studio.html'))
  studioUrl.searchParams.set('referenceId', primary.id)
  studioUrl.searchParams.set('projectId', authorization.projectId)
  await chrome.tabs.create({ windowId, active: true, url: studioUrl.toString() })
  return { referenceId: primary.id, projectId: authorization.projectId }
}

async function captureDesignReference(browserTarget: BrowserTarget, sessionId: string): Promise<{ referenceId: string; projectId: string }> {
  const evidence = await captureDesignReferenceEvidence(browserTarget)
  return openCapturedPrototype([evidence], sessionId, browserTarget.windowId)
}

async function waitForResponsiveCaptureTab(tabId: number, expected: URL, timeoutMs = 20_000): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete' && typeof tab.url === 'string') {
      const actual = new URL(tab.url)
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw new Error('临时测试窗口被重定向到其他页面，多尺寸实测已停止。')
      return tab
    }
    if (Date.now() >= deadline) throw new Error('临时测试窗口加载超时，多尺寸实测已停止。')
    await new Promise(resolve => setTimeout(resolve, 80))
  }
}

function measureResponsiveViewport(): { width: number; height: number } { return { width: Math.round(innerWidth), height: Math.round(innerHeight) } }

async function responsiveViewport(tabId: number): Promise<{ width: number; height: number }> {
  const measured = (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: measureResponsiveViewport }))[0]?.result
  if (measured === null || typeof measured !== 'object' || !Number.isSafeInteger((measured as { width?: unknown }).width) || !Number.isSafeInteger((measured as { height?: unknown }).height)) throw new Error('无法读取临时测试窗口的实际页面尺寸。')
  return measured as { width: number; height: number }
}

async function setResponsiveViewport(windowId: number, tabId: number, width: number, height: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = await responsiveViewport(tabId)
    if (Math.abs(measured.width - width) <= 2 && Math.abs(measured.height - height) <= 2) return
    const current = await chrome.windows.get(windowId)
    await chrome.windows.update(windowId, { width: Math.max(320, (current.width ?? width) + width - measured.width), height: Math.max(480, (current.height ?? height) + height - measured.height) })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  const measured = await responsiveViewport(tabId)
  if (Math.abs(measured.width - width) > 2 || Math.abs(measured.height - height) > 2) throw new Error(`无法把临时测试窗口校准到 ${width}×${height}px。`)
}

async function captureResponsiveDesignReference(browserTarget: BrowserTarget, sessionId: string, onProgress: (current: number) => void): Promise<{ referenceId: string; projectId: string }> {
  const sourceTab = await chrome.tabs.get(browserTarget.tabId)
  const live = targetFromActionTab(sourceTab)
  if (live === undefined || !sameBrowserTarget(live, browserTarget) || sourceTab.status !== 'complete') throw new Error('参考网页已经切换、关闭或仍在加载，请刷新后重试。')
  const expected = new URL(browserTarget.url)
  if (!['http:', 'https:'].includes(expected.protocol)) throw new Error('只有普通网页可以进行多尺寸实测。')
  const targets = [{ label: '桌面', width: 1280, height: 800 }, { label: '平板', width: 768, height: 900 }, { label: '手机', width: 390, height: 780 }]
  const created = await chrome.windows.create({ url: browserTarget.url, type: 'popup', focused: false, width: 1280, height: 900 })
  if (created === undefined) throw new Error('无法创建临时多尺寸测试窗口。')
  const windowId = created.id; const tabId = created.tabs?.[0]?.id
  if (!Number.isSafeInteger(windowId) || !Number.isSafeInteger(tabId)) { if (Number.isSafeInteger(windowId)) await chrome.windows.remove(windowId!); throw new Error('无法创建临时多尺寸测试窗口。') }
  const evidence = [] as Awaited<ReturnType<typeof captureDesignReferenceEvidence>>[]
  try {
    await waitForResponsiveCaptureTab(tabId!, expected)
    const captureModule = await import('../src/design-reference-capture')
    for (const [index, target] of targets.entries()) {
      onProgress(index + 1)
      await setResponsiveViewport(windowId!, tabId!, target.width, target.height)
      const raw = (await chrome.scripting.executeScript({ target: { tabId: tabId! }, world: 'ISOLATED', func: captureModule.captureDesignReferencePage }))[0]?.result
      const item = await captureModule.buildReferenceEvidence(raw, undefined)
      if (Math.abs(item.viewport.width - target.width) > 2 || Math.abs(item.viewport.height - target.height) > 2) throw new Error(`${target.label}尺寸没有按实际 ${target.width}×${target.height}px 完成采集。`)
      evidence.push(item)
    }
  } finally {
    await chrome.windows.remove(windowId!).catch(() => {})
  }
  return openCapturedPrototype(evidence, sessionId, browserTarget.windowId)
}

async function captureDesignReferences(browserTargets: BrowserTarget[], sessionId: string, onProgress: (current: number, tabId: number) => void): Promise<{ referenceId: string; projectId: string }> {
  if (browserTargets.length < 2 || browserTargets.length > 3 || new Set(browserTargets.map(item => item.tabId)).size !== browserTargets.length) throw new Error('请独立选择 2 到 3 个不同网页后再合并提取。')
  const evidence = [] as Awaited<ReturnType<typeof captureDesignReferenceEvidence>>[]
  for (const [index, target] of browserTargets.entries()) {
    onProgress(index + 1, target.tabId)
    try { evidence.push(await captureDesignReferenceEvidence(target)) } catch (error) { throw new Error(`第 ${index + 1} 页“${target.url}”提取失败；没有创建原型项目。${asError(error)}`) }
  }
  return openCapturedPrototype(evidence, sessionId, browserTargets[0]!.windowId)
}

async function createPrototypeVariant(source: PrototypeStudioAuthorization, windowId: number): Promise<{ referenceId: string; projectId: string }> {
  const sourceSnapshot = await prototypeHostRequest(source, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
  const sourceEvidence = [] as Awaited<ReturnType<typeof captureDesignReferenceEvidence>>[]
  if (!Array.isArray(sourceSnapshot.evidence) || sourceSnapshot.evidence.length < 1 || sourceSnapshot.evidence.length > 3) throw new Error('已保存的参考网页证据不存在或校验失败，请重新提取设计规范。')
  for (const item of sourceSnapshot.evidence) {
    const checked = validateReferenceEvidence(item)
    if (!checked.ok || !(await verifyReferenceEvidenceFingerprint(checked.value))) throw new Error('已保存的参考网页证据不存在或校验失败，请重新提取设计规范。')
    sourceEvidence.push(checked.value)
  }
  const authorization: PrototypeStudioAuthorization = {
    projectId: `prototype-${crypto.randomUUID()}`,
    referenceId: sourceEvidence[0]!.id,
    sessionId: source.sessionId,
    capability: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    openedAt: Date.now(),
  }
  const hostEvidence = sourceEvidence
  const opened = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_OPEN_PATH, { sessionId: authorization.sessionId, evidence: hostEvidence })
  await rememberPrototypeStudio(authorization)
  const binding = recoveryBindingFromSnapshot(opened, authorization.projectId, authorization.referenceId)
  if (binding === undefined) throw new Error('新设计方案未能确认恢复绑定，请重试。')
  await rememberPrototypeStudioRecoveryBinding(binding)
  const studioUrl = new URL(chrome.runtime.getURL('prototype-studio.html'))
  studioUrl.searchParams.set('referenceId', authorization.referenceId)
  studioUrl.searchParams.set('projectId', authorization.projectId)
  await chrome.tabs.create({ windowId, active: true, url: studioUrl.toString() })
  return { referenceId: authorization.referenceId, projectId: authorization.projectId }
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

async function resolveOfficeBrowserTarget(request: (ConnectorRequest | RoutedOfficeRequest) & { browserTargets?: BrowserTarget[]; unavailableBrowserTargets?: UnavailableBrowserTarget[] }): Promise<BrowserTargetBinding> {
  // Tab-update candidate persistence and Connector dispatch can arrive in the
  // same event turn. Read settings only after that serialized update settles.
  await browserTargetRuntime.settled()
  const captures = [...(runBrowserTargetLocks.get(request.runId)?.values() ?? [])]
    .filter(lock => !lock.canceled && (lock.state === 'active' || lock.state === 'pending'))
  const harnessSessionId = (request as ConnectorRequest & { harnessSessionId?: unknown }).harnessSessionId
  if (captures.length > 0 && typeof harnessSessionId !== 'string') {
    throw new Error('Browser Connector request has no Harness session identity for its captured Browser Target.')
  }
  const locked = typeof harnessSessionId === 'string'
    ? captures.find(lock => lock.sessionId === harnessSessionId)
    : undefined
  if (typeof harnessSessionId === 'string' && captures.length > 0 && locked === undefined) {
    throw new Error('No captured Browser Target matches this Harness session; refusing to use another session’s page.')
  }
  if (locked !== undefined) {
    if (!sameBrowserTarget(request.browserTarget, locked.binding.browserTarget)) {
      throw new Error('The Browser Target for this Harness session does not match its submitted capture.')
    }
    const tab = await chrome.tabs.get(locked.binding.browserTarget.tabId).catch(() => undefined)
    const live = tab === undefined ? undefined : targetFromActionTab(tab)
    if (live === undefined || !sameBrowserTarget(live, locked.binding.browserTarget)) {
      throw new Error('The Browser Target captured for this Harness Run changed before the Office request.')
    }
    await ensureRunBrowserTargetTransferred(request.runId, locked.binding)
    return locked.binding
  }
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

async function submittedBrowserTarget(browserTarget: BrowserTarget): Promise<BrowserTargetBinding> {
  const tab = await chrome.tabs.get(browserTarget.tabId).catch(() => undefined)
  const verified = tab === undefined ? undefined : targetFromActionTab(tab)
  const settings = await readBrowserTargetSettings()
  if (settings.mode === 'pinned-tabs') {
    if (verified === undefined || !samePinnedTab(verified, browserTarget)) {
      throw new Error('The Browser Target selected when this prompt was submitted changed before it could be locked.')
    }
    const binding = await pinnedBrowserTargets(settings)
    if (!samePinnedTab(binding.browserTarget, browserTarget)) {
      throw new Error('The primary pinned Browser Target changed before this prompt could be locked.')
    }
    return binding
  }
  if (verified === undefined || !sameBrowserTarget(verified, browserTarget)) {
    throw new Error('The Browser Target selected when this prompt was submitted changed before it could be locked.')
  }
  return bindingForTarget(verified)
}

/**
 * Record the user-selected target for this Harness session without moving the
 * Connector's active target.  A later browser request carries the session
 * identity back here, where it is revalidated and transferred under the
 * short-lived request queue.
 */
async function captureRunBrowserTarget(runId: string, sessionId: string, submissionId: string, binding: BrowserTargetBinding): Promise<void> {
  if (nativePort === undefined) throw new Error('Harness is not connected; the Browser Target cannot be captured.')
  const requestId = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRunBrowserTargetCaptures.delete(requestId)
      reject(new Error('Timed out waiting for Native to confirm the Browser Target capture.'))
    }, TRANSFER_TIMEOUT_MS)
    pendingRunBrowserTargetCaptures.set(requestId, { resolve, reject, timeout })
    try {
      nativePort?.postMessage({
        type: 'capture-browser-target', requestId, runId, sessionId, submissionId,
        browserTarget: binding.browserTarget, ...nativeBindingFields(binding),
      })
    } catch (error) {
      clearTimeout(timeout)
      pendingRunBrowserTargetCaptures.delete(requestId)
      reject(new Error(asError(error)))
    }
  })
}

function releaseRunBrowserTargetCapture(sessionId: string, submissionId: string): void {
  try { nativePort?.postMessage({ type: 'release-browser-target-capture', sessionId, submissionId }) } catch { /* a disconnected Host has already lost this ephemeral capture */ }
}

async function ensureRunBrowserTargetTransferred(runId: string, binding: BrowserTargetBinding): Promise<void> {
  const current = boundBrowserTargets.get(runId)
  if (current !== undefined && sameBrowserTarget(current.browserTarget, binding.browserTarget)) return
  const pending = pendingRunBrowserTargetTransfers.get(runId)
  if (pending !== undefined) {
    if (!sameBrowserTarget(pending.browserTarget, binding.browserTarget)) throw new Error('另一个对话正在运行，结束后再试。')
    await pending.promise
    return
  }
  const promise = transferBrowserTarget(runId, binding)
  pendingRunBrowserTargetTransfers.set(runId, { browserTarget: binding.browserTarget, promise })
  try {
    await promise
  } finally {
    if (pendingRunBrowserTargetTransfers.get(runId)?.promise === promise) pendingRunBrowserTargetTransfers.delete(runId)
  }
}

async function lockFollowBrowserTarget(sessionId: string, submissionId: string, browserTarget: BrowserTarget): Promise<boolean> {
  const runId = currentNativeRunId
  const port = nativePort
  if (runId === undefined || port === undefined) throw new Error('Harness is not connected; the Browser Target cannot be locked.')
  if (cancelledBrowserTargetSubmissions.delete(submissionId)) return false
  const locks = locksForRun(runId)
  const existing = locks.get(submissionId)
  if (existing !== undefined) {
    if (existing.sessionId !== sessionId || !sameBrowserTarget(existing.binding.browserTarget, browserTarget)) {
      throw new Error('另一个对话正在运行，结束后再试。')
    }
    return existing.promise
  }
  if (locks.size >= MAX_ACTIVE_BROWSER_TARGET_LOCKS) throw new Error('同时运行的对话过多，请等待一个对话结束后再试。')
  let resolve!: (locked: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  const lock: BrowserTargetRunLock = { sessionId, submissionId, binding: bindingForTarget(browserTarget), port, state: 'pending', observedActivity: false, canceled: false, resolve, reject, promise }
  locks.set(submissionId, lock)
  void (async () => {
    try {
      await browserTargetRuntime.settled()
      if (lock.canceled || cancelledBrowserTargetSubmissions.delete(submissionId)) {
        removeRunBrowserTargetLock(runId, submissionId, lock)
        releaseRunBrowserTargetCapture(sessionId, submissionId)
        resolve(false)
        return
      }
      lock.binding = await submittedBrowserTarget(browserTarget)
      if (nativePort !== port || currentNativeRunId !== runId) throw new Error('Harness Run changed before the Browser Target lock was confirmed.')
      await captureRunBrowserTarget(runId, sessionId, submissionId, lock.binding)
      if (lock.canceled || nativePort !== port || currentNativeRunId !== runId) {
        removeRunBrowserTargetLock(runId, submissionId, lock)
        releaseRunBrowserTargetCapture(sessionId, submissionId)
        resolve(false)
        return
      }
      lock.state = 'active'; resolve(true)
    } catch (error) { removeRunBrowserTargetLock(runId, submissionId, lock); reject(new Error(asError(error))) }
  })()
  return promise
}

function unlockFollowBrowserTarget(sessionId: string, submissionId: string): void {
  for (const [runId, locks] of runBrowserTargetLocks) {
    const lock = locks.get(submissionId)
    if (lock?.sessionId !== sessionId) continue
    lock.canceled = true
    if (lock.state === 'active') {
      removeRunBrowserTargetLock(runId, submissionId, lock)
      releaseRunBrowserTargetCapture(sessionId, submissionId)
    }
    return
  }
  cancelledBrowserTargetSubmissions.add(submissionId)
}

function observeFollowBrowserTarget(sessionId: string, submissionId: string): void {
  for (const locks of runBrowserTargetLocks.values()) {
    const lock = locks.get(submissionId)
    if (lock?.sessionId !== sessionId || lock.state !== 'active') continue
    lock.observedActivity = true
    return
  }
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

function textFromPresentation(result: Record<string, unknown>): string {
  const objects = Array.isArray(result.objects) ? result.objects : []
  const text = objects.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const value = (item as { text?: unknown }).text
    return typeof value === 'string' && value.trim().length > 0 ? [value] : []
  }).join('\n')
  return text.length > 0 ? text : JSON.stringify(result)
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

const WORK_TAB_WAKE_BUDGET_MS = 8_000

async function withAwakeWorkTab<T>(tab: chrome.tabs.Tab, operation: () => Promise<T>): Promise<T> {
  if (tab.id === undefined || (!tab.frozen && !tab.discarded)) return operation()
  const [previousActiveTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
  const previousActiveTabId = previousActiveTab?.id
  await chrome.tabs.update(tab.id, { active: true })
  try {
    const deadline = Date.now() + WORK_TAB_WAKE_BUDGET_MS
    for (;;) {
      const current = await chrome.tabs.get(tab.id)
      if (!current.frozen && !current.discarded && current.status !== 'loading') break
      if (Date.now() >= deadline) {
        throw { code: 'timeout', message: 'The sleeping work tab did not become ready within 8s.' } satisfies OfficeReadFailure
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return await operation()
  } finally {
    if (previousActiveTabId !== undefined && previousActiveTabId !== tab.id) {
      await chrome.tabs.update(previousActiveTabId, { active: true }).catch(() => undefined)
    }
  }
}

async function readWorkTabContent(request: ReadWorkTabRequest): Promise<Record<string, unknown>> {
  const binding = await resolveOfficeBrowserTarget({
    type: CONNECTOR_REQUEST,
    requestId: request.requestId,
    runId: request.runId,
    generation: request.generation,
    ...(request.harnessSessionId === undefined ? {} : { harnessSessionId: request.harnessSessionId }),
    browserTarget: request.browserTarget,
    browserTargets: request.browserTargets,
    unavailableBrowserTargets: request.unavailableBrowserTargets,
    tool: 'list_work_tabs',
  })
  const live = await liveRosterPage(pageFromRoster(binding, request.tab))
  const tab = await chrome.tabs.get(live.tabId)
  return withAwakeWorkTab(tab, async () => {
    const awakeLive = await liveRosterPage(live)
    const awakeTab = await chrome.tabs.get(awakeLive.tabId)
    const pageIdentity = { title: awakeTab.title ?? '', url: awakeLive.url }
    const isPrimary = samePinnedTab(awakeLive, binding.browserTarget)
    const identity = await probeDocumentIdentity(awakeLive.tabId)
    const offset = request.offset ?? 0
    const limit = request.limit ?? 80
    const knownWebEditKind = identity?.kind === 'webedit_light_document' || identity?.kind === 'webedit_spreadsheet' || identity?.kind === 'webedit_presentation'
      ? identity.kind
      : undefined
    // list_work_tabs deliberately uses a short, diagnostic-only identity probe
    // so it never holds the roster open for editor hydration. A docOnline page
    // can expose its WebEdit iframe before that 250ms probe is answered, though;
    // for an explicit read, route that narrowly identified cold-start case into
    // sendToWebEditFrame, which already waits, retries, and heals a missing
    // content-script receiver. Do not apply this wait to ordinary web pages.
    const docOnlineColdStart = knownWebEditKind === undefined && /\/teamKnowledge\/detail\/docOnline\//i.test(awakeLive.url)
    const frames = knownWebEditKind !== undefined || docOnlineColdStart
      ? webeditFramesOf(await chrome.webNavigation.getAllFrames({ tabId: awakeLive.tabId }) ?? [])
      : []
    const webEditKind = knownWebEditKind ?? (docOnlineColdStart && frames.length > 0 ? 'webedit_light_document' : undefined)
    if (webEditKind !== undefined) {
      if (frames.length === 0) throw { code: 'unsupported', message: 'That work tab has no supported WebEdit iframe.' } satisfies OfficeReadFailure
      const message = webEditKind === 'webedit_light_document'
        ? { type: 'office-document/v1', action: 'read', offset, limit }
        : webEditKind === 'webedit_spreadsheet'
          ? { type: 'office-spreadsheet/v1', action: 'used_range' }
          : { type: 'office-presentation/v1', action: 'get_context' }
      const { reply, frame } = await sendToWebEditFrame(awakeLive.tabId, frames, message)
      if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while reading that work tab.' }
      const latest = await chrome.webNavigation.getAllFrames({ tabId: awakeLive.tabId }) ?? []
      if (!latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) {
        throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while reading that work tab.' } satisfies OfficeReadFailure
      }
      const raw = reply.result as Record<string, unknown>
      const extracted = webEditKind === 'webedit_light_document' ? textFromLightDocument(raw)
        : webEditKind === 'webedit_spreadsheet' ? textFromSpreadsheet(raw) : textFromPresentation(raw)
      const clipped = clipWorkTabContent(extracted)
      return { status: 'ok', tab: request.tab, page: awakeLive, pageIdentity, kind: webEditKind, ...clipped, isPrimary }
    }
    const clipped = await readVisiblePageText(awakeLive.tabId)
    return { status: 'ok', tab: request.tab, page: awakeLive, pageIdentity, kind: 'web_page', ...clipped, isPrimary }
  })
}

function respondToReadWorkTab(port: chrome.runtime.Port, request: ReadWorkTabRequest): void {
  // Roster and page reads must not share the Native start/stop queue. A hung
  // iframe or executeScript on one checked tab would otherwise stall every
  // later list_work_tabs until Native times out the whole peer.
  const prepared = queueBrowserTargetRequest(async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const binding = await resolveOfficeBrowserTarget({
      type: CONNECTOR_REQUEST,
      requestId: request.requestId,
      runId: request.runId,
      generation: request.generation,
      ...(request.harnessSessionId === undefined ? {} : { harnessSessionId: request.harnessSessionId }),
      browserTarget: request.browserTarget,
      browserTargets: request.browserTargets,
      unavailableBrowserTargets: request.unavailableBrowserTargets,
      tool: 'list_work_tabs',
    })
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return binding
  })
  void prepared.then(async (binding) => {
    const result = await readWorkTabContent({ ...request, ...binding })
    return { ...binding, result }
  }).then(({ browserTarget, browserTargets, unavailableBrowserTargets, result }) => {
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
      browserTargets: request.browserTargets,
      unavailableBrowserTargets: request.unavailableBrowserTargets,
      error: officeReadFailure(error),
    })
  })
}

function respondToConnector(port: chrome.runtime.Port, request: ConnectorRequest): void {
  const prepared = queueBrowserTargetRequest(async () => {
    if (nativePort !== port) throw new Error('Connector request belongs to a stale Native connection.')
    const binding = await resolveOfficeBrowserTarget(request)
    if (nativePort !== port) throw new Error('Connector request became stale before Office context could be read.')
    return binding
  })
  void prepared
    .then(async (binding) => ({ ...binding, result: await readOfficeContext({ ...request, ...binding }) }))
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
  const allowed = ['unsupported', 'preview', 'readonly', 'invalid_range', 'invalid_request', 'write_rejected', 'write_incomplete', 'navigation', 'iframe_replaced', 'timeout', 'cancelled', 'precondition_required', 'fingerprint_mismatch', 'selection_changed', 'context_mismatch', 'readback_mismatch', 'runtime_error']
  return {
    code: allowed.includes(code ?? '') ? code as OfficeReadFailure['code'] : 'runtime_error',
    message: typeof source?.message === 'string' ? source.message : asError(error),
    ...(isOfficeReadFailureDetails(source?.details) ? { details: source.details } : {}),
  }
}

type RoutedOfficeRequest = OfficeDocumentRequest | OfficeSpreadsheetRequest | OfficePresentationRequest

interface ResolvedOfficeRequest {
  binding: BrowserTargetBinding
  // Resolve/migrate before forwarding, then freeze the request snapshot that
  // reaches the editor.  A stale inbound target must never be mixed with the
  // newly resolved binding during an Office read or write.
  request: RoutedOfficeRequest
}

function officeChannelFor(request: RoutedOfficeRequest): 'office-document/v1' | 'office-spreadsheet/v1' | 'office-presentation/v1' {
  if (request.tool === 'spreadsheet') return 'office-spreadsheet/v1'
  if (request.tool === 'presentation') return 'office-presentation/v1'
  return 'office-document/v1'
}

function presentationSelectionFor(request: RoutedOfficeRequest): PresentationFrameSelection | undefined {
  if (request.tool !== 'presentation') return undefined
  if (request.action === 'write') {
    return { expectedResource: request.resource, precondition: request.precondition, binding: presentationFrameBindings.get(request.runId) }
  }
  return { binding: presentationFrameBindings.get(request.runId) }
}

function spreadsheetSelectionFor(request: RoutedOfficeRequest): SpreadsheetFrameSelection | undefined {
  if (request.tool !== 'spreadsheet') return undefined
  if (request.action === 'write') {
    return { expectedResource: request.resource, precondition: request.precondition, binding: spreadsheetFrameBindings.get(request.runId) }
  }
  return { binding: spreadsheetFrameBindings.get(request.runId) }
}

async function readOfficeRequest(request: RoutedOfficeRequest): Promise<Record<string, unknown>> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
    throw { code: 'navigation', message: 'The trusted Browser Target changed before the Office resource could be read.' } satisfies OfficeReadFailure
  }
  const tab = await chrome.tabs.get(request.browserTarget.tabId)
  if (tab.windowId !== request.browserTarget.windowId || tab.url !== request.browserTarget.url) {
    throw { code: 'navigation', message: 'The trusted Browser Target navigated before the Office resource could be read.' } satisfies OfficeReadFailure
  }
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? [])
    .filter((candidate) => { try { return new URL(candidate.url).origin === 'https://webedit.midea.com' } catch { return false } })
  if (frames.length === 0) throw { code: 'unsupported', message: 'The bound Browser Target has no supported WebEdit iframe.' } satisfies OfficeReadFailure
  try {
    const fields = request as unknown as Record<string, unknown>
    if (request.tool === 'presentation' && request.action === 'write' && request.resource === undefined) {
      throw { code: 'precondition_required', message: 'Presentation write routing requires the approved Resource Identity.' } satisfies OfficeReadFailure
    }
    if (request.tool === 'spreadsheet' && request.action === 'write' && request.resource === undefined) {
      throw { code: 'precondition_required', message: 'Spreadsheet write routing requires the approved Resource Identity.' } satisfies OfficeReadFailure
    }
    const forwarded: Record<string, unknown> = { type: officeChannelFor(request), action: request.action }
    for (const key of ['offset', 'limit', 'query', 'range', 'sheetName', 'index', 'fieldName', 'axis', 'cellType', 'matchCase', 'matchEntireCell', 'searchBy', 'slideIndex', 'operation', 'payload', 'resource', 'precondition']) {
      if (fields[key] !== undefined) forwarded[key] = fields[key]
    }
    const { reply, frame } = await sendToWebEditFrame(request.browserTarget.tabId, frames, forwarded, presentationSelectionFor(request), spreadsheetSelectionFor(request))
    if (reply?.ok !== true) throw reply?.error ?? { code: 'iframe_replaced', message: 'The WebEdit iframe was replaced while handling the Office resource.' }
    const latest = await chrome.webNavigation.getAllFrames({ tabId: request.browserTarget.tabId }) ?? []
    if (!latest.some((candidate) => candidate.frameId === frame.frameId && candidate.url === frame.url)) {
      throw { code: 'iframe_replaced', message: 'The WebEdit iframe changed while handling the Office resource.' } satisfies OfficeReadFailure
    }
    if (request.tool === 'presentation') {
      const resource = presentationResourceFromProbe((reply.result as { resource?: unknown } | undefined)?.resource)
      if (resource !== undefined) presentationFrameBindings.set(request.runId, { frameId: frame.frameId, frameUrl: frame.url, resource })
    }
    if (request.tool === 'spreadsheet') {
      const resource = spreadsheetResourceFromResult(reply.result)
      if (resource !== undefined) spreadsheetFrameBindings.set(request.runId, { frameId: frame.frameId, frameUrl: frame.url, resource })
    }
    return reply.result as Record<string, unknown>
  } catch (error) { throw officeReadFailure(error) }
}

async function resolveRoutedOfficeRequest(request: RoutedOfficeRequest): Promise<ResolvedOfficeRequest> {
  const binding = await resolveOfficeBrowserTarget(request)
  return {
    binding,
    request: Object.freeze({ ...request, browserTarget: binding.browserTarget }) as RoutedOfficeRequest,
  }
}

function respondToOfficeRequest(port: chrome.runtime.Port, request: RoutedOfficeRequest): void {
  // ADR-0006: reads may run concurrently, but writes against one Resource
  // Identity pass through a Write Fence. Office work must not enter the
  // Native start/restart lifecycle queue: a timed-out iframe request can keep
  // running after its caller aborts and would otherwise delay every later
  // preview until the Native Connector times out. Stale-port checks below
  // still fail closed across reconnects. Writes are serialized per resource
  // fingerprint, so two documents edit in parallel while the same document's
  // read-patch-readback cycles can never interleave.
  const prepared = queueBrowserTargetRequest(async () => {
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    const resolved = await resolveRoutedOfficeRequest(request)
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return resolved
  })
  let resolvedBinding: BrowserTargetBinding | undefined
  const execute = async () => {
    const resolved = await prepared
    resolvedBinding = resolved.binding
    const result = resolved.request.action === 'write' && resolved.request.resource
      ? await queueResourceWrite(resolved.request.resource, () => readOfficeRequest(resolved.request))
      : await readOfficeRequest(resolved.request)
    if (nativePort !== port) throw { code: 'cancelled', message: 'The Native connection became stale.' } satisfies OfficeReadFailure
    return { ...resolved.binding, result }
  }
  const respond = (settled: Promise<Record<string, unknown>>) => settled
    .then(({ browserTarget, browserTargets, unavailableBrowserTargets, result }) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget, browserTargets, unavailableBrowserTargets, result }))
    .catch((error: unknown) => {
      const binding = resolvedBinding
      port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: binding?.browserTarget ?? request.browserTarget, ...(binding === undefined ? {} : { browserTargets: binding.browserTargets, unavailableBrowserTargets: binding.unavailableBrowserTargets }), error: officeReadFailure(error) })
    })
  void respond(execute())
}

async function htmlWorkbenchPageState(tabId: number, refresh: boolean, expectedStylesheets: HtmlWorkbenchStylesheetFingerprint[] = [], expectedAnchorSelectors: string[] = []): Promise<{ domFingerprint: string; sourceFingerprint: string; url: string; stylesheetFingerprints: HtmlWorkbenchStylesheetFingerprint[]; anchorStates: { selector: string; computedStyle: Record<string, string> }[] }> {
  if (refresh) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { chrome.webNavigation.onCompleted.removeListener(completed); reject(new Error('html_workbench_reload_timeout')) }, 10_000)
      const completed = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => { if (details.tabId !== tabId || details.frameId !== 0) return; clearTimeout(timeout); chrome.webNavigation.onCompleted.removeListener(completed); resolve() }
      chrome.webNavigation.onCompleted.addListener(completed)
      void chrome.tabs.reload(tabId, { bypassCache: true }).catch(error => { clearTimeout(timeout); chrome.webNavigation.onCompleted.removeListener(completed); reject(error) })
    })
  }
  const execution = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', args: [expectedStylesheets, expectedAnchorSelectors], func: async (expectedStylesheets: HtmlWorkbenchStylesheetFingerprint[] = [], expectedAnchorSelectors: string[] = []) => {
    const domFingerprint = (text: string) => { let value = 2166136261; for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619); return (value >>> 0).toString(16).padStart(64, '0') }
    const sourceFingerprint = async (text: string) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    }
    const text = document.documentElement?.outerHTML ?? ''
    const source = await fetch(location.href, { cache: 'no-store' }).then(reply => {
      if (reply.ok || (location.protocol === 'file:' && reply.status === 0 && reply.url === location.href)) return reply.text()
      return Promise.reject(new Error(`file_source_readback_${reply.status}`))
    })
    const stylesheetFingerprints = await Promise.all(expectedStylesheets.map(async expected => {
      const matching = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')].find(link => {
        const url = new URL(link.href); url.search = ''; url.hash = ''
        return url.href === expected.url
      })
      if (!matching) throw new Error(`html_workbench_stylesheet_missing:${expected.url}`)
      const stylesheet = await fetch(matching.href, { cache: 'no-store' }).then(reply => {
        if (reply.ok || (new URL(matching.href).protocol === 'file:' && reply.status === 0 && reply.url === matching.href)) return reply.text()
        return Promise.reject(new Error(`html_workbench_stylesheet_readback_${reply.status}:${expected.url}`))
      })
      return { url: expected.url, fingerprint: await sourceFingerprint(stylesheet) }
    }))
    const anchorStates = expectedAnchorSelectors.map(selector => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`html_workbench_anchor_missing:${selector}`)
      const style = getComputedStyle(element)
      return { selector, computedStyle: { display: style.display, visibility: style.visibility, color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, width: style.width, height: style.height } }
    })
    return { domFingerprint: domFingerprint(text), sourceFingerprint: await sourceFingerprint(source), url: location.href, stylesheetFingerprints, anchorStates }
  } })
  const result = execution[0]?.result
  if (!result || typeof result.domFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(result.sourceFingerprint) || typeof result.url !== 'string' || !validHtmlWorkbenchStylesheetFingerprints(result.stylesheetFingerprints) || !Array.isArray(result.anchorStates)) throw new Error('file_access_permission_missing_or_page_unreadable')
  return result
}

function respondToHtmlWorkbenchRequest(port: chrome.runtime.Port, request: HtmlWorkbenchRequest): void {
  const prepared = queueBrowserTargetRequest(async () => {
    const binding = boundBrowserTargets.get(request.runId)
    if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) throw new Error('Browser Target changed before HTML Workbench operation.')
    const tab = await chrome.tabs.get(request.browserTarget.tabId)
    if (tab.url !== request.browserTarget.url || !tab.url?.startsWith('file:')) throw new Error('HTML Workbench requires the unchanged local file:// Browser Target.')
    return htmlWorkbenchPickers.get(request.browserTarget.tabId)
  })
  void prepared.then(async (picker) => {
    if (request.action === 'refresh_readback') {
      const expectedStylesheets = request.expectedStylesheets
      const expectedAnchorSelectors = request.expectedAnchorSelectors
      if (!expectedStylesheets || !expectedAnchorSelectors) throw new Error('html_workbench_readback_expectations_missing')
      const page = await htmlWorkbenchPageState(request.browserTarget.tabId, true, expectedStylesheets, expectedAnchorSelectors)
      const stylesheetsMatch = page.stylesheetFingerprints.length === expectedStylesheets.length && page.stylesheetFingerprints.every((item, index) => item.url === expectedStylesheets[index].url && item.fingerprint === expectedStylesheets[index].fingerprint)
      const anchorsMatch = page.anchorStates.length === expectedAnchorSelectors.length && page.anchorStates.every((item, index) => item.selector === expectedAnchorSelectors[index])
      const verified = page.sourceFingerprint === request.expectedSourceFingerprint && stylesheetsMatch && anchorsMatch && page.url === request.browserTarget.url
      return { ...page, verified, ...(verified ? {} : { error: 'html_workbench_readback_mismatch' }), selections: picker?.anchors ?? [] }
    }
    const selections = picker?.url === request.browserTarget.url ? picker.anchors : []
    const expectedAnchorSelectors = selections.map(anchor => (anchor as { selector?: unknown }).selector).filter((selector): selector is string => typeof selector === 'string' && selector.length > 0 && selector.length <= 2_000)
    const page = await htmlWorkbenchPageState(request.browserTarget.tabId, false, [], expectedAnchorSelectors)
    return { domFingerprint: page.domFingerprint, anchorStates: page.anchorStates, selections }
  }).then(result => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
    .catch(error => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, error: asError(error) }))
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

async function assertTeamDocTarget(request: { runId: string; browserTarget: BrowserTarget }): Promise<void> {
  const binding = boundBrowserTargets.get(request.runId)
  if (binding === undefined || !sameBrowserTarget(binding.browserTarget, request.browserTarget)) {
    throw new Error('The trusted Browser Target changed before Team Doc execution.')
  }
  const tab = await chrome.tabs.get(request.browserTarget.tabId).catch(() => undefined)
  if (tab === undefined) throw new Error('The trusted Browser Target closed before Team Doc execution.')
  const actual = targetFromActionTab(tab)
  if (actual === undefined || !sameBrowserTarget(actual, request.browserTarget)) {
    throw new Error('The trusted Browser Target navigated before Team Doc execution.')
  }
}

function teamKnowledgeBatchLeaseKey(runId: string, batchId: string): string { return `${runId}\u0000${batchId}` }

function isTeamKnowledgeBatchLease(value: unknown): value is TeamKnowledgeBatchLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const lease = value as Partial<TeamKnowledgeBatchLease>
  return typeof lease.runId === 'string' && lease.runId.length > 0 && typeof lease.batchId === 'string' && lease.batchId.length > 0
    && validBrowserTarget(lease.browserTarget) && typeof lease.parentFingerprint === 'string' && lease.parentFingerprint.length > 0
}

async function teamKnowledgeBatchLeases(): Promise<Record<string, TeamKnowledgeBatchLease>> {
  const stored = (await chrome.storage.session.get(TEAM_KNOWLEDGE_BATCH_LEASES_KEY))[TEAM_KNOWLEDGE_BATCH_LEASES_KEY]
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  return Object.fromEntries(Object.entries(stored).flatMap(([key, lease]) => isTeamKnowledgeBatchLease(lease) ? [[key, lease]] : []))
}

async function teamKnowledgeBatchLease(runId: string, batchId: string): Promise<TeamKnowledgeBatchLease | undefined> {
  return (await teamKnowledgeBatchLeases())[teamKnowledgeBatchLeaseKey(runId, batchId)]
}

async function saveTeamKnowledgeBatchLease(lease: TeamKnowledgeBatchLease): Promise<void> {
  const leases = await teamKnowledgeBatchLeases()
  leases[teamKnowledgeBatchLeaseKey(lease.runId, lease.batchId)] = lease
  await chrome.storage.session.set({ [TEAM_KNOWLEDGE_BATCH_LEASES_KEY]: leases })
}

async function releaseTeamKnowledgeBatchLease(runId: string, batchId: string, parentFingerprint: string): Promise<void> {
  const leases = await teamKnowledgeBatchLeases()
  const key = teamKnowledgeBatchLeaseKey(runId, batchId)
  const lease = leases[key]
  if (lease === undefined) return
  if (lease.parentFingerprint !== parentFingerprint) throw new Error('team_knowledge_batch_lease_release_parent_changed')
  delete leases[key]
  await chrome.storage.session.set({ [TEAM_KNOWLEDGE_BATCH_LEASES_KEY]: leases })
}

async function resolveTeamKnowledgeBatchLease(request: TeamKnowledgeItemRequest): Promise<BrowserTargetBinding> {
  if (request.batchId === undefined || request.lease !== 'reuse') throw new Error('team_knowledge_batch_lease_missing')
  const lease = await teamKnowledgeBatchLease(request.runId, request.batchId)
  if (lease === undefined) throw new Error('team_knowledge_batch_lease_missing')
  const tab = await chrome.tabs.get(lease.browserTarget.tabId).catch(() => undefined)
  if (tab === undefined) throw new Error('team_knowledge_batch_lease_target_closed')
  const live = targetFromActionTab(tab)
  if (live === undefined || !sameBrowserTarget(live, lease.browserTarget)) throw new Error('team_knowledge_batch_lease_target_navigated')
  const binding = bindingForTarget(live)
  const current = boundBrowserTargets.get(request.runId)
  if (current === undefined) throw new Error('team_knowledge_batch_lease_run_unbound')
  if (!sameBrowserTarget(current.browserTarget, binding.browserTarget)) await transferBrowserTarget(request.runId, binding, request.requestId)
  return binding
}

function teamKnowledgeResultParent(result: object): TeamKnowledgeParent | undefined {
  const parent = (result as { parent?: unknown }).parent
  return isTeamKnowledgeParent(parent) ? parent : undefined
}

function teamKnowledgeResultItemUrl(result: object): string | undefined {
  const item = (result as { item?: { url?: unknown } }).item
  return typeof item?.url === 'string' && item.url.length > 0 ? item.url : undefined
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

type TeamDocWebEditReadback = { ok?: unknown; readbackMatches?: unknown; observedBody?: unknown; failedAt?: unknown; error?: unknown }

function teamDocWebEditReadbackMatches(result: TeamDocWebEditReadback | undefined): result is TeamDocWebEditReadback & { ok: true; readbackMatches: true; observedBody: string } {
  return result?.ok === true && result.readbackMatches === true && typeof result.observedBody === 'string'
}

function teamDocWebEditReadbackPollWindowMs(): number {
  // Test-only bounded override; production has no such global and keeps 10s.
  const configured = Number((globalThis as typeof globalThis & { __DSH_TEAM_DOC_READBACK_POLL_WINDOW_MS?: unknown }).__DSH_TEAM_DOC_READBACK_POLL_WINDOW_MS)
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 10_000) : 10_000
}

async function pollTeamDocWebEditReadback(tabId: number, frameId: number, body: string, first: TeamDocWebEditReadback | undefined): Promise<TeamDocWebEditReadback | undefined> {
  let result = first
  const deadline = Date.now() + teamDocWebEditReadbackPollWindowMs()
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
    const initialPersistedReadback = (await chrome.scripting.executeScript({ target: { tabId: request.browserTarget.tabId, frameIds: [reopenedFrame.frameId] }, world: 'MAIN', func: writeTeamDocInWebEdit, args: [request.body!, true] }))[0]?.result as TeamDocWebEditReadback | undefined
    // Reopening reaches the same resource, but WebEdit can expose its frame
    // before its persisted XML has hydrated. Reuse the bounded read-only poll;
    // an empty or mismatched body remains a failed Verified Write after 10s.
    const persistedReadback = await pollTeamDocWebEditReadback(request.browserTarget.tabId, reopenedFrame.frameId, request.body!, initialPersistedReadback)
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

async function resolveTeamKnowledgeRequestBinding(request: TeamKnowledgeItemRequest): Promise<BrowserTargetBinding> {
  if (request.lease === 'reuse') return resolveTeamKnowledgeBatchLease(request)
  if (request.action === 'create') {
    await assertTeamDocTarget(request)
    return bindingForTarget(request.browserTarget)
  }
  return resolveOfficeBrowserTarget({
    type: request.type, requestId: request.requestId, runId: request.runId,
    generation: request.generation, browserTarget: request.browserTarget,
    ...(request.harnessSessionId === undefined ? {} : { harnessSessionId: request.harnessSessionId }),
    tool: 'list_work_tabs',
  })
}

function respondToTeamKnowledgeItem(port: chrome.runtime.Port, request: TeamKnowledgeItemRequest): void {
  const prepared = queueBrowserTargetRequest(() => resolveTeamKnowledgeRequestBinding(request))
  void prepared.then((binding) => queueNativeLifecycle(async () => {
    if (nativePort !== port) throw new Error('Team Knowledge item request belongs to a stale Native connection.')
    if (request.action === 'inspect_parent' && request.pmdReviewAdoption !== undefined) await verifyPmdReviewAdoption(request.pmdReviewAdoption)
    if (request.action === 'release') {
      if (request.batchId === undefined || request.lease !== 'release' || request.parent === undefined) throw new Error('team_knowledge_batch_lease_release_invalid')
      await releaseTeamKnowledgeBatchLease(request.runId, request.batchId, request.parent.fingerprint)
      return { browserTarget: binding.browserTarget, result: { status: 'ok', parent: request.parent } }
    }
    // Team Knowledge batch/item calls may be the first tool after the user
    // selects another document in the same tab. Resolve and migrate the live
    // Browser Target here instead of requiring an list_work_tabs preflight.
    // A batch lease always wins over the ambient active tab. It is session
    // storage rather than a saved Browser Target preference, so user settings
    // and browser focus are unchanged while the batch is in progress.
    const resolvedRequest = { ...request, browserTarget: binding.browserTarget }
    const result = await runTeamKnowledgeItemRequest(resolvedRequest)
    if (request.batchId !== undefined && request.lease === 'acquire' && request.action === 'inspect_parent') {
      const parent = teamKnowledgeResultParent(result)
      if (parent === undefined) throw new Error('team_knowledge_batch_lease_acquire_failed')
      const existing = await teamKnowledgeBatchLease(request.runId, request.batchId)
      if (existing !== undefined && (!sameBrowserTarget(existing.browserTarget, binding.browserTarget) || existing.parentFingerprint !== parent.fingerprint)) {
        throw new Error('team_knowledge_batch_lease_already_bound')
      }
      if (existing === undefined) await saveTeamKnowledgeBatchLease({ runId: request.runId, batchId: request.batchId, browserTarget: binding.browserTarget, parentFingerprint: parent.fingerprint })
    }
    if (request.batchId !== undefined && request.lease === 'reuse' && request.action === 'inspect_parent') {
      const lease = await teamKnowledgeBatchLease(request.runId, request.batchId)
      const parent = teamKnowledgeResultParent(result)
      if (lease === undefined || parent === undefined || parent.fingerprint !== lease.parentFingerprint) throw new Error('team_knowledge_batch_lease_parent_changed')
    }
    if (request.batchId !== undefined && request.lease === 'reuse' && request.action === 'create'
      && (result as { status?: unknown }).status === 'partial_delivery') {
      const lease = await teamKnowledgeBatchLease(request.runId, request.batchId)
      const itemUrl = teamKnowledgeResultItemUrl(result)
      if (lease !== undefined && itemUrl !== undefined) await saveTeamKnowledgeBatchLease({ ...lease, browserTarget: { ...lease.browserTarget, url: itemUrl } })
    }
    if (nativePort !== port) throw new Error('Team Knowledge item request became stale before completion.')
    return { browserTarget: binding.browserTarget, result }
  })).then(({ browserTarget, result }) => port.postMessage({ type: CONNECTOR_RESPONSE, requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget, result }))
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
  presentationFrameBindings.delete(payload.runId)
  spreadsheetFrameBindings.delete(payload.runId)
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
  currentNativeRunId = undefined
  knowledgeTransport.clearProxy()
  nativePort = undefined
  boundBrowserTargets.clear()
  rejectBrowserTargetRunLocks(new Error(error))
  presentationFrameBindings.clear()
  spreadsheetFrameBindings.clear()
  rejectTargetTransfers(new Error(error))
  rejectPrototypeRecoverySignatures(new Error(error))
  for (const pending of pendingReleaseUpdates.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error }) }
  pendingReleaseUpdates.clear()
  for (const [requestId, pending] of pendingPmdPrdReviewAdoptions) { clearTimeout(pending.timeout); pending.reject(new Error(error)); pendingPmdPrdReviewAdoptions.delete(requestId) }
  for (const [requestId, pending] of pendingPrdEventReports) { clearTimeout(pending.timeout); pending.reject(new Error(error)); pendingPrdEventReports.delete(requestId) }
  const updateInstalling = Date.now() < releaseUpdateReconnectBlockedUntil
  void chrome.runtime.sendMessage({
    type: updateInstalling ? 'harness-update-installing' : 'harness-disconnected',
    error,
  }).catch(() => {})
}

function connectNativePort(): chrome.runtime.Port {
  if (Date.now() < releaseUpdateReconnectBlockedUntil) {
    throw new Error('Harness UI 正在安装更新，请稍候。')
  }
  if (nativePort !== undefined) return nativePort
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  port.onDisconnect.addListener(() => disconnectNativePort(port))
  port.onMessage.addListener((message: NativeMessage) => {
    if (message.type === 'prd_event_recorded' || message.type === 'prd_event_failed') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const pending = requestId === undefined ? undefined : pendingPrdEventReports.get(requestId)
      if (pending !== undefined && requestId !== undefined) {
        pendingPrdEventReports.delete(requestId)
        clearTimeout(pending.timeout)
        if (message.type === 'prd_event_recorded') pending.resolve()
        else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'PRD 埋点未持久化。'))
      }
      return
    }
    if (message.type === 'pmd_prd_review_adoption_recorded' || message.type === 'pmd_prd_review_adoption_failed') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const pending = requestId === undefined ? undefined : pendingPmdPrdReviewAdoptions.get(requestId)
      if (pending !== undefined && requestId !== undefined) {
        pendingPmdPrdReviewAdoptions.delete(requestId); clearTimeout(pending.timeout)
        if (message.type === 'pmd_prd_review_adoption_recorded') pending.resolve()
        else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'PRD 采纳记录失败。'))
      }
      return
    }
    if (message.type === 'release_update_reload_required') {
      // Do not let the open side panel immediately recreate the old Host while
      // the detached installer is trying to replace its runtime directory.
      releaseUpdateReconnectBlockedUntil = Date.now() + NATIVE_UPDATE_HANDOFF_GRACE_MS
      void rememberReleaseUpdateReload((message as { version?: unknown }).version).catch(error => console.warn('[deepseek-harness] Could not persist release-update reload request:', error))
      return
    }
    if (message.type === 'release_update_checked' || message.type === 'release_update_prepared' || message.type === 'release_update_failed' || message.type === 'release_update_cancelled' || message.type === 'release_update_cancel_unknown' || message.type === 'release_update_cancel_too_late') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const pending = requestId === undefined ? undefined : pendingReleaseUpdates.get(requestId)
      if (message.type === 'release_update_cancel_too_late' && pending !== undefined && requestId !== undefined) {
        clearTimeout(pending.cancelTimer)
        pending.cancelResolve?.({ ok: true, status: 'too_late' })
        pending.cancelResolve = undefined
        pending.cancelling = false
        pending.timer = setTimeout(() => {
          if (pendingReleaseUpdates.get(requestId) !== pending) return
          pendingReleaseUpdates.delete(requestId)
          pending.resolve({ ok: false, error: '在线更新状态未知；请查看更新状态' })
        }, 10_000)
        return
      }
      const result = requestId === undefined ? undefined : releaseUpdateResult(message, requestId)
      if (requestId !== undefined && pending !== undefined && result !== undefined) {
        clearTimeout(pending.timer); clearTimeout(pending.cancelTimer); pendingReleaseUpdates.delete(requestId)
        // A successful prepare means the updater crossed its irreversible go
        // point before cancellation could win.
        pending.cancelResolve?.({ ok: result.ok, ...(result.ok ? { status: 'too_late' } : { error: result.error }) })
        pending.resolve(result)
      }
      return
    }
    if (message.type === 'prototype_recovery_signed' || message.type === 'prototype_recovery_sign_failed') {
      settlePrototypeRecoverySignature(message)
      return
    }
    if (isConnectorRequest(message)) {
      respondToConnector(port, message)
      return
    }
    if (isReadWorkTabRequest(message)) {
      respondToReadWorkTab(port, message)
      return
    }
    if (isOfficeDocumentRequest(message)) {
      respondToOfficeRequest(port, message)
      return
    }
    if (isOfficeSpreadsheetRequest(message)) {
      respondToOfficeRequest(port, message)
      return
    }
    if (isOfficePresentationRequest(message)) {
      respondToOfficeRequest(port, message)
      return
    }
    if (isHtmlWorkbenchRequest(message)) {
      respondToHtmlWorkbenchRequest(port, message)
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
    if (message.type === 'browser_target_captured' || message.type === 'browser_target_capture_failed') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined
      const pending = requestId === undefined ? undefined : pendingRunBrowserTargetCaptures.get(requestId)
      if (pending === undefined || requestId === undefined) return
      clearTimeout(pending.timeout)
      pendingRunBrowserTargetCaptures.delete(requestId)
      if (message.type === 'browser_target_captured') pending.resolve()
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Native rejected the Browser Target capture.'))
      return
    }
    if (message.type !== 'server_started') return
    const payload = message.payload as NativeStartPayload | undefined
    if (typeof payload?.url !== 'string') return
    if (typeof payload.runId !== 'string' || payload.runId.length === 0) return
    knowledgeTransport.configureProxy(payload.knowledgeProxyUrl, payload.knowledgeProxyToken)
    nativeRuntimeIdentity = runtimeIdentitySummary(payload.runtimeIdentity)
    nativeUrl = payload.url
    currentNativeRunId = payload.runId
    void reloadExtensionAfterReleaseUpdate(payload.nativeVersion).catch(error => console.warn('[deepseek-harness] Could not reload after release update:', error))
    void publishHarnessReady(nativeUrl)
  })
  nativePort = port
  return port
}

async function transferBrowserTarget(runId: unknown, binding: BrowserTargetBinding, requestId: string = crypto.randomUUID()): Promise<void> {
  if (typeof runId !== 'string' || runId.length === 0 || !validBrowserTarget(binding.browserTarget)
    || binding.browserTargets.length === 0 || !binding.browserTargets.every(validBrowserTarget)) {
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
          currentNativeRunId = payload.runId
          knowledgeTransport.configureProxy(payload.knowledgeProxyUrl, payload.knowledgeProxyToken)
          if (binding !== undefined) {
            boundBrowserTargets.set(payload.runId, binding)
            presentationFrameBindings.delete(payload.runId)
            spreadsheetFrameBindings.delete(payload.runId)
          }
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
      const productVersion = chrome.runtime.getManifest?.().version
      port.postMessage({
        type: 'start',
        ...(typeof productVersion === 'string' && /^\d+(?:\.\d+){0,3}$/.test(productVersion) && productVersion.length <= 128 ? { productVersion } : {}),
        ...(binding === undefined ? { browserTarget: undefined } : { browserTarget: binding.browserTarget, ...nativeBindingFields(binding) }),
      })
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

function isPrototypeStudioSender(sender: chrome.runtime.MessageSender, projectId?: string, referenceId?: string): boolean {
  if (sender.tab?.id === undefined || typeof sender.url !== 'string') return false
  try {
    const actual = new URL(sender.url); const expected = new URL(chrome.runtime.getURL('prototype-studio.html'))
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && (projectId === undefined || actual.searchParams.get('projectId') === projectId)
      && (referenceId === undefined || actual.searchParams.get('referenceId') === referenceId)
  } catch { return false }
}

function isPrototypeStudioSelection(value: unknown): value is { elementId: string; type: string; label: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>; const keys = Object.keys(item)
  return keys.length === 3 && keys.every(key => ['elementId', 'type', 'label'].includes(key))
    && typeof item.elementId === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(item.elementId)
    && typeof item.type === 'string' && ['text', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal', 'table-row', 'list-item', 'tab', 'navigation-item', 'breadcrumb-item'].includes(item.type)
    && typeof item.label === 'string' && item.label.length <= 2_000
}

let markdownReviewPersistence: Promise<void> = Promise.resolve()

function queueMarkdownReviewPersistence<T>(work: () => Promise<T>): Promise<T> {
  const queued = markdownReviewPersistence.catch(() => undefined).then(work)
  markdownReviewPersistence = queued.then(() => undefined, () => undefined)
  return queued
}

async function persistedMarkdownReviews(): Promise<Record<string, PersistedMarkdownReview>> {
  const storage = chrome.storage?.session
  if (storage === undefined) return {}
  const value = (await storage.get(MARKDOWN_REVIEW_STORAGE_KEY))[MARKDOWN_REVIEW_STORAGE_KEY]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, PersistedMarkdownReview> : {}
}

async function persistMarkdownReview(record: MarkdownReviewRecord): Promise<void> {
  await queueMarkdownReviewPersistence(async () => {
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
      ...(record.sourceTabId === undefined ? {} : { sourceTabId: record.sourceTabId }),
      ...(record.pmdPrd === true ? { pmdPrd: true } : {}),
      ...(record.prdGenerationId === undefined ? {} : { prdGenerationId: record.prdGenerationId }),
      ...(record.rating === undefined ? {} : { rating: record.rating }),
    }
    await storage.set({ [MARKDOWN_REVIEW_STORAGE_KEY]: reviews })
  })
}

async function forgetPersistedMarkdownReview(reviewIdValue: string): Promise<void> {
  await queueMarkdownReviewPersistence(async () => {
    const storage = chrome.storage?.session
    if (storage === undefined) return
    const reviews = await persistedMarkdownReviews()
    if (reviews[reviewIdValue] === undefined) return
    delete reviews[reviewIdValue]
    await storage.set({ [MARKDOWN_REVIEW_STORAGE_KEY]: reviews })
  })
}

async function recoverMarkdownReview(reviewIdValue: string, tabId: number): Promise<MarkdownReviewRecord | undefined> {
  await markdownReviewPersistence
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
  const record = { ...review, tabId, windowId: tab.windowId, ...(Number.isSafeInteger(persisted.sourceTabId) ? { sourceTabId: persisted.sourceTabId } : {}), ...(persisted.pmdPrd === true ? { pmdPrd: true } : {}), ...(reviewId(persisted.prdGenerationId) ? { prdGenerationId: persisted.prdGenerationId } : {}), ...(isPrdRating(persisted.rating) ? { rating: persisted.rating } : {}) } satisfies MarkdownReviewRecord
  markdownReviews.set(record.reviewId, record)
  markdownReviewKeys.set(markdownReviewKey(record.harnessSessionId, record.resourceId), record.reviewId)
  await persistMarkdownReview(record)
  return record
}

/** An expired or invalid capability is safe to retry once: Host authorization fails before every read or Verified Write. */
function expiredWorkspaceReviewCapability(error: unknown): boolean {
  const message = asError(error)
  return /(?:review\s+)?capability\s+(?:is\s+)?(?:expired|invalid)|authorization\s+(?:is\s+)?(?:expired|invalid)/i.test(message)
}

async function rehydrateMarkdownReview(record: MarkdownReviewRecord): Promise<void> {
  const active = markdownReviewRehydrates.get(record.reviewId)
  if (active !== undefined) return active
  const pending = refreshMarkdownReviewCapability(record)
  markdownReviewRehydrates.set(record.reviewId, pending)
  try {
    await pending
  } finally {
    if (markdownReviewRehydrates.get(record.reviewId) === pending) markdownReviewRehydrates.delete(record.reviewId)
  }
}

async function refreshMarkdownReviewCapability(record: MarkdownReviewRecord): Promise<void> {
  const requestId = crypto.randomUUID()
  const response = await chrome.runtime.sendMessage({
    type: 'markdown-review-rehydrate-forward/v1', requestId,
    review: { reviewId: record.reviewId, harnessSessionId: record.harnessSessionId, resourceId: record.resourceId },
  }) as { ok?: boolean; review?: unknown; error?: string } | undefined
  if (response?.ok !== true || !isOpenMarkdownReview(response.review)) throw new Error(response?.error ?? '无法恢复文档授权。请从文件树重新打开。')
  const review = response.review
  if (review.reviewId !== record.reviewId || review.harnessSessionId !== record.harnessSessionId || review.resourceId !== record.resourceId || review.displayPath !== record.displayPath) {
    throw new Error('恢复的文档授权与当前文件不一致。请从文件树重新打开。')
  }
  Object.assign(record, review)
  await persistMarkdownReview(record)
}

async function retryExpiredWorkspaceReviewCapability<T>(record: MarkdownReviewRecord, operation: () => Promise<T>): Promise<T> {
  const attemptedCapability = record.capability
  try {
    return await operation()
  } catch (error) {
    if (!expiredWorkspaceReviewCapability(error)) throw error
    if (record.capability === attemptedCapability) await rehydrateMarkdownReview(record)
    return operation()
  }
}

async function openMarkdownReviewTab(review: OpenMarkdownReview): Promise<MarkdownReviewRecord> {
  const key = markdownReviewKey(review.harnessSessionId, review.resourceId)
  const existingId = markdownReviewKeys.get(key)
  const existing = existingId === undefined ? undefined : markdownReviews.get(existingId)
  if (existing !== undefined) {
    try {
      const tab = await chrome.tabs.get(existing.tabId)
      if (tab.id === existing.tabId && review.reviewId === existing.reviewId && isMarkdownReviewTabUrl(tab.url, existing.reviewId)) {
        const updated = { ...existing, ...review, tabId: existing.tabId, windowId: tab.windowId, ...(existing.prdGenerationId === undefined && review.pmdPrd === true ? { prdGenerationId: `prd:${crypto.randomUUID()}` } : {}) } satisfies MarkdownReviewRecord
        markdownReviews.delete(existing.reviewId)
        markdownReviews.set(review.reviewId, updated)
        markdownReviewKeys.set(key, review.reviewId)
        await chrome.tabs.update?.(existing.tabId, { active: true })
        markdownReviewPorts.get(existing.tabId)?.postMessage({ v: 1, type: 'markdown-review-target-updated', requestId: crypto.randomUUID(), reviewId: review.reviewId })
        await persistMarkdownReview(updated)
        if (updated.pmdPrd === true) reportPrdReviewGenerated(updated)
        return updated
      }
    } catch { /* stale registry entry; create a replacement below */ }
  }

  const window = await chrome.windows.getLastFocused()
  if (window.id === undefined || window.id < 0) throw new Error('Chrome could not identify the window for Markdown review.')
  let sourceTabId: number | undefined
  try {
    const target = await activeBrowserTarget(window.id)
    sourceTabId = target.tabId
    await updateBrowserTargetSettings(settings => ({ ...settings, candidate: target }))
  } catch { /* opening review remains allowed when Browser Target mode is none */ }
  const url = new URL(chrome.runtime.getURL('markdown-review.html'))
  url.searchParams.set('reviewId', review.reviewId)
  const tab = await chrome.tabs.create({ windowId: window.id, active: true, url: url.toString() })
  if (tab.id === undefined) throw new Error('Chrome did not return the Markdown Review Tab identity.')
  const record = { ...review, tabId: tab.id, windowId: tab.windowId, ...(sourceTabId === undefined ? {} : { sourceTabId }), ...(review.pmdPrd === true ? { prdGenerationId: `prd:${crypto.randomUUID()}` } : {}) } satisfies MarkdownReviewRecord
  markdownReviews.set(record.reviewId, record)
  markdownReviewKeys.set(key, record.reviewId)
  await persistMarkdownReview(record)
  if (record.pmdPrd === true) reportPrdReviewGenerated(record)
  return record
}

class WorkspaceReviewRequestTimeoutError extends Error {
  constructor(operation: string) {
    super(`Markdown review ${operation} timed out after ${String(WORKSPACE_REVIEW_REQUEST_TIMEOUT_MS / 1_000)} seconds; the Host did not confirm a result.`)
    this.name = 'WorkspaceReviewRequestTimeoutError'
  }
}

async function workspaceReviewHostRequest(record: MarkdownReviewRecord, path: string, body: Record<string, unknown>, operation: string): Promise<Record<string, unknown>> {
  const base = nativeUrl ?? await startHarnessForSettings()
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const request = (async () => {
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.capability}` },
      body: JSON.stringify({ reviewId: record.reviewId, ...body }),
      signal: controller.signal,
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `workspace review ${operation} failed: HTTP ${String(response.status)}`)
    return payload
  })()
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort()
      reject(new WorkspaceReviewRequestTimeoutError(operation))
    }, WORKSPACE_REVIEW_REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

async function workspaceReviewSnapshot(record: MarkdownReviewRecord): Promise<{ v: 1; type: 'markdown-review-snapshot'; reviewId: string; harnessSessionId: string; sidePanelTabId?: number; resource: { resourceId: string; displayPath: string; revision: string; fingerprint: string }; content: string; truncated: boolean; readOnly: true; pmdPrd?: true; rating?: PrdRating }> {
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_SNAPSHOT_PATH, {}, 'snapshot')
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
    ...(record.sourceTabId === undefined ? {} : { sidePanelTabId: record.sourceTabId }),
    resource: { resourceId: record.resourceId, displayPath: record.displayPath, revision: record.revision, fingerprint: record.fingerprint },
    content: payload.content,
    truncated: payload.truncated,
    readOnly: true,
    ...(record.pmdPrd === true ? { pmdPrd: true } : {}),
    ...(record.rating === undefined ? {} : { rating: record.rating }),
  }
}

async function verifyPmdReviewAdoption(adoption: NonNullable<TeamKnowledgeItemRequest['pmdReviewAdoption']>): Promise<void> {
  const record = markdownReviews.get(adoption.reviewId)
  if (record === undefined || record.harnessSessionId !== adoption.harnessSessionId || record.resourceId !== adoption.resourceId || record.displayPath !== adoption.displayPath) throw new Error('pmd_prd_review_adoption_workspace_changed')
  const snapshot = await retryExpiredWorkspaceReviewCapability(record, () => workspaceReviewSnapshot(record))
  if (snapshot.truncated) throw new Error('pmd_prd_review_adoption_snapshot_truncated')
  if (snapshot.resource.revision !== adoption.revision || snapshot.resource.fingerprint !== adoption.fingerprint || await sha256Hex(snapshot.content) !== adoption.contentHash) throw new Error('pmd_prd_review_adoption_source_changed')
}

async function workspaceReviewProposals(record: MarkdownReviewRecord, afterSequence: number): Promise<Record<string, unknown>> {
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_PROPOSALS_PATH, { afterSequence }, 'proposal read')
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
  const payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_PREPARE_WRITE_PATH, { expected: request.expected, content: request.content }, 'write preparation')
  const prepared = payload.status === 'prepared' && Object.keys(payload).every(key => ['status', 'approval', 'contentHash', 'expiresAt'].includes(key))
    && reviewId(payload.approval) && reviewId(payload.contentHash) && Number.isSafeInteger(payload.expiresAt) && (payload.expiresAt as number) > Date.now()
  if (!prepared && !(payload.status === 'conflict' && Object.keys(payload).every(key => ['status', 'latest'].includes(key)) && isHostMarkdownSnapshot(payload.latest, record))) {
    throw new Error('Harness returned an invalid Markdown write preparation.')
  }
  return payload
}

async function commitMarkdownWrite(record: MarkdownReviewRecord, request: CommitWriteRequest): Promise<Record<string, unknown>> {
  const beforeFingerprint = record.fingerprint
  const edit = record.pmdPrd === true && record.prdGenerationId !== undefined ? request.prdEdit ?? { source: 'manual' as const, mutationId: request.idempotencyKey } : undefined
  if (edit !== undefined) reportPrdEdit(record, edit.source, 'attempt', edit.mutationId)
  let payload: Record<string, unknown>
  try {
    payload = await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_COMMIT_WRITE_PATH, {
      approval: request.approval, idempotencyKey: request.idempotencyKey, content: request.content,
    }, 'write commit')
  } catch (error) {
    if (error instanceof WorkspaceReviewRequestTimeoutError) {
      return {
        status: 'uncertain',
        message: `${error.message} The write may or may not have reached the target; it is not a Verified Write. Re-read the document before any further write.`,
      }
    }
    throw error
  }
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
    if (edit !== undefined && beforeFingerprint !== record.fingerprint) reportPrdEdit(record, edit.source, 'applied', edit.mutationId, beforeFingerprint, record.fingerprint)
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
  const sidePanelUnavailable = /侧边栏|side panel|bound harness workspace/i.test(message)
  const reopenRequired = !sidePanelUnavailable && /capability|authorization|reopen|not found/i.test(message)
  return { code: sidePanelUnavailable ? 'sidepanel_unavailable' : code, message, ...(reopenRequired ? { reopenRequired: true } : {}) }
}

const SIDE_PANEL_UNAVAILABLE_MESSAGE = '侧边栏未打开或尚未准备好。请打开侧边栏后重新发送。'

function missingSidePanelReceiver(error: unknown): boolean {
  return /could not establish connection\.\s*receiving end does not exist\.?/i.test(asError(error))
}

interface MarkdownReviewDelivery { readonly deliveryId: string; readonly targetSessionId: string; readonly targetSessionTitle: string; readonly status: 'queued' | 'processing' }

interface MarkdownReviewSessionActionDelivery {
  readonly action: 'rewrite' | 'accept'
  readonly targetSessionId: string
  readonly targetSessionTitle: string
  readonly status: 'draft_ready' | 'queued' | 'processing'
}

function markdownReviewDelivery(value: unknown, deliveryId: string): MarkdownReviewDelivery | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  return item.ok === true && item.status !== undefined && (item.status === 'queued' || item.status === 'processing')
    && reviewId(item.targetSessionId) && boundedReviewText(item.targetSessionTitle, 2_048)
    ? { deliveryId, targetSessionId: item.targetSessionId, targetSessionTitle: item.targetSessionTitle, status: item.status }
    : undefined
}

async function deliverMarkdownReview(record: MarkdownReviewRecord, request: DeliverRequest): Promise<MarkdownReviewDelivery> {
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
      : { editorRevision: anchor.editorRevision, from: anchor.from, to: anchor.to, blocks: anchor.blocks, ...(anchor.table === undefined ? {} : { table: anchor.table }) }),
  }
  await workspaceReviewHostRequest(record, WORKSPACE_REVIEW_SELECTION_PATH, { selection: { id: request.annotation.id, ...anchor } }, 'selection delivery')
  let response: { ok?: boolean; error?: string } | undefined
  try {
    response = await chrome.runtime.sendMessage({ type: 'markdown-review-feedback-forward/v1', feedback }) as { ok?: boolean; error?: string } | undefined
  } catch (error) {
    if (missingSidePanelReceiver(error)) throw new Error(SIDE_PANEL_UNAVAILABLE_MESSAGE)
    throw error
  }
  const delivery = markdownReviewDelivery(response, request.annotation.id)
  if (delivery === undefined) throw new Error(response?.error ?? SIDE_PANEL_UNAVAILABLE_MESSAGE)
  reportPrdEdit(record, 'ai_annotation', 'attempt', request.annotation.id)
  return delivery
}

function markdownReviewSessionActionDelivery(value: unknown, action: 'rewrite' | 'accept'): MarkdownReviewSessionActionDelivery | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const expectedStatus = item.status === 'draft_ready'
  return item.ok === true && item.action === action && expectedStatus
    && reviewId(item.targetSessionId) && boundedReviewText(item.targetSessionTitle, 2_048)
    ? { action, targetSessionId: item.targetSessionId, targetSessionTitle: item.targetSessionTitle, status: item.status as MarkdownReviewSessionActionDelivery['status'] }
    : undefined
}

async function deliverMarkdownReviewSessionAction(record: MarkdownReviewRecord, request: { harnessSessionId: string; resourceId: string; displayPath: string; revision: string; fingerprint: string; action: 'rewrite' | 'accept' }): Promise<MarkdownReviewSessionActionDelivery> {
  if (request.harnessSessionId !== record.harnessSessionId || request.resourceId !== record.resourceId || request.displayPath !== record.displayPath) throw new Error('Markdown review action does not match its bound Harness session and resource.')
  const snapshot = await workspaceReviewSnapshot(record)
  if (request.action === 'accept' && snapshot.truncated) throw new Error('Markdown file snapshot is truncated; reopen a complete PRD before adopting it.')
  if (request.revision !== snapshot.resource.revision || request.fingerprint !== snapshot.resource.fingerprint) {
    throw new Error('Markdown file changed since this review. Re-read and review the current saved file before adopting it.')
  }
  let response: unknown
  try {
    response = await chrome.runtime.sendMessage({
      type: 'markdown-review-session-action-forward/v1',
      action: request.action,
      review: {
        reviewId: record.reviewId,
        harnessSessionId: record.harnessSessionId,
        resourceId: record.resourceId,
        displayPath: record.displayPath,
        revision: snapshot.resource.revision,
        fingerprint: snapshot.resource.fingerprint,
      },
    })
  } catch (error) {
    if (missingSidePanelReceiver(error)) throw new Error(SIDE_PANEL_UNAVAILABLE_MESSAGE)
    throw error
  }
  const delivery = markdownReviewSessionActionDelivery(response, request.action)
  if (delivery === undefined) throw new Error((response as { error?: unknown } | undefined)?.error as string ?? SIDE_PANEL_UNAVAILABLE_MESSAGE)
  if (request.action === 'accept') {
    if (record.sourceTabId === undefined) throw new Error('执行指令已放入右侧输入框，但未找到当前 Browser Target，无法打开在线文档。请重新打开 PRD 后再采纳。')
    await recordPmdPrdReviewAdoption({
      harnessSessionId: delivery.targetSessionId,
      reviewId: record.reviewId,
      resourceId: record.resourceId,
      displayPath: record.displayPath,
      revision: snapshot.resource.revision,
      fingerprint: snapshot.resource.fingerprint,
    }, snapshot.content)
    try {
      await chrome.tabs.update(record.sourceTabId, { url: 'https://doc.midea.com/docs', active: true })
    } catch (error) {
      throw new Error(`执行指令已放入右侧输入框，但无法打开在线文档：${asError(error)}`)
    }
  }
  return delivery
}

function reportPrdReviewAction(record: MarkdownReviewRecord, requestId: string, action: 'rewrite' | 'accept', outcome: 'succeeded' | 'failed' | 'timeout', status?: string): void {
  if (record.pmdPrd !== true) return
  void reportPrdEvent({
        eventId: `review:${record.reviewId}:${requestId}`,
        eventType: 'review_action',
        outcome,
        occurredAt: new Date().toISOString(),
        sessionId: record.harnessSessionId,
        action,
        ...(status === undefined ? {} : { status }),
  }).catch(() => { /* Telemetry must never change the review action result. */ })
}

function prdReviewName(displayPath: string): string | undefined {
  const separator = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'))
  const name = displayPath.slice(separator + 1).trim()
  return boundedReviewText(name, 256) ? name : undefined
}

function reportPrdReviewGenerated(record: MarkdownReviewRecord): void {
  if (record.pmdPrd !== true || record.prdGenerationId === undefined) return
  const name = prdReviewName(record.displayPath)
  void reportPrdEvent({
        eventId: `${record.prdGenerationId}:generated`,
        eventType: 'review_generated',
        outcome: 'succeeded',
        occurredAt: new Date().toISOString(),
        sessionId: record.harnessSessionId,
        prdGenerationId: record.prdGenerationId,
        ...(name === undefined ? {} : { name }),
  }).catch(() => { /* Telemetry must never change the review open result. */ })
}

async function reportPrdReviewRating(record: MarkdownReviewRecord, request: RatingRequest): Promise<void> {
  if (record.prdGenerationId === undefined) throw new Error('PRD generation identity is unavailable; reopen the generated PRD.')
  await reportPrdEvent({
        eventId: `${record.prdGenerationId}:rating:${request.requestId}`,
        eventType: 'prd_rating',
        outcome: 'succeeded',
        occurredAt: new Date().toISOString(),
        sessionId: record.harnessSessionId,
        generationEventId: `${record.prdGenerationId}:generated`,
        prdGenerationId: record.prdGenerationId,
        rating: request.rating,
  })
}

function reportPrdEdit(record: MarkdownReviewRecord, editSource: 'manual' | 'ai_annotation', editOutcome: 'attempt' | 'applied' | 'rejected', mutationId: string, beforeFingerprint?: string, afterFingerprint?: string): void {
  if (record.pmdPrd !== true || record.prdGenerationId === undefined) return
  void reportPrdEvent({
    eventId: `${record.prdGenerationId}:edit:${editSource}:${mutationId}:${editOutcome}`,
    eventType: 'prd_edit', outcome: 'succeeded', occurredAt: new Date().toISOString(),
    sessionId: record.harnessSessionId, prdGenerationId: record.prdGenerationId,
    editSource, editOutcome, mutationId,
    ...(beforeFingerprint === undefined ? {} : { beforeFingerprint }),
    ...(afterFingerprint === undefined ? {} : { afterFingerprint }),
  }).catch(() => { /* Telemetry must never change the review result. */ })
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
          const snapshot = await retryExpiredWorkspaceReviewCapability(record, () => workspaceReviewSnapshot(record))
          port.postMessage({ v: 1, type: 'markdown-review-snapshot-response', requestId: message.requestId, ok: true, snapshot })
          return
        }
        if (message.type === 'markdown-review-proposals-request') {
          const proposals = await retryExpiredWorkspaceReviewCapability(record, () => workspaceReviewProposals(record, message.afterSequence as number))
          port.postMessage({ v: 1, type: 'markdown-review-proposals-response', requestId: message.requestId, ok: true, ...proposals })
          return
        }
        if (message.type === 'markdown-review-prepare-write-request') {
          const preparation = await retryExpiredWorkspaceReviewCapability(record, () => prepareMarkdownWrite(record, message))
          port.postMessage({ v: 1, type: 'markdown-review-prepare-write-response', requestId: message.requestId, ok: true, preparation })
          return
        }
        if (message.type === 'markdown-review-commit-write-request') {
          const result = await retryExpiredWorkspaceReviewCapability(record, () => commitMarkdownWrite(record, message))
          port.postMessage({ v: 1, type: 'markdown-review-commit-write-response', requestId: message.requestId, ok: true, result })
          return
        }
        if (message.type === 'markdown-review-prd-edit-rejected-request') {
          reportPrdEdit(record, 'ai_annotation', 'rejected', message.mutationId)
          port.postMessage({ v: 1, type: 'markdown-review-prd-edit-rejected-response', requestId: message.requestId, ok: true })
          return
        }
        if (message.type === 'markdown-review-rating-request') {
          if (record.pmdPrd !== true) throw new Error('当前 Markdown 文档不是由 /pmd-prd 生成，不能评分。')
          await reportPrdReviewRating(record, message)
          record.rating = message.rating
          await persistMarkdownReview(record)
          port.postMessage({ v: 1, type: 'markdown-review-rating-response', requestId: message.requestId, ok: true, rating: message.rating })
          return
        }
        if (message.type === 'markdown-review-session-action-request') {
          try {
            const action = await deliverMarkdownReviewSessionAction(record, message)
            reportPrdReviewAction(record, message.requestId, message.action, 'succeeded', action.status)
            port.postMessage({ v: 1, type: 'markdown-review-session-action-response', requestId: message.requestId, ok: true, ...action })
          } catch (error) {
            reportPrdReviewAction(record, message.requestId, message.action, /timeout|timed out|超时|未在.{0,20}秒/i.test(asError(error)) ? 'timeout' : 'failed')
            throw error
          }
          return
        }
        const delivery = await retryExpiredWorkspaceReviewCapability(record, () => deliverMarkdownReview(record, message))
        port.postMessage({ v: 1, type: 'markdown-review-deliver-response', requestId: message.requestId, ok: true, ...delivery })
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
  chrome.notifications?.onClicked.addListener((notificationId) => {
    void workspaceDesktopNotifications.click(notificationId)
  })

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false
    }
    const request = message as { type?: unknown; surface?: unknown; windowId?: unknown; tabId?: unknown; settings?: unknown; runId?: unknown; browserTarget?: unknown; browserTargets?: unknown; sessionId?: unknown; submissionId?: unknown; scope?: unknown; enabled?: unknown; remember?: unknown; action?: unknown; candidate?: unknown; refresh?: unknown; review?: unknown; command?: unknown; requestId?: unknown; apiKey?: unknown; protocol?: unknown; projectId?: unknown; projectName?: unknown; confirmationProjectId?: unknown; referenceId?: unknown; candidateId?: unknown; prompt?: unknown; brief?: unknown; allowRevisionEviction?: unknown; designConfirmed?: unknown; designSpec?: unknown; selection?: unknown; targetRevisionId?: unknown; expectedCurrentRevisionId?: unknown; expectedRevisionId?: unknown; nonce?: unknown; pageUrl?: unknown; anchors?: unknown; eventId?: unknown; kind?: unknown; foreground?: unknown }
    if (request.type === 'workspace-desktop-notification/v1') {
      if (!isSidePanelSender(sender) || !validWorkspaceDesktopNotification(request)) { sendResponse({ ok: false }); return false }
      void workspaceDesktopNotifications.notify(request).then(shown => sendResponse({ ok: true, shown })).catch(() => sendResponse({ ok: true, shown: false }))
      return true
    }
    if (request.type === 'restore-notification-sidepanel-path/v1') {
      if (!isSidePanelSender(sender)) { sendResponse({ ok: false }); return false }
      void chrome.sidePanel?.setOptions({ path: 'sidepanel.html' }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
      return true
    }
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
    if (request.type === 'html-workbench-select/v1') {
      if (!isSidePanelSender(sender) || !Number.isInteger(request.tabId) || typeof request.sessionId !== 'string' || request.sessionId.length === 0 || request.sessionId.length > 160) { sendResponse({ ok: false, error: 'HTML 元素选择请求无效。' }); return false }
      void chrome.tabs.get(request.tabId as number).then(async tab => {
        if (!tab.url?.startsWith('file:')) throw new Error('请选择本地 file:// HTML Browser Target。')
        const nonce = crypto.randomUUID(); htmlWorkbenchPickers.set(tab.id!, { nonce, sessionId: request.sessionId as string, url: tab.url, anchors: [] })
        await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: 'ISOLATED', args: [nonce, request.sessionId as string], func: (pickerNonce: string, sessionId: string) => {
          const key = '__accruiHtmlWorkbenchPicker'
          const old = (globalThis as Record<string, unknown>)[key] as { stop?: () => void } | undefined; old?.stop?.()
          const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(64, '0') }
          const selector = (node: Element) => { const parts: string[] = []; let current: Element | null = node; while (current && parts.length < 16) { const id = current.id ? `#${CSS.escape(current.id)}` : ''; const cls = !id ? [...current.classList].slice(0, 2).map(item => `.${CSS.escape(item)}`).join('') : ''; let item = `${current.tagName.toLowerCase()}${id || cls}`; if (!id) { let index = 1; let sibling = current.previousElementSibling; while (sibling) { if (sibling.tagName === current.tagName) index += 1; sibling = sibling.previousElementSibling }; item += `:nth-of-type(${index})` } parts.unshift(item); if (id) break; current = current.parentElement }; return parts.join(' > ') }
          const selected: Element[] = []; const root = document.documentElement; const previousPicking = root.getAttribute('data-accrui-html-workbench-picking'); root.setAttribute('data-accrui-html-workbench-picking', 'true'); const style = document.createElement('style'); style.textContent = '[data-accrui-html-workbench-picking]{user-select:none!important;-webkit-user-select:none!important}[data-accrui-html-selected]{outline:2px solid #2563eb!important;outline-offset:2px!important}#accrui-html-workbench-picker{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:6px;align-items:center;padding:9px 10px;border-radius:10px;background:#111827;color:#fff;font:13px sans-serif;box-shadow:0 6px 22px #0008}#accrui-html-workbench-picker button{border:0;border-radius:6px;padding:5px 8px;background:#374151;color:#fff;cursor:pointer}#accrui-html-workbench-picker button[data-send]{background:#2563eb}'; root.append(style)
          const panel = document.createElement('div'); panel.id = 'accrui-html-workbench-picker'; panel.setAttribute('role', 'status'); const count = document.createElement('span'); const parent = document.createElement('button'); parent.textContent = '选择父级'; const cancel = document.createElement('button'); cancel.textContent = '取消'; const send = document.createElement('button'); send.textContent = '发送给 AI'; send.setAttribute('data-send', ''); panel.append(count, parent, cancel, send); document.documentElement.append(panel)
          const update = () => { count.textContent = `已选 ${selected.length} 个（Shift 多选）`; send.toggleAttribute('disabled', selected.length === 0) }
          const anchors = () => selected.slice(0, 12).map(item => { const value = selector(item); const structurePath = value.split(' > '); return value.length > 0 && value.length <= 2_000 && structurePath.length <= 64 && structurePath.every(part => part.length <= 256) ? { selector: value, structurePath, fingerprint: hash(item.outerHTML), text: item.textContent?.slice(0, 4000) ?? '', outerHTML: item.outerHTML.slice(0, 16000) } : null }).filter((item): item is { selector: string; structurePath: string[]; fingerprint: string; text: string; outerHTML: string } => item !== null)
          const clearNativeSelection = () => document.getSelection()?.removeAllRanges()
          const preventNativeSelection = (event: Event) => { if (panel.contains(event.target as Node)) return; event.preventDefault(); clearNativeSelection() }
          const stop = () => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', keydown, true); document.removeEventListener('mousedown', preventNativeSelection, true); document.removeEventListener('selectstart', preventNativeSelection, true); document.removeEventListener('dragstart', preventNativeSelection, true); clearNativeSelection(); style.remove(); panel.remove(); selected.forEach(node => node.removeAttribute('data-accrui-html-selected')); if (previousPicking === null) root.removeAttribute('data-accrui-html-workbench-picking'); else root.setAttribute('data-accrui-html-workbench-picking', previousPicking); delete (globalThis as Record<string, unknown>)[key] }
          const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') stop() }
          const click = (event: MouseEvent) => { if (panel.contains(event.target as Node)) return; const raw = event.target; if (!(raw instanceof Element)) return; event.preventDefault(); event.stopPropagation(); clearNativeSelection(); const node = event.altKey ? raw.parentElement ?? raw : raw; if (!event.shiftKey) { selected.splice(0).forEach(item => item.removeAttribute('data-accrui-html-selected')) }; if (!selected.includes(node)) { selected.push(node); node.setAttribute('data-accrui-html-selected', 'true') }; update() }
          parent.onclick = () => { const node = selected.at(-1)?.parentElement; if (!node) return; selected.forEach(item => item.removeAttribute('data-accrui-html-selected')); selected.splice(0, selected.length, node); node.setAttribute('data-accrui-html-selected', 'true'); update() }; cancel.onclick = stop; send.onclick = () => { if (selected.length === 0) return; void chrome.runtime.sendMessage({ type: 'html-workbench-selection/v1', nonce: pickerNonce, sessionId, pageUrl: location.href, anchors: anchors() }); stop() }
          update(); document.addEventListener('mousedown', preventNativeSelection, true); document.addEventListener('selectstart', preventNativeSelection, true); document.addEventListener('dragstart', preventNativeSelection, true); document.addEventListener('click', click, true); document.addEventListener('keydown', keydown, true); (globalThis as Record<string, unknown>)[key] = { stop }
        } })
      }).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: asError(error).includes('Cannot access') ? '无法访问本地文件。请在扩展详情中开启“允许访问文件网址”。' : asError(error) }))
      return true
    }
    if (request.type === 'html-workbench-selection/v1') {
      const tabId = sender.tab?.id; const picker = tabId === undefined ? undefined : htmlWorkbenchPickers.get(tabId)
      if (!picker || request.nonce !== picker.nonce || request.sessionId !== picker.sessionId || request.pageUrl !== picker.url || !Array.isArray(request.anchors) || request.anchors.length < 1 || request.anchors.length > 12 || !request.anchors.every(validHtmlWorkbenchAnchor)) { sendResponse({ ok: false, error: 'HTML 页面选择已失效，请重新启用选择。' }); return false }
      picker.anchors = request.anchors
      void chrome.runtime.sendMessage({ type: 'html-workbench-prompt-forward/v1', payload: { sessionId: picker.sessionId, pageUrl: picker.url, anchors: picker.anchors } }).then(reply => sendResponse(reply)).catch(error => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'release-update/v1') {
      if (!isSidePanelSender(sender) || (request.action !== 'check' && request.action !== 'prepare' && request.action !== 'cancel')) { sendResponse({ ok: false, error: '在线更新请求无效。' }); return false }
      const requestId = typeof request.requestId === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(request.requestId) ? request.requestId : crypto.randomUUID()
      try {
        const port = connectNativePort()
        if (request.action === 'cancel') {
          const pending = pendingReleaseUpdates.get(requestId)
          if (pending === undefined || pending.cancelling) { sendResponse({ ok: false, error: '在线更新状态未知；请查看更新状态' }); return false }
          pending.cancelling = true
          clearTimeout(pending.timer)
          pending.cancelResolve = sendResponse
          pending.cancelTimer = setTimeout(() => {
            if (pendingReleaseUpdates.get(requestId) !== pending) return
            pendingReleaseUpdates.delete(requestId)
            pending.resolve({ ok: false, error: '在线更新状态未知；请查看更新状态' })
            pending.cancelResolve?.({ ok: false, error: '在线更新状态未知；请查看更新状态' })
          }, 5_000)
          port.postMessage(releaseUpdateNativeMessage('cancel', requestId))
          return true
        }
        const timer = setTimeout(() => {
          const pending = pendingReleaseUpdates.get(requestId)
          if (pending !== undefined && !pending.cancelling) {
            pending.cancelling = true
            clearTimeout(pending.timer)
            try { port.postMessage(releaseUpdateNativeMessage('cancel', requestId)) } catch {}
            pending.cancelTimer = setTimeout(() => {
              if (pendingReleaseUpdates.get(requestId) !== pending) return
              pendingReleaseUpdates.delete(requestId)
              pending.resolve({ ok: false, error: '在线更新状态未知；请查看更新状态' })
            }, 5_000)
          }
        }, request.action === 'prepare' ? 180_000 : 45_000)
        pendingReleaseUpdates.set(requestId, { resolve: sendResponse, timer })
        port.postMessage(releaseUpdateNativeMessage(request.action, requestId, request.candidate))
        return true
      } catch (error) { sendResponse({ ok: false, error: asError(error) }); return false }
    }
    if (request.type === 'switch-harness-surface/v1') {
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0 || (request.sessionId !== undefined && !validSessionIdentity(request.sessionId))) {
        sendResponse({ ok: false, error: 'Chrome could not switch the Harness Workspace to a Tab.' })
        return false
      }
      const windowId = request.windowId as number
      if (request.surface === 'fullscreen-tab') {
        if (chrome.sidePanel?.close === undefined) {
          sendResponse({ ok: false, error: '全屏模式需要 Chrome 141 或更高版本；当前 Chrome 仍可正常使用侧边栏。' })
          return false
        }
        if (chrome.tabs?.create === undefined) {
          sendResponse({ ok: false, error: 'Chrome could not switch the Harness Workspace to a Tab.' })
          return false
        }
        void (async () => {
          // Capture the real Browser Target before creating the extension Tab;
          // Chrome activates that Tab immediately, so resolving afterwards
          // would otherwise report the unusable fullscreen document.
          await preserveFullscreenBrowserTarget(windowId, activeBrowserTarget, updateBrowserTargetSettings)
          const url = new URL(chrome.runtime.getURL('sidepanel.html'))
          url.searchParams.set('dshHarnessSurface', 'fullscreen-tab')
          url.searchParams.set('dshHarnessHandoffNonce', crypto.randomUUID())
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
      if (!Number.isInteger(request.windowId) || (request.windowId as number) < 0 || !Number.isInteger(request.tabId) || (request.tabId as number) < 0 || !validSessionIdentity(request.sessionId) || !validHandoffNonce(request.nonce) || chrome.tabs?.get === undefined) {
        sendResponse({ ok: false, error: 'Chrome could not prepare the Harness side-panel handoff.' })
        return false
      }
      const windowId = request.windowId as number
      const tabId = request.tabId as number
      const sessionId = request.sessionId
      const nonce = request.nonce
      const handoff = { sessionId, tabId, nonce, expiresAt: Date.now() + SIDE_PANEL_HANDOFF_TTL_MS }
      pendingSidePanelHandoffs.set(windowId, handoff)
      void (async () => {
        try {
          const tab = await chrome.tabs.get(tabId)
          if (tab?.windowId !== windowId) throw new Error('The full-screen Harness Tab is no longer in this browser window.')
          const url = new URL(tab.url ?? '')
          if (url.searchParams.get('dshHarnessSurface') !== 'fullscreen-tab' || url.searchParams.get('dshHarnessHandoffNonce') !== nonce) throw new Error('The full-screen Harness Tab handoff nonce is invalid.')
          await persistSidePanelHandoff(windowId, handoff)
        } catch (error) {
          const handoff = pendingSidePanelHandoffs.get(windowId)
          if (handoff?.tabId === tabId && handoff.sessionId === sessionId && handoff.nonce === nonce) { pendingSidePanelHandoffs.delete(windowId); await persistSidePanelHandoff(windowId, undefined) }
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
      void (async () => {
        const handoff = pendingSidePanelHandoffs.get(windowId) ?? await readPersistedSidePanelHandoff(windowId)
        if (handoff === undefined || handoff.expiresAt <= Date.now()) {
          pendingSidePanelHandoffs.delete(windowId)
          await persistSidePanelHandoff(windowId, undefined)
          sendResponse({ ok: true })
          return
        }
        pendingSidePanelHandoffs.set(windowId, handoff)
        sendResponse({ ok: true, sessionId: handoff.sessionId, tabId: handoff.tabId, nonce: handoff.nonce })
      })().catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'session-handoff-applied/v1') {
      if (!isSidePanelSender(sender) || !Number.isInteger(request.windowId) || (request.windowId as number) < 0 || !Number.isInteger(request.tabId) || (request.tabId as number) < 0 || !validSessionIdentity(request.sessionId) || !validHandoffNonce(request.nonce) || chrome.tabs?.get === undefined || chrome.tabs?.remove === undefined) {
        sendResponse({ ok: false, error: 'Chrome could not complete the Harness side-panel handoff.' })
        return false
      }
      const windowId = request.windowId as number
      const tabId = request.tabId as number
      void (async () => {
        const handoff = pendingSidePanelHandoffs.get(windowId) ?? await readPersistedSidePanelHandoff(windowId)
        if (handoff !== undefined && handoff.expiresAt <= Date.now()) { pendingSidePanelHandoffs.delete(windowId); await persistSidePanelHandoff(windowId, undefined); throw new Error('The Harness side-panel handoff has expired.') }
        const activeHandoff = handoff
        if (activeHandoff === undefined || activeHandoff.tabId !== tabId || activeHandoff.sessionId !== request.sessionId || activeHandoff.nonce !== request.nonce) throw new Error('The Harness side-panel handoff does not match the restored session.')
        const tab = await chrome.tabs.get(tabId)
        if (tab?.windowId !== windowId) throw new Error('The full-screen Harness Tab is no longer in this browser window.')
        const url = new URL(tab.url ?? '')
        const tabNonce = url.searchParams.get('dshHarnessHandoffNonce')
        if (url.origin !== new URL(chrome.runtime.getURL('/')).origin || url.searchParams.get('dshHarnessSurface') !== 'fullscreen-tab' || !validHandoffNonce(tabNonce) || activeHandoff?.nonce !== tabNonce || request.nonce !== tabNonce) throw new Error('The Harness side-panel handoff nonce is no longer current.')
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
        await persistSidePanelHandoff(windowId, undefined)
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
        || (request.protocol !== 'anthropic-messages' && request.protocol !== 'openai-completions')) {
        sendResponse({ ok: false, error: 'Invalid company gateway probe.' })
        return false
      }
      const requestId = request.requestId
      const apiKey = request.apiKey
      const protocol = request.protocol
      void probeCompanyGateway(apiKey)
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
          knowledgeTransport.clearCatalog()
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
        if (!knowledgeTransport.hasProxy()) await startHarnessForSettings()
        if (request.action === 'login' || request.action === 'retry') {
          knowledgeTransport.clearCatalog()
        }
        if (request.action === 'login') {
          await setAccountLocallySignedOut(false)
          await chrome.tabs.create({ url: KNOWLEDGE_LOGIN_URL, active: true })
        }
        if (request.scope !== undefined || typeof request.enabled === 'boolean' || typeof request.remember === 'boolean') {
          const existing = (await resolveKnowledgeScopeRecord({ harnessSessionId: sessionId } as KnowledgeQueryRequest))?.scope
          const nextScope = request.scope ?? existing ?? { domainSystems: {}, repositoryIds: [] }
          if (!validScope(nextScope)) throw new Error('Invalid knowledge selection.')
          await saveKnowledgeScope(sessionId, nextScope, typeof request.enabled === 'boolean' ? request.enabled : undefined, typeof request.remember === 'boolean' ? request.remember : undefined)
        }
        let record = await resolveKnowledgeScopeRecord({ harnessSessionId: sessionId } as KnowledgeQueryRequest)
        const preference = await knowledgeEnabledPreference()
        try {
          const catalog = await knowledgeTransport.loadCatalog()
          // Another selection can land while the remote catalog is loading; prune
          // that latest record instead of writing the earlier snapshot back over it.
          record = await resolveKnowledgeScopeRecord({ harnessSessionId: sessionId } as KnowledgeQueryRequest)
          const savedScope = record?.scope
          const scope = savedScope === undefined ? savedScope : pruneScope(savedScope, catalog)
          if (scope !== undefined && savedScope !== undefined && scopeFingerprint(scope) !== scopeFingerprint(savedScope)) record = await saveKnowledgeScope(sessionId, scope)
          sendResponse({ ok: true, scope, enabled: record?.enabled ?? (preference.remember ? preference.enabled : true), remember: preference.remember, notice: record?.notice, serviceState: 'ready', catalog })
        } catch (error) {
          const text = asError(error)
          sendResponse({ ok: false, scope: record?.scope, enabled: record?.enabled, remember: preference.remember, notice: record?.notice, serviceState: knowledgeTransport.serviceState(error), error: text })
        }
      })().catch(async (error: unknown) => {
        const record = await resolveKnowledgeScopeRecord({ harnessSessionId: sessionId } as KnowledgeQueryRequest)
        const preference = await knowledgeEnabledPreference()
        sendResponse({
          ok: false,
          scope: record?.scope,
          enabled: record?.enabled ?? (preference.remember ? preference.enabled : true),
          remember: preference.remember,
          notice: record?.notice,
          serviceState: knowledgeTransport.serviceState(error),
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
      if (!isSidePanelSender(sender) || !validBrowserTarget(request.browserTarget) || !validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: 'A trusted Side Panel, Harness session, and explicit Browser Target are required.' })
        return false
      }
      void captureDesignReference(request.browserTarget, request.sessionId)
        .then(({ referenceId, projectId }) => sendResponse({ ok: true, referenceId, projectId }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'capture-responsive-design-reference/v1') {
      if (!isSidePanelSender(sender) || !validBrowserTarget(request.browserTarget) || !validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: '多尺寸实测需要可信侧栏、Harness 对话和明确参考网页。' })
        return false
      }
      const browserTarget = request.browserTarget
      void captureResponsiveDesignReference(browserTarget, request.sessionId, current => { void chrome.runtime.sendMessage({ type: 'design-reference-capture-progress/v1', current, total: 3, tabId: browserTarget.tabId }).catch(() => {}) })
        .then(({ referenceId, projectId }) => sendResponse({ ok: true, referenceId, projectId }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'capture-design-references/v1') {
      if (!isSidePanelSender(sender) || !Array.isArray(request.browserTargets) || request.browserTargets.length < 2 || request.browserTargets.length > 3 || !request.browserTargets.every(validBrowserTarget) || new Set(request.browserTargets.map(item => item.tabId)).size !== request.browserTargets.length || !validSessionIdentity(request.sessionId)) {
        sendResponse({ ok: false, error: 'A trusted Side Panel, Harness session, and two to three explicit Browser Targets are required.' })
        return false
      }
      const browserTargets = request.browserTargets as BrowserTarget[]
      void captureDesignReferences(browserTargets, request.sessionId, (current, tabId) => {
        void chrome.runtime.sendMessage({ type: 'design-reference-capture-progress/v1', current, total: browserTargets.length, tabId }).catch(() => {})
      })
        .then(({ referenceId, projectId }) => sendResponse({ ok: true, referenceId, projectId }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-recent/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || !keys.every(key => ['type', 'sessionId'].includes(key)) || keys.length > 2 || (request.sessionId !== undefined && !validSessionIdentity(request.sessionId))) { sendResponse({ ok: false, error: '最近原型请求无效。' }); return false }
      void recentPrototypeStudios(typeof request.sessionId === 'string' ? request.sessionId : undefined)
        .then(projects => sendResponse({ ok: true, projects }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-open-recent/v1') {
      if (!isSidePanelSender(sender) || Object.keys(request).length !== 2 || typeof request.projectId !== 'string') { sendResponse({ ok: false, error: '打开最近原型的请求无效。' }); return false }
      void openRecentPrototypeStudio(request.projectId)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-continue-current/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'sessionId'].includes(key)) || typeof request.projectId !== 'string' || !validSessionIdentity(request.sessionId)) { sendResponse({ ok: false, error: '在当前对话继续的请求无效。' }); return false }
      void continueRecentPrototypeStudioInSession(request.projectId, request.sessionId)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-rename/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'projectName'].includes(key)) || typeof request.projectId !== 'string' || typeof request.projectName !== 'string' || request.projectName.trim().length < 1 || request.projectName.trim().length > 80) { sendResponse({ ok: false, error: '重命名原型的请求无效。' }); return false }
      void renameRecentPrototypeStudio(request.projectId, request.projectName.trim()).then(() => sendResponse({ ok: true })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-delete/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'confirmationProjectId'].includes(key)) || typeof request.projectId !== 'string' || request.confirmationProjectId !== request.projectId) { sendResponse({ ok: false, error: '删除原型需要确认当前项目。' }); return false }
      void deleteRecentPrototypeStudio(request.projectId, request.confirmationProjectId).then(() => sendResponse({ ok: true })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-snapshot/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId)) { sendResponse({ ok: false, error: '原型页面身份或项目参数无效，请重新打开原型工具。' }); return false }
      void prototypeStudioSnapshot(request.projectId).then(snapshot => {
        if (snapshot === undefined) {
          sendResponse({ ok: false, code: 'prototype_authorization_expired', recoveryAvailable: true, error: '当前浏览器授权已过期，但原型和历史版本仍安全保留。请点击“恢复已有项目”。' })
          return undefined
        }
        return snapshot
      })
        .then(snapshot => { if (snapshot !== undefined) sendResponse({ ok: true, snapshot }) })
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-recover/v1') {
      const keys = Object.keys(request)
      if (keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'referenceId'].includes(key)) || typeof request.projectId !== 'string' || typeof request.referenceId !== 'string' || !isPrototypeStudioSender(sender, request.projectId, request.referenceId)) { sendResponse({ ok: false, error: '恢复请求与当前原型页面不匹配，请从原型页重新操作。' }); return false }
      void recoverPrototypeStudio(request.projectId, request.referenceId)
        .then(snapshot => sendResponse({ ok: true, snapshot }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-confirm-design/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || request.designSpec === null || typeof request.designSpec !== 'object' || Array.isArray(request.designSpec)) { sendResponse({ ok: false, error: '设计规范确认内容无效，请重新打开确认页。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CONFIRM_DESIGN_PATH, { designSpec: request.designSpec })
        if (result.status !== 'verified_write' || typeof result.designSpecFingerprint !== 'string') throw new Error('设计规范没有完成安全保存和回读，请重试。')
        return result
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-revision-preview/v1') {
      const keys = Object.keys(request)
      if (keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'targetRevisionId'].includes(key)) || typeof request.projectId !== 'string' || typeof request.targetRevisionId !== 'string' || !isPrototypeStudioSender(sender, request.projectId)) { sendResponse({ ok: false, error: '历史版本预览请求无效，请刷新原型工具后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_REVISION_PREVIEW_PATH, { targetRevisionId: request.targetRevisionId })
      }).then(preview => sendResponse({ ok: true, preview })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-reopen-design/v1') {
      const keys = Object.keys(request)
      if (keys.length !== 2 || !keys.every(key => key === 'type' || key === 'projectId') || typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId)) { sendResponse({ ok: false, error: '重新调整设计规范的请求无效，请刷新后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_REOPEN_DESIGN_PATH, {})
        if (result.status !== 'verified_write' || result.designConfirmed !== false) throw new Error('设计规范没有安全返回调整状态，请勿继续生成并重试。')
        return result
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-create-variant/v1') {
      const keys = Object.keys(request)
      if (keys.length !== 2 || !keys.every(key => key === 'type' || key === 'projectId') || typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || !Number.isSafeInteger(sender.tab?.windowId)) { sendResponse({ ok: false, error: '新设计方案请求无效，请从当前原型页面重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return createPrototypeVariant(authorization, sender.tab!.windowId)
      }).then(result => sendResponse({ ok: true, ...result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-restore/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.targetRevisionId !== 'string' || typeof request.expectedCurrentRevisionId !== 'string') { sendResponse({ ok: false, error: '历史版本恢复请求无效，请先重新预览该版本。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_RESTORE_PATH, { targetRevisionId: request.targetRevisionId, expectedCurrentRevisionId: request.expectedCurrentRevisionId })
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-cancel-generation/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.requestId !== 'string' || (request.expectedRevisionId !== undefined && request.expectedRevisionId !== null && typeof request.expectedRevisionId !== 'string')) { sendResponse({ ok: false, error: '停止生成的请求无效，请刷新生成状态后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CANCEL_GENERATION_PATH, { requestId: request.requestId, expectedRevisionId: request.expectedRevisionId ?? null })
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-confirm-candidate/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.candidateId !== 'string' || (request.expectedCurrentRevisionId !== undefined && request.expectedCurrentRevisionId !== null && typeof request.expectedCurrentRevisionId !== 'string')) { sendResponse({ ok: false, error: '应用候选原型的请求无效，请刷新预览后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CONFIRM_CANDIDATE_PATH, { candidateId: request.candidateId, expectedCurrentRevisionId: request.expectedCurrentRevisionId ?? null })
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-cancel-candidate/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.candidateId !== 'string') { sendResponse({ ok: false, error: '放弃候选原型的请求无效，请刷新预览后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        return prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CANCEL_CANDIDATE_PATH, { candidateId: request.candidateId })
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-confirm-brief/v1') {
      const keys = Object.keys(request)
      const brief = productBrief(request.brief)
      if (keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'brief'].includes(key)) || typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || brief === undefined) { sendResponse({ ok: false, error: '产品需求清单不完整，请检查使用者、核心任务、页面和流程。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        const expectedFingerprint = await sha256Fingerprint(brief)
        const result = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CONFIRM_BRIEF_PATH, { brief })
        if (result.status !== 'verified_write' || productBrief(result.productBrief) === undefined || result.productBriefFingerprint !== expectedFingerprint || await sha256Fingerprint(result.productBrief) !== expectedFingerprint) throw new Error('产品需求清单没有完成安全保存和同内容回读，请重试。')
        return result
      }).then(result => sendResponse({ ok: true, result })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-suggest-brief/v1') {
      const keys = Object.keys(request)
      if (keys.length !== 3 || !keys.every(key => ['type', 'projectId', 'requestId'].includes(key)) || typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(request.requestId)) { sendResponse({ ok: false, error: 'AI 整理产品需求的请求无效，请刷新后重试。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请先恢复已有项目。')
        const snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
        if (snapshot.designConfirmed !== true) throw new Error('请先确认参考网页的设计规范。')
        if (snapshot.generationAttempt !== undefined) throw new Error('当前正在生成原型，请完成或停止后再整理需求。')
        const began = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_BEGIN_BRIEF_SUGGESTION_PATH, { requestId: request.requestId })
        if (began.status !== 'verified_write' || began.requestId !== request.requestId) throw new Error('需求整理请求没有完成安全登记，请重试。')
        try {
          const response = await chrome.runtime.sendMessage({ type: 'prototype-studio-brief-suggestion-forward/v1', payload: { projectId: authorization.projectId, sessionId: authorization.sessionId, requestId: request.requestId } }) as { ok?: boolean; error?: string } | undefined
          if (response?.ok !== true) throw new Error(response?.error ?? 'Harness 对话没有接受需求整理请求。')
        } catch (error) {
          // The short-lived Host request expires automatically. It deliberately
          // remains pending here so a late, already accepted Agent result can
          // still be validated against the same request id.
          throw error
        }
      }).then(() => sendResponse({ ok: true })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'prototype-studio-prompt/v1') {
      if (typeof request.projectId !== 'string' || !isPrototypeStudioSender(sender, request.projectId) || typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(request.requestId) || typeof request.prompt !== 'string' || request.prompt.trim().length === 0 || request.prompt.length > 6_000 || (request.allowRevisionEviction !== undefined && request.allowRevisionEviction !== true)) { sendResponse({ ok: false, error: '发送给 AI 的原型请求无效或过长，请精简后重试。' }); return false }
      const selection = request.selection === undefined ? undefined : request.selection
      if (selection !== undefined && !isPrototypeStudioSelection(selection)) { sendResponse({ ok: false, error: '选中的原型元素已经失效，请重新选择。' }); return false }
      const brief = request.brief === undefined ? undefined : productBrief(request.brief)
      if (request.brief !== undefined && brief === undefined) { sendResponse({ ok: false, error: '产品需求清单格式无效，请重新确认。' }); return false }
      void prototypeStudioAuthorization(request.projectId).then(async authorization => {
        if (authorization === undefined) throw new Error('原型授权已过期，请重新提取参考网页。')
        const snapshot = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_SNAPSHOT_PATH, {})
        if (snapshot.designConfirmed !== true) throw new Error('请先查看并确认网页设计规范，再让 AI 生成原型。')
        const confirmedDesignSpec = snapshot.confirmedDesignSpec ?? snapshot.designSpec
        if (confirmedDesignSpec === null || typeof confirmedDesignSpec !== 'object' || Array.isArray(confirmedDesignSpec)) throw new Error('已确认的设计规范无法读取，请重新确认。')
        const expectedRevisionId = typeof snapshot.currentRevisionId === 'string' ? snapshot.currentRevisionId : undefined
        const confirmedBrief = productBrief(snapshot.productBrief)
        if (expectedRevisionId === undefined && confirmedBrief === undefined) throw new Error('首次生成前请先保存并确认产品需求清单。')
        const briefChanged = brief !== undefined && confirmedBrief !== undefined && await sha256Fingerprint(brief) !== await sha256Fingerprint(confirmedBrief)
        if (briefChanged && expectedRevisionId === undefined) throw new Error('产品需求清单已经变化，请先重新确认后再生成。')
        if (briefChanged && selection !== undefined) throw new Error('更新整个产品需求时不能同时修改局部元素，请先切换到“完善整个原型”。')
        const generationBrief = brief ?? confirmedBrief
        const began = await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_BEGIN_GENERATION_PATH, { requestId: request.requestId, expectedRevisionId: expectedRevisionId ?? null, prompt: request.prompt, ...(selection === undefined ? {} : { selection }), ...(generationBrief === undefined ? {} : { brief: generationBrief }), ...(request.allowRevisionEviction === true ? { allowRevisionEviction: true } : {}) })
        if (began.status !== 'verified_write' || began.requestId !== request.requestId) throw new Error('本次生成请求没有完成安全登记，请重试。')
        const payload = { projectId: authorization.projectId, sessionId: authorization.sessionId, requestId: request.requestId, ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }), request: request.prompt, ...(selection === undefined ? {} : { selection }), ...(generationBrief === undefined ? {} : { productBrief: generationBrief }), evidence: snapshot.evidence, revisions: snapshot.revisions, currentRevisionId: snapshot.currentRevisionId, designSpec: confirmedDesignSpec, document: snapshot.document }
        if (JSON.stringify(payload).length > 260_000) throw new Error('参考证据和原型内容过大，暂时无法发送给 AI。')
        try {
          const response = await chrome.runtime.sendMessage({ type: 'prototype-studio-prompt-forward/v1', payload }) as { ok?: boolean; error?: string } | undefined
          if (response?.ok !== true) throw new Error(response?.error ?? 'The Harness Workspace did not accept the prototype request.')
          return response
        } catch (error) {
          await prototypeHostRequest(authorization, PROTOTYPE_STUDIO_CANCEL_GENERATION_PATH, { requestId: request.requestId, expectedRevisionId: expectedRevisionId ?? null, message: '未能将本次原型生成请求交给 Harness，已取消。' }).catch(() => {})
          throw error
        }
      }).then(() => sendResponse({ ok: true })).catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'lock-browser-target/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 4 || !keys.every(key => ['type', 'sessionId', 'submissionId', 'browserTarget'].includes(key)) || !validSessionIdentity(request.sessionId) || !validSessionIdentity(request.submissionId) || !validBrowserTarget(request.browserTarget)) {
        sendResponse({ ok: false, error: 'Browser Target lock request is invalid.' })
        return false
      }
      void lockFollowBrowserTarget(request.sessionId, request.submissionId, request.browserTarget)
        .then(locked => sendResponse({ ok: true, locked }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'get-active-browser-target-lock/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 1 || keys[0] !== 'type') {
        sendResponse({ ok: false, error: 'Browser Target lock query is invalid.' })
        return false
      }
      const locks = activeRunBrowserTargetLocks(currentNativeRunId)
      if (locks.length === 0) {
        sendResponse({ ok: true })
        return true
      }
      const projectedLocks = locks.map(lock => ({ sessionId: lock.sessionId, submissionId: lock.submissionId, browserTarget: lock.binding.browserTarget, ...(lock.observedActivity ? { observedActivity: true } : {}) }))
      if (projectedLocks.length === 1) {
        sendResponse({ ok: true, lock: projectedLocks[0] })
        return true
      }
      sendResponse({ ok: true, lock: projectedLocks[0], locks: projectedLocks })
      return true
    }
    if (request.type === 'unlock-browser-target/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'sessionId', 'submissionId'].includes(key)) || !validSessionIdentity(request.sessionId) || !validSessionIdentity(request.submissionId)) {
        sendResponse({ ok: false, error: 'Browser Target unlock request is invalid.' })
        return false
      }
      unlockFollowBrowserTarget(request.sessionId, request.submissionId)
      sendResponse({ ok: true })
      return false
    }
    if (request.type === 'observe-browser-target-lock/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'sessionId', 'submissionId'].includes(key)) || !validSessionIdentity(request.sessionId) || !validSessionIdentity(request.submissionId)) {
        sendResponse({ ok: false, error: 'Browser Target lifecycle observation is invalid.' })
        return false
      }
      observeFollowBrowserTarget(request.sessionId, request.submissionId)
      sendResponse({ ok: true })
      return false
    }
    if (request.type === 'reconcile-browser-target-lock/v1') {
      const keys = Object.keys(request)
      if (!isSidePanelSender(sender) || keys.length !== 3 || !keys.every(key => ['type', 'sessionId', 'submissionId'].includes(key)) || !validSessionIdentity(request.sessionId) || !validSessionIdentity(request.submissionId)) { sendResponse({ ok: false, error: 'Browser Target reconciliation request is invalid.' }); return false }
      for (const [runId, locks] of runBrowserTargetLocks) {
        const lock = locks.get(request.submissionId)
        if (lock?.sessionId === request.sessionId && lock.state === 'active') {
          removeRunBrowserTargetLock(runId, request.submissionId, lock)
          releaseRunBrowserTargetCapture(request.sessionId, request.submissionId)
        }
      }
      sendResponse({ ok: true })
      return false
    }
    if (request.type === 'save-browser-target-settings') {
      const settings = settingsFromUnknown(request.settings)
      void saveBrowserTargetSettings(settings)
        .then((saved) => sendResponse({ ok: true, settings: saved }))
        .catch((error: unknown) => sendResponse({ ok: false, error: asError(error) }))
      return true
    }
    if (request.type === 'transfer-browser-target') {
      if (!validBrowserTarget(request.browserTarget)) {
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
