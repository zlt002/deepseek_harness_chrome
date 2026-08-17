#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedHarnessRoot = resolve(projectRoot, '.generated/harness-product')
const explicitHarnessRoot = process.env.DSH_ROOT?.trim()
const explicitHarnessCli = process.env.DSH_CLI_PATH?.trim()
const harnessRoot = explicitHarnessRoot
  ? resolve(explicitHarnessRoot)
  : explicitHarnessCli
    ? resolve(dirname(explicitHarnessCli), '../../..')
    : generatedHarnessRoot

export function extensionIdsFromManifest(manifest) {
  const origins = Array.isArray(manifest?.allowed_origins) ? manifest.allowed_origins : []
  return [...new Set(origins.flatMap((origin) => {
    const match = typeof origin === 'string' ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin) : null
    return match === null ? [] : [match[1]]
  }))]
}

export function extensionIdsFromManifests(manifests) {
  return [...new Set(manifests.flatMap(extensionIdsFromManifest))]
}

export function processTree(processes, commandFragment) {
  const roots = processes.filter((entry) => entry.command.includes(commandFragment)).map((entry) => entry.pid)
  const selected = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (!selected.has(entry.pid) && selected.has(entry.ppid)) {
        selected.add(entry.pid)
        changed = true
      }
    }
  }
  return processes.filter((entry) => selected.has(entry.pid)).sort((left, right) => {
    const leftRoot = roots.includes(left.pid)
    const rightRoot = roots.includes(right.pid)
    return Number(leftRoot) - Number(rightRoot)
  })
}

// Harness CLI children spawned by the native host carry a temporary connector
// patch argument. When the host dies without a graceful stop, those children
// are orphaned (ppid becomes 1) and escape a pure process-tree walk, so match
// the connector marker directly. Sessions started outside the native host
// (for example a manual `dsh web`) never carry this marker and are never hit.
const HARNESS_CONNECTOR_MARKER = 'deepseek-harness-connector-'

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolvePromise(output) : reject(new Error(`${command} failed with exit ${String(code)}`)))
  })
}

export function devServerAvailable(port = 3001, host = 'localhost') {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host })
    const finish = (available) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(available)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForDevServer(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await devServerAvailable()) return
    if (child.exitCode !== null) throw new Error(`WXT dev server exited before port 3001 became ready (exit ${String(child.exitCode)}).`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  child.kill('SIGTERM')
  throw new Error('Timed out waiting for the WXT dev server on localhost:3001.')
}

function startDevServer() {
  const child = spawn('pnpm', ['dev'], { cwd: projectRoot, stdio: 'inherit' })
  const closed = new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolvePromise()
      else reject(new Error(`pnpm dev failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
  return { child, closed }
}

export async function installedPaths() {
  if (platform() !== 'darwin') throw new Error('dev:restart currently supports the macOS Chrome/Edge development setup.')
  const installRoot = join(homedir(), 'Library/Application Support/DeepSeekHarness')
  const manifestPaths = [
    join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.harness.chrome.json'),
    join(homedir(), 'Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.deepseek.harness.chrome.json'),
  ].filter(existsSync)
  if (manifestPaths.length === 0) throw new Error('Native Host is not registered yet. Run pnpm run register-native-host once with the extension id.')
  const extensionIds = extensionIdsFromManifests(await Promise.all(manifestPaths.map(async (manifestPath) => JSON.parse(await readFile(manifestPath, 'utf8')))))
  if (extensionIds.length === 0) throw new Error(`No extension id was found in ${manifestPaths.join(', ')}.`)
  return { installRoot, extensionIds }
}

export async function stopInstalledHost(installRoot) {
  const output = await capture('ps', ['-axo', 'pid=,ppid=,command='])
  const processes = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
  const target = [
    ...processTree(processes, join(installRoot, 'native-server/bin.mjs')),
    // Also stop Harness CLI children the host spawned. A graceful host stop
    // terminates them itself; direct SIGTERM to the host orphans them.
    ...processes.filter((entry) => entry.command.includes(HARNESS_CONNECTOR_MARKER)),
  ]
  const seen = new Set()
  for (const entry of target) {
    if (seen.has(entry.pid)) continue
    seen.add(entry.pid)
    try { process.kill(entry.pid, 'SIGTERM') } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  return seen.size
}

export async function main(args = process.argv.slice(2)) {
  const skipHarnessBuild = args.includes('--skip-harness-build')
  const { installRoot, extensionIds } = await installedPaths()

  if (!explicitHarnessRoot && !explicitHarnessCli && !existsSync(join(generatedHarnessRoot, '.harness-product.json'))) {
    throw new Error(`Generated product Harness is missing: ${generatedHarnessRoot}. Run pnpm build:harness-product first, or set DSH_ROOT/DSH_CLI_PATH explicitly for a different Harness checkout.`)
  }

  if (!skipHarnessBuild) {
    if (!existsSync(join(harnessRoot, 'package.json'))) throw new Error(`Harness checkout not found: ${harnessRoot}`)
    console.log('1/4 Building the latest Harness host libraries...')
    await run('pnpm', ['run', 'build:lib:host'], { cwd: harnessRoot })
  } else {
    console.log('1/4 Skipping Harness host build.')
  }

  console.log('2/4 Installing the latest Native Host sources...')
  await run(process.execPath, [join(projectRoot, 'scripts/register-native-host.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_EXTENSION_ID: extensionIds.join(','),
      DSH_ROOT: process.env.DSH_ROOT?.trim() || harnessRoot,
    },
  })

  let ownedDevServer
  if (await devServerAvailable()) {
    console.log('3/4 WXT dev server is already running on localhost:3001.')
  } else {
    console.log('3/4 Starting the WXT dev server on localhost:3001...')
    ownedDevServer = startDevServer()
    await waitForDevServer(ownedDevServer.child)
  }

  console.log('4/4 Restarting the active development host...')
  const stopped = await stopInstalledHost(installRoot)
  console.log(stopped === 0
    ? 'Updated. Open the side panel to start the latest version.'
    : `Updated and stopped ${String(stopped)} old process(es). The open side panel will reconnect automatically.`)
  if (ownedDevServer !== undefined) {
    console.log('WXT hot reload is active. Keep this terminal open; press Ctrl+C to stop it.')
    await ownedDevServer.closed
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
