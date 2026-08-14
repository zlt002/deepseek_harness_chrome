import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSensitiveDiagnostic } from '../native-server/src/redact.mjs'

test('redacts authorization, bearer tokens, and cookies from Native Host diagnostics', () => {
  assert.equal(
    redactSensitiveDiagnostic('Authorization: Bearer local-secret; Cookie=session=private'),
    'Authorization: [REDACTED]; Cookie=[REDACTED]',
  )
})
