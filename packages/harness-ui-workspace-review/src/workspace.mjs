import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 1024 * 1024
export const MAX_DIRECTORY_ENTRIES = 200
export const CAPABILITY_TTL_MS = 5 * 60 * 1000
export const APPROVAL_TTL_MS = 60 * 1000
export const MAX_REPLACEMENT_CHARS = 100_000
const MAX_PROPOSALS_PER_REVIEW = 20

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
      mode: current.mode,
    }
  } finally {
    await file.close()
  }
}

/** In-memory authority records. Restarting this runtime deliberately invalidates every capability. */
export class WorkspaceReviewRuntime {
  #reviews = new Map()
  #byResource = new Map()
  #writeFences = new Map()
  #proposalSequence = 0

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
        else visible.push({ kind: 'file', name: entry.name, displayPath: child })
      } else if (entry.isFile()) {
        visible.push({ kind: 'file', name: entry.name, displayPath: child })
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
      selections: new Map(), proposals: [], approvals: new Map(), writeResults: new Map(),
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

  async registerSelection(reviewId, capability, selection) {
    const record = this.#authorize(reviewId, capability)
    if (!selection || typeof selection !== 'object') throw new Error('workspace review selection is required')
    const id = boundedId(selection.id, 'selection id')
    const quote = boundedText(selection.quote, 8_000, 'selection quote')
    const sourceFingerprint = boundedId(selection.sourceFingerprint, 'selection fingerprint')
    const snapshot = await fileSnapshot(record.root, record.displayPath)
    if (snapshot.truncated) throw new Error('truncated Markdown snapshots cannot create AI edit selections')
    if (snapshot.canonical !== record.canonical || sourceFingerprint !== snapshot.fingerprint) {
      throw new Error('Markdown selection is stale; re-read the file and select the text again')
    }
    let registered
    if (selection.version === 2) {
      const editorRevision = selection.editorRevision; const from = selection.from; const to = selection.to
      if (!Number.isSafeInteger(editorRevision) || editorRevision < 0 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) throw new Error('visual Markdown selection range is invalid')
      if (!Array.isArray(selection.blocks) || selection.blocks.length > 24) throw new Error('visual Markdown selection blocks are invalid')
      const blocks = selection.blocks.map(block => {
        if (!block || typeof block !== 'object') throw new Error('visual Markdown selection block is invalid')
        return { kind: boundedText(block.kind, 32, 'selection block kind'), text: boundedText(block.text, 2_000, 'selection block text', true) }
      })
      const table = selection.table === undefined ? undefined : visualTableContext(selection.table)
      registered = { id, version: 2, quote, sourceFingerprint, editorRevision, from, to, blocks, ...(table === undefined ? {} : { table }), createdAt: Date.now() }
    } else {
      const start = selection.startUtf16; const end = selection.endUtf16
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > snapshot.content.length || snapshot.content.slice(start, end) !== quote) {
        throw new Error('workspace review selection range is invalid or stale')
      }
      const prefix = boundedText(selection.prefix, 512, 'selection prefix', true)
      const suffix = boundedText(selection.suffix, 512, 'selection suffix', true)
      registered = { id, version: 1, startUtf16: start, endUtf16: end, quote, prefix, suffix, sourceFingerprint, createdAt: Date.now() }
    }
    record.selections.set(id, registered)
    while (record.selections.size > 50) record.selections.delete(record.selections.keys().next().value)
    return registered
  }

  async proposeEdit(sessionId, reviewId, selectionId, replacementMarkdown, summary = '') {
    const record = this.#reviews.get(boundedId(reviewId, 'review id'))
    if (record === undefined || record.sessionId !== sessionId) throw new Error('Markdown review is not bound to the calling Harness session')
    const selection = record.selections.get(boundedId(selectionId, 'selection id'))
    if (selection === undefined) throw new Error('Markdown review selection is unavailable; ask the user to select and send it again')
    const replacement = boundedText(replacementMarkdown, MAX_REPLACEMENT_CHARS, 'replacement Markdown', true)
    const safeSummary = boundedText(summary, 1_000, 'proposal summary', true)
    const snapshot = await fileSnapshot(record.root, record.displayPath)
    if (snapshot.truncated || snapshot.fingerprint !== selection.sourceFingerprint) throw new Error('Markdown file changed after the selection was sent; no proposal was queued')
    if (selection.version === 2 && (selection.table !== undefined || selection.blocks.some(block => block.kind === 'table_cell'))) {
      if (selection.table === undefined) throw new Error('Table selection context is missing; reselect the complete table before asking AI to edit it')
      if (!isCompleteMarkdownTable(replacement, selection.table.columnCount)) {
        throw new Error(`Table edit proposals must be one complete Markdown table with a header, separator, and exactly ${String(selection.table.columnCount)} columns`)
      }
    }
    const base = {
      proposalId: opaqueId(),
      selectionId: selection.id,
      sequence: ++this.#proposalSequence,
      baseFingerprint: snapshot.fingerprint,
      summary: safeSummary,
      createdAt: Date.now(),
    }
    const proposal = selection.version === 2
      ? { ...base, kind: 'selection', replacementMarkdown: replacement, editorRevision: selection.editorRevision, from: selection.from, to: selection.to }
      : snapshot.content.slice(selection.startUtf16, selection.endUtf16) !== selection.quote
        ? (() => { throw new Error('Markdown file changed after the selection was sent; no proposal was queued') })()
        : { ...base, kind: 'document', candidateMarkdown: `${snapshot.content.slice(0, selection.startUtf16)}${replacement}${snapshot.content.slice(selection.endUtf16)}` }
    record.proposals.push(proposal)
    if (record.proposals.length > MAX_PROPOSALS_PER_REVIEW) record.proposals.splice(0, record.proposals.length - MAX_PROPOSALS_PER_REVIEW)
    return { status: 'queued', proposalId: proposal.proposalId, reviewId: record.reviewId, selectionId: selection.id }
  }

  proposals(reviewId, capability, afterSequence = 0) {
    const record = this.#authorize(reviewId, capability)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('proposal sequence must be a non-negative integer')
    return {
      v: 1,
      reviewId: record.reviewId,
      proposals: record.proposals
        .filter(proposal => proposal.sequence > afterSequence)
        .map(({ createdAt: _createdAt, ...proposal }) => proposal),
    }
  }

  async prepareWrite(reviewId, capability, expected, content) {
    const record = this.#authorize(reviewId, capability)
    if (!expected || typeof expected !== 'object' || expected.resourceId !== record.resourceId) throw new Error('write preparation resource identity does not match the review')
    const nextContent = boundedMarkdownContent(content)
    const current = await fileSnapshot(record.root, record.displayPath)
    if (current.truncated) throw new Error('truncated Markdown snapshots cannot be saved')
    if (current.canonical !== record.canonical || expected.revision !== current.revision || expected.fingerprint !== current.fingerprint) {
      return { status: 'conflict', latest: this.#snapshotResponse(record, current) }
    }
    const contentHash = digest(Buffer.from(nextContent))
    const approval = opaqueId(32)
    const prepared = {
      approval, reviewId: record.reviewId, resourceId: record.resourceId, expectedRevision: current.revision,
      expectedFingerprint: current.fingerprint, contentHash, expiresAt: Date.now() + APPROVAL_TTL_MS, used: false,
    }
    record.approvals.set(approval, prepared)
    return { status: 'prepared', approval, contentHash, expiresAt: prepared.expiresAt }
  }

  async commitWrite(reviewId, capability, approval, idempotencyKey, content) {
    const record = this.#authorize(reviewId, capability)
    const key = boundedId(idempotencyKey, 'idempotency key')
    const nextContent = boundedMarkdownContent(content)
    const contentHash = digest(Buffer.from(nextContent))
    const previous = record.writeResults.get(key)
    if (previous !== undefined) {
      if (previous.contentHash !== contentHash) throw new Error('idempotency key was already used for different Markdown content')
      return previous.result ?? previous.pending
    }
    const grant = record.approvals.get(boundedId(approval, 'approval'))
    if (grant === undefined || grant.used || Date.now() > grant.expiresAt || grant.contentHash !== contentHash) throw new Error('write approval is invalid, expired, used, or bound to different content')
    grant.used = true
    const pending = this.#withWriteFence(record.resourceId, async () => {
      const current = await fileSnapshot(record.root, record.displayPath)
      if (current.canonical !== record.canonical || current.revision !== grant.expectedRevision || current.fingerprint !== grant.expectedFingerprint) {
        return { status: 'conflict', latest: this.#snapshotResponse(record, current) }
      }
      await atomicWrite(current.canonical, nextContent, current.mode)
      const readback = await fileSnapshot(record.root, record.displayPath)
      if (readback.canonical !== record.canonical || readback.fingerprint !== contentHash || readback.content !== nextContent) {
        return { status: 'uncertain', message: 'Markdown write completed but same-resource readback did not match; re-read before retrying' }
      }
      record.revision = readback.revision
      record.fingerprint = readback.fingerprint
      return { status: 'verified_write', resource: this.#resource(record), contentHash }
    })
    record.writeResults.set(key, { contentHash, pending })
    const result = await pending
    record.writeResults.set(key, { contentHash, result })
    return result
  }

  #snapshotResponse(record, snapshot) {
    return {
      v: 1, type: 'markdown-review-snapshot', reviewId: record.reviewId,
      resource: { resourceId: record.resourceId, displayPath: record.displayPath, revision: snapshot.revision, fingerprint: snapshot.fingerprint },
      content: snapshot.content, truncated: snapshot.truncated, readOnly: true,
    }
  }

  async #withWriteFence(resourceId, operation) {
    const previous = this.#writeFences.get(resourceId) ?? Promise.resolve()
    let release
    const next = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => next)
    this.#writeFences.set(resourceId, tail)
    await previous
    try { return await operation() } finally {
      release()
      if (this.#writeFences.get(resourceId) === tail) this.#writeFences.delete(resourceId)
    }
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

function boundedId(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function boundedText(value, maximum, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.length === 0)) throw new Error(`${label} is invalid or exceeds its limit`)
  return value
}

