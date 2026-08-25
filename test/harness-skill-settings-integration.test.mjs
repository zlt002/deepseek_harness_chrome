import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { claudeSkillsPatch, productUiPatch, resolveSchemasteryUrl } from '../apps/native-server/src/harness-process.mjs'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, 'upstream/deepseek-harness')

test('generic Skill seams remain applicable to the clean upstream', () => {
  for (const patch of [
    '0002-skill-invocation-policy-registry.patch',
    '0003-skill-settings-api-wire.patch',
    '0005-ui-skill-settings-invalidation.patch',
  ]) {
    execFileSync('git', ['apply', '--check', resolve(root, 'upstream-contributions', patch)], { cwd: upstream, stdio: 'pipe' })
  }
  const wirePatch = readFileSync(resolve(root, 'upstream-contributions/0003-skill-settings-api-wire.patch'), 'utf8')
  assert.match(wirePatch, /configurationExposed/)
  assert.doesNotMatch(wirePatch, /PRODUCT_SETTINGS_NAMESPACES.*skill-settings/)
})

test('product profile mounts Claude discovery and the Skill settings plugin exactly once', () => {
  const home = '/tmp/accrui-skill-settings-home'
  const patch = claudeSkillsPatch({ HOME: home })
  const claudeSkills = resolve(home, '.claude', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(patch, /customSkillDirs:/)
  assert.match(patch, new RegExp(claudeSkills))
  assert.match(patch, /deepseek-harness-chrome-product-office-skills/)
  assert.doesNotMatch(patch, /@accrui\/harness-skill-settings/)
  const productPatch = productUiPatch({})
  assert.equal(productPatch.match(/name: '@accrui\/harness-skill-settings'/g)?.length, 1)
})

test('product Host resolves its validation runtime from the selected Harness tree', () => {
  const url = resolveSchemasteryUrl(resolve(root, '.generated/harness-product/apps/cli/lib/bin.js'))
  assert.match(url, /^file:/)
  assert.ok(existsSync(new URL(url)), url)
})

test('skill settings package exposes the real Host and client loader entries', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages/harness-skill-settings/package.json'), 'utf8'))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  const host = readFileSync(resolve(root, 'packages/harness-skill-settings/src/index.ts'), 'utf8')
  assert.match(host, /registerInvocationPolicy/)
  assert.match(host, /configurationExposed:\s*true/)
  assert.match(readFileSync(resolve(root, 'packages/harness-skill-settings/src/client/index.ts'), 'utf8'), /settings\.section/)
})
