interface WorkspaceMemberView {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

interface SessionSummaryView { readonly id: string; readonly cwd?: string }
interface SessionListView { readonly current: string | undefined; readonly byId: Readonly<Record<string, SessionSummaryView | undefined>> }

/** Client summaries can originate on either platform; Host canonicalizes again before every proposal. */
export function sameWorkspaceCwd(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  const normalize = (value: string): string => {
    const slash = value.replace(/\\/g, '/')
    const trimmed = slash.length > 1 ? slash.replace(/\/+$/, '') : slash
    return /^[A-Za-z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed
  }
  return normalize(left) === normalize(right)
}

/** Public workspace snapshots expose an item list; do not assume a private byId index exists. */
export function workspacePathForDirectory(
  workspaces: readonly WorkspaceMemberView[],
  workspaceId: string | undefined,
): string | undefined {
  if (workspaceId === undefined) return undefined
  return workspaces.find(item => String(item.workspaceId) === workspaceId)?.path
}

/** Prefer a cwd-ready session, then let the Host resolve an accounted cold session from its durable registry. */
export function selectReadyWorkspaceDirectorySession(
  workspaces: readonly WorkspaceMemberView[],
  sessions: SessionListView,
  workspaceId: string | undefined,
): string | undefined {
  if (workspaceId === undefined) return undefined
  const workspace = workspaces.find(item => String(item.workspaceId) === workspaceId)
  if (workspace === undefined) return undefined
  const candidates = sessions.current === undefined
    ? workspace.sessionIds
    : [sessions.current, ...workspace.sessionIds.filter(id => id !== sessions.current)]
  const ready = candidates.find(id => {
    if (!workspace.sessionIds.some(member => String(member) === String(id))) return false
    const session = sessions.byId[String(id)]
    return session !== undefined && sameWorkspaceCwd(session.cwd, workspace.path)
  })
  if (ready !== undefined) return ready
  return workspace.sessionIds.find(id => String(id) !== '')
}
