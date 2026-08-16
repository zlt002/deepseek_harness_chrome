import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OfficeSpreadsheetWriteRecordStore } from '../native-server/src/office-spreadsheet-write-record-store.mjs'

test('spreadsheet checkpoint grants exactly one initial dispatch and fail-closes a historical pending record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spreadsheet-store-')); const recordPath = join(directory, 'writes.json')
  const input = { idempotencyIdentity: 'write-1', targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'set_values', payloadHash: 'payload' }
  try {
    const first = new OfficeSpreadsheetWriteRecordStore({ recordPath })
    assert.equal((await first.create(input)).createdNew, true)
    const reopened = new OfficeSpreadsheetWriteRecordStore({ recordPath })
    const historical = await reopened.create(input)
    assert.equal(historical.createdNew, false); assert.equal(historical.record.state, 'uncertain')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('independent spreadsheet stores atomically grant only one concurrent dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spreadsheet-store-')); const recordPath = join(directory, 'writes.json')
  const input = { idempotencyIdentity: 'write-concurrent', targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'set_values', payloadHash: 'payload' }
  try {
    const [left, right] = await Promise.all([
      new OfficeSpreadsheetWriteRecordStore({ recordPath }).create(input),
      new OfficeSpreadsheetWriteRecordStore({ recordPath }).create(input),
    ])
    assert.equal([left, right].filter((result) => result.createdNew).length, 1)
    const rejected = [left, right].find((result) => !result.createdNew)
    assert.equal(rejected.record.state, 'uncertain')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('stale takeover never lets the former owner remove the rebuilt lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spreadsheet-store-')); const recordPath = join(directory, 'writes.json'); const lock = `${recordPath}.lock`
  const deferred = () => { let resolve; const promise = new Promise((next) => { resolve = next }); return { promise, resolve } }
  const oldClaimed = deferred(); const releaseOld = deferred(); const newClaimed = deferred(); const releaseNew = deferred()
  const input = (id) => ({ idempotencyIdentity: id, targetFingerprint: 'target', resourceFingerprint: 'resource', operation: 'set_values', payloadHash: 'payload' })
  try {
    const old = new OfficeSpreadsheetWriteRecordStore({ recordPath, lockHooks: { onClaim: async () => { oldClaimed.resolve(); await releaseOld.promise } } })
    const oldRun = old.create(input('old-owner'))
    await oldClaimed.promise
    const stale = new Date(Date.now() - 31_000); await utimes(lock, stale, stale)
    const replacement = new OfficeSpreadsheetWriteRecordStore({ recordPath, lockHooks: { onClaim: async () => { newClaimed.resolve(); await releaseNew.promise } } })
    const replacementRun = replacement.create(input('replacement-owner'))
    await newClaimed.promise
    releaseOld.resolve()
    let thirdSettled = false
    const thirdRun = new OfficeSpreadsheetWriteRecordStore({ recordPath }).create(input('third-owner')).then((result) => { thirdSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(thirdSettled, false)
    releaseNew.resolve()
    const [oldResult, replacementResult, thirdResult] = await Promise.all([oldRun, replacementRun, thirdRun])
    assert.equal(replacementResult.createdNew, true)
    assert.equal(oldResult.createdNew, true)
    assert.equal(thirdResult.createdNew, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
