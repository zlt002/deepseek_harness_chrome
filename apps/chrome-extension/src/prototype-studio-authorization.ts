/**
 * Short-lived, opaque grants that let the extension page ask the Native Host
 * for one Prototype Studio project.  These records deliberately live in
 * chrome.storage.session (rather than local storage): MV3 may restart the
 * Service Worker, but a browser restart must drop the capability.
 */
export const PROTOTYPE_STUDIO_AUTHORIZATION_STORAGE_KEY = 'harnessPrototypeStudioAuthorizationsV1'
export const MAX_OPEN_PROTOTYPE_STUDIOS = 8
export const PROTOTYPE_STUDIO_AUTHORIZATION_TTL_MS = 12 * 60 * 60_000

export interface PrototypeStudioAuthorization {
  projectId: string
  referenceId: string
  sessionId: string
  capability: string
  openedAt: number
}

export interface StoredPrototypeStudioAuthorizations {
  v: 1
  authorizations: Record<string, PrototypeStudioAuthorization>
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const projectId = new RegExp(`^prototype-${uuid}$`, 'i')
const referenceId = new RegExp(`^ref-${uuid}$`, 'i')
const capability = new RegExp(`^${uuid}${uuid}$`, 'i')
const sessionId = /^[A-Za-z0-9._:-]{1,160}$/

export function validPrototypeStudioAuthorization(value: unknown, now = Date.now()): value is PrototypeStudioAuthorization {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Partial<PrototypeStudioAuthorization>
  const openedAt = item.openedAt
  return typeof item.projectId === 'string' && projectId.test(item.projectId)
    && typeof item.referenceId === 'string' && referenceId.test(item.referenceId)
    && typeof item.sessionId === 'string' && sessionId.test(item.sessionId)
    && typeof item.capability === 'string' && capability.test(item.capability)
    && typeof openedAt === 'number' && Number.isSafeInteger(openedAt) && openedAt > now - PROTOTYPE_STUDIO_AUTHORIZATION_TTL_MS
    && openedAt <= now + 5 * 60_000
}

export function retainedPrototypeStudioAuthorizations(values: Iterable<unknown>, now = Date.now()): PrototypeStudioAuthorization[] {
  const byProjectId = new Map<string, PrototypeStudioAuthorization>()
  for (const value of values) {
    if (!validPrototypeStudioAuthorization(value, now)) continue
    const item = value as PrototypeStudioAuthorization
    const existing = byProjectId.get(item.projectId)
    if (existing === undefined || item.openedAt > existing.openedAt) byProjectId.set(item.projectId, item)
  }
  return [...byProjectId.values()]
    .sort((left, right) => right.openedAt - left.openedAt || left.projectId.localeCompare(right.projectId))
    .slice(0, MAX_OPEN_PROTOTYPE_STUDIOS)
}

export function storedPrototypeStudioAuthorizations(value: unknown, now = Date.now()): StoredPrototypeStudioAuthorizations {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { v: 1, authorizations: {} }
  const record = value as Partial<StoredPrototypeStudioAuthorizations>
  if (record.v !== 1 || typeof record.authorizations !== 'object' || record.authorizations === null || Array.isArray(record.authorizations)) return { v: 1, authorizations: {} }
  const retained = retainedPrototypeStudioAuthorizations(Object.values(record.authorizations), now)
  return { v: 1, authorizations: Object.fromEntries(retained.map(item => [item.projectId, item])) }
}
