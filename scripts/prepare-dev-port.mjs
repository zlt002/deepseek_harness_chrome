import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = 3101

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received ${JSON.stringify(value)}`)
  }
  return parsed
}

async function listenerPids() {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ], { encoding: 'utf8' })
    return parsePids(stdout)
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? '').trim()) return []
    throw new Error(`Unable to inspect listeners on port ${port}: ${error.message}`)
  }
}

function parsePids(output) {
  const lines = output.trim() === '' ? [] : output.trim().split(/\s+/)
  const pids = new Set()
  for (const value of lines) {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`Unable to resolve listeners on port ${port}: invalid PID ${JSON.stringify(value)}`)
    }
    pids.add(value)
  }
  return [...pids]
}

async function signal(pids, signalName) {
  for (const pid of pids) {
    try {
      await execFileAsync('kill', [signalName, pid], { encoding: 'utf8' })
    } catch (error) {
      console.warn(`Could not send ${signalName} to PID ${pid}: ${error.message}`)
    }
  }
}

async function waitForRelease(waitMs, pollMs) {
  const deadline = Date.now() + waitMs
  let pids = await listenerPids()
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    pids = await listenerPids()
  }
  return pids
}

async function main() {
  const waitMs = positiveInteger(process.env.DEV_PORT_WAIT_MS, 1_000)
  const pollMs = positiveInteger(process.env.DEV_PORT_POLL_MS, 50)
  const initialPids = await listenerPids()
  if (initialPids.length === 0) {
    console.log(`Port ${port} is available.`)
    return
  }

  console.log(`Releasing port ${port} from listener PID(s): ${initialPids.join(', ')}`)
  await signal(initialPids, '-TERM')
  let remainingPids = await waitForRelease(waitMs, pollMs)

  if (remainingPids.length > 0) {
    console.warn(`Port ${port} is still occupied; sending KILL to PID(s): ${remainingPids.join(', ')}`)
    await signal(remainingPids, '-KILL')
    remainingPids = await waitForRelease(waitMs, pollMs)
  }

  if (remainingPids.length > 0) {
    throw new Error(`Port ${port} remains occupied after TERM and KILL: ${remainingPids.join(', ')}`)
  }

  console.log(`Released port ${port}.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
