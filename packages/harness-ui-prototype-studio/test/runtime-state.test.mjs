import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function reducer() {
  const source = await readFile(new URL('../src/client/runtime-state.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(output)}#${Date.now()}`)
}

test('fixed reducer implements prototype interaction actions without code execution', async () => {
  const { initialRuntimeState, reducePrototypeRuntime } = await reducer()
  const doc = { initialScreenId: 'home' }
  let state = initialRuntimeState(doc)
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'open-modal', targetId: 'confirm' } })
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'name', value: 'Ada' })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'set-tab', targetId: 'mode', value: 'team' } })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'submit-success', targetScreenId: 'done' } })
  assert.deepEqual(state, { screenId: 'done', openModalIds: [], values: { name: 'Ada' }, tabs: { mode: 'team' }, submitted: true })
})

test('close-modal only changes the requested modal and toggle has local state', async () => {
  const { reducePrototypeRuntime } = await reducer()
  let state = { screenId: 'home', openModalIds: ['a', 'b'], values: {}, tabs: {}, submitted: false }
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'close-modal', targetId: 'a' } })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'toggle', targetId: 'enabled' } })
  assert.deepEqual(state.openModalIds, ['b'])
  assert.equal(state.values.enabled, true)
})

test('reset replaces every prior screen, form, tab, modal, and submission state for a new revision', async () => {
  const { reducePrototypeRuntime } = await reducer()
  const state = reducePrototypeRuntime({ screenId: 'old', openModalIds: ['modal'], values: { email: 'old@example.test' }, tabs: { sections: 'advanced' }, submitted: true }, { type: 'reset', document: { initialScreenId: 'new-home' } })
  assert.deepEqual(state, { screenId: 'new-home', openModalIds: [], values: {}, tabs: {}, submitted: false })
})
