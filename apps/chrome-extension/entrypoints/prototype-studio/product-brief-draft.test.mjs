import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function draftModule() {
  const source = await readFile(new URL('./product-brief-draft.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}

function storage() {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

test('keeps one incomplete product brief draft in the current tab and clears it after confirmation', async () => {
  const { clearProductBriefDraft, loadProductBriefDraft, saveProductBriefDraft } = await draftModule()
  const target = storage(); const projectId = 'prototype-12345678'
  const value = { audience: '采购经理', coreTask: '', pages: '供应商列表', modules: '风险记录', flows: '', notes: '保留草稿' }
  saveProductBriefDraft(target, projectId, value)
  assert.deepEqual(loadProductBriefDraft(target, projectId), value)
  assert.equal(loadProductBriefDraft(target, 'prototype-87654321'), undefined)
  clearProductBriefDraft(target, projectId)
  assert.equal(loadProductBriefDraft(target, projectId), undefined)
})

test('drops corrupt, oversized, empty, and wrong-project drafts', async () => {
  const { loadProductBriefDraft, saveProductBriefDraft } = await draftModule()
  const target = storage(); const projectId = 'prototype-12345678'; const storageKey = `prototype-studio-brief-draft:v1:${projectId}`
  target.values.set(storageKey, JSON.stringify({ v: 1, projectId, audience: 'a'.repeat(121), coreTask: '', pages: '', modules: '', flows: '', notes: '' }))
  assert.equal(loadProductBriefDraft(target, projectId), undefined)
  saveProductBriefDraft(target, projectId, { audience: '', coreTask: '', pages: '', modules: '', flows: '', notes: '' })
  assert.equal(target.values.has(storageKey), false)
  target.values.set(storageKey, JSON.stringify({ v: 1, projectId: 'prototype-87654321', audience: '采购', coreTask: '', pages: '', flows: '', notes: '' }))
  assert.equal(loadProductBriefDraft(target, projectId), undefined)
  target.values.set(storageKey, JSON.stringify({ v: 1, projectId, audience: '采购', coreTask: '', pages: '列表', flows: '', notes: '' }))
  assert.deepEqual(loadProductBriefDraft(target, projectId)?.modules, '')
})
