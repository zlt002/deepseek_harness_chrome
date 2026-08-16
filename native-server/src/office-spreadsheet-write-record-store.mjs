import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATES = new Set(['pending', 'uncertain', 'verified'])
export function resolveOfficeSpreadsheetWriteStatePath(environment = process.env) {
  return join(environment.DSH_CONNECTOR_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Chrome', 'connector-state'), 'office-spreadsheet-write-records.json')
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function text(value, label) { if (typeof value !== 'string' || !value || value.length > 128) throw new TypeError(`${label} is required`); return value }
function normalize(input) { return { version: 1, idempotencyIdentity: text(input?.idempotencyIdentity, 'idempotencyIdentity'), targetFingerprint: text(input?.targetFingerprint, 'targetFingerprint'), resourceFingerprint: text(input?.resourceFingerprint, 'resourceFingerprint'), operation: text(input?.operation, 'operation'), payloadHash: text(input?.payloadHash, 'payloadHash'), state: STATES.has(input?.state) ? input.state : 'pending', createdAt: input?.createdAt ?? new Date().toISOString(), updatedAt: input?.updatedAt ?? new Date().toISOString() } }
function sameContract(left, right) { return left.targetFingerprint === right.targetFingerprint && left.resourceFingerprint === right.resourceFingerprint && left.operation === right.operation && left.payloadHash === right.payloadHash }

/** Body-free durable no-retry fence for spreadsheet mutations. */
export class OfficeSpreadsheetWriteRecordStore {
  constructor({ recordPath, now = () => new Date(), lockHooks } = {}) { this.recordPath = recordPath ?? resolveOfficeSpreadsheetWriteStatePath(); this.now = now; this.lockHooks = lockHooks; this.queue = Promise.resolve() }
  async #read() { try { return JSON.parse(await readFile(this.recordPath, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return { version: 1, writes: {} }; throw error } }
  async #write(data) { await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 }); const tmp = `${this.recordPath}.${process.pid}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 }); await chmod(tmp, 0o600); await rename(tmp, this.recordPath); await chmod(this.recordPath, 0o600) }
  #serial(work) { const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next }
  async #lockOwner(lock) { try { return (await readFile(lock, 'utf8')).trim() || null } catch { return null } }
  async #releaseLock(lock, token) { try { if (await this.#lockOwner(lock) === token) await rm(lock, { force: true }) } catch {} }
  async #quarantineStaleLock(lock) {
    let snapshot; try { snapshot = await stat(lock) } catch { return false }
    if (Date.now() - snapshot.mtimeMs <= 30_000) return false
    const owner = await this.#lockOwner(lock); const quarantine = `${lock}.stale.${randomUUID()}`
    try { await rename(lock, quarantine) } catch { return false }
    // Never remove a rebuilt lock: only dispose of the inode we renamed.
    // If ownership changed between inspection and rename, restore it when no
    // new claimant exists and let the normal retry path decide again.
    if (owner !== await this.#lockOwner(quarantine)) { try { await rename(quarantine, lock) } catch {}; return false }
    await rm(quarantine, { recursive: true, force: true }); return true
  }
  async #locked(work) {
    const lock = `${this.recordPath}.lock`; await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = randomUUID()
      try {
        await writeFile(lock, token, { flag: 'wx', mode: 0o600 }); await chmod(lock, 0o600)
        await this.lockHooks?.onClaim?.({ lock, token })
        // A stale claimant may wake after another writer safely took over.
        // It must not enter the critical section or release that new lock.
        if (await this.#lockOwner(lock) !== token) continue
        try { return await work() } finally { await this.#releaseLock(lock, token) }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        await this.#quarantineStaleLock(lock)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    throw new Error('office_spreadsheet_write_lock_timeout')
  }
  async create(input) { return this.#serial(() => this.#locked(async () => { const candidate = normalize(input); const data = await this.#read(); data.writes ??= {}; const existing = data.writes[candidate.idempotencyIdentity]; if (existing) { if (!sameContract(existing, candidate)) throw new Error('office_spreadsheet_write_conflict'); const record = existing.state === 'pending' ? normalize({ ...existing, state: 'uncertain', updatedAt: this.now().toISOString() }) : existing; if (record !== existing) { data.writes[candidate.idempotencyIdentity] = record; await this.#write(data) }; return { record: clone(record), createdNew: false } } data.writes[candidate.idempotencyIdentity] = candidate; await this.#write(data); return { record: clone(candidate), createdNew: true } })) }
  async setState(idempotencyIdentity, state) { return this.#serial(() => this.#locked(async () => { const data = await this.#read(); const current = data.writes?.[idempotencyIdentity]; if (!current || !STATES.has(state)) throw new Error('office_spreadsheet_write_not_found'); const record = normalize({ ...current, state, updatedAt: this.now().toISOString() }); data.writes[idempotencyIdentity] = record; await this.#write(data); return clone(record) })) }
}
