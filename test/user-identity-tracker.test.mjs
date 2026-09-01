import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserIdentityTracker, normalizeUserIdentityObservation } from '../apps/native-server/src/user-identity-tracker.mjs'

test('user identity telemetry accepts only the two login identity fields and observation time', () => {
  assert.deepEqual(normalizeUserIdentityObservation({ userCode: 'zhanglt21', employeeId: '20680888', observedAt: '2026-09-01T08:00:00Z' }), {
    userCode: 'zhanglt21', employeeId: '20680888', observedAt: '2026-09-01T08:00:00.000Z',
  })
  assert.equal(normalizeUserIdentityObservation({ userCode: 'zhanglt21', employeeId: '20680888', email: 'private@example.test' }), undefined)
  assert.equal(normalizeUserIdentityObservation({ userCode: 'zhanglt21', employeeId: 'not-numeric' }), undefined)
})

test('user identity telemetry enriches the observation with device and version then retries safely', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'user-identity-tracking-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const identityPath = join(root, 'tracking-device.json')
  const outboxPath = join(root, 'outbox.json')
  await writeFile(identityPath, JSON.stringify({ deviceInstallationId: 'device-1' }))
  let succeed = false
  let now = 1_000
  const requests = []
  const tracker = new UserIdentityTracker({
    environment: { ACCR_TRACKING_IDENTITY_PATH: identityPath },
    outboxPath,
    endpoint: 'http://127.0.0.1:8793/api/tracking/user-identities',
    apiKey: 'write-key',
    productVersion: '1.1.94',
    now: () => now,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return { ok: succeed, status: succeed ? 201 : 503 }
    },
  })
  t.after(() => tracker.stop())
  await tracker.report({ userCode: 'zhanglt21', employeeId: '20680888', observedAt: '2026-09-01T08:00:00Z' })
  assert.equal(JSON.parse(await readFile(outboxPath, 'utf8')).length, 1)
  now += 20_000
  succeed = true
  await tracker.flush()
  assert.equal(JSON.parse(await readFile(outboxPath, 'utf8')).length, 0)
  assert.deepEqual({
    userCode: requests.at(-1).userCode,
    employeeId: requests.at(-1).employeeId,
    deviceInstallationId: requests.at(-1).deviceInstallationId,
    productVersion: requests.at(-1).productVersion,
    source: requests.at(-1).source,
  }, {
    userCode: 'zhanglt21', employeeId: '20680888', deviceInstallationId: 'device-1',
    productVersion: '1.1.94', source: 'knowledge_login',
  })
  assert.equal('email' in requests.at(-1), false)
})
