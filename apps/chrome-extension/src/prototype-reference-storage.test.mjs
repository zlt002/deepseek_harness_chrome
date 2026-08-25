import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function storageModule() {
  const source = await readFile(new URL('./prototype-reference-storage.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("import { MAX_OPEN_PROTOTYPE_STUDIOS } from './prototype-studio-authorization';", 'const MAX_OPEN_PROTOTYPE_STUDIOS = 8;')
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}-${Math.random()}`)
}

function evidence(id, capturedAt, extra = {}) {
  return {
    v: 1,
    id,
    source: { url: `https://example.test/${id}`, title: id, capturedAt },
    fingerprint: id.padEnd(64, 'f').slice(0, 64),
    screenshotFingerprint: id.padEnd(64, 's').slice(0, 64),
    ...extra,
  }
}

test('keeps only the eight newest references by capturedAt', async () => {
  const { MAX_STORED_PROTOTYPE_REFERENCES, retainedPrototypeReferences } = await storageModule()
  const references = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const id = `ref-${index}`
    return [id, evidence(id, new Date(Date.UTC(2026, 7, index + 1)).toISOString())]
  }))
  const retained = retainedPrototypeReferences(references)
  assert.equal(MAX_STORED_PROTOTYPE_REFERENCES, 8)
  assert.deepEqual(Object.keys(retained), ['ref-9', 'ref-8', 'ref-7', 'ref-6', 'ref-5', 'ref-4', 'ref-3', 'ref-2'])
})

test('uses measured JSON bytes and strips the oldest screenshot before newer screenshots', async () => {
  const { prototypeReferenceStorageBytes, retainedPrototypeReferences } = await storageModule()
  const newer = evidence('newer', '2026-08-25T00:00:00.000Z', { screenshotDataUrl: `data:image/jpeg;base64,${'n'.repeat(500)}` })
  const older = evidence('older', '2026-08-24T00:00:00.000Z', { screenshotDataUrl: `data:image/jpeg;base64,${'o'.repeat(500)}` })
  const expected = { newer, older: (({ screenshotDataUrl: _image, ...rest }) => rest)(older) }
  const budgetBytes = new TextEncoder().encode(JSON.stringify({ v: 1, references: expected })).byteLength
  assert.equal(prototypeReferenceStorageBytes(expected), budgetBytes)
  const retained = retainedPrototypeReferences({ older, newer }, { budgetBytes })
  assert.deepEqual(retained, expected)
  assert.ok(prototypeReferenceStorageBytes(retained) <= budgetBytes)
})

test('preserves evidence and screenshot fingerprints when an old screenshot is stripped', async () => {
  const { prototypeReferenceStorageBytes, retainedPrototypeReferences } = await storageModule()
  const latest = evidence('latest', '2026-08-25T00:00:00.000Z')
  const old = evidence('old', '2026-08-24T00:00:00.000Z', { screenshotDataUrl: `data:image/png;base64,${'x'.repeat(1_000)}` })
  const withoutOldImage = { latest, old: (({ screenshotDataUrl: _image, ...rest }) => rest)(old) }
  const retained = retainedPrototypeReferences({ old, latest }, { budgetBytes: prototypeReferenceStorageBytes(withoutOldImage) })
  assert.equal(retained.old.fingerprint, old.fingerprint)
  assert.equal(retained.old.screenshotFingerprint, old.screenshotFingerprint)
  assert.equal('screenshotDataUrl' in retained.old, false)
})

test('drops an oversized stale record only after screenshots cannot reduce it enough', async () => {
  const { prototypeReferenceStorageBytes, retainedPrototypeReferences } = await storageModule()
  const latest = evidence('latest', '2026-08-25T00:00:00.000Z')
  const stale = evidence('stale', '2026-08-01T00:00:00.000Z', { unexpectedLegacyPayload: 'z'.repeat(20_000) })
  const budgetBytes = prototypeReferenceStorageBytes({ latest })
  assert.deepEqual(retainedPrototypeReferences({ stale, latest }, { budgetBytes }), { latest })
})

test('default budget retains one newest legal maximum-size screenshot', async () => {
  const { PROTOTYPE_REFERENCE_STORAGE_BUDGET_BYTES, prototypeReferenceStorageBytes, retainedPrototypeReferences } = await storageModule()
  const prefix = 'data:image/jpeg;base64,'
  const latest = evidence('latest', '2026-08-25T00:00:00.000Z', { screenshotDataUrl: prefix + 'a'.repeat(2_000_000 - prefix.length) })
  const retained = retainedPrototypeReferences({ latest })
  assert.equal(retained.latest.screenshotDataUrl.length, 2_000_000)
  assert.ok(prototypeReferenceStorageBytes(retained) <= PROTOTYPE_REFERENCE_STORAGE_BUDGET_BYTES)
})
