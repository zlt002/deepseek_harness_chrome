const markdownExtension = /\.(?:md|markdown)$/i
const scheme = /^[a-z][a-z\d+.-]*:/i

function decodedPath(href) {
  const withoutSuffix = href.split(/[?#]/, 1)[0]
  try { return decodeURIComponent(withoutSuffix) } catch { return undefined }
}

function slash(value) {
  return value.replaceAll('\\', '/')
}

/** Resolve a conversation Markdown destination to one safe workspace-relative review path. */
export function workspaceMarkdownLink(cwd, href) {
  if (typeof cwd !== 'string' || cwd.length === 0 || typeof href !== 'string' || href.length === 0) return undefined
  const decoded = decodedPath(href.trim())
  if (decoded === undefined || decoded.length === 0 || decoded.includes('\0')) return undefined
  if (scheme.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) return undefined

  const root = slash(cwd).replace(/\/$/, '')
  let candidate = slash(decoded)
  if (candidate.startsWith('/')) {
    if (!(candidate === root || candidate.startsWith(`${root}/`))) return undefined
    candidate = candidate.slice(root.length).replace(/^\//, '')
  } else if (/^[a-z]:\//i.test(candidate)) {
    const foldedRoot = root.toLowerCase()
    const foldedCandidate = candidate.toLowerCase()
    if (!(foldedCandidate === foldedRoot || foldedCandidate.startsWith(`${foldedRoot}/`))) return undefined
    candidate = candidate.slice(root.length).replace(/^\//, '')
  }

  candidate = candidate.replace(/^\.\//, '')
  const segments = candidate.split('/')
  if (segments.length === 0 || segments.length > 32 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return markdownExtension.test(segments.at(-1)) ? segments.join('/') : undefined
}
