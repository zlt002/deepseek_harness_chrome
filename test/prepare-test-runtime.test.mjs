import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { acquireTestRuntimeLock, freshnessLayers, planTestRuntimePreparation, runtimeFreshnessMatches } from '../scripts/checks/prepare-test-runtime.mjs'

test('standalone test preparation materializes only missing runtime layers', () => {
  const ready = new Set([
    'product-marker',
    'web-dist',
    'plugin-libs',
    'extension-assets',
    'product-fresh',
    'plugin-fresh',
    'asset-fresh',
  ])

  assert.deepEqual(planTestRuntimePreparation((name) => ready.has(name)), [])
  assert.deepEqual(
    planTestRuntimePreparation((name) => name !== 'extension-assets'),
    ['sync-harness-assets'],
  )
  assert.deepEqual(
    planTestRuntimePreparation((name) => name !== 'plugin-libs' && name !== 'extension-assets'),
    ['build:harness-client-plugins', 'sync-harness-assets'],
  )
  assert.deepEqual(
    planTestRuntimePreparation(() => false),
    ['build:harness-product', 'build:harness-client-plugins', 'sync-harness-assets'],
  )
  assert.deepEqual(
    planTestRuntimePreparation((name) => name !== 'plugin-fresh'),
    ['build:harness-client-plugins', 'sync-harness-assets'],
  )
  assert.deepEqual(
    planTestRuntimePreparation((name) => name !== 'asset-fresh'),
    ['sync-harness-assets'],
  )
})

test('every planned preparation script exists in the root package manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const plans = [
    planTestRuntimePreparation(() => false),
    planTestRuntimePreparation((name) => name !== 'plugin-libs' && name !== 'extension-assets'),
    planTestRuntimePreparation((name) => name !== 'asset-fresh'),
  ]
  for (const script of plans.flat()) assert.equal(typeof manifest.scripts[script], 'string', `Missing package script: ${script}`)
})

test('runtime freshness refuses a changed source hash or explicit Harness root', () => {
  const expected = { format: 1, harnessRoot: '/runtime/one', productHash: 'product-a', pluginHash: 'plugin-a', assetHash: 'asset-a' }
  assert.equal(runtimeFreshnessMatches(expected, { ...expected }), true)
  assert.equal(runtimeFreshnessMatches(expected, { ...expected, pluginHash: 'plugin-b' }), true)
  assert.equal(runtimeFreshnessMatches(expected, { ...expected, harnessRoot: '/runtime/two' }), false)
})

test('freshness layers keep a current product when only plugin source changes', () => {
  const recorded = { format: 1, harnessRoot: '/runtime/one', productHash: 'product-a', pluginHash: 'plugin-a', assetHash: 'asset-a' }
  const current = { ...recorded, pluginHash: 'plugin-b' }
  assert.deepEqual(freshnessLayers(recorded, current), { product: true, plugin: false, asset: true })
  assert.deepEqual(planTestRuntimePreparation((name) => !name.endsWith('-fresh') || freshnessLayers(recorded, current)[name.slice(0, -6)]), ['build:harness-client-plugins', 'sync-harness-assets'])
})

test('an explicit complete Harness root never rebuilds the default product', () => {
  const complete = new Set(['product-marker', 'web-dist', 'plugin-libs', 'extension-assets', 'plugin-fresh', 'asset-fresh'])
  assert.deepEqual(planTestRuntimePreparation((name) => complete.has(name), { explicitRuntime: true }), [])
  const changedAssets = new Set([...complete].filter((name) => name !== 'asset-fresh'))
  assert.deepEqual(planTestRuntimePreparation((name) => changedAssets.has(name), { explicitRuntime: true }), ['sync-harness-assets'])
  assert.throws(() => planTestRuntimePreparation(() => false, { explicitRuntime: true }), /Explicit ACCRUI_HARNESS_ROOT is incomplete/)
})

test('a partial owner file waits through its grace window instead of being deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-test-runtime-owner-'))
  let releaseOwner
  const ownerReady = new Promise((resolve) => { releaseOwner = resolve })
  try {
    const first = acquireTestRuntimeLock(directory, { beforeWriteOwner: async () => ownerReady, ownerGraceMs: 300, pollMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    let secondAcquired = false
    const second = acquireTestRuntimeLock(directory, { ownerGraceMs: 300, pollMs: 10 }).then((lock) => { secondAcquired = true; return lock })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(secondAcquired, false)
    releaseOwner()
    const firstLock = await first
    await firstLock.release()
    await (await second).release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('test-runtime lock recovers a stale owner and remains exclusive under contention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-test-runtime-stress-'))
  try {
    await writeFile(join(directory, '.test-runtime-preparation.lock'), JSON.stringify({ pid: 999999999, token: 'stale' }))
    const recovered = await acquireTestRuntimeLock(directory, { pollMs: 5 })
    await recovered.release()
    let active = 0; let maximum = 0
    await Promise.all(Array.from({ length: 12 }, async () => {
      const lock = await acquireTestRuntimeLock(directory, { pollMs: 5 })
      active += 1; maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      await lock.release()
    }))
    assert.equal(maximum, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('test-runtime lock recovers aged empty and malformed owner files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-test-runtime-partial-stale-'))
  try {
    for (const content of ['', '{not-json']) {
      await writeFile(join(directory, '.test-runtime-preparation.lock'), content)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const lock = await acquireTestRuntimeLock(directory, { ownerGraceMs: 1, staleMs: 5, pollMs: 1, waitMs: 80 })
      await lock.release()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('test-runtime preparation lock serializes two processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-test-runtime-lock-'))
  const moduleUrl = new URL('../scripts/checks/prepare-test-runtime.mjs', import.meta.url).href
  const child = (label, holdMs) => spawn(process.execPath, ['--input-type=module', '--eval', `import { acquireTestRuntimeLock } from ${JSON.stringify(moduleUrl)}; const lock = await acquireTestRuntimeLock(process.argv[1], { pollMs: 10, waitMs: 2_000 }); console.log(${JSON.stringify(label + ':acquired')}); await new Promise(resolve => setTimeout(resolve, ${holdMs})); await lock.release(); console.log(${JSON.stringify(label + ':released')});`, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const first = child('first', 120)
    const firstExit = once(first, 'exit')
    const [firstOutput] = await once(first.stdout, 'data')
    assert.match(String(firstOutput), /first:acquired/)
    const second = child('second', 0)
    const secondExit = once(second, 'exit')
    const [secondOutput] = await once(second.stdout, 'data')
    assert.match(String(secondOutput), /second:acquired/)
    await Promise.all([firstExit, secondExit])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
