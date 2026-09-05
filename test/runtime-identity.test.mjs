import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntimeIdentity, validRuntimeIdentity } from '../scripts/shared/runtime-identity.mjs'
import { sameRuntimeReleaseIdentity } from '../apps/native-server/src/runtime/runtime-identity-contract.mjs'

test('runtime identity binds the upstream product marker to copied assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-identity-'))
  const harnessRoot = join(root, 'harness')
  const assetRoot = join(root, 'public/harness')
  await mkdir(harnessRoot, { recursive: true })
  await mkdir(assetRoot, { recursive: true })
  await writeFile(join(harnessRoot, '.harness-product.json'), JSON.stringify({
    revision: 'a'.repeat(40), patches: [{ path: 'upstream-contributions/0001.patch', bytes: 12 }],
  }))
  await writeFile(join(assetRoot, 'boot.js'), 'window.__DSH_BOOT__ = {}')
  const first = await createRuntimeIdentity({ harnessRoot, assetRoots: [assetRoot], pluginRoots: [assetRoot], bootEntries: [{ id: '@accrui/example' }] })
  assert.equal(validRuntimeIdentity(first), true)
  await writeFile(join(assetRoot, 'boot.js'), 'window.__DSH_BOOT__ = {changed:true}')
  const second = await createRuntimeIdentity({ harnessRoot, assetRoots: [assetRoot], pluginRoots: [assetRoot], bootEntries: [{ id: '@accrui/example' }] })
  assert.notEqual(second.assetHash, first.assetHash)
  assert.equal(second.productHash, first.productHash)
})

test('runtime peers require the same product, installed plugins, and boot order', () => {
  const identity = {
    format: 'accrui-harness-runtime-identity-v1', upstreamRevision: 'a'.repeat(40),
    productHash: 'b'.repeat(64), assetHash: 'c'.repeat(64), assetFileCount: 1,
    pluginHash: 'd'.repeat(64), pluginFileCount: 1, bootEntries: ['@deepseek/official', '@accrui/one', '@accrui/two'],
    productBootEntries: ['@accrui/one', '@accrui/two'],
  }
  assert.equal(sameRuntimeReleaseIdentity(identity, { ...identity, assetHash: 'e'.repeat(64) }), true)
  assert.equal(sameRuntimeReleaseIdentity(identity, { ...identity, pluginHash: 'e'.repeat(64) }), false)
  assert.equal(sameRuntimeReleaseIdentity(identity, { ...identity, bootEntries: [...identity.bootEntries].reverse() }), true)
  assert.equal(sameRuntimeReleaseIdentity(identity, { ...identity, productBootEntries: [...identity.productBootEntries].reverse() }), false)
  assert.equal(sameRuntimeReleaseIdentity(identity, { ...identity, pluginHash: undefined, pluginFileCount: undefined }), false)
})
