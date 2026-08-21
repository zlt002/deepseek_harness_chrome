import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Host bundle declares and inlines its YAML parser', async () => {
  const [workspace, manifest, config] = await Promise.all([
    readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../tsdown.config.ts', import.meta.url), 'utf8'),
  ])
  assert.equal(JSON.parse(workspace).devDependencies['js-yaml'], '4.1.0')
  assert.equal(JSON.parse(manifest).dependencies, undefined)
  assert.match(config, /lib:\s*\{\s*noExternal:\s*\['js-yaml'\]\s*\}/)
})
