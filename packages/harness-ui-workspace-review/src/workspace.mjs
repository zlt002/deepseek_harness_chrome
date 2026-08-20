import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 1024 * 1024
export const MAX_DIRECTORY_ENTRIES = 200
export const CAPABILITY_TTL_MS = 5 * 60 * 1000

const markdownExtensions = new Set(['.md', '.markdown'])

export function isMarkdownPath(path) {
  return markdownExtensions.has(extname(path).toLowerCase())
}

/** Parse a UI path as a bounded workspace-relative path, never as a host path. */
export function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('relativePath is required and must be at most 2048 characters')
  }
  if (value.includes('\0') || isAbsolute(value) || value.includes('\\')) {
    throw new Error('relativePath must be a relative slash-separated path')
  }
  const segments = value.split('/')
  if (segments.length > 32 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('relativePath contains an invalid workspace segment')
  }
  return segments.join('/')
}

export function isWithinRoot(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function canonicalRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('session has no project cwd')
  const root = await realpath(cwd)
  if (!(await stat(root)).isDirectory()) throw new Error('session project cwd is not a directory')
  return root
}

async function workspacePath(root, relativePath, { markdown = false } = {}) {
  const normalized = normalizeRelativePath(relativePath)
  if (markdown && !isMarkdownPath(normalized)) throw new Error('only .md and .markdown files are reviewable')
  const unresolved = resolve(root, normalized)
  if (!isWithinRoot(root, unresolved)) throw new Error('refusing a path outside the session workspace')
  let cursor = root
  let link
  for (const segment of normalized.split('/')) {
    cursor = resolve(cursor, segment)
    link = await lstat(cursor)
    if (link.isSymbolicLink()) throw new Error('symbolic links are not reviewable workspace resources')
  }
  const canonical = await realpath(unresolved)
  if (!isWithinRoot(root, canonical)) throw new Error('resolved path escapes the session workspace')
  return { normalized, canonical, link }
}

function revisionOf(file) {
  return `${String(file.dev)}:${String(file.ino)}:${String(Math.trunc(file.mtimeMs))}:${String(file.size)}`
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function opaqueId(bytes = 18) {
  return randomBytes(bytes).toString('base64url')
}

async function fileSnapshot(root, displayPath) {
  const located = await workspacePath(root, displayPath, { markdown: true })
  if (!located.link.isFile()) throw new Error('review resources must be regular files')
  if (located.link.size > MAX_FILE_BYTES) throw new Error(`Markdown file exceeds ${String(MAX_FILE_BYTES)} byte review limit`)
  const file = await open(located.canonical, 'r')
  try {
    const bytes = Buffer.alloc(located.link.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const current = await file.stat()
    if (!current.isFile()) throw new Error('review resource changed type while reading')
    if (current.size > MAX_FILE_BYTES) throw new Error(`Markdown file exceeds ${String(MAX_FILE_BYTES)} byte review limit`)
    if (revisionOf(current) !== revisionOf(located.link) || bytesRead !== current.size) {
      throw new Error('review resource changed while reading; retry the request')
    }
    const content = bytes.subarray(0, Math.min(bytesRead, MAX_SNAPSHOT_BYTES)).toString('utf8')
    return {
      displayPath: located.normalized,
      canonical: located.canonical,
      content,
      truncated: current.size > MAX_SNAPSHOT_BYTES,
      revision: revisionOf(current),
      fingerprint: digest(bytes),
      size: current.size,
    }
  } finally {
    await file.close()
  }
}

/** In-memory authority records. Restarting this runtime deliberately invalidates every capability. */
export class WorkspaceReviewRuntime {
  #reviews = new Map()
  #byResource = new Map()

  async list(cwd, requestedPath = undefined) {
    const root = await canonicalRoot(cwd)
    const displayPath = requestedPath === undefined || requestedPath === '' ? '' : normalizeRelativePath(requestedPath)
    const directory = displayPath === '' ? root : (await workspacePath(root, displayPath)).canonical
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory()) throw new Error('relativePath must name a workspace directory')
    const entries = await readdir(directory, { withFileTypes: true })
    const visible = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (visible.length >= MAX_DIRECTORY_ENTRIES) break
      if (entry.isSymbolicLink()) continue
      const child = displayPath === '' ? entry.name : `${displayPath}/${entry.name}`
      if (entry.isDirectory()) {
        visible.push({ kind: 'directory', name: entry.name, displayPath: child })
      } else if (entry.isFile() && isMarkdownPath(entry.name)) {
        const details = await lstat(resolve(directory, entry.name))
        if (details.size <= MAX_FILE_BYTES) visible.push({ kind: 'markdown', name: entry.name, displayPath: child, size: details.size })
      }
    }
    return { v: 1, relativePath: displayPath, entries: visible, truncated: entries.length > visible.length }
  }

  async open(sessionId, cwd, relativePath) {
    const root = await canonicalRoot(cwd)
    const snapshot = await fileSnapshot(root, relativePath)
    const resourceId = digest(`${root}\0${snapshot.displayPath}`)
    const resourceKey = `${sessionId}\0${resourceId}`
    const existing = this.#byResource.get(resourceKey)
    const record = existing === undefined ? {
      reviewId: opaqueId(), sessionId, root, resourceId, displayPath: snapshot.displayPath,
    } : existing
    record.canonical = snapshot.canonical
    record.revision = snapshot.revision
    record.fingerprint = snapshot.fingerprint
    this.#sign(record)
    this.#reviews.set(record.reviewId, record)
    this.#byResource.set(resourceKey, record)
    return this.#openResponse(record)
  }

  async snapshot(reviewId, capability) {
    const record = this.#authorize(reviewId, capability)
    const snapshot = await fileSnapshot(record.root, record.displayPath)
    if (snapshot.canonical !== record.canonical) throw new Error('review resource identity changed; reopen from the file tree')
    record.revision = snapshot.revision
    record.fingerprint = snapshot.fingerprint
    return {
      v: 1,
      type: 'markdown-review-snapshot',
      reviewId: record.reviewId,
      resource: this.#resource(record),
      content: snapshot.content,
      truncated: snapshot.truncated,
      readOnly: true,
    }
  }

  async rehydrate(sessionId, cwd, reviewId, resourceId) {
    const record = this.#reviews.get(reviewId)
    if (record === undefined) throw new Error('review authorization is unavailable; reopen from the file tree')
    const root = await canonicalRoot(cwd)
    if (record.sessionId !== sessionId || record.resourceId !== resourceId || record.root !== root) {
      throw new Error('review does not belong to this Harness session workspace')
    }
    this.#sign(record)
    return this.#openResponse(record)
  }

  #resource(record) {
    return { resourceId: record.resourceId, displayPath: record.displayPath, revision: record.revision, fingerprint: record.fingerprint }
  }

  #openResponse(record) {
    return { v: 1, reviewId: record.reviewId, harnessSessionId: record.sessionId, capability: record.capability, ...this.#resource(record) }
  }

  #sign(record) {
    record.capability = opaqueId(32)
    record.capabilityExpiresAt = Date.now() + CAPABILITY_TTL_MS
  }

  #authorize(reviewId, capability) {
    const record = this.#reviews.get(reviewId)
    if (record === undefined || Date.now() > record.capabilityExpiresAt) throw new Error('review capability is expired; reopen from the file tree')
    if (typeof capability !== 'string' || capability.length !== record.capability.length) throw new Error('review capability is invalid')
    if (!timingSafeEqual(Buffer.from(capability), Buffer.from(record.capability))) throw new Error('review capability is invalid')
    return record
  }
}

export { fileSnapshot }
