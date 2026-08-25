import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES,
  MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS,
  retainedPrototypeStudioPendingRecoveries,
  retainedPrototypeStudioRecoveryBindings,
  storedPrototypeStudioPendingRecoveries,
  storedPrototypeStudioRecoveries,
  validPrototypeStudioPendingRecovery,
  validPrototypeStudioRecoveryBinding,
} from './prototype-studio-recovery.ts'

const uuid = n => `0000000${n}-0000-4000-8000-00000000000${n}`
const binding = (n, updatedAt = Date.now() - n) => ({ projectId: `prototype-${uuid(n)}`, referenceId: `ref-${uuid(n)}`, sessionId: `session-${n}`, evidenceFingerprint: String(n).repeat(64).slice(0, 64), recoveryEpoch: n, updatedAt })
const pending = (n, createdAt = Date.now() - n) => ({ projectId: `prototype-${uuid(n)}`, referenceId: `ref-${uuid(n)}`, sessionId: `session-${n}`, evidenceFingerprint: String(n).repeat(64).slice(0, 64), expectedRecoveryEpoch: n, capability: `${uuid(n)}${uuid(n)}`, createdAt, expiresAt: createdAt + 60_000, nonce: uuid(n + 1) })

test('keeps only bounded non-secret exact project recovery bindings', () => {
  const values = Array.from({ length: MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS + 1 }, (_, index) => binding((index % 9) + 1, Date.now() - index))
  const retained = retainedPrototypeStudioRecoveryBindings(values)
  assert.ok(retained.length <= MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS)
  assert.equal(retained.every(validPrototypeStudioRecoveryBinding), true)
  assert.equal(JSON.stringify(retained).includes('capability'), false)
})

test('drops malformed or secret-shaped local recovery records', () => {
  const valid = binding(1)
  const stored = storedPrototypeStudioRecoveries({ v: 1, projects: { [valid.projectId]: valid, injected: { ...binding(2), capability: 'must-not-persist' }, malformed: { ...binding(3), recoveryEpoch: -1 } } })
  assert.deepEqual(Object.keys(stored.projects), [valid.projectId])
})

test('retains only bounded, unexpired, exact pending recovery candidates in session shape', () => {
  const now = Date.now()
  const values = Array.from({ length: MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES + 2 }, (_, index) => pending(index + 1, now - index))
  const retained = retainedPrototypeStudioPendingRecoveries(values, now)
  assert.equal(retained.length, MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES)
  assert.equal(retained.every(item => validPrototypeStudioPendingRecovery(item, now)), true)
  const stored = storedPrototypeStudioPendingRecoveries({ v: 1, projects: Object.fromEntries(values.map(item => [item.projectId, item])) }, now)
  assert.equal(Object.keys(stored.projects).length, MAX_PROTOTYPE_STUDIO_PENDING_RECOVERIES)
})

test('rejects expired, malformed, and local-only pending recovery candidates', () => {
  const now = Date.now()
  const valid = pending(1, now - 100)
  const stored = storedPrototypeStudioPendingRecoveries({
    v: 1,
    projects: {
      [valid.projectId]: valid,
      expired: { ...pending(2, now - 120_000), expiresAt: now - 1 },
      injected: { ...pending(3, now - 100), unexpected: true },
    },
  }, now)
  assert.deepEqual(Object.keys(stored.projects), [valid.projectId])
})
