import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATES = new Set(['pending', 'uncertain', 'verified'])

export function resolveOfficeDocumentWriteStatePath(environment = process.env) {
  const root = environment.DSH_CONNECTOR_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Chrome', 'connector-state')
  return join(root, 'office-document-write-records.json')
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function nonEmpty(value, label, maximum = 128) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new TypeError(`${label} is required`)
  return value
}
function bodyFree(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(body|content|text|markdown|html|payload|observed)$/i.test(key)) throw new TypeError('office write checkpoint must not persist document content')
    bodyFree(child)
  }
}
function normalize(input) {
  bodyFree(input)
  return {
    version: 1,
    idempotencyIdentity: nonEmpty(input?.idempotencyIdentity, 'idempotencyIdentity'),
    targetFingerprint: nonEmpty(input?.targetFingerprint, 'targetFingerprint'),
    resourceFingerprint: nonEmpty(input?.resourceFingerprint, 'resourceFingerprint'),
    operation: nonEmpty(input?.operation, 'operation', 64),
    payloadHash: nonEmpty(input?.payloadHash, 'payloadHash'),
    state: STATES.has(input?.state) ? input.state : 'pending',
    createdAt: input?.createdAt ?? new Date().toISOString(),
    updatedAt: input?.updatedAt ?? new Date().toISOString(),
  }
}
function sameContract(left, right) {
  return left.targetFingerprint === right.targetFingerprint && left.resourceFingerprint === right.resourceFingerprint
    && left.operation === right.operation && left.payloadHash === right.payloadHash
}

/** Atomic, body-free uncertainty fence for non-repeatable light-document writes. */
export class OfficeDocumentWriteRecordStore {
  constructor({ recordPath, now = () => new Date() } = {}) { this.recordPath = recordPath ?? resolveOfficeDocumentWriteStatePath(); this.now = now; this.queue = Promise.resolve() }
  async #read() { try { return JSON.parse(await readFile(this.recordPath, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return { version: 1, writes: {} }; throw error } }
  async #write(data) {
    await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.recordPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, this.recordPath); await chmod(this.recordPath, 0o600)
  }
  #serial(work) { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next }
  async load(idempotencyIdentity) { const data = await this.#read(); const value = data.writes?.[idempotencyIdentity]; return value ? clone(value) : null }
  async create(input) {
    return this.#serial(async () => {
      const candidate = normalize(input); const data = await this.#read(); data.writes ??= {}; const existing = data.writes[candidate.idempotencyIdentity]
      if (existing) {
        if (!sameContract(existing, candidate)) throw new Error('office_document_write_conflict')
        // A pre-existing pending record may have crashed after mutation and
        // before the extension response. Treat it as uncertain, never retry.
        const record = existing.state === 'pending' ? normalize({ ...existing, state: 'uncertain', updatedAt: this.now().toISOString() }) : existing
        if (record !== existing) { data.writes[candidate.idempotencyIdentity] = record; await this.#write(data) }
        return { record: clone(record), createdNew: false }
      }
      data.writes[candidate.idempotencyIdentity] = candidate; await this.#write(data); return { record: clone(candidate), createdNew: true }
    })
  }
  async setState(idempotencyIdentity, state) {
    return this.#serial(async () => {
      const data = await this.#read(); const current = data.writes?.[idempotencyIdentity]
      if (!current || !STATES.has(state)) throw new Error('office_document_write_not_found')
      const next = normalize({ ...current, state, updatedAt: this.now().toISOString() }); data.writes[idempotencyIdentity] = next; await this.#write(data); return clone(next)
    })
  }
}
