import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PROTOTYPE_STUDIO_RECOVERY_BINDINGS, retainedPrototypeStudioRecoveryBindings, storedPrototypeStudioRecoveries, validPrototypeStudioRecoveryBinding } from './prototype-studio-recovery.ts'

const uuid = n => `0000000${n}-0000-4000-8000-00000000000${n}`
const binding = (n, updatedAt = Date.now() - n) => ({ projectId: `prototype-${uuid(n)}`, referenceId: `ref-${uuid(n)}`, sessionId: `session-${n}`, evidenceFingerprint: String(n).repeat(64).slice(0, 64), recoveryEpoch: n, updatedAt })

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
