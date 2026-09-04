import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserTargetRunBindings } from '../apps/native-server/src/browser-target-run-bindings.mjs'

const first = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test/first' }
const second = { browser: 'chrome', windowId: 1, tabId: 3, url: 'https://example.test/second' }

test('BrowserTargetRunBindings owns immutable Run and captured submission snapshots', () => {
  const bindings = new BrowserTargetRunBindings()
  assert.deepEqual(bindings.register('run-1', first), { ok: true, runChanged: false, targetChanged: false })
  const current = bindings.current()
  assert.equal(Object.isFrozen(current), true)
  assert.equal(Object.isFrozen(current.browserTarget), true)
  assert.equal(Object.isFrozen(current.browserTargets), true)
  assert.deepEqual(bindings.transfer('run-1', second), { ok: true, runChanged: false, targetChanged: true })
  assert.equal(bindings.capture('run-1', 'session-a', 'submission-a', first), true)
  assert.equal(bindings.capture('run-1', 'session-a', 'submission-b', second), true)
  assert.equal(bindings.release('session-a', 'submission-old'), false)
  assert.equal(bindings.bindingFor('run-1', 'session-a').submissionId, 'submission-b')
  assert.equal(bindings.release('session-a', 'submission-a'), false)
  assert.equal(bindings.release('session-a', 'submission-b'), true)
  assert.equal(bindings.bindingFor('run-1', 'session-a'), undefined)
  bindings.clear()
  assert.equal(bindings.current(), undefined)
})

test('BrowserTargetRunBindings keeps a Run unbound until explicit transfer and rejects invalid target sets', () => {
  const bindings = new BrowserTargetRunBindings()
  assert.equal(bindings.bindingFor('unknown-run'), undefined)
  assert.equal(bindings.register('run-1').ok, true)
  assert.equal(bindings.current().browserTarget, undefined)
  assert.equal(bindings.transfer('run-1', first, [first, { ...first }]).ok, false)
  assert.equal(bindings.transfer('other-run', first).ok, false)
  assert.equal(bindings.transfer('run-1', first).ok, true)
  assert.equal(bindings.current().browserTarget.url, first.url)
})

test('BrowserTargetRunBindings preserves the existing non-empty Run id contract', () => {
  const bindings = new BrowserTargetRunBindings()
  assert.equal(bindings.register('sheet-transition-预算.xlsx', first).ok, true)
  assert.equal(bindings.current().runId, 'sheet-transition-预算.xlsx')
})
