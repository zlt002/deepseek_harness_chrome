export const WORKSPACE_REVIEW_API = '/api/workspace-review'
export const WORKSPACE_REVIEW_LIST_PATH = `${WORKSPACE_REVIEW_API}/list`
export const WORKSPACE_REVIEW_OPEN_PATH = `${WORKSPACE_REVIEW_API}/open`
export const WORKSPACE_REVIEW_SNAPSHOT_PATH = `${WORKSPACE_REVIEW_API}/snapshot`
export const WORKSPACE_REVIEW_REHYDRATE_PATH = `${WORKSPACE_REVIEW_API}/rehydrate`

export const WORKSPACE_REVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024
export const WORKSPACE_REVIEW_MAX_SNAPSHOT_BYTES = 1024 * 1024
export const WORKSPACE_REVIEW_MAX_DIRECTORY_ENTRIES = 200
export const WORKSPACE_REVIEW_CAPABILITY_TTL_MS = 5 * 60 * 1000

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

export type WorkspaceTreeEntry = WorkspaceDirectoryEntry | WorkspaceMarkdownEntry

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
