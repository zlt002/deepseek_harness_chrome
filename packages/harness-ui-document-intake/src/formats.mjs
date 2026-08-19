/** Shared document-kind classification used by both Host write and Client intake. */

export const DOCUMENT_INTAKE_PATH = '/api/composer.document'
export const DOCUMENT_INTAKE_MAX_BYTES = 32 * 1024 * 1024
export const DOCUMENT_UPLOADS_DIR = '.dsh-uploads'

const KIND_BY_EXTENSION = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
}

const KIND_BY_MEDIA = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/markdown': 'md',
  'text/plain': 'txt',
}

const SKILL_BY_KIND = {
  docx: 'docx',
  pdf: 'pdf',
  pptx: 'pptx',
  xlsx: 'xlsx',
}

/**
 * Classify one uploaded file by MIME type, then by extension.
 * @param {string} name
 * @param {string} [mediaType]
 * @returns {'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt' | undefined}
 */
export function documentKindOf(name, mediaType = '') {
  const media = KIND_BY_MEDIA[mediaType.trim().toLowerCase()]
  if (media !== undefined) return media
  const match = /\.[^.]+$/.exec(name.trim().toLowerCase())
  if (match === null) return undefined
  return KIND_BY_EXTENSION[match[0]]
}

/**
 * Product office skill that should parse this kind, when one exists.
 * @param {'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt'} kind
 * @returns {string | undefined}
 */
export function skillForDocumentKind(kind) {
  return SKILL_BY_KIND[kind]
}

/**
 * Keep only the file's basename and drop path separators.
 * @param {string} name
 * @returns {string}
 */
export function documentBaseName(name) {
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''
  return base === '' ? 'document' : base
}

/**
 * Build the composer draft line that names the saved file and its parse skill.
 * @param {string} relativePath
 * @param {'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt'} kind
 * @returns {string}
 */
export function documentDraftLine(relativePath, kind) {
  const skill = skillForDocumentKind(kind)
  if (skill === undefined) {
    return `已附加文档 ${relativePath}。请先读取该文件，再根据用户问题作答。`
  }
  return `已附加文档 ${relativePath}。请先调用 /${skill} 解析该文件，再根据用户问题作答。`
}

/**
 * Refuse unsupported or oversized browser files before the Host write.
 * @param {ReadonlyArray<{ name: string, type?: string, size: number }>} files
 * @returns {string | null}
 */
export function classifyDocuments(files) {
  if (files.length === 0) return '没有可附加的文档'
  for (const file of files) {
    if (documentKindOf(file.name, file.type ?? '') === undefined) {
      return `暂不支持 ${file.name || '该文件'}。请附加 PPTX、XLSX、DOCX、PDF、MD 或 TXT。`
    }
    if (file.size > DOCUMENT_INTAKE_MAX_BYTES) {
      return `${file.name} 超过 32MB，无法附加。`
    }
  }
  return null
}
