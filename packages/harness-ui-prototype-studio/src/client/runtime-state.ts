import type { PrototypeActionV1, PrototypeDocumentV1, PrototypeInputNodeV1 } from '../prototype-document'

export interface PrototypeRuntimeState {
  screenId: string
  openModalIds: string[]
  values: Record<string, string | boolean>
  /** Bounded, document-declared product state used by visibility conditions. */
  stateValues: Record<string, string>
  stateAllowedValues: Record<string, string[]>
  tabs: Record<string, string>
  submitted: boolean
  validationErrorIds: string[]
}

export type PrototypeRuntimeEvent = { type: 'reset'; document: PrototypeDocumentV1 } | { type: 'action'; action: PrototypeActionV1 } | { type: 'input'; elementId: string; value: string | boolean; bindStateId?: string } | { type: 'submit'; action: PrototypeActionV1; missingInputIds: string[] } | { type: 'validate'; missingInputIds: string[] }

export function initialRuntimeState(document: PrototypeDocumentV1): PrototypeRuntimeState {
  const stateVariables = document.stateVariables ?? []
  return {
    screenId: document.initialScreenId,
    openModalIds: [],
    values: {},
    stateValues: Object.fromEntries(stateVariables.map(variable => [variable.id, variable.initialValue])),
    stateAllowedValues: Object.fromEntries(stateVariables.map(variable => [variable.id, variable.allowedValues])),
    tabs: {},
    submitted: false,
    validationErrorIds: [],
  }
}

function setBoundState(state: PrototypeRuntimeState, stateId: string | undefined, value: unknown): PrototypeRuntimeState {
  if (typeof value !== 'string' || stateId === undefined || !state.stateAllowedValues[stateId]?.includes(value)) {
    // Return a new object so a controlled text input visibly resets after an
    // out-of-range keystroke instead of looking like it accepted unsafe state.
    return { ...state, stateValues: { ...state.stateValues } }
  }
  return { ...state, stateValues: { ...state.stateValues, [stateId]: value } }
}

export function prototypeInputHasValidationError(node: PrototypeInputNodeV1, state: PrototypeRuntimeState): boolean {
  if (node.inputType === 'checkbox') return node.required === true && state.values[node.id] !== true
  const raw = node.bindStateId === undefined ? state.values[node.id] ?? node.value ?? '' : state.stateValues[node.bindStateId] ?? node.value ?? ''
  const value = String(raw).trim()
  if (value === '') return node.required === true
  if (node.inputType === 'email') return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (node.inputType === 'number') return !Number.isFinite(Number(value))
  return false
}

/** Fixed reducer for the small action language; no model text is ever evaluated. */
export function reducePrototypeRuntime(state: PrototypeRuntimeState, event: PrototypeRuntimeEvent): PrototypeRuntimeState {
  if (event.type === 'reset') return initialRuntimeState(event.document)
  if (event.type === 'validate') return { ...state, submitted: false, validationErrorIds: [...new Set(event.missingInputIds)] }
  if (event.type === 'input') { const updated = event.bindStateId === undefined
    ? { ...state, values: { ...state.values, [event.elementId]: event.value } }
    : setBoundState(state, event.bindStateId, event.value); return { ...updated, validationErrorIds: updated.validationErrorIds.filter(id => id !== event.elementId) } }
  if (event.type === 'submit') return event.missingInputIds.length > 0
    ? { ...state, submitted: false, validationErrorIds: [...new Set(event.missingInputIds)] }
    : reducePrototypeRuntime({ ...state, validationErrorIds: [] }, { type: 'action', action: event.action })
  const action = event.action
  if (action.type === 'sequence') return (action.actions ?? []).reduce((current, item) => reducePrototypeRuntime(current, { type: 'action', action: item }), state)
  switch (action.type) {
    case 'navigate': return action.targetScreenId === undefined ? state : { ...state, screenId: action.targetScreenId, openModalIds: [], validationErrorIds: [] }
    case 'open-modal': return action.targetId === undefined || state.openModalIds.includes(action.targetId) ? state : { ...state, openModalIds: [...state.openModalIds, action.targetId] }
    case 'close-modal': return action.targetId === undefined ? { ...state, openModalIds: [] } : { ...state, openModalIds: state.openModalIds.filter(id => id !== action.targetId) }
    case 'set-value': return action.targetId === undefined || typeof action.value !== 'string' ? state : { ...state, values: { ...state.values, [action.targetId]: action.value } }
    case 'set-state': return setBoundState(state, action.targetId, action.value)
    case 'toggle': return action.targetId === undefined ? state : { ...state, values: { ...state.values, [action.targetId]: !state.values[action.targetId] } }
    case 'set-tab': return action.targetId === undefined || typeof action.value !== 'string' ? state : { ...state, tabs: { ...state.tabs, [action.targetId]: action.value } }
    case 'submit-success': return action.targetScreenId === undefined ? { ...state, submitted: true, validationErrorIds: [] } : { ...state, submitted: true, screenId: action.targetScreenId, openModalIds: [], validationErrorIds: [] }
    case 'add-row':
    case 'edit-row':
    case 'delete-row': return state
  }
}
