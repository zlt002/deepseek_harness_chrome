import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveSessionTrackingPatch } from '../apps/native-server/src/harness-process.mjs'
import {
  DEFAULT_TRACKING_API_KEY,
  DEFAULT_TRACKING_ENDPOINT,
  apply,
  resolveTrackingEndpoint,
} from '../packages/harness-tracking/src/index.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Native Host always mounts AccrUI effective-session tracking to the company endpoint', async () => {
  const patch = effectiveSessionTrackingPatch({})
  const processSource = await readFile(resolve(projectRoot, 'apps/native-server/src/harness-process.mjs'), 'utf8')
  assert.match(patch, /id: deepseek-harness-effective-session-tracking/)
  assert.match(patch, /packages\/harness-tracking\/src\/index\.mjs/)
  assert.match(processSource, /effectiveSessionTrackingPatch\(this\.env\)/)
  assert.equal(resolveTrackingEndpoint({}), DEFAULT_TRACKING_ENDPOINT)
  assert.equal(DEFAULT_TRACKING_ENDPOINT, 'http://10.27.15.64:8793/api/tracking/effective-sessions')
  assert.equal(DEFAULT_TRACKING_API_KEY.length > 0, true)
})

test('a root model step posts one AccrUI-compatible effective-session event', async () => {
  const requests = []
  const listeners = []
  apply({
    on(_name, listener) {
      listeners.push(listener)
      return () => {}
    },
    effect(setup) {
      return setup()
    },
    logger: { debug() {} },
  }, {
    deviceInstallationId: 'device-1',
    deviceName: 'PM-MacBook',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), headers: options.headers })
      return { ok: true, status: 201 }
    },
  })

  listeners[0](
    { id: 'session-1', header: {} },
    { type: 'step/start', data: { turn: 1, step: 1 }, time: Date.parse('2026-06-08T01:00:00.000Z') },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, DEFAULT_TRACKING_ENDPOINT)
  assert.equal(requests[0].headers.Authorization, `Bearer ${DEFAULT_TRACKING_API_KEY}`)
  assert.deepEqual(requests[0].body, {
    sessionId: 'session-1',
    runId: 'session-1:turn-1',
    occurredAt: '2026-06-08T01:00:00.000Z',
    deviceInstallationId: 'device-1',
    apiKey: DEFAULT_TRACKING_API_KEY,
    deviceName: 'PM-MacBook',
  })
})
