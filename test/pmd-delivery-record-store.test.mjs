import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PmdDeliveryRecordStore, resolvePmdDeliveryStatePath } from '../native-server/src/pmd-delivery-record-store.mjs'

const item = (kind) => ({ kind, name: `${kind}.doc`, idempotencyIdentity: `run-1:${kind}`, contentHash: `hash-${kind}` })

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'pmd-delivery-'))
  return new PmdDeliveryRecordStore({ recordPath: join(dir, 'runs.json') })
}

test('uses a private connector-state path by default', () => {
  assert.equal(
    resolvePmdDeliveryStatePath({ DSH_CONNECTOR_STATE_DIR: '/private/connector-state' }),
    '/private/connector-state/pmd-prd-delivery-records.json',
  )
})

test('persists a body-free atomic two-document run and returns only the unfinished item', async () => {
  const store = await makeStore()
  await store.create({ requirementId: 'REQ-20260816-001', deliveryRunId: 'run-1', targetFingerprint: 'parent-1', contentFingerprint: 'content-1', documents: [item('analysis'), item('prd')] })
  await store.updateItem({ requirementId: 'REQ-20260816-001', deliveryRunId: 'run-1', kind: 'analysis', status: 'created', catalogId: '101', stages: ['created', 'readback_verified'] })
  const pending = await store.unfinished('REQ-20260816-001', 'run-1')
  assert.deepEqual(pending.map((entry) => entry.kind), ['prd'])
  const raw = await readFile(store.recordPath, 'utf8')
  assert.doesNotMatch(raw, /body|content\s*:/i)
  assert.equal((await stat(store.recordPath)).mode & 0o777, 0o600)
  const restored = await new PmdDeliveryRecordStore({ recordPath: store.recordPath }).load('REQ-20260816-001', 'run-1')
  assert.equal(restored.documents.find((entry) => entry.kind === 'analysis').catalogId, '101')
  assert.equal(restored.status, 'partial')
})

test('does not replace an existing run and rejects document bodies', async () => {
  const store = await makeStore()
  const input = { requirementId: 'REQ-20260816-002', deliveryRunId: 'run-2', targetFingerprint: 'parent-2', contentFingerprint: 'content-2', documents: [item('analysis'), item('prd')] }
  const first = await store.create(input)
  const second = await store.create(input)
  assert.deepEqual(second, first)
  await assert.rejects(() => store.create({ ...input, documents: input.documents.map((entry) => ({ ...entry, name: 'changed' })) }), /pmd_delivery_run_conflict/)
  await assert.rejects(() => store.create({ ...input, targetFingerprint: 'other-parent' }), /pmd_delivery_run_conflict/)
  await assert.rejects(() => store.create({ ...input, documents: [item('analysis'), { ...item('prd'), body: '# secret' }] }), /must not persist document body/)
})

test('serializes concurrent creates for the same run', async () => {
  const store = await makeStore()
  const input = { requirementId: 'REQ-20260816-003', deliveryRunId: 'run-3', targetFingerprint: 'parent-3', contentFingerprint: 'content-3', documents: [item('analysis'), item('prd')] }
  const records = await Promise.all([store.create(input), store.create(input), store.create(input)])
  assert.equal(new Set(records.map((record) => record.updatedAt)).size, 1)
})

test('serializes concurrent item updates without losing either item', async () => {
  const store = await makeStore()
  const input = { requirementId: 'REQ-20260816-004', deliveryRunId: 'run-4', targetFingerprint: 'parent-4', contentFingerprint: 'content-4', documents: [item('analysis'), item('prd')] }
  await store.create(input)
  await Promise.all([
    store.updateItem({ requirementId: input.requirementId, deliveryRunId: input.deliveryRunId, kind: 'analysis', status: 'created', catalogId: '401' }),
    store.updateItem({ requirementId: input.requirementId, deliveryRunId: input.deliveryRunId, kind: 'prd', status: 'created', catalogId: '402' }),
  ])
  const record = await store.load(input.requirementId, input.deliveryRunId)
  assert.deepEqual(record.documents.map((entry) => entry.catalogId), ['401', '402'])
  assert.equal(record.status, 'completed')
})
