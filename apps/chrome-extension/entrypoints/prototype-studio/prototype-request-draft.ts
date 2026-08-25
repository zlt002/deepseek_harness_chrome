const PREFIX = 'prototype-studio-request-draft:v1:'
const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const REVISION_ID = /^rev-[a-z0-9-]{8,160}$/i
const ELEMENT_ID = /^[a-z][a-z0-9_-]{0,79}$/
const TYPES = new Set(['text', 'icon', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal', 'table-row', 'list-item', 'tab', 'navigation-item', 'breadcrumb-item'])

interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface PrototypeRequestDraftSelection { elementId: string; type: string; label: string }
export interface PrototypeRequestDraft { request: string; selection?: PrototypeRequestDraftSelection }

function key(projectId: string): string | undefined { return PROJECT_ID.test(projectId) ? `${PREFIX}${projectId}` : undefined }
function selection(value: unknown): PrototypeRequestDraftSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || !ELEMENT_ID.test(String(item.elementId)) || typeof item.type !== 'string' || !TYPES.has(item.type) || typeof item.label !== 'string' || item.label.length > 2_000) return undefined
  return { elementId: item.elementId as string, type: item.type, label: item.label }
}

export function loadPrototypeRequestDraft(store: DraftStorage, projectId: string, baselineRevisionId: string): PrototypeRequestDraft | undefined {
  const storageKey = key(projectId)
  if (storageKey === undefined || !REVISION_ID.test(baselineRevisionId)) return undefined
  try {
    const raw = store.getItem(storageKey)
    if (raw === null) return undefined
    const item = JSON.parse(raw) as Record<string, unknown>
    const checkedSelection = item.selection === undefined ? undefined : selection(item.selection)
    if (item.v !== 1 || Object.keys(item).some(name => !['v', 'projectId', 'baselineRevisionId', 'request', 'selection'].includes(name)) || item.projectId !== projectId || item.baselineRevisionId !== baselineRevisionId || typeof item.request !== 'string' || item.request.trim() === '' || item.request.length > 4_000 || (item.selection !== undefined && checkedSelection === undefined)) {
      store.removeItem(storageKey); return undefined
    }
    return { request: item.request, ...(checkedSelection === undefined ? {} : { selection: checkedSelection }) }
  } catch { store.removeItem(storageKey); return undefined }
}

export function savePrototypeRequestDraft(store: DraftStorage, projectId: string, baselineRevisionId: string, draft: PrototypeRequestDraft): void {
  const storageKey = key(projectId)
  if (storageKey === undefined || !REVISION_ID.test(baselineRevisionId) || draft.request.length > 4_000 || (draft.selection !== undefined && selection(draft.selection) === undefined)) return
  if (draft.request.trim() === '') { clearPrototypeRequestDraft(store, projectId); return }
  try { store.setItem(storageKey, JSON.stringify({ v: 1, projectId, baselineRevisionId, request: draft.request, ...(draft.selection === undefined ? {} : { selection: draft.selection }) })) } catch { /* Draft persistence must never block the trusted flow. */ }
}

export function clearPrototypeRequestDraft(store: DraftStorage, projectId: string): void {
  const storageKey = key(projectId)
  if (storageKey === undefined) return
  try { store.removeItem(storageKey) } catch { /* Best effort only. */ }
}
