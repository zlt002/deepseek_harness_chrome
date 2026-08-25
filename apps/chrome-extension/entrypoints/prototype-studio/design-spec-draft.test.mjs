import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleUnderTest() {
  const source = await readFile(new URL('./design-spec-draft.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

const original = { v: 1, id: 'design-ref-one', basedOnEvidenceIds: ['ref-one'], colors: [{ value: '#3977e8' }] }
const changed = { ...original, colors: [{ value: '#0057d9' }] }
const validate = (value, ids) => value?.id === 'design-ref-one' && value?.basedOnEvidenceIds?.[0] === ids[0] ? { ok: true, value } : { ok: false }

test('restores a valid draft only for the same project and evidence', async () => {
  const { loadDesignSpecDraft, saveDesignSpecDraft } = await moduleUnderTest()
  const storage = memoryStorage()
  saveDesignSpecDraft(storage, 'prototype-one', ['ref-one'], changed, original)
  assert.deepEqual(loadDesignSpecDraft(storage, 'prototype-one', ['ref-one'], validate), changed)
  assert.equal(loadDesignSpecDraft(storage, 'prototype-one', ['ref-two'], validate), undefined)
  assert.equal(loadDesignSpecDraft(storage, 'prototype-two', ['ref-one'], validate), undefined)
})

test('clears unchanged and confirmed drafts and ignores corrupt storage', async () => {
  const { clearDesignSpecDraft, loadDesignSpecDraft, saveDesignSpecDraft } = await moduleUnderTest()
  const storage = memoryStorage()
  saveDesignSpecDraft(storage, 'prototype-one', ['ref-one'], changed, original)
  clearDesignSpecDraft(storage, 'prototype-one')
  assert.equal(loadDesignSpecDraft(storage, 'prototype-one', ['ref-one'], validate), undefined)
  saveDesignSpecDraft(storage, 'prototype-one', ['ref-one'], changed, original)
  saveDesignSpecDraft(storage, 'prototype-one', ['ref-one'], original, original)
  assert.equal(loadDesignSpecDraft(storage, 'prototype-one', ['ref-one'], validate), undefined)
  storage.setItem('accrui.prototype-studio.design-draft.v1:prototype-one', '{broken')
  assert.equal(loadDesignSpecDraft(storage, 'prototype-one', ['ref-one'], validate), undefined)
})
