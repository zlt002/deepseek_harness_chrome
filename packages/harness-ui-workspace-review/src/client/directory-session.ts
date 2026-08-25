interface WorkspaceMemberView {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

interface SessionSummaryView { readonly id: string; readonly cwd?: string }
interface SessionListView { readonly current: string | undefined; readonly byId: Readonly<Record<string, SessionSummaryView | undefined>> }

/** A directory read is valid only for an accounted session whose Host cwd has arrived. */
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
  return candidates.find(id => {
    if (!workspace.sessionIds.some(member => String(member) === String(id))) return false
    const session = sessions.byId[String(id)]
    return session !== undefined && session.cwd === workspace.path
  })
}
