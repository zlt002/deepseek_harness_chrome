import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseUpdateNativeMessage, releaseUpdateResult } from '../apps/chrome-extension/src/release-update-wire.ts'

test('release update wire accepts only correlated Native Host result envelopes', () => {
  assert.deepEqual(releaseUpdateNativeMessage('check', 'request-12345678'), { type: 'release-update-check', requestId: 'request-12345678' })
  assert.deepEqual(releaseUpdateResult({ type: 'release_update_checked', requestId: 'request-12345678', update: { available: false, version: '1.1.76', sha256: 'a'.repeat(64) } }, 'request-12345678'), { ok: true, update: { available: false, version: '1.1.76', sha256: 'a'.repeat(64) } })
  assert.equal(releaseUpdateResult({ type: 'release_update_checked', requestId: 'other', update: {} }, 'request-12345678'), undefined)
})
