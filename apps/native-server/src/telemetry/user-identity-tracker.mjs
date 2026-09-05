import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname, homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_EFFECTIVE_SESSION_ENDPOINT = 'http://10.27.15.64:8793/api/tracking/effective-sessions'
const MAX_ATTEMPTS = 12

function text(value, maxLength) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined
}

function identityEndpoint(environment) {
  const explicit = text(environment.ACCR_TRACKING_USER_IDENTITY_ENDPOINT, 2_048)
  if (explicit) return explicit
  const effective = text(environment.ACCR_TRACKING_ENDPOINT, 2_048) ?? DEFAULT_EFFECTIVE_SESSION_ENDPOINT
  const url = new URL(effective)
  url.pathname = '/api/tracking/user-identities'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function outboxPath(environment) {
  const explicit = text(environment.ACCR_TRACKING_USER_IDENTITY_OUTBOX_PATH, 4_096)
  if (explicit) return resolve(explicit)
  const root = text(environment.ACCRUI_CONNECTOR_STATE_DIR, 4_096)
    ?? join(environment.HOME?.trim() || homedir(), 'Library', 'Application Support', 'accr-ui-harness', 'connector-state-v1')
  return join(root, 'user-identity-outbox.json')
}

function trackingIdentityPath(environment) {
  const explicit = text(environment.ACCR_TRACKING_IDENTITY_PATH, 4_096)
  return explicit ? resolve(explicit) : resolve(text(environment.DSH_HOME, 4_096) || join(environment.HOME?.trim() || homedir(), '.dsh'), 'tracking-device.json')
}

function deviceName() {
  try {
    const username = text(userInfo().username, 256)
    if (username) return username
  } catch {
    // Fall through to the machine hostname.
  }
  return text(hostname(), 256)
}

async function readOrCreateInstallationId(environment) {
  const path = trackingIdentityPath(environment)
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'))
    const existing = text(stored?.deviceInstallationId, 256)
    if (existing) return existing
  } catch {
    // Use the same recoverable identity behavior as session tracking.
  }
  const deviceInstallationId = randomUUID()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ deviceInstallationId }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  return deviceInstallationId
}

export function normalizeUserIdentityObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).some(key => !['userCode', 'employeeId', 'observedAt'].includes(key))) return undefined
  const userCode = text(value.userCode, 64)
  const employeeId = text(String(value.employeeId ?? ''), 32)
  const observedAt = text(value.observedAt, 64) ?? new Date().toISOString()
  if (!userCode || !/^[A-Za-z0-9._-]+$/.test(userCode) || !employeeId || !/^\d+$/.test(employeeId) || Number.isNaN(Date.parse(observedAt))) return undefined
  return Object.freeze({ userCode, employeeId, observedAt: new Date(observedAt).toISOString() })
}

async function loadOutbox(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(-100) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function saveOutbox(path, entries) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function retryDelay(attempts) {
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.min(attempts, 9)))
}

export class UserIdentityTracker {
  constructor(options = {}) {
    this.environment = options.environment ?? process.env
    this.fetch = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.endpoint = options.endpoint ?? identityEndpoint(this.environment)
    this.apiKey = options.apiKey ?? text(this.environment.ACCR_TRACKING_API_KEY, 1_024)
    this.outboxPath = options.outboxPath ?? outboxPath(this.environment)
    this.productVersion = text(options.productVersion ?? this.environment.ACCR_PRODUCT_VERSION, 128)
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.queue = Promise.resolve()
    this.retryTimer = undefined
    this.stopped = false
  }

  setProductVersion(value) {
    this.productVersion = text(value, 128)
    void this.flush()
  }

  start() { void this.flush() }

  stop() {
    this.stopped = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  report(value) {
    const observation = normalizeUserIdentityObservation(value)
    if (!observation || text(this.environment.ACCR_TRACKING_DISABLED, 32)) return Promise.resolve(false)
    return this.#serialize(async () => {
      const entries = await loadOutbox(this.outboxPath)
      const entry = { observation, attempts: 0, nextAttemptAt: this.now() }
      const index = entries.findIndex(item => item?.observation?.userCode === observation.userCode)
      if (index >= 0) entries[index] = entry
      else entries.push(entry)
      await saveOutbox(this.outboxPath, entries.slice(-100))
      await this.#flushUnlocked()
      return true
    })
  }

  flush() { return this.#serialize(() => this.#flushUnlocked()) }

  #serialize(work) {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  async #flushUnlocked() {
    if (this.stopped || !this.productVersion || text(this.environment.ACCR_TRACKING_DISABLED, 32)) return false
    const entries = await loadOutbox(this.outboxPath)
    if (entries.length === 0) return true
    const deviceInstallationId = await readOrCreateInstallationId(this.environment)
    const currentDeviceName = deviceName()
    const retained = []
    const now = this.now()
    for (const item of entries) {
      if (!item?.observation || item.nextAttemptAt > now || item.attempts >= MAX_ATTEMPTS) { retained.push(item); continue }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
          signal: controller.signal,
          body: JSON.stringify({
            ...item.observation,
            deviceInstallationId,
            ...(currentDeviceName ? { deviceName: currentDeviceName } : {}),
            productVersion: this.productVersion,
            source: 'knowledge_login',
          }),
        })
        if (!response?.ok) throw new Error(`tracking_http_${String(response?.status)}`)
      } catch {
        const attempts = Number.isSafeInteger(item.attempts) ? item.attempts + 1 : 1
        retained.push({ ...item, attempts, nextAttemptAt: now + retryDelay(attempts) })
      } finally {
        clearTimeout(timeout)
      }
    }
    await saveOutbox(this.outboxPath, retained)
    this.#schedule(retained)
    return retained.length === 0
  }

  #schedule(entries) {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.stopped || !this.productVersion) return
    const next = Math.min(...entries.filter(item => item.attempts < MAX_ATTEMPTS).map(item => item.nextAttemptAt))
    if (!Number.isFinite(next)) return
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush() }, Math.max(0, next - this.now()))
    this.retryTimer.unref?.()
  }
}
