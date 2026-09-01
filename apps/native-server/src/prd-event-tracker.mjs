import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_EFFECTIVE_SESSION_ENDPOINT = 'http://10.27.15.64:8793/api/tracking/effective-sessions'
const DEFAULT_TRACKING_API_KEY = '4c688737784096b395936f4174aa7694fcaa173d3d70cc33'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_OUTBOX_EVENTS = 1_000
const MAX_ATTEMPTS = 12

const EVENT_TYPES = new Set(['review_generated', 'review_action', 'prd_rating', 'document_published'])
const REVIEW_ACTIONS = new Set(['rewrite', 'accept'])
const OUTCOMES = new Set(['succeeded', 'failed', 'timeout'])
const REVIEW_STATUSES = new Set(['draft_ready', 'queued', 'processing'])

function text(value, maxLength) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined
}

function eventEndpoint(environment) {
  const explicit = text(environment.ACCR_TRACKING_PRD_ENDPOINT, 2_048)
  if (explicit) return explicit
  const effective = text(environment.ACCR_TRACKING_ENDPOINT, 2_048) ?? DEFAULT_EFFECTIVE_SESSION_ENDPOINT
  const url = new URL(effective)
  url.pathname = '/api/tracking/prd-events'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function resolvePrdTrackingOutboxPath(environment = process.env) {
  const explicit = text(environment.ACCR_TRACKING_PRD_OUTBOX_PATH, 4_096)
  if (explicit) return resolve(explicit)
  const root = text(environment.ACCRUI_CONNECTOR_STATE_DIR, 4_096)
    ?? join(environment.HOME?.trim() || homedir(), 'Library', 'Application Support', 'accr-ui-harness', 'connector-state-v1')
  return join(root, 'prd-tracking-outbox.json')
}

export function normalizePrdTrackingEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (['body', 'content', 'userInput', 'comment', 'rewriteReason'].some(field => Object.hasOwn(value, field))) return undefined
  const eventId = text(value.eventId, 200)
  const rawEventType = text(value.eventType, 64)
  const rawOutcome = text(value.outcome, 32)
  const occurredAt = text(value.occurredAt, 64) ?? new Date().toISOString()
  const sessionId = text(value.sessionId, 200)
  const runId = text(value.runId, 200)
  const action = text(value.action, 32)
  const status = text(value.status, 64)
  const generationEventId = text(value.generationEventId, 200)
  const rating = typeof value.rating === 'number' && [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].includes(value.rating) ? value.rating : undefined
  const batchId = text(value.batchId, 100)
  const itemIndex = Number.isSafeInteger(value.itemIndex) && value.itemIndex >= 0 && value.itemIndex <= 100 ? value.itemIndex : undefined
  const documentName = text(value.documentName ?? value.name, 256)
  const documentCatalogId = text(value.documentCatalogId ?? value.catalogId, 256)
  const documentUrl = text(value.documentUrl ?? value.url, 2_048)
  const eventType = rawEventType === 'review_generated' ? 'prd_generated'
    : rawEventType === 'review_action' && action === 'rewrite' ? 'markdown_review_rewrite'
    : rawEventType === 'review_action' && action === 'accept' ? 'markdown_review_accept'
      : rawEventType === 'document_published' ? 'online_document_verified_write' : rawEventType
  const outcome = rawOutcome === 'succeeded' ? 'success' : rawOutcome === 'failed' ? 'failure' : rawOutcome
  if (!eventId || !eventType || !['prd_generated', 'markdown_review_rewrite', 'markdown_review_accept', 'prd_rating', 'online_document_verified_write'].includes(eventType) || !outcome || !['success', 'failure', 'timeout'].includes(outcome) || Number.isNaN(Date.parse(occurredAt))) return undefined
  if ((eventType === 'prd_generated' || eventType === 'markdown_review_rewrite' || eventType === 'markdown_review_accept' || eventType === 'prd_rating') && !sessionId) return undefined
  if (eventType === 'prd_generated' && outcome !== 'success') return undefined
  if (eventType === 'prd_rating' && (outcome !== 'success' || generationEventId === undefined || rating === undefined)) return undefined
  if (eventType === 'online_document_verified_write' && (outcome !== 'success' || !runId || !documentName || !documentCatalogId || !documentUrl)) return undefined
  const validStatus = status === undefined
    || (eventType === 'markdown_review_rewrite' && outcome === 'success' && status === 'draft_ready')
    || (eventType === 'markdown_review_accept' && outcome === 'success' && REVIEW_STATUSES.has(status) && status !== 'draft_ready')
  if (!validStatus) return undefined
  return Object.freeze({
    eventId,
    eventType,
    outcome,
    occurredAt: new Date(occurredAt).toISOString(),
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(status ? { status } : {}),
    ...(eventType === 'prd_generated' && documentName ? { name: documentName } : {}),
    ...(eventType === 'prd_rating' ? { generationEventId, rating } : {}),
    ...(eventType === 'online_document_verified_write' ? {
      ...(generationEventId === undefined ? {} : { generationEventId }),
      name: documentName, catalogId: documentCatalogId, url: documentUrl,
    } : {}),
  })
}

