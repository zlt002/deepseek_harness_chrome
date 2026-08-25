/**
 * Non-secret recovery bindings for persisted Prototype Studio projects.
 * The short-lived capability never enters chrome.storage.local. A binding is
 * only enough for Native Host to sign an exact, user-triggered recovery.
 */
export const PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY = 'harnessPrototypeStudioRecoveriesV1'
export const MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS = 50
// A recovery candidate is deliberately short lived and session-only. It
// closes the MV3 crash window between the Host's capability rotation and the
// Service Worker's active-authorization write; it is never a local project
// record and never survives a browser restart.
export const PROTOTYPE_STUDIO_PENDING_RECOVERY_STORAGE_KEY = 'harnessPrototypeStudioPendingRecoveriesV1'
export const MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES = 8
export const PROTOTYPE_STUDIO_PENDING_RECOVERY_TTL_MS = 2 * 60_000

export interface PrototypeStudioRecoveryBinding {
  projectId: string
  referenceId: string
  sessionId: string
  evidenceFingerprint: string
  recoveryEpoch: number
  updatedAt: number
  /** Human-readable, non-secret index fields for the Side Panel. */
  referenceTitle?: string
  referenceUrl?: string
  projectName?: string
  currentRevisionId?: string
  revisionCount?: number
}

export interface StoredPrototypeStudioRecoveries {
  v: 1
  projects: Record<string, PrototypeStudioRecoveryBinding>
}

export interface PrototypeStudioPendingRecovery {
  projectId: string
  referenceId: string
  sessionId: string
  evidenceFingerprint: string
  expectedRecoveryEpoch: number
  capability: string
  createdAt: number
  expiresAt: number
  nonce: string
}

