const PREFIX = 'prototype-studio-brief-draft:v1:'

export interface ProductBriefDraftFields {
  audience: string
  coreTask: string
  pages: string
  modules: string
  flows: string
  notes: string
}

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const limits: Record<keyof ProductBriefDraftFields, number> = { audience: 120, coreTask: 300, pages: 700, modules: 1_000, flows: 1_300, notes: 1_200 }

function key(projectId: string): string | undefined {
  return PROJECT_ID.test(projectId) ? `${PREFIX}${projectId}` : undefined
}

function fields(value: unknown): ProductBriefDraftFields | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.v !== 1 || ![7, 8].includes(Object.keys(item).length) || typeof item.projectId !== 'string' || !PROJECT_ID.test(item.projectId)) return undefined
  for (const [name, maximum] of Object.entries(limits)) if (name === 'modules' && item[name] === undefined) continue; else if (typeof item[name] !== 'string' || item[name].length > maximum) return undefined
  return { audience: item.audience as string, coreTask: item.coreTask as string, pages: item.pages as string, modules: typeof item.modules === 'string' ? item.modules : '', flows: item.flows as string, notes: item.notes as string }
}

export function loadProductBriefDraft(draftStore: DraftStorage, projectId: string): ProductBriefDraftFields | undefined {
  const storageKey = key(projectId)
  if (storageKey === undefined) return undefined
  try {
    const raw = draftStore.getItem(storageKey)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as unknown
    const checked = fields(parsed)
    if (checked === undefined || (parsed as { projectId?: unknown }).projectId !== projectId) { draftStore.removeItem(storageKey); return undefined }
    return checked
  } catch { draftStore.removeItem(storageKey); return undefined }
}

export function saveProductBriefDraft(draftStore: DraftStorage, projectId: string, value: ProductBriefDraftFields): void {
  const storageKey = key(projectId)
  if (storageKey === undefined || fields({ v: 1, projectId, ...value }) === undefined) return
  if (Object.values(value).every(item => item.trim() === '')) { draftStore.removeItem(storageKey); return }
  try { draftStore.setItem(storageKey, JSON.stringify({ v: 1, projectId, ...value })) } catch { /* A draft must never block the trusted flow. */ }
}

export function clearProductBriefDraft(draftStore: DraftStorage, projectId: string): void {
  const storageKey = key(projectId)
  if (storageKey === undefined) return
  try { draftStore.removeItem(storageKey) } catch { /* Best effort only. */ }
}
