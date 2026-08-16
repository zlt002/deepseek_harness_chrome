import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DOCUMENT_BODY_KEYS = /^(body|content|text|markdown|observedBody)$/i

function bodyFreeClone(value) {
  if (Array.isArray(value)) return value.map(bodyFreeClone)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !DOCUMENT_BODY_KEYS.test(key))
    .map(([key, child]) => [key, bodyFreeClone(child)]))
}

export function resolveTeamDocStatePath(environment = process.env) {
  const root = environment.DSH_CONNECTOR_STATE_DIR
    || join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Chrome', 'connector-state')
  return join(root, 'team-doc-delivery-records.json')
}

/** A small, body-free, atomic recovery record store. Callers must supply an explicit private path. */
export class TeamDocRecordStore {
  constructor({ recordPath } = {}) {
    this.recordPath = recordPath ?? resolveTeamDocStatePath()
    this.queue = Promise.resolve()
  }
  async load(identity) {
    try {
      const records = JSON.parse(await readFile(this.recordPath, 'utf8'))
      return records[identity] ?? null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  async save(record) {
    const write = async () => {
      await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 })
      let records = {}
      try { records = JSON.parse(await readFile(this.recordPath, 'utf8')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      records[record.idempotencyIdentity] = bodyFreeClone(record)
      const temporary = `${this.recordPath}.${process.pid}.${crypto.randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.recordPath)
      await chmod(this.recordPath, 0o600)
    }
    const work = this.queue.then(write, write)
    this.queue = work.then(() => undefined, () => undefined)
    return work
  }
}
