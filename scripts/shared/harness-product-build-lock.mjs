import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const LOCK_NAME = '.harness-product-build.lock'

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function owner(lockPath) {
  try {
    return JSON.parse(await readFile(resolve(lockPath, 'owner.json'), 'utf8'))
  } catch {
    return undefined
  }
}

export async function acquireHarnessProductBuildLock(generatedRoot, pid = process.pid) {
  const lockPath = resolve(generatedRoot, LOCK_NAME)
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath)
      await writeFile(resolve(lockPath, 'owner.json'), `${JSON.stringify({ pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8')
      return {
        async release() {
          const current = await owner(lockPath)
          if (current?.token === token) await rm(lockPath, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const current = await owner(lockPath)
      if (processExists(current?.pid)) {
        throw new Error(`Harness product build is already running (PID ${String(current.pid)}). Wait for it to finish before running dev:refresh or build:harness-product again.`)
      }
      await rm(lockPath, { recursive: true, force: true })
    }
  }
  throw new Error('Unable to acquire the Harness product build lock.')
}
