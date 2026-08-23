import assert from 'node:assert/strict'
import test from 'node:test'
import { RunTargetRegistry } from '../apps/native-server/src/run-target-registry.mjs'

const first = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test/first' }
const second = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://example.test/second' }

test('RunTargetRegistry reports identity changes and returns immutable snapshots', () => {
  const registry = new RunTargetRegistry()
  assert.deepEqual(registry.register('run-1', first), { ok: true, runChanged: false, targetChanged: false })
  assert.equal(registry.current().browserTarget.url, first.url)
  assert.deepEqual(registry.register('run-1', second), { ok: true, runChanged: false, targetChanged: true })
  assert.deepEqual(registry.register('run-2', undefined), { ok: true, runChanged: true, targetChanged: false })
  assert.equal(registry.current().browserTarget, undefined)
  registry.clear()
  assert.equal(registry.current(), undefined)
})

test('RunTargetRegistry rejects duplicate selected identities', () => {
  const registry = new RunTargetRegistry()
  assert.equal(registry.register('run-1', first, [first, { ...first }]).ok, false)
  assert.equal(registry.current(), undefined)
})
