import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')

test('the account bridge uses the iframe nonce and monotonically increasing sequences', () => {
  assert.match(source, /type: 'account-access-snapshot\/v1', nonce: frameNonce, sequence: accountSnapshotSequenceRef\.current/)
  assert.match(source, /value\.nonce !== frameNonce/)
  assert.match(source, /value\.sequence <= accountCommandSequenceRef\.current/)
})

test('login polling is bounded and logout cancels it', () => {
  assert.match(source, /accountLoginAttemptsRef\.current < 15/)
  assert.match(source, /command === 'logout' && accountLoginTimerRef\.current !== undefined/)
})
