import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  NATIVE_RECONNECT_DELAYS_MS,
  retryNativeConnection,
  shouldConsumeReleaseUpdateReload,
} from '../apps/chrome-extension/src/native-reconnect-policy.ts'

test('Native reconnect retries with bounded backoff until the new Host is registered', async () => {
  const attempts = []
  const waits = []
  const connected = await retryNativeConnection(async () => {
    attempts.push(attempts.length + 1)
    return attempts.length === 3
  }, {
    delaysMs: [250, 500, 1_000],
    wait: async delay => { waits.push(delay) },
  })
  assert.equal(connected, true)
  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(waits, [250, 500])
  assert.ok(NATIVE_RECONNECT_DELAYS_MS.reduce((total, delay) => total + delay, 0) >= 55_000)
})

test('only the target Native package version can consume an extension reload request', () => {
  assert.equal(shouldConsumeReleaseUpdateReload('1.1.82', '1.1.81'), false)
  assert.equal(shouldConsumeReleaseUpdateReload('1.1.82', '1.1.82'), true)
})

test('Native reconnect stops immediately when the side panel is disposed', async () => {
  const controller = new AbortController()
  let attempts = 0
  const connected = await retryNativeConnection(async () => {
    attempts += 1
    controller.abort()
    return false
  }, {
    signal: controller.signal,
    delaysMs: [1, 1],
    wait: async () => { throw new Error('an aborted reconnect must not wait') },
  })
  assert.equal(connected, false)
  assert.equal(attempts, 1)
})

test('the side panel uses the bounded reconnect policy after a Native upgrade disconnect', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /retryNativeConnection/)
  assert.match(source, /harness-disconnected/)
  assert.match(source, /AbortController/)
})
