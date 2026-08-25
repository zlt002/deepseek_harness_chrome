import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireHarnessProductBuildLock } from '../scripts/harness-product-build-lock.mjs'

test('prevents a concurrent Harness product build and releases cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-product-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await acquireHarnessProductBuildLock(root)
  await assert.rejects(acquireHarnessProductBuildLock(root), /already running/)
  await first.release()
  const second = await acquireHarnessProductBuildLock(root)
  await second.release()
})

test('reclaims a stale Harness product build lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-product-stale-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lockPath = join(root, '.harness-product-build.lock')
  await mkdir(lockPath)
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 999_999_999, token: 'stale' }))
  const lock = await acquireHarnessProductBuildLock(root)
  await lock.release()
})

test('fast refresh uses the same lock before touching the installed host', async () => {
  const source = await readFile(new URL('../scripts/refresh-dev.mjs', import.meta.url), 'utf8')
  assert.match(source, /fast \? await acquireHarnessProductBuildLock\(generatedRoot\)/)
  assert.ok(source.indexOf('acquireHarnessProductBuildLock(generatedRoot)') < source.indexOf('await stopCurrentNativeHost()'))
  assert.ok(source.indexOf('fastBuildLock?.release()') < source.indexOf("console.log('4\/4 Restarting WXT"))
})
