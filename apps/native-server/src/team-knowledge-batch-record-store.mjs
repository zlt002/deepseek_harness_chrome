import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ACCRUI_CONNECTOR_STATE_DIRECTORY } from './product-runtime-identity.mjs'

const ITEM_STATUSES = ['pending', 'creating', 'created', 'failed']

export function resolveTeamKnowledgeBatchStatePath(environment = process.env) {
  const root = environment.ACCRUI_CONNECTOR_STATE_DIR
    || join(environment.HOME ?? '', 'Library', 'Application Support', 'accr-ui-harness', ACCRUI_CONNECTOR_STATE_DIRECTORY)
  return join(root, 'team-knowledge-batch-records.json')
}

function assertString(value, label, max = Infinity) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new TypeError(`${label} is required`)
  return value
}

function assertBodyFree(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(body|content|text|markdown|observedBody)$/i.test(key)) throw new TypeError('batch record must not persist document body')
    assertBodyFree(child)
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function normalizeItem(value, index) {
  assertBodyFree(value)
  const name = assertString(value?.name, `items[${index}].name`, 120)
  if (name !== name.trim()) throw new TypeError(`items[${index}].name must be canonical`)
  return {
    index,
    name,
    idempotencyIdentity: assertString(value?.idempotencyIdentity, `items[${index}].idempotencyIdentity`, 128),
    contentHash: assertString(value?.contentHash, `items[${index}].contentHash`, 128),
    status: ITEM_STATUSES.includes(value?.status) ? value.status : 'pending',
    catalogId: value?.catalogId == null ? null : assertString(value.catalogId, `items[${index}].catalogId`, 64),
    stages: Array.isArray(value?.stages) ? [...new Set(value.stages.map((stage) => assertString(stage, `items[${index}].stage`, 64)))] : [],
    error: value?.error == null ? null : String(value.error).slice(0, 1000),
  }
}

function normalizeRecord(value) {
  assertBodyFree(value)
  const items = value?.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) throw new TypeError('batch record requires 1 to 10 items')
  const normalized = items.map(normalizeItem)
  if (new Set(normalized.map((item) => item.name.normalize('NFKC'))).size !== normalized.length) throw new TypeError('batch item names must be unique')
  const created = normalized.filter((item) => item.status === 'created').length
  const status = created === normalized.length ? 'completed' : created > 0 ? 'partial' : normalized.some((item) => item.status === 'failed') ? 'failed' : normalized.some((item) => item.status === 'creating') ? 'creating' : 'pending'
  return {
    version: 1,
    batchId: assertString(value?.batchId, 'batchId', 128),
    targetFingerprint: assertString(value?.targetFingerprint, 'targetFingerprint', 128),
    contentFingerprint: assertString(value?.contentFingerprint, 'contentFingerprint', 128),
    status,
    items: normalized,
    createdAt: value?.createdAt ?? new Date().toISOString(),
    updatedAt: value?.updatedAt ?? new Date().toISOString(),
  }
}

function sameContract(left, right) {
  return left.targetFingerprint === right.targetFingerprint && left.contentFingerprint === right.contentFingerprint
    && left.items.length === right.items.length && left.items.every((item, index) => {
      const candidate = right.items[index]
      return item.name === candidate?.name && item.idempotencyIdentity === candidate?.idempotencyIdentity && item.contentHash === candidate?.contentHash
    })
}

/** Body-free, atomic recovery state for an ordered batch of one to ten light documents. */
export class TeamKnowledgeBatchRecordStore {
  constructor({ recordPath, now = () => new Date() } = {}) {
    this.recordPath = recordPath ?? resolveTeamKnowledgeBatchStatePath()
    this.now = now
    this.queue = Promise.resolve()
  }

  async #read() {
    try { return JSON.parse(await readFile(this.recordPath, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, batches: {} }
      throw error
    }
  }
  async #write(value) {
    await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.recordPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600); await rename(temporary, this.recordPath); await chmod(this.recordPath, 0o600)
  }
  #serial(work) { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next }

  async load(batchId) { const data = await this.#read(); const value = data.batches?.[batchId]; return value ? clone(value) : null }
  /** Return every unfinished batch item that owns this exact Team Knowledge catalog id. */
  async findIncompleteItemsByCatalogId(catalogId) {
    if (typeof catalogId !== 'string' || !/^\d+$/.test(catalogId)) return []
    const data = await this.#read()
    const matches = []
    for (const [batchId, value] of Object.entries(data.batches ?? {})) {
      const batch = normalizeRecord(value)
      if (batch.status === 'completed') continue
      for (const item of batch.items) {
        if (item.catalogId === catalogId) matches.push({ batchId, batchStatus: batch.status, item })
      }
    }
    return clone(matches)
  }
  async create(input) {
    return this.#serial(async () => {
      const candidate = normalizeRecord(input); const data = await this.#read(); data.batches ??= {}
      const existing = data.batches[candidate.batchId]
      if (existing) { if (!sameContract(existing, candidate)) throw new Error('team_knowledge_batch_conflict'); return clone(existing) }
      data.batches[candidate.batchId] = candidate; await this.#write(data); return clone(candidate)
    })
  }
  async updateItem({ batchId, index, ...patch }) {
    return this.#serial(async () => {
      const data = await this.#read(); const current = data.batches?.[batchId]
      if (!current || !Number.isInteger(index) || !current.items[index]) throw new Error('team_knowledge_batch_not_found')
      const items = current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)
      const next = normalizeRecord({ ...current, items, updatedAt: this.now().toISOString() })
      data.batches[batchId] = next; await this.#write(data); return clone(next)
    })
  }
}
