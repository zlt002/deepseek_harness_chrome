import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OfficeDocumentWriteRecordStore } from '../apps/native-server/src/office-document-write-record-store.mjs'

test('persists a body-free light-document write uncertainty fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-office-document-store-'))
  const recordPath = join(directory, 'writes.json')
  try {
    const store = new OfficeDocumentWriteRecordStore({ recordPath })
    const input = { idempotencyIdentity: 'write-1', targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'replace', payloadHash: 'payload' }
    const created = await store.create(input)
    assert.equal(created.createdNew, true); assert.equal(created.record.state, 'pending')
    assert.equal((await store.setState('write-1', 'uncertain')).state, 'uncertain')
    assert.equal((await new OfficeDocumentWriteRecordStore({ recordPath }).load('write-1')).state, 'uncertain')
    const persisted = await readFile(recordPath, 'utf8')
    assert.equal(/markdown|payload\"\s*:|content\"\s*:/i.test(persisted), false)
    await assert.rejects(() => store.create({ ...input, payloadHash: 'different' }), /conflict/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reopening a pending record atomically marks it uncertain and never grants a second first dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-office-document-store-'))
  const recordPath = join(directory, 'writes.json')
  const input = { idempotencyIdentity: 'pending-1', targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'replace', payloadHash: 'payload' }
  try {
    const first = new OfficeDocumentWriteRecordStore({ recordPath })
    assert.equal((await first.create(input)).createdNew, true)
    const reopened = new OfficeDocumentWriteRecordStore({ recordPath })
    const existing = await reopened.create(input)
    assert.equal(existing.createdNew, false); assert.equal(existing.record.state, 'uncertain')
    assert.equal((await reopened.load('pending-1')).state, 'uncertain')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('only a pending checkpoint can be discarded after a peer-attested pre-mutation rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-office-document-store-'))
  const recordPath = join(directory, 'writes.json')
  const input = { idempotencyIdentity: 'preflight-1', targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'replace', payloadHash: 'payload' }
  try {
    const store = new OfficeDocumentWriteRecordStore({ recordPath })
    await store.create(input)
    assert.equal(await store.discardPending('preflight-1'), true)
    assert.equal(await store.load('preflight-1'), null)
    await store.create(input)
    await store.setState('preflight-1', 'uncertain')
    assert.equal(await store.discardPending('preflight-1'), false)
    assert.equal((await store.load('preflight-1')).state, 'uncertain')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
