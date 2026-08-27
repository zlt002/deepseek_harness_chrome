/**
 * Local-file half of the HTML Workbench.  This deliberately lives beside the
 * Native Host: the Extension proves the Browser Target and DOM identity while
 * this module is the only component allowed to write local files.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HTML_WORKBENCH_MAX_SELECTIONS = 12
export const HTML_WORKBENCH_MAX_TEXT = 4_000
export const HTML_WORKBENCH_MAX_OUTER_HTML = 16_000
export const HTML_WORKBENCH_MAX_EDIT_BYTES = 200_000
export const HTML_WORKBENCH_MAX_HTML_BYTES = 1_000_000
export const HTML_WORKBENCH_MAX_STYLESHEETS = 20
export const HTML_WORKBENCH_MAX_STYLESHEET_BYTES = 250_000
export const HTML_WORKBENCH_MAX_TOTAL_CSS_BYTES = 1_000_000

export function fingerprint(value) { return createHash('sha256').update(value).digest('hex') }
export function isFileHtmlUrl(value) {
  try { const url = new URL(value); return url.protocol === 'file:' && /\.html?$/i.test(url.pathname) } catch { return false }
}
async function assertNoSymlinkAncestor(path, label) {
  const segments = resolve(path).split(sep).filter(Boolean)
  let current = sep
  for (const segment of segments) { current = resolve(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlinked ${label} is rejected.`) }
}
function sameDirectory(left, right) { return left.dev === right.dev && left.ino === right.ino }
async function checkedDirectory(path) {
  await assertNoSymlinkAncestor(path, 'HTML Workbench write directory')
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error('HTML Workbench write directory is unavailable.')
  return { dev: info.dev, ino: info.ino }
}

// Node does not expose openat(2), but process.chdir() retains the directory
// inode after a pathname is renamed. Serialising this narrow critical section
// lets relative open/rename stay bound to the directory we just verified.
// Do not replace this with absolute-path writeFile/rename: those follow a
// swapped ancestor directory between validation and the mutation.
let anchoredDirectoryTail = Promise.resolve()
async function inAnchoredDirectory(path, expected, action) {
  const previous = anchoredDirectoryTail
  let release
  anchoredDirectoryTail = new Promise(resolve => { release = resolve })
  await previous
  const originalCwd = process.cwd()
  try {
    const current = await checkedDirectory(path)
    if (!sameDirectory(current, expected)) throw new Error('write_directory_changed: The approved local directory changed before the write; no file was written.')
    process.chdir(path)
    const anchored = await stat('.')
    if (!sameDirectory(anchored, expected)) throw new Error('write_directory_changed: The approved local directory changed before the write; no file was written.')
    return await action()
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd)
    release()
  }
}
export function htmlFilePath(url) { if (!isFileHtmlUrl(url)) throw new Error('HTML Workbench supports only a local file:// HTML Browser Target.'); return fileURLToPath(url) }
export function boundedSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value
  return typeof item.selector === 'string' && item.selector.length > 0 && item.selector.length <= 2_000
    && Array.isArray(item.structurePath) && item.structurePath.length > 0 && item.structurePath.length <= 64 && item.structurePath.every(part => typeof part === 'string' && part.length <= 256)
    && typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(item.fingerprint)
    && typeof item.text === 'string' && item.text.length <= HTML_WORKBENCH_MAX_TEXT
    && typeof item.outerHTML === 'string' && item.outerHTML.length <= HTML_WORKBENCH_MAX_OUTER_HTML
}
export function boundedSelections(value) { return Array.isArray(value) && value.length > 0 && value.length <= HTML_WORKBENCH_MAX_SELECTIONS && value.every(boundedSelection) }
export function validEdits(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(edit => edit && typeof edit === 'object' && !Array.isArray(edit)
    && typeof edit.path === 'string' && edit.path.length > 0 && edit.path.length <= 512
    && typeof edit.content === 'string' && Buffer.byteLength(edit.content) <= HTML_WORKBENCH_MAX_EDIT_BYTES)
}
function under(root, candidate) { const rel = relative(root, candidate); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(root, rel).startsWith(`..${sep}`)) }
function linkedStylesheets(html) {
  const paths = new Set()
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const rel = /\brel\s*=\s*(["'])?([^\s"'>]+)\1?/i.exec(tag)?.[2]?.toLowerCase().split(/\s+/) ?? []
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]
    if (!rel.includes('stylesheet') || !href || /^(?:https?:|\/\/|data:|blob:|javascript:)/i.test(href)) continue
    paths.add(href.split(/[?#]/, 1)[0])
  }
  return paths
}
export async function workspaceFor(url) {
  const selectedPath = resolve(htmlFilePath(url)); await assertNoSymlinkAncestor(selectedPath, 'HTML Browser Target'); const selectedStat = await lstat(selectedPath)
  if (selectedStat.isSymbolicLink()) throw new Error('Symlinked HTML Browser Target is rejected.')
  const htmlPath = await realpath(selectedPath)
  return { url: pathToFileURL(htmlPath).href, htmlPath, root: dirname(htmlPath) }
}
async function readBounded(path, maximum, label) { const info = await stat(path); if (!info.isFile() || info.size > maximum) throw new Error(`${label} exceeds the HTML Workbench safety limit.`); return readFile(path, 'utf8') }
export async function readWorkspace(url, selections = []) {
  const workspace = await workspaceFor(url)
  const html = await readBounded(workspace.htmlPath, HTML_WORKBENCH_MAX_HTML_BYTES, 'HTML file')
  const stylesheets = []
  let cssBytes = 0
  for (const href of linkedStylesheets(html)) {
    if (stylesheets.length >= HTML_WORKBENCH_MAX_STYLESHEETS) throw new Error('Too many linked CSS files for HTML Workbench.')
    const candidate = resolve(workspace.root, href)
    if (!under(workspace.root, candidate) || extname(candidate).toLowerCase() !== '.css') continue
    try { await assertNoSymlinkAncestor(candidate, 'CSS'); if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Symlinked CSS is rejected.'); const path = await realpath(candidate); if (!under(workspace.root, path)) throw new Error('Symlinked CSS is rejected.'); const content = await readBounded(path, HTML_WORKBENCH_MAX_STYLESHEET_BYTES, 'CSS file'); cssBytes += Buffer.byteLength(content); if (cssBytes > HTML_WORKBENCH_MAX_TOTAL_CSS_BYTES) throw new Error('Linked CSS exceeds the HTML Workbench aggregate safety limit.'); stylesheets.push({ path: relative(workspace.root, path), content, fingerprint: fingerprint(content) }) } catch (error) { if (error instanceof Error && /safety limit|Symlinked CSS/.test(error.message)) throw error /* a missing local stylesheet is evidence, not a write target */ }
  }
  return { ...workspace, html, fingerprint: fingerprint(html), selections: boundedSelections(selections) ? selections : [], stylesheets }
}
export function safeEditPath(workspace, path) {
  if (path.includes('\0') || path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Rejected out-of-workspace edit path: ${path}`)
  const candidate = resolve(workspace.root, path)
  if (!under(workspace.root, candidate)) throw new Error(`Rejected out-of-workspace edit path: ${path}`)
  if (candidate !== workspace.htmlPath && extname(candidate).toLowerCase() !== '.css') throw new Error('Only the bound HTML file and local relative CSS files may be edited.')
  return candidate
}
export function unifiedDiff(path, before, after) {
  if (before === after) return `--- ${path}\n+++ ${path}\n(no changes)`
  const oldLines = before.split('\n'); const newLines = after.split('\n')
  const limit = 400
  return [`--- ${path}`, `+++ ${path}`, ...oldLines.slice(0, limit).map(line => `-${line}`), ...newLines.slice(0, limit).map(line => `+${line}`)].join('\n')
}
export async function previewEdits(url, edits, selections = []) {
  if (!validEdits(edits)) throw new Error('HTML Workbench edits must be a bounded non-empty path/content list.')
  const snapshot = await readWorkspace(url, selections)
  const files = new Map([[snapshot.htmlPath, { path: relative(snapshot.root, snapshot.htmlPath) || '.', content: snapshot.html, fingerprint: snapshot.fingerprint }], ...snapshot.stylesheets.map(item => [resolve(snapshot.root, item.path), item])])
  const prepared = edits.map(edit => {
    const absolute = safeEditPath(snapshot, edit.path)
    const before = files.get(absolute)
    if (!before) throw new Error(`Only linked same-directory CSS is writable: ${edit.path}`)
    return { path: edit.path, absolute, before: before.content, beforeFingerprint: before.fingerprint, content: edit.content }
  })
  return { snapshot, edits: prepared, diff: prepared.map(edit => unifiedDiff(edit.path, edit.before, edit.content)).join('\n\n'), editFingerprint: fingerprint(JSON.stringify(prepared.map(edit => [edit.path, edit.beforeFingerprint, edit.content]))) }
}
export async function atomicWrite(edits, { beforeTemporaryCreate } = {}) {
  const groups = new Map()
  try {
    for (const edit of edits) {
      const directory = dirname(edit.absolute)
      const expected = await checkedDirectory(directory)
      const group = groups.get(directory) ?? { directory, expected, edits: [] }
      if (!sameDirectory(group.expected, expected)) throw new Error('write_directory_changed: The approved local directory changed before the write; no file was written.')
      group.edits.push(edit); groups.set(directory, group)
    }
    for (const group of groups.values()) {
      await inAnchoredDirectory(group.directory, group.expected, async () => {
        const staged = []
        try {
          for (const edit of group.edits) {
            await beforeTemporaryCreate?.(edit)
            const temporary = `.${basename(edit.absolute)}.accrui-${randomBytes(8).toString('hex')}.tmp`
            const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try { await handle.writeFile(edit.content, 'utf8'); await handle.sync() } finally { await handle.close() }
            staged.push({ temporary, target: basename(edit.absolute) })
          }
          for (const item of staged) await rename(item.temporary, item.target)
        } catch (error) {
          // Keep cleanup in the inode-bound directory. If it cannot happen,
          // the caller still receives an uncertain outcome and must not retry.
          await Promise.all(staged.map(item => rm(item.temporary, { force: true }).catch(() => {})))
          throw error
        }
      })
    }
  } catch (error) {
    // A failed rename is an uncertain external state to callers; do not retry.
    throw new Error(`atomic_write_uncertain: ${error instanceof Error ? error.message : String(error)}`)
  }
}
