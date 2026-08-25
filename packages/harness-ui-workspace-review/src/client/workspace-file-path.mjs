/**
 * Join a Host-provided, slash-separated workspace entry to the native
 * workspace root before handing it to the public system-file opener.
 * Directory entries are already constrained by the workspace-review Host;
 * validate again here so a stale UI value cannot escape its workspace.
 */
export function workspaceFilePath(workspacePath, displayPath) {
  if (workspacePath.length === 0) throw new Error('workspace path is unavailable')
  if (displayPath.length === 0 || displayPath.includes('\\') || displayPath.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('workspace file path is invalid')
  }
  const separator = workspacePath.includes('\\') ? '\\' : '/'
  return `${workspacePath.replace(/[\\/]$/, '')}${separator}${displayPath.split('/').join(separator)}`
}
