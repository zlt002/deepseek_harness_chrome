import assert from 'node:assert/strict'
import test from 'node:test'
import { acknowledgeScopeSwitch, optimisticScopeSwitch, shownScopeSwitch } from '../src/client/scope-switch-state.js'

const snapshot = { sessionId: 'session-1', enabled: true, remember: false, requestSequence: 1 }

test('shows the remember checkbox update immediately', () => {
  const pending = optimisticScopeSwitch(2, 'session-1', snapshot, { remember: true })
  assert.deepEqual(shownScopeSwitch(snapshot, pending), { enabled: true, remember: true })
})

test('does not let an older initialization snapshot overwrite a pending remember update', () => {
  const pending = optimisticScopeSwitch(2, 'session-1', snapshot, { remember: true })
  assert.equal(acknowledgeScopeSwitch(pending, { ...snapshot, requestSequence: 1 }), pending)
  assert.deepEqual(shownScopeSwitch({ ...snapshot, remember: false }, pending), { enabled: true, remember: true })
})

test('settles local switch feedback only when the matching command response arrives', () => {
  const pending = optimisticScopeSwitch(2, 'session-1', snapshot, { enabled: false, remember: true })
  assert.equal(acknowledgeScopeSwitch(pending, { ...snapshot, sessionId: 'session-1', requestSequence: 2, enabled: false, remember: true }), undefined)
})

test('keeps a pending switch confined to the session that sent it', () => {
  const pending = optimisticScopeSwitch(2, 'session-1', snapshot, { remember: true })
  const otherSession = { ...snapshot, sessionId: 'session-2', requestSequence: 2, remember: false }
  assert.deepEqual(shownScopeSwitch(otherSession, pending), { enabled: true, remember: false })
  assert.equal(acknowledgeScopeSwitch(pending, otherSession), pending)
})
