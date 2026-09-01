export const WINDOWS_NODE_REQUIREMENT_LABEL = 'Node.js 22.19.x 或 24+'

/** Match the materialized Harness engine contract: ^22.19.0 || >=24.0.0. */
export function isSupportedWindowsNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}

export function windowsNodePowerShellPredicate(versionVariable = '$nodeVersion') {
  return `(${versionVariable} -match '^v?(?<major>\\d+)\\.(?<minor>\\d+)\\.(?<patch>\\d+)' -and (([int]$Matches.major -eq 22 -and [int]$Matches.minor -ge 19) -or [int]$Matches.major -ge 24))`
}