function visualTableContext(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('visual Markdown table context is invalid')
  const table = value
  if (!Object.keys(table).every(key => ['from', 'to', 'rowCount', 'columnCount', 'selectedRowStart', 'selectedRowEnd', 'selectedColumnStart', 'selectedColumnEnd', 'isWholeTable', 'header', 'rows'].includes(key))) throw new Error('visual Markdown table context is invalid')
  const integer = (name) => {
    const item = table[name]
    if (!Number.isSafeInteger(item)) throw new Error('visual Markdown table context is invalid')
    return item
  }
  const from = integer('from'); const to = integer('to'); const rowCount = integer('rowCount'); const columnCount = integer('columnCount')
  const selectedRowStart = integer('selectedRowStart'); const selectedRowEnd = integer('selectedRowEnd')
  const selectedColumnStart = integer('selectedColumnStart'); const selectedColumnEnd = integer('selectedColumnEnd')
  if (from < 0 || to <= from || rowCount < 1 || columnCount < 1
    || selectedRowStart < 0 || selectedRowEnd < selectedRowStart || selectedRowEnd >= rowCount
    || selectedColumnStart < 0 || selectedColumnEnd < selectedColumnStart || selectedColumnEnd >= columnCount
    || typeof table.isWholeTable !== 'boolean') throw new Error('visual Markdown table context is invalid')
  const tableRow = (value) => {
    if (!Array.isArray(value) || value.length !== columnCount) throw new Error('visual Markdown table context is invalid')
    return value.map(cell => boundedText(cell, 2_000, 'visual Markdown table cell', true))
  }
  const header = tableRow(table.header)
  if (!Array.isArray(table.rows) || table.rows.length + 1 !== rowCount) throw new Error('visual Markdown table context is invalid')
  const rows = table.rows.map(tableRow)
  return { from, to, rowCount, columnCount, selectedRowStart, selectedRowEnd, selectedColumnStart, selectedColumnEnd, isWholeTable: table.isWholeTable, header, rows }
}

function markdownTableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined
  const cells = []
  let cell = ''
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]
    if (character === '\\' && index + 1 < trimmed.length - 1) {
      cell += character + trimmed[index + 1]
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += character
  }
  cells.push(cell.trim())
  return cells
}

function isCompleteMarkdownTable(candidate, columnCount) {
  const lines = candidate.trim().split(/\r?\n/)
  if (lines.length < 3 || lines.some(line => line.trim() === '')) return false
  const header = markdownTableCells(lines[0]); const separator = markdownTableCells(lines[1])
  return header?.length === columnCount && separator?.length === columnCount
    && separator.every(cell => /^:?-{3,}:?$/.test(cell))
    && lines.slice(2).every(line => markdownTableCells(line)?.length === columnCount)
}

function boundedMarkdownContent(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) throw new Error('Markdown content is invalid or exceeds its byte limit')
  return value
}

async function atomicWrite(path, content, mode) {
  const temp = resolve(dirname(path), `.${basename(path)}.${opaqueId(9)}.tmp`)
  const file = await open(temp, 'wx', mode & 0o777)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await file.close()
  try {
    await chmod(temp, mode & 0o777)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export { fileSnapshot }
