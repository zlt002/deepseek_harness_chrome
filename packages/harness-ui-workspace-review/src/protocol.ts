export const WORKSPACE_REVIEW_API = '/api/workspace-review'
export const WORKSPACE_REVIEW_LIST_PATH = `${WORKSPACE_REVIEW_API}/list`
export const WORKSPACE_REVIEW_OPEN_PATH = `${WORKSPACE_REVIEW_API}/open`
export const WORKSPACE_REVIEW_SNAPSHOT_PATH = `${WORKSPACE_REVIEW_API}/snapshot`
export const WORKSPACE_REVIEW_REHYDRATE_PATH = `${WORKSPACE_REVIEW_API}/rehydrate`
export const WORKSPACE_REVIEW_SELECTION_PATH = `${WORKSPACE_REVIEW_API}/selection`
export const WORKSPACE_REVIEW_PROPOSALS_PATH = `${WORKSPACE_REVIEW_API}/proposals`
export const WORKSPACE_REVIEW_PREPARE_WRITE_PATH = `${WORKSPACE_REVIEW_API}/prepare-write`
export const WORKSPACE_REVIEW_COMMIT_WRITE_PATH = `${WORKSPACE_REVIEW_API}/commit-write`

export const WORKSPACE_REVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024
export const WORKSPACE_REVIEW_MAX_SNAPSHOT_BYTES = 1024 * 1024
export const WORKSPACE_REVIEW_MAX_DIRECTORY_ENTRIES = 200
export const WORKSPACE_REVIEW_CAPABILITY_TTL_MS = 5 * 60 * 1000
export const WORKSPACE_REVIEW_APPROVAL_TTL_MS = 60 * 1000
export const WORKSPACE_REVIEW_MAX_REPLACEMENT_CHARS = 100_000

export interface WorkspaceDirectoryEntry {
  readonly kind: 'directory'
  readonly displayPath: string
  readonly name: string
}

export interface WorkspaceMarkdownEntry {
  readonly kind: 'markdown'
  readonly displayPath: string
  readonly name: string
  readonly size: number
}

export interface WorkspaceFileEntry {
  readonly kind: 'file'
  readonly displayPath: string
  readonly name: string
}

export type WorkspaceTreeEntry = WorkspaceDirectoryEntry | WorkspaceMarkdownEntry | WorkspaceFileEntry

export interface WorkspaceReviewResource {
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
}

export interface OpenWorkspaceReview extends WorkspaceReviewResource {
  readonly v: 1
  readonly reviewId: string
  readonly harnessSessionId: string
  readonly capability: string
}

export interface WorkspaceReviewSnapshot {
  readonly v: 1
  readonly type: 'markdown-review-snapshot'
  readonly reviewId: string
  readonly resource: WorkspaceReviewResource
  readonly content: string
  readonly truncated: boolean
  readonly readOnly: true
}

export interface WorkspaceReviewSelection {
  readonly id: string
  readonly version: 1 | 2
  readonly startUtf16?: number
  readonly endUtf16?: number
  readonly quote: string
  readonly prefix?: string
  readonly suffix?: string
  readonly sourceFingerprint: string
  readonly editorRevision?: number
  readonly from?: number
  readonly to?: number
  readonly blocks?: ReadonlyArray<{ readonly kind: string; readonly text: string }>
  readonly table?: { readonly from: number; readonly to: number; readonly rowCount: number; readonly columnCount: number; readonly selectedRowStart: number; readonly selectedRowEnd: number; readonly selectedColumnStart: number; readonly selectedColumnEnd: number; readonly isWholeTable: boolean; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
}

export interface WorkspaceReviewProposal {
  readonly proposalId: string
  readonly selectionId: string
  readonly sequence: number
  readonly baseFingerprint: string
  readonly kind: 'document' | 'selection'
  readonly candidateMarkdown?: string
  readonly replacementMarkdown?: string
  readonly editorRevision?: number
  readonly from?: number
  readonly to?: number
  readonly summary: string
}
