interface SessionLookup {
  get(id: string): { header: { cwd?: string } } | undefined
}

interface WorkspaceLookup {
  list(): readonly { readonly path: string; readonly sessionIds: readonly string[] }[]
}

export interface SessionProjectContext {
  readonly sessions: SessionLookup
  readonly workspaceRegistry: WorkspaceLookup
}

/** Resolve both live and cold sessions through Host-authoritative project ownership. */
export function resolveSessionProject(ctx: SessionProjectContext, value: unknown): { id: string; cwd: string } {
  const id = typeof value === 'string' && value !== '' ? value : undefined
  if (id === undefined) throw new Error('workspace review requires sessionId')

  const liveCwd = ctx.sessions.get(id)?.header.cwd
  if (liveCwd !== undefined && liveCwd !== '') return { id, cwd: liveCwd }

  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.some(sessionId => String(sessionId) === id))
  if (workspace !== undefined && workspace.path !== '') return { id, cwd: workspace.path }

  throw new Error(`session "${id}" has no project cwd`)
}
