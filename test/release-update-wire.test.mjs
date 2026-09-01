import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseUpdateNativeMessage, releaseUpdateResult } from '../apps/chrome-extension/src/release-update-wire.ts'

test('release update wire accepts only correlated Native Host result envelopes', () => {
  assert.deepEqual(releaseUpdateNativeMessage('check', 'request-12345678'), { type: 'release-update-check', requestId: 'request-12345678' })
  assert.deepEqual(releaseUpdateResult({ type: 'release_update_checked', requestId: 'request-12345678', update: { available: false, version: '1.1.76', sha256: 'a'.repeat(64) } }, 'request-12345678'), { ok: true, update: { available: false, version: '1.1.76', sha256: 'a'.repeat(64) } })
  assert.equal(releaseUpdateResult({ type: 'release_update_checked', requestId: 'other', update: {} }, 'request-12345678'), undefined)
})

test('release update wire creates a correlated cancel command', () => {
  assert.deepEqual(releaseUpdateNativeMessage('cancel', 'request-12345678'), { type: 'release-update-cancel', requestId: 'request-12345678' })
})

test('release update wire requires the checked release identity for prepare', () => {
  const candidate = { version: '1.1.81', sha256: 'a'.repeat(64), packageUrl: 'https://example.test/1.1.81.zip' }
  assert.deepEqual(releaseUpdateNativeMessage('prepare', 'request-12345678', candidate), { type: 'release-update-prepare', requestId: 'request-12345678', candidate })
  assert.throws(() => releaseUpdateNativeMessage('prepare', 'request-12345678'), /候选/)
})
