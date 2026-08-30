import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { TeamDocRecordStore, resolveTeamDocStatePath } from '../apps/native-server/src/team-doc-record-store.mjs'

test('uses only the AccrUI connector-state override in tests', () => {
  assert.equal(resolveTeamDocStatePath({ ACCRUI_CONNECTOR_STATE_DIR: '/private/test-state', DSH_CONNECTOR_STATE_DIR: '/other-product' }), join('/private/test-state', 'team-doc-delivery-records.json'))
})

test('persists body-free recovery stages atomically with owner-only permissions', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-team-doc-')), 'records.json')
  const store = new TeamDocRecordStore({ recordPath: path })
  await store.save({ idempotencyIdentity: 'doc-1', targetFingerprint: 'target', contentHash: 'sha256:body', stages: ['parent_inspected', 'created'], documentId: '9007199254740993' })
  if (platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await store.load('doc-1'), { idempotencyIdentity: 'doc-1', targetFingerprint: 'target', contentHash: 'sha256:body', stages: ['parent_inspected', 'created'], documentId: '9007199254740993' })
})

test('retains confirmed stages and service identity when a partial record advances', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-team-doc-stages-')), 'records.json')
  const store = new TeamDocRecordStore({ recordPath: path })
  const confirmed = {
    idempotencyIdentity: 'doc-2', targetFingerprint: 'target', contentHash: 'sha256:body',
    stages: ['parent_inspected', 'created', 'rediscovered'], documentId: '9007199254740993', verified: false,
  }
  await store.save(confirmed)
  const loaded = await store.load('doc-2')
  await store.save({ ...loaded, stages: [...loaded.stages, 'body_written'] })
  const advanced = await store.load('doc-2')
  assert.deepEqual(advanced.stages, ['parent_inspected', 'created', 'rediscovered', 'body_written'])
  assert.equal(advanced.documentId, '9007199254740993')
  assert.equal(advanced.verified, false)
})

test('strips document bodies from nested recovery results', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-team-doc-body-free-')), 'records.json')
  const store = new TeamDocRecordStore({ recordPath: path })
  await store.save({
    idempotencyIdentity: 'doc-body-free', targetFingerprint: 'target', contentHash: 'sha256:body',
    stages: ['readback_verified'], verified: true,
    result: { status: 'verified_write', observedBody: '# secret', readback: { body: '# secret', title: 'Safe title' } },
  })
  const raw = await readFile(path, 'utf8')
  assert.doesNotMatch(raw, /# secret|observedBody|"body"/)
  assert.equal((await store.load('doc-body-free')).result.readback.title, 'Safe title')
})

test('serializes concurrent records without losing a different identity', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-team-doc-concurrent-')), 'records.json')
  const store = new TeamDocRecordStore({ recordPath: path })
  await Promise.all(['one', 'two', 'three'].map((identity) => store.save({ idempotencyIdentity: identity, targetFingerprint: 'target', contentHash: `hash-${identity}`, stages: [] })))
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(), ['one', 'three', 'two'])
})
