#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PRODUCT_UI_PLUGIN_DIRECTORIES } from '../../apps/native-server/src/product-plugin-manifest.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '../..')
const FRESHNESS_PATH = join(PROJECT_ROOT, '.generated', 'test-runtime-freshness.json')
const LOCK_NAME = '.test-runtime-preparation.lock'
let cachedFreshness

function hashInputs(paths, skip = () => false) {
  const hash = createHash('sha256')
  const visit = (path) => {
    if (!existsSync(path)) { hash.update(`missing:${path}\0`); return }
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (!skip(entry, path)) visit(join(path, entry))
      }
      return
    }
    hash.update(`${path}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  for (const path of paths) visit(path)
  return hash.digest('hex')
}

function gitRevision(directory) {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (result.status !== 0 || !/^[a-f0-9]{40}$/i.test(result.stdout.trim())) return `unavailable:${result.status ?? 'error'}`
  return result.stdout.trim()
}

function runtimeFreshness() {
  const explicitProductRoot = process.env.ACCRUI_HARNESS_ROOT?.trim()
  const harnessRoot = resolve(explicitProductRoot || join(PROJECT_ROOT, '.generated/harness-product'))
  const skipPackageOutput = (entry) => entry === 'lib' || entry === 'node_modules' || entry === 'test'
  const productHash = hashInputs([
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'pnpm-lock.yaml'),
    join(PROJECT_ROOT, 'scripts/build/materialize-harness-product.mjs'),
    join(PROJECT_ROOT, 'upstream-contributions'),
    join(PROJECT_ROOT, 'upstream/deepseek-harness/package.json'),
    join(PROJECT_ROOT, 'upstream/deepseek-harness/pnpm-lock.yaml'),
    join(harnessRoot, '.harness-product.json'),
    join(harnessRoot, 'apps/cli/lib/bin.js'),
    join(harnessRoot, 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'),
    join(harnessRoot, 'apps/web/dist'),
  ], (entry) => entry === '.git')
  const productSourceHash = createHash('sha256').update(productHash).update(gitRevision(join(PROJECT_ROOT, 'upstream/deepseek-harness'))).digest('hex')
  const pluginHash = hashInputs([
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'pnpm-lock.yaml'),
    join(PROJECT_ROOT, 'apps/native-server/src/product-plugin-manifest.mjs'),
    join(PROJECT_ROOT, 'scripts/build/build-harness-client-plugins.mjs'),
    join(PROJECT_ROOT, 'packages'),
  ], skipPackageOutput)
  const assetHash = hashInputs([
    join(PROJECT_ROOT, 'scripts/build/sync-harness-assets.mjs'),
    join(harnessRoot, '.harness-product.json'),
    join(harnessRoot, 'apps/web/dist'),
  ], (entry) => entry === 'node_modules')
  return { format: 1, harnessRoot, productHash: productSourceHash, pluginHash, assetHash }
}

function currentFreshness() {
  cachedFreshness ??= runtimeFreshness()
  return cachedFreshness
}

export function runtimeFreshnessMatches(expected, current) {
  return Boolean(expected) && expected.format === 1 && current.format === 1
    && expected.harnessRoot === current.harnessRoot
}

export function freshnessLayers(recorded, current) {
  if (!runtimeFreshnessMatches(recorded, current)) return { product: false, plugin: false, asset: false }
  return {
    product: recorded.productHash === current.productHash,
    plugin: recorded.pluginHash === current.pluginHash,
    asset: recorded.assetHash === current.assetHash,
  }
}

function recordedFreshness() {
  try { return JSON.parse(readFileSync(FRESHNESS_PATH, 'utf8')) } catch { return undefined }
}

export function planTestRuntimePreparation(layerReady, { explicitRuntime = false } = {}) {
  const productComplete = layerReady('product-marker') && layerReady('web-dist')
  if (explicitRuntime && !productComplete) throw new Error('Explicit ACCRUI_HARNESS_ROOT is incomplete: marker, CLI, skeleton, and Web dist are required.')
  const productReady = productComplete && layerReady('product-fresh')
  const pluginsReady = layerReady('plugin-libs') && layerReady('plugin-fresh')
  const assetsReady = layerReady('extension-assets') && layerReady('asset-fresh')
  if (!explicitRuntime && !productReady) {
    return ['build:harness-product', 'build:harness-client-plugins', 'sync-harness-assets']
  }
  if (!pluginsReady) return ['build:harness-client-plugins', 'sync-harness-assets']
  if (!assetsReady) return ['sync-harness-assets']
  return []
}

function currentLayerReady(name) {
  const explicitProductRoot = process.env.ACCRUI_HARNESS_ROOT?.trim()
  const productRoot = resolve(explicitProductRoot || join(PROJECT_ROOT, '.generated/harness-product'))
  if (name === 'product-marker') {
    return existsSync(join(productRoot, '.harness-product.json'))
      && existsSync(join(productRoot, 'apps/cli/lib/bin.js'))
      && existsSync(join(productRoot, 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'))
  }
  if (name === 'web-dist') return existsSync(join(productRoot, 'apps/web/dist/index.html'))
  if (name === 'product-fresh' || name === 'plugin-fresh' || name === 'asset-fresh') {
    const current = currentFreshness()
    const recorded = recordedFreshness()
    return freshnessLayers(recorded, current)[name.slice(0, -6)]
  }
  if (name === 'plugin-libs') {
    return PRODUCT_UI_PLUGIN_DIRECTORIES.every((directory) =>
      existsSync(join(PROJECT_ROOT, 'packages', directory, 'lib/index.js'))
      && existsSync(join(PROJECT_ROOT, 'packages', directory, 'lib/client.js')))
  }
  if (name === 'extension-assets') {
    const publicRoot = join(PROJECT_ROOT, 'apps/chrome-extension/public')
    return existsSync(join(publicRoot, 'harness/boot.js'))
      && existsSync(join(publicRoot, 'harness/runtime-manifest.json'))
      && PRODUCT_UI_PLUGIN_DIRECTORIES.every((directory) =>
        existsSync(join(publicRoot, 'plugins', '@accrui', directory, 'client.js')))
  }
  throw new Error(`Unknown test runtime layer: ${name}`)
}

function runPnpmScript(script) {
  const npmExecPath = process.env.npm_execpath
  const invocation = npmExecPath
    ? { command: process.execPath, args: [npmExecPath, 'run', script] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: ['run', script] }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Unable to prepare test runtime: pnpm ${script} failed with exit ${String(result.status)}`)
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function lockState(lockPath) {
  let details
  try {
    details = await stat(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', ageMs: 0 }
    return { kind: 'partial', ageMs: 0 }
  }
  const ageMs = Date.now() - details.mtimeMs
  let text
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'missing', ageMs: 0 } : { kind: 'partial', ageMs }
  }
  try {
    const owner = JSON.parse(text)
    return owner && Number.isSafeInteger(owner.pid) && typeof owner.token === 'string' ? { kind: 'owned', owner, ageMs } : { kind: 'partial', ageMs }
  } catch {
    return { kind: 'partial', ageMs }
  }
}

