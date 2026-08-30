/** Refresh the public session baseline before opening a Host-created cold session. */
export async function openImportedSession(sessions, sessionId) {
  await sessions.refresh()
  if (sessions.list.getSnapshot().byId[sessionId] === undefined) return false
  sessions.open(sessionId)
  return true
}
