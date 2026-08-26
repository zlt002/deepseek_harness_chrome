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
  assert.match(effectiveSessionTrackingPatch({ ACCR_PRODUCT_VERSION: '1.1.75' }), /productVersion: '1.1.75'/)
})

test('reports only authoritative Skill names appended after the first step, never message content', async () => {
  const requests = []
  const listeners = []
  apply({
    on(_name, listener) { listeners.push(listener); return () => {} },
    effect(setup) { return setup() },
    logger: { debug() {} },
  }, {
    deviceInstallationId: 'device-1',
    productVersion: '1.1.75',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return { ok: true, status: 201 }
    },
  })

  const session = { id: 'session-skill', header: {} }
  listeners[0](session, { type: 'step/start', data: { turn: 1, step: 1 }, time: Date.parse('2026-06-08T01:00:00.000Z') })
  listeners[0](session, {
    type: 'user/message',
    data: {
      source: { kind: 'skill-invocation', name: 'pmd-prd', form: 'instructions' },
      content: [{ type: 'text', text: 'PRIVATE USER PROMPT AND SKILL PARAMETERS' }],
    },
  })
  listeners[0](session, {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: 'pmd-prd', form: 'instructions' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(requests[0].skillNames, ['pmd-prd'])
  assert.equal(requests[0].productVersion, '1.1.75')
  assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE USER PROMPT|PARAMETERS/)
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