export async function acquireTestRuntimeLock(root = dirname(FRESHNESS_PATH), { pid = process.pid, pollMs = 50, waitMs = 60_000, ownerGraceMs = 500, staleMs = 60_000, beforeWriteOwner = undefined } = {}) {
  const lockPath = join(root, LOCK_NAME)
  const token = `${pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const deadline = Date.now() + waitMs
  await mkdir(root, { recursive: true })
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await beforeWriteOwner?.({ lockPath, token })
      await handle.writeFile(`${JSON.stringify({ pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      return { async release() { const current = await lockState(lockPath); if (current.kind === 'owned' && current.owner.token === token) await rm(lockPath, { force: true }) } }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (error?.code !== 'EEXIST') {
        if (handle !== undefined) await rm(lockPath, { force: true })
        throw error
      }
      const current = await lockState(lockPath)
      if (current.kind === 'owned' && !processExists(current.owner.pid)) { await rm(lockPath, { force: true }); continue }
      if (current.kind === 'partial' && current.ageMs >= staleMs && current.ageMs >= ownerGraceMs) { await rm(lockPath, { force: true }); continue }
      if (Date.now() >= deadline) throw new Error(`Test runtime preparation is already running (${current.kind === 'owned' ? `PID ${String(current.owner.pid)}` : 'owner is still being recorded'}).`)
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }
}

export async function prepareTestRuntime() {
  const lock = await acquireTestRuntimeLock()
  try {
    cachedFreshness = undefined
    const plan = planTestRuntimePreparation(currentLayerReady, { explicitRuntime: Boolean(process.env.ACCRUI_HARNESS_ROOT?.trim()) })
    for (const script of plan) runPnpmScript(script)
    cachedFreshness = undefined
    const freshness = currentFreshness()
    if (!currentLayerReady('product-marker') || !currentLayerReady('web-dist') || !currentLayerReady('plugin-libs') || !currentLayerReady('extension-assets')) {
      throw new Error('Unable to prepare a complete standalone test runtime.')
    }
    mkdirSync(dirname(FRESHNESS_PATH), { recursive: true })
    const temporary = `${FRESHNESS_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(freshness)}\n`)
    renameSync(temporary, FRESHNESS_PATH)
    if (plan.length > 0) console.log(`Prepared standalone test runtime: ${plan.join(' -> ')}`)
  } finally {
    await lock.release()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await prepareTestRuntime()
}
