#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(projectRoot, '../deepseek-harness')

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

async function installedPaths() {
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

async function stopInstalledHost(installRoot) {
  const output = await capture('ps', ['-axo', 'pid=,ppid=,command='])
  const processes = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
  const target = processTree(processes, join(installRoot, 'native-server/bin.mjs'))
  for (const entry of target) {
    try { process.kill(entry.pid, 'SIGTERM') } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  return target.length
}

export async function main(args = process.argv.slice(2)) {
  const skipHarnessBuild = args.includes('--skip-harness-build')
  const { installRoot, extensionIds } = await installedPaths()

  if (!skipHarnessBuild) {
    if (!existsSync(join(harnessRoot, 'package.json'))) throw new Error(`Harness checkout not found: ${harnessRoot}`)
    console.log('1/3 Building the latest Harness host libraries...')
    await run('pnpm', ['run', 'build:lib:host'], { cwd: harnessRoot })
  } else {
    console.log('1/3 Skipping Harness host build.')
  }

  console.log('2/3 Installing the latest Native Host sources...')
  await run(process.execPath, [join(projectRoot, 'scripts/register-native-host.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_EXTENSION_ID: extensionIds.join(','),
      DSH_ROOT: process.env.DSH_ROOT?.trim() || harnessRoot,
    },
  })

  console.log('3/3 Restarting the active development host...')
  const stopped = await stopInstalledHost(installRoot)
  console.log(stopped === 0
    ? 'Updated. Open the side panel to start the latest version.'
    : `Updated and stopped ${String(stopped)} old process(es). The open side panel will reconnect automatically.`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
