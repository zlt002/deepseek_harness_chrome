import type { PrototypeActionV1, PrototypeDocumentV1 } from '../prototype-document'

export interface PrototypeRuntimeState {
  screenId: string
  openModalIds: string[]
  values: Record<string, string | boolean>
  tabs: Record<string, string>
  submitted: boolean
}

export type PrototypeRuntimeEvent = { type: 'reset'; document: PrototypeDocumentV1 } | { type: 'action'; action: PrototypeActionV1 } | { type: 'input'; elementId: string; value: string | boolean }

export function initialRuntimeState(document: PrototypeDocumentV1): PrototypeRuntimeState {
  return { screenId: document.initialScreenId, openModalIds: [], values: {}, tabs: {}, submitted: false }
}

/** Fixed reducer for the small action language; no model text is ever evaluated. */
export function reducePrototypeRuntime(state: PrototypeRuntimeState, event: PrototypeRuntimeEvent): PrototypeRuntimeState {
  if (event.type === 'reset') return initialRuntimeState(event.document)
  if (event.type === 'input') return { ...state, values: { ...state.values, [event.elementId]: event.value } }
  const action = event.action
  switch (action.type) {
    case 'navigate': return action.targetScreenId === undefined ? state : { ...state, screenId: action.targetScreenId, openModalIds: [] }
    case 'open-modal': return action.targetId === undefined || state.openModalIds.includes(action.targetId) ? state : { ...state, openModalIds: [...state.openModalIds, action.targetId] }
    case 'close-modal': return action.targetId === undefined ? { ...state, openModalIds: [] } : { ...state, openModalIds: state.openModalIds.filter(id => id !== action.targetId) }
    case 'set-value': return action.targetId === undefined || typeof action.value !== 'string' ? state : { ...state, values: { ...state.values, [action.targetId]: action.value } }
    case 'toggle': return action.targetId === undefined ? state : { ...state, values: { ...state.values, [action.targetId]: !state.values[action.targetId] } }
    case 'set-tab': return action.targetId === undefined || typeof action.value !== 'string' ? state : { ...state, tabs: { ...state.tabs, [action.targetId]: action.value } }
    case 'submit-success': return action.targetScreenId === undefined ? { ...state, submitted: true } : { ...state, submitted: true, screenId: action.targetScreenId, openModalIds: [] }
  }
}
