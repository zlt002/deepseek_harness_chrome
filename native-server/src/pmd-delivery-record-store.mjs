import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const KINDS = ['analysis', 'prd']
const STATUSES = ['pending', 'creating', 'created', 'failed']

export function resolvePmdDeliveryStatePath(environment = process.env) {
  const root = environment.DSH_CONNECTOR_STATE_DIR
    || join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Chrome', 'connector-state')
  return join(root, 'pmd-prd-delivery-records.json')
}

function keyOf(requirementId, deliveryRunId) {
  return JSON.stringify([String(requirementId).trim(), String(deliveryRunId).trim()])
}

function assertIdentity(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`)
  return value.trim()
}

function assertBodyFree(value) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(body|content|text|markdown)$/i.test(key)) throw new TypeError('delivery record must not persist document body')
      assertBodyFree(child)
    }
  }
}

function normalizeItem(item, kind) {
  if (!item || typeof item !== 'object') throw new TypeError(`document ${kind} is required`)
  assertBodyFree(item)
  return {
    kind,
    name: assertIdentity(item.name, `${kind}.name`),
    idempotencyIdentity: assertIdentity(item.idempotencyIdentity, `${kind}.idempotencyIdentity`),
    status: STATUSES.includes(item.status) ? item.status : 'pending',
    catalogId: item.catalogId == null ? null : assertIdentity(item.catalogId, `${kind}.catalogId`),
    contentHash: assertIdentity(item.contentHash, `${kind}.contentHash`),
    stages: Array.isArray(item.stages) ? [...new Set(item.stages.map((stage) => assertIdentity(stage, `${kind}.stage`)))] : [],
    error: item.error == null ? null : String(item.error),
  }
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object') throw new TypeError('delivery record is required')
  assertBodyFree(input)
  const requirementId = assertIdentity(input.requirementId, 'requirementId')
  const deliveryRunId = assertIdentity(input.deliveryRunId, 'deliveryRunId')
  if (!input.targetFingerprint || !input.contentFingerprint) throw new TypeError('delivery fingerprints are required')
  if (!Array.isArray(input.documents) || input.documents.length !== 2) throw new TypeError('delivery record requires exactly two documents')
  const byKind = new Map(input.documents.map((item) => [item?.kind, item]))
  if (KINDS.some((kind) => !byKind.has(kind))) throw new TypeError('delivery record requires analysis and prd documents')
  return {
    version: 1,
    requirementId,
    deliveryRunId,
    targetFingerprint: assertIdentity(input.targetFingerprint, 'targetFingerprint'),
    contentFingerprint: assertIdentity(input.contentFingerprint, 'contentFingerprint'),
    status: ['pending', 'creating', 'partial', 'completed', 'failed', 'paused'].includes(input.status) ? input.status : 'pending',
    documents: KINDS.map((kind) => normalizeItem(byKind.get(kind), kind)),
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sameRunContract(left, right) {
  if (left.targetFingerprint !== right.targetFingerprint || left.contentFingerprint !== right.contentFingerprint) return false
  return KINDS.every((kind) => {
    const a = left.documents.find((item) => item.kind === kind)
    const b = right.documents.find((item) => item.kind === kind)
    return a?.name === b?.name && a?.idempotencyIdentity === b?.idempotencyIdentity && a?.contentHash === b?.contentHash
  })
}

/** Body-free, atomic state for a two-document pmd-prd delivery run. */
export class PmdDeliveryRecordStore {
  constructor({ recordPath, now = () => new Date() } = {}) {
    this.recordPath = assertIdentity(recordPath ?? resolvePmdDeliveryStatePath(), 'recordPath')
    this.now = now
    this.queue = Promise.resolve()
  }

  async #read() {
    try { return JSON.parse(await readFile(this.recordPath, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, runs: {} }
      throw error
    }
  }

  async #atomicWrite(value) {
    await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.recordPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.recordPath)
    await chmod(this.recordPath, 0o600)
  }

  #serialize(work) {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  async load(requirementId, deliveryRunId) {
    const data = await this.#read()
    const record = data.runs?.[keyOf(requirementId, deliveryRunId)]
    return record ? clone(record) : null
  }

  async create(input) {
    return this.#serialize(async () => {
      const candidate = normalizeRecord(input)
      const data = await this.#read()
      const key = keyOf(candidate.requirementId, candidate.deliveryRunId)
      if (data.runs?.[key]) {
        if (!sameRunContract(data.runs[key], candidate)) throw new Error('pmd_delivery_run_conflict')
        return clone(data.runs[key])
      }
      const record = candidate
      data.runs ??= {}
      data.runs[key] = record
      await this.#atomicWrite(data)
      return clone(record)
    })
  }

  async update(input) {
    return this.#serialize(async () => {
      const data = await this.#read()
      const key = keyOf(input.requirementId, input.deliveryRunId)
      if (!data.runs?.[key]) throw new Error('pmd_delivery_run_not_found')
      const current = data.runs[key]
      const next = normalizeRecord({ ...current, ...input, documents: input.documents ?? current.documents, updatedAt: this.now().toISOString() })
      data.runs[key] = next
      await this.#atomicWrite(data)
      return clone(next)
    })
  }

  async updateItem({ requirementId, deliveryRunId, kind, ...patch }) {
    if (!KINDS.includes(kind)) throw new TypeError('kind must be analysis or prd')
    return this.#serialize(async () => {
      const data = await this.#read()
      const key = keyOf(requirementId, deliveryRunId)
      const current = data.runs?.[key]
      if (!current) throw new Error('pmd_delivery_run_not_found')
      const documents = current.documents.map((item) => item.kind === kind ? { ...item, ...patch } : item)
      const created = documents.filter((item) => item.status === 'created').length
      const status = created === 2 ? 'completed' : created === 1 ? 'partial' : documents.some((item) => item.status === 'failed') ? 'failed' : 'creating'
      const next = normalizeRecord({ ...current, status, documents, updatedAt: this.now().toISOString() })
      data.runs[key] = next
      await this.#atomicWrite(data)
      return clone(next)
    })
  }

  async unfinished(requirementId, deliveryRunId) {
    const record = await this.load(requirementId, deliveryRunId)
    return record ? record.documents.filter((item) => item.status !== 'created').map(clone) : []
  }
}

export { KINDS as PMD_DELIVERY_KINDS }