async function readOrCreateInstallationId(environment) {
  const configured = text(environment.ACCR_TRACKING_IDENTITY_PATH, 4_096)
  const dshHome = text(environment.DSH_HOME, 4_096)
  const path = configured ? resolve(configured) : resolve(dshHome || join(environment.HOME?.trim() || homedir(), '.dsh'), 'tracking-device.json')
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'))
    const existing = text(stored?.deviceInstallationId, 200)
    if (existing) return existing
  } catch {
    // Create the same identity file used by effective-session tracking.
  }
  const deviceInstallationId = randomUUID()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify({ deviceInstallationId }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  return deviceInstallationId
}

async function loadOutbox(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    // Do not trim here. A full outbox must retain every previously accepted
    // event; report() rejects only new unique events once the capacity is
    // reached, and flush() may drain an over-capacity outbox created by an
    // older version without silently deleting its head.
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function saveOutbox(path, events) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function retryDelay(attempts) {
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.min(attempts, 9)))
}

export class PrdEventTracker {
  constructor(options = {}) {
    this.environment = options.environment ?? process.env
    this.fetch = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.endpoint = options.endpoint ?? eventEndpoint(this.environment)
    this.apiKey = options.apiKey ?? text(this.environment.ACCR_TRACKING_API_KEY, 1_024) ?? DEFAULT_TRACKING_API_KEY
    this.outboxPath = options.outboxPath ?? resolvePrdTrackingOutboxPath(this.environment)
    this.productVersion = text(options.productVersion ?? this.environment.ACCR_PRODUCT_VERSION, 128)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.queue = Promise.resolve()
    this.retryTimer = undefined
    this.stopped = false
  }

  setProductVersion(value) { this.productVersion = text(value, 128) }

  start() { void this.flush() }

  stop() {
    this.stopped = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  report(value) {
    const normalizedEvent = normalizePrdTrackingEvent(value)
    if (!normalizedEvent || !this.productVersion || text(this.environment.ACCR_TRACKING_DISABLED, 32)) return Promise.resolve(false)
    const event = Object.freeze({
      ...normalizedEvent,
      productVersion: this.productVersion,
      skillName: 'pmd-prd',
    })
    return this.#serialize(async () => {
      const events = await loadOutbox(this.outboxPath)
      const entry = { event, attempts: 0, nextAttemptAt: this.now() }
      const index = events.findIndex(item => item?.event?.eventId === event.eventId)
      if (index >= 0) {
        // Re-reporting the same eventId is idempotent with respect to queue
        // capacity: refresh the existing entry without adding another item.
        events[index] = entry
      } else {
        // Preserve the durable queue's existing contents. In particular,
        // never ACK a new event after silently evicting an older one.
        if (events.length >= MAX_OUTBOX_EVENTS) return false
        events.push(entry)
      }
      await saveOutbox(this.outboxPath, events)
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
    if (this.stopped || text(this.environment.ACCR_TRACKING_DISABLED, 32)) return false
    const events = await loadOutbox(this.outboxPath)
    if (events.length === 0) return true
    const installationId = await readOrCreateInstallationId(this.environment)
    const retained = []
    const now = this.now()
    for (const item of events) {
      if (!item?.event || item.nextAttemptAt > now || item.attempts >= MAX_ATTEMPTS) { retained.push(item); continue }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
          signal: controller.signal,
          body: JSON.stringify({
            ...item.event,
            deviceInstallationId: installationId,
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

  #schedule(events) {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.stopped) return
    const next = Math.min(...events.filter(item => item.attempts < MAX_ATTEMPTS).map(item => item.nextAttemptAt))
    if (!Number.isFinite(next)) return
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush() }, Math.max(0, next - this.now()))
    this.retryTimer.unref?.()
  }
}
