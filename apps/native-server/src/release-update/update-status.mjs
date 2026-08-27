import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const UPDATE_STATUS_FILE = '.accrui-update-status.json'

function validStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!['pending', 'succeeded', 'failed'].includes(value.state)) return false
  if (typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) return false
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return false
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 2_048)) return false
  return value.logPath === undefined || (typeof value.logPath === 'string' && value.logPath.length <= 1_024)
}

/** Read the detached Windows updater result without letting a stale file break update checks. */
export async function readUpdateStatus(installRoot, { readFileImpl = readFile } = {}) {
  if (typeof installRoot !== 'string' || installRoot.trim() === '') return undefined
  try {
    const status = JSON.parse(await readFileImpl(resolve(installRoot, UPDATE_STATUS_FILE), 'utf8'))
    if (!validStatus(status)) return undefined
    return Object.freeze({
      state: status.state,
      version: status.version,
      updatedAt: status.updatedAt,
      ...(status.error === undefined ? {} : { error: status.error }),
      ...(status.logPath === undefined ? {} : { logPath: status.logPath }),
    })
  } catch {
    return undefined
  }
}
