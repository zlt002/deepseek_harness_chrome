import type { DesignSpecV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface DraftRecord {
  v: 1
  projectId: string
  evidenceIds: string[]
  designSpec: DesignSpecV1
}

const PREFIX = 'accrui.prototype-studio.design-draft.v1:'

function key(projectId: string): string {
  return `${PREFIX}${projectId}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function loadDesignSpecDraft(
  draftStore: DraftStorage,
  projectId: string,
  evidenceIds: readonly string[],
  validate: (value: unknown, authorizedEvidenceIds: readonly string[]) => { ok: boolean; value?: DesignSpecV1 },
): DesignSpecV1 | undefined {
  try {
    const raw = draftStore.getItem(key(projectId))
    if (raw === null || raw.length > 80_000) return undefined
    const parsed = JSON.parse(raw) as Partial<DraftRecord>
    if (parsed.v !== 1 || parsed.projectId !== projectId || !Array.isArray(parsed.evidenceIds) || !sameIds(parsed.evidenceIds, evidenceIds)) return undefined
    const checked = validate(parsed.designSpec, evidenceIds)
    return checked.ok ? checked.value : undefined
  } catch {
    return undefined
  }
}

export function saveDesignSpecDraft(draftStore: DraftStorage, projectId: string, evidenceIds: readonly string[], designSpec: DesignSpecV1, original: DesignSpecV1): void {
  try {
    if (JSON.stringify(designSpec) === JSON.stringify(original)) {
      draftStore.removeItem(key(projectId))
      return
    }
    const record: DraftRecord = { v: 1, projectId, evidenceIds: [...evidenceIds], designSpec }
    draftStore.setItem(key(projectId), JSON.stringify(record))
  } catch {
    // A disabled or full session store must not prevent review and confirmation.
  }
}

export function clearDesignSpecDraft(draftStore: DraftStorage, projectId: string): void {
  try { draftStore.removeItem(key(projectId)) } catch { /* Best-effort cleanup only. */ }
}
