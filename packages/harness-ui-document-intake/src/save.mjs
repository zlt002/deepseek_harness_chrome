import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  DOCUMENT_INTAKE_MAX_BYTES,
  DOCUMENT_UPLOADS_DIR,
  documentBaseName,
  documentKindOf,
  isSafeTextDocumentBytes,
  isTextDocumentKind,
  skillForDocumentKind,
} from './formats.mjs'

/**
 * Write classified documents under the session workspace upload directory.
 * @param {string} cwd
 * @param {ReadonlyArray<{ name: string, mediaType?: string, bytes: Uint8Array }>} uploads
 * @returns {Promise<ReadonlyArray<{ name: string, relativePath: string, kind: string, skill?: string }>>}
 */
export async function saveSessionDocuments(cwd, uploads) {
  if (cwd.trim() === '') throw new Error('session has no project cwd')
  const root = resolve(cwd)
  const dest = join(root, DOCUMENT_UPLOADS_DIR)
  await mkdir(dest, { recursive: true })
  const used = new Set()
  const saved = []
  for (const upload of uploads) {
    if (upload.bytes.byteLength > DOCUMENT_INTAKE_MAX_BYTES) {
      throw new Error(`document exceeds ${String(DOCUMENT_INTAKE_MAX_BYTES)} bytes`)
    }
    const name = documentBaseName(upload.name)
    const kind = documentKindOf(name, upload.mediaType ?? '')
    if (kind === undefined) throw new Error(`unsupported document: ${name}`)
    if (isTextDocumentKind(kind) && !isSafeTextDocumentBytes(upload.bytes)) {
      throw new Error(`text document is not valid UTF-8 text: ${name}`)
    }
    const fileName = uniqueName(used, safeFileName(name))
    const absolute = join(dest, fileName)
    if (!absolute.startsWith(`${root}${sep}`) && absolute !== root) {
      throw new Error(`refusing to write outside the session workspace: ${name}`)
    }
    await writeFile(absolute, upload.bytes)
    const skill = skillForDocumentKind(kind)
    saved.push({
      name,
      relativePath: `${DOCUMENT_UPLOADS_DIR}/${fileName}`,
      kind,
      ...(skill === undefined ? {} : { skill }),
    })
  }
  return saved
}

function safeFileName(name) {
  const cleaned = name.replace(/[\0\r\n/\\]/g, '_').replace(/^\.+/u, '_').trim()
  const base = cleaned === '' ? 'document' : cleaned.slice(0, 180)
  const ext = extname(base)
  const stem = basename(base, ext) || 'document'
  return `${stem}${ext}`
}

function uniqueName(used, name) {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const ext = extname(name)
  const stem = basename(name, ext) || 'document'
  let index = 2
  let candidate = `${stem}-${String(index)}${ext}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${stem}-${String(index)}${ext}`
  }
  used.add(candidate)
  return candidate
}
