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
  assert.deepEqual(state, { screenId: 'done', openModalIds: [], values: { name: 'Ada' }, stateValues: {}, stateAllowedValues: {}, tabs: { mode: 'team' }, submitted: true, validationErrorIds: [] })
})

test('close-modal only changes the requested modal and toggle has local state', async () => {
  const { reducePrototypeRuntime } = await reducer()
  let state = { screenId: 'home', openModalIds: ['a', 'b'], values: {}, stateValues: {}, stateAllowedValues: {}, tabs: {}, submitted: false, validationErrorIds: [] }
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'close-modal', targetId: 'a' } })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'toggle', targetId: 'enabled' } })
  assert.deepEqual(state.openModalIds, ['b'])
  assert.equal(state.values.enabled, true)
})

test('reset replaces every prior screen, form, tab, modal, and submission state for a new revision', async () => {
  const { reducePrototypeRuntime } = await reducer()
  const state = reducePrototypeRuntime({ screenId: 'old', openModalIds: ['modal'], values: { email: 'old@example.test' }, stateValues: { status: 'pending' }, stateAllowedValues: { status: ['pending', 'approved'] }, tabs: { sections: 'advanced' }, submitted: true, validationErrorIds: ['email'] }, { type: 'reset', document: { initialScreenId: 'new-home' } })
  assert.deepEqual(state, { screenId: 'new-home', openModalIds: [], values: {}, stateValues: {}, stateAllowedValues: {}, tabs: {}, submitted: false, validationErrorIds: [] })
})

test('bounded business state changes only to declared values for approval and select filters', async () => {
  const { initialRuntimeState, reducePrototypeRuntime } = await reducer()
  const document = { initialScreenId: 'approvals', stateVariables: [
    { id: 'approval-status', initialValue: 'pending', allowedValues: ['pending', 'approved'] },
    { id: 'assignee-filter', initialValue: 'all', allowedValues: ['all', 'mine'] },
  ] }
  let state = initialRuntimeState(document)
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'set-state', targetId: 'approval-status', value: 'approved' } })
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'filter', bindStateId: 'assignee-filter', value: 'mine' })
  assert.deepEqual(state.stateValues, { 'approval-status': 'approved', 'assignee-filter': 'mine' })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'set-state', targetId: 'approval-status', value: 'rejected' } })
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'filter', bindStateId: 'assignee-filter', value: 'everyone' })
  assert.deepEqual(state.stateValues, { 'approval-status': 'approved', 'assignee-filter': 'mine' })
})

test('a bounded sequence can approve and close a dialog as one product action', async () => {
  const { initialRuntimeState, reducePrototypeRuntime } = await reducer()
  const document = { initialScreenId: 'approvals', stateVariables: [{ id: 'approval-status', initialValue: 'pending', allowedValues: ['pending', 'approved'] }] }
  let state = initialRuntimeState(document)
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'open-modal', targetId: 'approval-dialog' } })
  state = reducePrototypeRuntime(state, { type: 'action', action: { type: 'sequence', actions: [
    { type: 'set-state', targetId: 'approval-status', value: 'approved' },
    { type: 'close-modal', targetId: 'approval-dialog' },
  ] } })
  assert.equal(state.stateValues['approval-status'], 'approved')
  assert.deepEqual(state.openModalIds, [])
})

test('required-field submission stays on the form until missing values are filled', async () => {
  const { initialRuntimeState, reducePrototypeRuntime } = await reducer()
  let state = initialRuntimeState({ initialScreenId: 'form' })
  const submit = { type: 'submit-success', targetScreenId: 'done' }
  state = reducePrototypeRuntime(state, { type: 'submit', action: submit, missingInputIds: ['email'] })
  assert.equal(state.screenId, 'form')
  assert.equal(state.submitted, false)
  assert.deepEqual(state.validationErrorIds, ['email'])
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'email', value: 'pm@example.test' })
  assert.deepEqual(state.validationErrorIds, [])
  state = reducePrototypeRuntime(state, { type: 'submit', action: submit, missingInputIds: [] })
  assert.equal(state.screenId, 'done')
  assert.equal(state.submitted, true)
})

test('fixed validation rejects malformed email and number values without model code', async () => {
  const { initialRuntimeState, prototypeInputHasValidationError, reducePrototypeRuntime } = await reducer()
  let state = initialRuntimeState({ initialScreenId: 'form' })
  const email = { id: 'email', type: 'input', label: '邮箱', inputType: 'email', required: true }
  const amount = { id: 'amount', type: 'input', label: '金额', inputType: 'number' }
  assert.equal(prototypeInputHasValidationError(email, state), true)
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'email', value: 'not-an-email' })
  assert.equal(prototypeInputHasValidationError(email, state), true)
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'email', value: 'pm@example.test' })
  assert.equal(prototypeInputHasValidationError(email, state), false)
  state = reducePrototypeRuntime(state, { type: 'input', elementId: 'amount', value: 'twelve' })
  assert.equal(prototypeInputHasValidationError(amount, state), true)
})
