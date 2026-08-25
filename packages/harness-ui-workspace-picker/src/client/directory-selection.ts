/** Choose the session whose cwd represents a workspace without leaking picker view state. */
export function selectWorkspaceDirectorySession<Session extends { readonly id: string }>(
  sessions: readonly Session[],
  currentSessionId: string | undefined,
): Session | undefined {
  return sessions.find(session => session.id === currentSessionId) ?? sessions[0]
}