export interface StoredPrototypeStudioPendingRecoveries {
  v: 1
  projects: Record<string, PrototypeStudioPendingRecovery>
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const projectId = new RegExp(`^prototype-${uuid}$`, 'i')
const referenceId = new RegExp(`^ref-${uuid}$`, 'i')
const nonce = new RegExp(`^${uuid}$`, 'i')
const sessionId = /^[A-Za-z0-9._:-]{1,160}$/
const fingerprint = /^[0-9a-f]{64}$/
const capability = new RegExp(`^${uuid}${uuid}$`, 'i')

export function validPrototypeStudioRecoveryBinding(value: unknown): value is PrototypeStudioRecoveryBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Partial<PrototypeStudioRecoveryBinding>
  const required = ['projectId', 'referenceId', 'sessionId', 'evidenceFingerprint', 'recoveryEpoch', 'updatedAt']
  const allowed = [...required, 'referenceTitle', 'referenceUrl', 'projectName', 'currentRevisionId', 'revisionCount']
  return Object.keys(item).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(item, key))
    && typeof item.projectId === 'string' && projectId.test(item.projectId)
    && typeof item.referenceId === 'string' && referenceId.test(item.referenceId)
    && typeof item.sessionId === 'string' && sessionId.test(item.sessionId)
    && typeof item.evidenceFingerprint === 'string' && fingerprint.test(item.evidenceFingerprint)
    && typeof item.recoveryEpoch === 'number' && Number.isSafeInteger(item.recoveryEpoch) && item.recoveryEpoch >= 0
    && typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0 && item.updatedAt <= Date.now() + 5 * 60_000
    && (item.referenceTitle === undefined || (typeof item.referenceTitle === 'string' && item.referenceTitle.trim().length > 0 && item.referenceTitle.length <= 240))
    && (item.referenceUrl === undefined || (typeof item.referenceUrl === 'string' && item.referenceUrl.length <= 2_048 && /^https?:\/\//i.test(item.referenceUrl)))
    && (item.projectName === undefined || (typeof item.projectName === 'string' && item.projectName.trim().length > 0 && item.projectName.length <= 160))
    && (item.currentRevisionId === undefined || (typeof item.currentRevisionId === 'string' && /^rev-[a-z0-9-]{1,156}$/i.test(item.currentRevisionId)))
    && (item.revisionCount === undefined || (typeof item.revisionCount === 'number' && Number.isSafeInteger(item.revisionCount) && item.revisionCount >= 0 && item.revisionCount <= 20))
}

export function retainedPrototypeStudioRecoveryBindings(values: Iterable<unknown>): PrototypeStudioRecoveryBinding[] {
  const byProject = new Map<string, PrototypeStudioRecoveryBinding>()
  for (const value of values) {
    if (!validPrototypeStudioRecoveryBinding(value)) continue
    const existing = byProject.get(value.projectId)
    if (existing === undefined || value.updatedAt > existing.updatedAt) byProject.set(value.projectId, value)
  }
  return [...byProject.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.projectId.localeCompare(right.projectId))
    .slice(0, MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS)
}

export function storedPrototypeStudioRecoveries(value: unknown): StoredPrototypeStudioRecoveries {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { v: 1, projects: {} }
  const record = value as Partial<StoredPrototypeStudioRecoveries>
  if (record.v !== 1 || typeof record.projects !== 'object' || record.projects === null || Array.isArray(record.projects)) return { v: 1, projects: {} }
  const retained = retainedPrototypeStudioRecoveryBindings(Object.values(record.projects))
  return { v: 1, projects: Object.fromEntries(retained.map(item => [item.projectId, item])) }
}

export function validPrototypeStudioPendingRecovery(value: unknown, now = Date.now()): value is PrototypeStudioPendingRecovery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Partial<PrototypeStudioPendingRecovery>
  const required = ['projectId', 'referenceId', 'sessionId', 'evidenceFingerprint', 'expectedRecoveryEpoch', 'capability', 'createdAt', 'expiresAt', 'nonce']
  return Object.keys(item).every(key => required.includes(key)) && required.every(key => Object.hasOwn(item, key))
    && typeof item.projectId === 'string' && projectId.test(item.projectId)
    && typeof item.referenceId === 'string' && referenceId.test(item.referenceId)
    && typeof item.sessionId === 'string' && sessionId.test(item.sessionId)
    && typeof item.evidenceFingerprint === 'string' && fingerprint.test(item.evidenceFingerprint)
    && typeof item.expectedRecoveryEpoch === 'number' && Number.isSafeInteger(item.expectedRecoveryEpoch) && item.expectedRecoveryEpoch >= 0
    && typeof item.capability === 'string' && capability.test(item.capability)
    && typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt > now - PROTOTYPE_STUDIO_PENDING_RECOVERY_TTL_MS && item.createdAt <= now + 5 * 60_000
    && typeof item.expiresAt === 'number' && Number.isSafeInteger(item.expiresAt) && item.expiresAt > now && item.expiresAt >= item.createdAt && item.expiresAt <= item.createdAt + PROTOTYPE_STUDIO_PENDING_RECOVERY_TTL_MS
    && typeof item.nonce === 'string' && nonce.test(item.nonce)
}

export function retainedPrototypeStudioPendingRecoveries(values: Iterable<unknown>, now = Date.now()): PrototypeStudioPendingRecovery[] {
  const byProject = new Map<string, PrototypeStudioPendingRecovery>()
  for (const value of values) {
    if (!validPrototypeStudioPendingRecovery(value, now)) continue
    const existing = byProject.get(value.projectId)
    if (existing === undefined || value.createdAt > existing.createdAt) byProject.set(value.projectId, value)
  }
  return [...byProject.values()]
    .sort((left, right) => right.createdAt - left.createdAt || left.projectId.localeCompare(right.projectId))
    .slice(0, MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES)
}

export function storedPrototypeStudioPendingRecoveries(value: unknown, now = Date.now()): StoredPrototypeStudioPendingRecoveries {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { v: 1, projects: {} }
  const record = value as Partial<StoredPrototypeStudioPendingRecoveries>
  if (record.v !== 1 || typeof record.projects !== 'object' || record.projects === null || Array.isArray(record.projects)) return { v: 1, projects: {} }
  const retained = retainedPrototypeStudioPendingRecoveries(Object.values(record.projects), now)
  return { v: 1, projects: Object.fromEntries(retained.map(item => [item.projectId, item])) }
}
