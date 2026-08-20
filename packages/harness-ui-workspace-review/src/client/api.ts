import {
  WORKSPACE_REVIEW_LIST_PATH,
  WORKSPACE_REVIEW_OPEN_PATH,
  WORKSPACE_REVIEW_REHYDRATE_PATH,
  type OpenWorkspaceReview,
  type WorkspaceTreeEntry,
} from '../protocol.ts'

export interface WorkspaceDirectoryListing {
  readonly v: 1
  readonly relativePath: string
  readonly entries: readonly WorkspaceTreeEntry[]
  readonly truncated: boolean
}

export async function listWorkspaceMarkdown(sessionId: string, relativePath?: string): Promise<WorkspaceDirectoryListing> {
  return post(WORKSPACE_REVIEW_LIST_PATH, { sessionId, ...(relativePath === undefined ? {} : { relativePath }) })
}

export async function openWorkspaceMarkdown(sessionId: string, relativePath: string): Promise<OpenWorkspaceReview> {
  return post(WORKSPACE_REVIEW_OPEN_PATH, { sessionId, relativePath })
}

export async function rehydrateWorkspaceMarkdown(sessionId: string, reviewId: string, resourceId: string): Promise<OpenWorkspaceReview> {
  return post(WORKSPACE_REVIEW_REHYDRATE_PATH, { sessionId, reviewId, resourceId })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `workspace review request failed: HTTP ${String(response.status)}`)
  return payload
}
