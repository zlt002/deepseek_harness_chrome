import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function draftModule() {
  const source = await readFile(new URL('./prototype-request-draft.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}
function storage() { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } }

test('restores an unsent whole-prototype request only on the same project and revision', async () => {
  const { loadPrototypeRequestDraft, savePrototypeRequestDraft } = await draftModule()
  const target = storage(); const projectId = 'prototype-12345678'; const revisionId = 'rev-12345678'
  savePrototypeRequestDraft(target, projectId, revisionId, { request: '增加负责人筛选和风险抽屉' })
  assert.deepEqual(loadPrototypeRequestDraft(target, projectId, revisionId), { request: '增加负责人筛选和风险抽屉' })
  assert.equal(loadPrototypeRequestDraft(target, 'prototype-87654321', revisionId), undefined)
  assert.equal(loadPrototypeRequestDraft(target, projectId, 'rev-87654321'), undefined)
})

test('keeps a bounded selected-element draft and drops corrupt or empty data', async () => {
  const { loadPrototypeRequestDraft, savePrototypeRequestDraft } = await draftModule()
  const target = storage(); const projectId = 'prototype-12345678'; const revisionId = 'rev-12345678'; const selection = { elementId: 'risk-row', type: 'table-row', label: '风险记录' }
  savePrototypeRequestDraft(target, projectId, revisionId, { request: '点击后打开风险抽屉', selection })
  assert.deepEqual(loadPrototypeRequestDraft(target, projectId, revisionId), { request: '点击后打开风险抽屉', selection })
  savePrototypeRequestDraft(target, projectId, revisionId, { request: '' })
  assert.equal(loadPrototypeRequestDraft(target, projectId, revisionId), undefined)
  target.values.set(`prototype-studio-request-draft:v1:${projectId}`, JSON.stringify({ v: 1, projectId, baselineRevisionId: revisionId, request: 'x', selection: { elementId: 'bad id', type: 'button', label: 'x' } }))
  assert.equal(loadPrototypeRequestDraft(target, projectId, revisionId), undefined)
})
