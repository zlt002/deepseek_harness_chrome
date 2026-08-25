/**
 * Non-secret recovery bindings for persisted Prototype Studio projects.
 * The short-lived capability never enters chrome.storage.local. A binding is
 * only enough for Native Host to sign an exact, user-triggered recovery.
 */
export const PROTOTYPE_STUDIO_RECOVERY_STORAGE_KEY = 'harnessPrototypeStudioRecoveriesV1'
export const MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS = 50

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
}

export interface StoredPrototypeStudioRecoveries {
  v: 1
  projects: Record<string, PrototypeStudioRecoveryBinding>
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const projectId = new RegExp(`^prototype-${uuid}$`, 'i')
const referenceId = new RegExp(`^ref-${uuid}$`, 'i')
const sessionId = /^[A-Za-z0-9._:-]{1,160}$/
const fingerprint = /^[0-9a-f]{64}$/

export function validPrototypeStudioRecoveryBinding(value: unknown): value is PrototypeStudioRecoveryBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Partial<PrototypeStudioRecoveryBinding>
  const required = ['projectId', 'referenceId', 'sessionId', 'evidenceFingerprint', 'recoveryEpoch', 'updatedAt']
  const allowed = [...required, 'referenceTitle', 'referenceUrl']
  return Object.keys(item).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(item, key))
    && typeof item.projectId === 'string' && projectId.test(item.projectId)
    && typeof item.referenceId === 'string' && referenceId.test(item.referenceId)
    && typeof item.sessionId === 'string' && sessionId.test(item.sessionId)
    && typeof item.evidenceFingerprint === 'string' && fingerprint.test(item.evidenceFingerprint)
    && typeof item.recoveryEpoch === 'number' && Number.isSafeInteger(item.recoveryEpoch) && item.recoveryEpoch >= 0
    && typeof item.updatedAt === 'number' && Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0 && item.updatedAt <= Date.now() + 5 * 60_000
    && (item.referenceTitle === undefined || (typeof item.referenceTitle === 'string' && item.referenceTitle.trim().length > 0 && item.referenceTitle.length <= 240))
    && (item.referenceUrl === undefined || (typeof item.referenceUrl === 'string' && item.referenceUrl.length <= 2_048 && /^https?:\/\//i.test(item.referenceUrl)))
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
