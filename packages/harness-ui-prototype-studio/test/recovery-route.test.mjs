import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const capabilityFingerprint = value => createHash('sha256').update(value).digest('hex')
const assertionBytes = item => Buffer.from(JSON.stringify([item.v, item.purpose, item.runId, item.projectId, item.expectedSessionId, item.referenceId, item.evidenceFingerprint, item.capabilityFingerprint, item.expectedRecoveryEpoch, item.nonce, item.issuedAt, item.expiresAt]))
const nonce = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

async function routeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prototype-recovery-route-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const prior = {
    DSH_PROTOTYPE_STORE: process.env.DSH_PROTOTYPE_STORE,
    DSH_PROTOTYPE_RECOVERY_PUBLIC_KEY: process.env.DSH_PROTOTYPE_RECOVERY_PUBLIC_KEY,
    DSH_PROTOTYPE_RECOVERY_RUN_ID: process.env.DSH_PROTOTYPE_RECOVERY_RUN_ID,
  }
  const runId = 'native-route-test-run'
  process.env.DSH_PROTOTYPE_STORE = root
  process.env.DSH_PROTOTYPE_RECOVERY_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  process.env.DSH_PROTOTYPE_RECOVERY_RUN_ID = runId
  const runtime = await import(new URL(`../lib/index.js?recovery-route=${randomUUID()}`, import.meta.url).href)
  const routes = new Map()
  const ctx = {
    tools: { register: () => () => {} },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } },
    inject: (_deps, callback) => callback(ctx),
    effect: callback => callback(),
  }
  runtime.apply(ctx)
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const post = async (path, body, headers = {}) => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`Route was not registered: ${path}`)
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
    let status = 200; let content = ''; let ended = false
    await new Promise((resolve, reject) => {
      const response = {
        get headersSent() { return ended },
        writeHead: value => { status = value },
        end: value => { content += value?.toString() ?? ''; ended = true; resolve() },
      }
      try { handler(request, response) } catch (error) { reject(error) }
    })
    return { status, body: JSON.parse(content) }
  }
  const evidence = { v: 1, id: 'reference-route', source: { url: 'https://example.test/recovery-route', title: '路由恢复', capturedAt: '2026-08-25T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['路由恢复测试。'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: '' }
  evidence.fingerprint = await runtime.computeReferenceEvidenceFingerprint(evidence)
  const projectId = 'prototype-route-12345678'
  const sessionId = 'session-route-1'
  const oldCapability = 'old-route-capability-abcdefghijklmnopqrstuvwxyz-123456'
  const opened = await post('/api/prototype-studio/open', { projectId, sessionId, evidence: [evidence] }, { authorization: `Bearer ${oldCapability}` })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  const makeAssertion = (overrides = {}) => {
    const item = {
      v: 1,
      purpose: 'prototype-studio-capability-recovery',
      runId,
      projectId,
      expectedSessionId: sessionId,
      referenceId: evidence.id,
      evidenceFingerprint: evidence.fingerprint,
      capabilityFingerprint: capabilityFingerprint(overrides.capability ?? 'new-route-capability-abcdefghijklmnopqrstuvwxyz-123456'),
      expectedRecoveryEpoch: 0,
      nonce: nonce(1),
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 30_000,
      ...overrides,
    }
    const signature = sign(null, assertionBytes(item), privateKey).toString('base64url')
    return { assertion: item, signature, capability: overrides.capability ?? 'new-route-capability-abcdefghijklmnopqrstuvwxyz-123456' }
  }
  return { post, runtime, makeAssertion, projectId, sessionId, evidence, oldCapability, runId }
}

test('actual recovery HTTP route verifies the Native Host assertion and passes its runId into Store', { concurrency: false }, async t => {
  const fixture = await routeFixture(t)
  const reject = async (payload, expected) => {
    const response = await fixture.post('/api/prototype-studio/recover', payload)
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.error, expected)
  }
  const valid = fixture.makeAssertion()
  await reject({ ...valid, signature: `${valid.signature.startsWith('A') ? 'B' : 'A'}${valid.signature.slice(1)}` }, /signature is invalid/)
  await reject(fixture.makeAssertion({ runId: 'wrong-native-run' }), /assertion is invalid/)
  await reject(fixture.makeAssertion({ issuedAt: Date.now() - 62_000, expiresAt: Date.now() - 1 }), /has expired/)
  await reject(fixture.makeAssertion({ expectedSessionId: 'session-route-other', nonce: nonce(2) }), /does not match/)
  await reject(fixture.makeAssertion({ referenceId: 'reference-other', nonce: nonce(3) }), /does not match/)
  await reject(fixture.makeAssertion({ evidenceFingerprint: 'f'.repeat(64), nonce: nonce(4) }), /does not match/)
  const capHashMismatch = fixture.makeAssertion({ nonce: nonce(5) })
  await reject({ ...capHashMismatch, capability: 'other-route-capability-abcdefghijklmnopqrstuvwxyz-123456' }, /capability does not match/)

  const recovered = await fixture.post('/api/prototype-studio/recover', valid)
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
  assert.equal(recovered.body.status, 'verified_write')
  assert.equal(recovered.body.projectId, fixture.projectId)
  assert.equal(recovered.body.recoveryEpoch, 1)
  const snapshot = await fixture.post('/api/prototype-studio/snapshot', { projectId: fixture.projectId }, { authorization: `Bearer ${valid.capability}` })
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body))
  assert.equal(snapshot.body.recoveryEpoch, 1)
  const oldCapability = await fixture.post('/api/prototype-studio/snapshot', { projectId: fixture.projectId }, { authorization: `Bearer ${fixture.oldCapability}` })
  assert.equal(oldCapability.status, 400)
  assert.match(oldCapability.body.error, /capability is invalid/)
})
