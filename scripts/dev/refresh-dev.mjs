#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireHarnessProductBuildLock } from '../shared/harness-product-build-lock.mjs'
import { installedPaths, stopInstalledHost } from './restart-dev.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const generatedRoot = resolve(projectRoot, '.generated')
const fast = process.argv.slice(2).includes('--fast')

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

async function stopCurrentNativeHost() {
  try {
    const { installRoot } = await installedPaths()
    const stopped = await stopInstalledHost(installRoot)
    if (stopped > 0) {
      console.log(`Stopped ${String(stopped)} old Native Host process(es) before rebuilding.`)
      // Give the host a moment to release its cwd and loaded Harness files so
      // macOS can remove the generated product tree cleanly.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  } catch (error) {
    // A first-time checkout may not have a registered Native Host yet. That is
    // not a refresh failure; the final dev:restart step reports real install
    // or extension-id problems with its normal actionable error.
    if (!(error instanceof Error) || !error.message.includes('Native Host is not registered yet')) throw error
  }
}

const fastBuildLock = fast ? await acquireHarnessProductBuildLock(generatedRoot) : undefined
process.once('exit', () => { void fastBuildLock?.release() })

await stopCurrentNativeHost()

if (fast) {
  console.log('1/4 Fast refresh: keeping the existing generated Harness product.')
} else {
  console.log('1/4 Rebuilding the generated Harness product...')
  await run('pnpm', ['run', 'build:harness-product'])
}

console.log('2/4 Rebuilding product Harness plugins...')
await run('pnpm', ['run', 'build:harness-client-plugins'])

console.log('3/4 Synchronizing Harness Web assets into the extension...')
await run('pnpm', ['run', 'sync-harness-assets'])
await fastBuildLock?.release()

console.log('4/4 Restarting WXT and Native Host...')
// WXT's development public directory is populated during its build:done hook.
// Releasing port 3101 guarantees that the next dev boot copies the freshly
// synchronized Harness assets instead of leaving an old iframe bundle served.
await run(process.execPath, ['scripts/dev/prepare-dev-port.mjs'])
await run('pnpm', ['run', 'dev:restart', '--', '--skip-harness-build', '--skip-extension-prebuild'])
