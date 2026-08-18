import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TRACKING_API_KEY,
  DEFAULT_TRACKING_ENDPOINT,
  apply,
  effectiveRunId,
  getTrackingIdentity,
  reportEffectiveSession,
  resolveTrackingConfig,
  resolveTrackingEndpoint,
  shouldReportEffectiveSession,
} from '../src/index.mjs'

test('allows the AccrUI company HTTP tracking host and localhost', () => {
  assert.equal(
    resolveTrackingEndpoint({ endpoint: DEFAULT_TRACKING_ENDPOINT }),
    DEFAULT_TRACKING_ENDPOINT,
  )
  assert.equal(
    resolveTrackingEndpoint({ endpoint: 'http://127.0.0.1:8793/api/tracking/effective-sessions' }),
    'http://127.0.0.1:8793/api/tracking/effective-sessions',
  )
})

test('rejects non-allowlisted HTTP tracking endpoints', () => {
  assert.throws(
    () => resolveTrackingEndpoint({ endpoint: 'http://tracking.example.com/api/tracking/effective-sessions' }),
    /HTTPS/,
  )
})

test('environment can disable reporting without changing Agent execution', () => {
  assert.deepEqual(
    resolveTrackingConfig({}, { ACCR_TRACKING_DISABLED: '1' }),
    { disabled: true },
  )
})

test('counts only the first model step of a root turn as one effective session', () => {
  const session = { id: 'session-1', header: {} }
  const reported = new Set()
  assert.equal(shouldReportEffectiveSession(session, { type: 'turn/start', data: { turn: 1 } }, reported), false)
  assert.equal(shouldReportEffectiveSession(session, { type: 'step/start', data: { turn: 1, step: 1 } }, reported), true)
  reported.add(effectiveRunId('session-1', 1))
  assert.equal(shouldReportEffectiveSession(session, { type: 'step/start', data: { turn: 1, step: 2 } }, reported), false)
  assert.equal(shouldReportEffectiveSession(session, { type: 'step/start', data: { turn: 2, step: 1 } }, reported), true)
  assert.equal(
    shouldReportEffectiveSession(
      { id: 'child-1', header: { origin: 'subagent', depth: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      new Set(),
    ),
    false,
  )
})

test('reuses a durable installation id and posts AccrUI-compatible payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-tracking-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const identityPath = join(root, 'tracking-device.json')
  const first = await getTrackingIdentity({ identityPath, deviceName: 'PM-MacBook' })
  const second = await getTrackingIdentity({ identityPath, deviceName: 'PM-MacBook' })
  assert.equal(first.deviceInstallationId, second.deviceInstallationId)
  assert.match(first.deviceInstallationId, /^[0-9a-f-]{36}$/)
  assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).deviceInstallationId, first.deviceInstallationId)

  const requests = []
  await reportEffectiveSession({
    endpoint: DEFAULT_TRACKING_ENDPOINT,
    apiKey: DEFAULT_TRACKING_API_KEY,
    modelApiKey: 'sk-model-secret',
    sessionId: 'session-1',
    runId: 'session-1:turn-1',
    occurredAt: '2026-06-08T01:00:00.000Z',
    deviceInstallationId: first.deviceInstallationId,
    deviceName: 'PM-MacBook',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 201 }
    },
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, DEFAULT_TRACKING_ENDPOINT)
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${DEFAULT_TRACKING_API_KEY}`)
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    sessionId: 'session-1',
    runId: 'session-1:turn-1',
    occurredAt: '2026-06-08T01:00:00.000Z',
    deviceInstallationId: first.deviceInstallationId,
    apiKey: DEFAULT_TRACKING_API_KEY,
    modelApiKey: 'sk-model-secret',
    deviceName: 'PM-MacBook',
  })
})

test('reports once per root turn and ignores later steps or child sessions', async () => {
  const requests = []
  const listeners = []
  const ctx = {
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    effect(setup) {
      return setup()
    },
    logger: { debug() {} },
  }

  apply(ctx, {
    endpoint: DEFAULT_TRACKING_ENDPOINT,
    apiKey: 'write-key',
    modelApiKey: 'sk-model',
    deviceInstallationId: 'device-1',
    deviceName: 'PM-MacBook',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return { ok: true, status: 201 }
    },
  })

  const session = { id: 'session-1', header: {} }
  const child = { id: 'child-1', header: { origin: 'subagent', depth: 1 } }
  listeners[0].listener(session, { type: 'turn/start', data: { turn: 1 }, time: Date.parse('2026-06-08T01:00:00.000Z') })
  listeners[0].listener(session, { type: 'step/start', data: { turn: 1, step: 1 }, time: Date.parse('2026-06-08T01:00:00.000Z') })
  listeners[0].listener(session, { type: 'step/start', data: { turn: 1, step: 2 }, time: Date.parse('2026-06-08T01:00:01.000Z') })
  listeners[0].listener(child, { type: 'step/start', data: { turn: 1, step: 1 }, time: Date.parse('2026-06-08T01:00:02.000Z') })
  listeners[0].listener(session, { type: 'step/start', data: { turn: 2, step: 1 }, time: Date.parse('2026-06-08T01:05:00.000Z') })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(requests.map((body) => body.runId), ['session-1:turn-1', 'session-1:turn-2'])
  assert.equal(requests[0].sessionId, 'session-1')
  assert.equal(requests[0].deviceInstallationId, 'device-1')
  assert.equal(requests[0].deviceName, 'PM-MacBook')
})
