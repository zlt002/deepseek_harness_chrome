import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = 3101
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, received ${JSON.stringify(value)}`)
  return parsed
}

export function parsePids(output) {
  const lines = output.trim() === '' ? [] : output.trim().split(/\s+/)
  const pids = new Set()
  for (const value of lines) {
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Unable to resolve listeners on port ${port}: invalid PID ${JSON.stringify(value)}`)
    pids.add(value)
  }
  return [...pids]
}

async function listenerPids() {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    return parsePids(stdout)
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? '').trim()) return []
    throw new Error(`Unable to inspect listeners on port ${port}: ${error.message}`)
  }
}

export function listenerBelongsToProject({ command, cwd }, root = projectRoot) {
  const normalizedRoot = resolve(root).replaceAll('\\', '/')
  const extensionRoot = `${normalizedRoot}/apps/chrome-extension/`
  const normalizedCommand = typeof command === 'string' ? command.replaceAll('\\', '/') : command
  const normalizedCwd = typeof cwd === 'string' ? resolve(cwd).replaceAll('\\', '/') : cwd
  return typeof normalizedCommand === 'string'
    && normalizedCommand.includes(extensionRoot)
    && /(?:^|\/)wxt(?:\.mjs)?(?:\s|$)/.test(normalizedCommand)
    && (normalizedCwd === undefined || normalizedCwd === `${normalizedRoot}/apps/chrome-extension` || normalizedCwd.startsWith(extensionRoot))
}

async function listenerIdentity(pid) {
  const [{ stdout: command }, { stdout: cwdOutput }] = await Promise.all([
    execFileAsync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }),
    execFileAsync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }),
  ])
  const cwd = cwdOutput.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1)
  return { command: command.trim(), cwd }
}

export async function assertOwnedListeners(pids, inspect = listenerIdentity) {
  const identities = await Promise.all(pids.map(async (pid) => ({ pid, ...await inspect(pid) })))
  const external = identities.filter((identity) => !listenerBelongsToProject(identity))
  if (external.length > 0) {
    const details = external.map(({ pid, cwd }) => `${pid} (${cwd ?? 'unknown cwd'})`).join('; ')
    throw new Error(`Port ${port} is occupied by a listener not proven to belong to this repository; it was left running: ${details}`)
  }
  return identities
}

async function signal(pids, signalName) {
  for (const pid of pids) {
    try { await execFileAsync('kill', [signalName, pid], { encoding: 'utf8' }) } catch (error) { console.warn(`Could not send ${signalName} to PID ${pid}: ${error.message}`) }
  }
}

async function waitForRelease(waitMs, pollMs) {
  const deadline = Date.now() + waitMs
  let pids = await listenerPids()
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs))
    pids = await listenerPids()
  }
  return pids
}

export async function releaseOwnedListeners(initialPids, { inspect = listenerIdentity, signalProcess = signal, wait = waitForRelease, waitMs, pollMs } = {}) {
  await assertOwnedListeners(initialPids, inspect)
  await signalProcess(initialPids, '-TERM')
  let remainingPids = await wait(waitMs, pollMs)
  if (remainingPids.length > 0) {
    await assertOwnedListeners(remainingPids, inspect)
    await signalProcess(remainingPids, '-KILL')
    remainingPids = await wait(waitMs, pollMs)
  }
  return remainingPids
}

async function main() {
  const waitMs = positiveInteger(process.env.DEV_PORT_WAIT_MS, 1_000)
  const pollMs = positiveInteger(process.env.DEV_PORT_POLL_MS, 50)
  const initialPids = await listenerPids()
  if (initialPids.length === 0) return console.log(`Port ${port} is available.`)
  await assertOwnedListeners(initialPids)
  console.log(`Releasing this repository's port ${port} listener PID(s): ${initialPids.join(', ')}`)
  const remainingPids = await releaseOwnedListeners(initialPids, { waitMs, pollMs })
  if (remainingPids.length > 0) throw new Error(`Port ${port} remains occupied after TERM and KILL: ${remainingPids.join(', ')}`)
  console.log(`Released port ${port}.`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
