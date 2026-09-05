#!/usr/bin/env node
/**
 * Watch apps/native-server sources and hot-sync them into the registered
 * Native Host install directory, then stop the running host so Chrome pulls
 * the new code on the next sidepanel open.
 *
 * This gives accr-ui-style "save = effective" for native-server development:
 *   pnpm dev:watch
 *
 * It deliberately does NOT touch:
 *   - the WXT dev server or port 3101 (extension code keeps its own HMR)
 *   - the generated Harness product (use pnpm dev:refresh for that)
 */
import { existsSync } from 'node:fs'
import { watch } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedPaths, stopInstalledHost } from './restart-dev.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const nativeServerSource = join(projectRoot, 'apps/native-server')
const debounceMs = Number(process.env.DEV_WATCH_DEBOUNCE_MS ?? 400)

function run(command, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

function changedLabel(pathname) {
  return relative(projectRoot, pathname) || pathname
}

async function syncNow(installRoot, extensionIds) {
  const startedAt = Date.now()
  await run(process.execPath, [join(projectRoot, 'scripts/native/register-native-host.mjs')], {
    DEEPSEEK_HARNESS_EXTENSION_ID: extensionIds.join(','),
  })
  const stopped = await stopInstalledHost(installRoot)
  console.log(`[${new Date().toLocaleTimeString()}] synced in ${String(Date.now() - startedAt)}ms; stopped ${String(stopped)} old host process(es). Reopen the sidepanel to run the new code.`)
}

async function main() {
  const { installRoot, extensionIds } = await installedPaths()
  if (!existsSync(nativeServerSource)) {
    throw new Error(`native-server sources are missing: ${nativeServerSource}`)
  }

  let syncing = false
  let pendingPaths = new Set()
  let debounceTimer = undefined

  const scheduleSync = (pathname) => {
    pendingPaths.add(pathname)
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined
      if (syncing) return
      const batch = [...pendingPaths]
      pendingPaths = new Set()
      syncing = true
      const labels = batch.map(changedLabel).sort().join(', ')
      console.log(`\n[${new Date().toLocaleTimeString()}] change detected: ${labels}`)
      try {
        await syncNow(installRoot, extensionIds)
      } catch (error) {
        console.error(`[${new Date().toLocaleTimeString()}] sync failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        syncing = false
        // Changes that arrived while syncing are not lost; flush them next tick.
        if (pendingPaths.size > 0) scheduleSync(pendingPaths.values().next().value)
      }
    }, debounceMs)
  }

  const controller = new AbortController()
  const watcher = watch(nativeServerSource, { recursive: true, signal: controller.signal })
  const watched = relative(projectRoot, nativeServerSource)
  console.log(`Watching ${watched} for changes (debounce ${String(debounceMs)}ms)...`)
  console.log('Save a file there, or Ctrl+C to stop.')

  for await (const event of watcher) {
    if (event.filename === null) continue
    scheduleSync(join(nativeServerSource, event.filename))
  }
}

const interruptHandlers = ['SIGINT', 'SIGTERM']
let stopping = false
for (const signal of interruptHandlers) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    console.log('\nStopping dev:watch.')
    process.exit(0)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
