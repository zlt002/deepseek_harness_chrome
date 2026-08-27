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
  // Data, configuration, and source files are retained as plain UTF-8 text.
  // Keep this an explicit allowlist: file names alone must not turn arbitrary
  // binaries into a text attachment.
  '.json': 'txt',
  '.ipynb': 'txt',
  '.jsonl': 'txt',
  '.ndjson': 'txt',
  '.yaml': 'txt',
  '.yml': 'txt',
  '.toml': 'txt',
  '.ini': 'txt',
  '.cfg': 'txt',
  '.conf': 'txt',
  '.env': 'txt',
  '.log': 'txt',
  '.csv': 'txt',
  '.tsv': 'txt',
  '.xml': 'txt',
  '.html': 'txt',
  '.htm': 'txt',
  '.css': 'txt',
  '.js': 'txt',
  '.mjs': 'txt',
  '.cjs': 'txt',
  '.ts': 'txt',
  '.tsx': 'txt',
  '.jsx': 'txt',
  '.vue': 'txt',
  '.svelte': 'txt',
  '.astro': 'txt',
  '.py': 'txt',
  '.rb': 'txt',
  '.go': 'txt',
  '.rs': 'txt',
  '.java': 'txt',
  '.c': 'txt',
  '.h': 'txt',
  '.cc': 'txt',
  '.cpp': 'txt',
  '.cxx': 'txt',
  '.hpp': 'txt',
  '.cs': 'txt',
  '.php': 'txt',
  '.swift': 'txt',
  '.kt': 'txt',
  '.kts': 'txt',
  '.sh': 'txt',
  '.bash': 'txt',
  '.zsh': 'txt',
  '.fish': 'txt',
  '.ps1': 'txt',
  '.bat': 'txt',
  '.cmd': 'txt',
  '.sql': 'txt',
  '.graphql': 'txt',
  '.gql': 'txt',
  '.r': 'txt',
  '.lua': 'txt',
  '.pl': 'txt',
  '.pm': 'txt',
  '.dart': 'txt',
  '.scala': 'txt',
  '.ex': 'txt',
  '.exs': 'txt',
  '.erl': 'txt',
  '.hrl': 'txt',
  '.fs': 'txt',
  '.fsx': 'txt',
  '.vb': 'txt',
  '.clj': 'txt',
  '.cljs': 'txt',
  '.edn': 'txt',
  '.lisp': 'txt',
  '.scm': 'txt',
  '.rkt': 'txt',
  '.tex': 'txt',
  '.properties': 'txt',
  '.gradle': 'txt',
  '.lock': 'txt',
  '.proto': 'txt',
  '.rst': 'txt',
  '.adoc': 'txt',
  '.org': 'txt',
  '.wiki': 'txt',
  '.diff': 'txt',
  '.patch': 'txt',
  '.dockerignore': 'txt',
  '.gitignore': 'txt',
  '.gitattributes': 'txt',
  '.gitmodules': 'txt',
  '.editorconfig': 'txt',
  '.npmrc': 'txt',
  '.nvmrc': 'txt',
  '.babelrc': 'txt',
  '.prettierrc': 'txt',
  '.eslintrc': 'txt',
  '.stylelintrc': 'txt',
  '.browserslistrc': 'txt',
}

const KIND_BY_MEDIA = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'txt',
  'application/x-ndjson': 'txt',
  'application/ndjson': 'txt',
  'application/jsonl': 'txt',
  'application/yaml': 'txt',
  'application/x-yaml': 'txt',
  'application/toml': 'txt',
  'application/xml': 'txt',
  'application/graphql': 'txt',
  'application/x-httpd-php': 'txt',
}

const KIND_BY_FILE_NAME = {
  readme: 'txt',
  license: 'txt',
  copying: 'txt',
  notice: 'txt',
  changelog: 'txt',
  makefile: 'txt',
  dockerfile: 'txt',
}

/** Shared picker and drop allowlist; extensions include their leading dot. */
export const DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS = Object.freeze(Object.keys(KIND_BY_EXTENSION))

/** MIME fallback for extensionless files only; unknown extensions stay rejected. */
export const DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES = Object.freeze(Object.keys(KIND_BY_MEDIA))

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
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim().toLowerCase() ?? ''
  const match = /\.[^.]+$/.exec(base)
  // An explicit extension wins over MIME. Browsers commonly label arbitrary
  // files as text/plain; accepting an unknown extension from that MIME would
  // make the visible picker rule and the drop rule disagree.
  if (match !== null) return KIND_BY_EXTENSION[match[0]]
  const named = KIND_BY_FILE_NAME[base]
  if (named !== undefined) return named
  return KIND_BY_MEDIA[mediaType.trim().toLowerCase()]
}

/** True when a kind is stored as a UTF-8 text attachment rather than an office binary. */
export function isTextDocumentKind(kind) {
  return kind === 'md' || kind === 'txt'
}

/** Reject bytes that cannot safely be treated as UTF-8 text. */
export function isSafeTextDocumentBytes(bytes) {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
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
      return `暂不支持 ${file.name || '该文件'}。请附加 Office/PDF 或常见文本、代码、配置和数据文件。`
    }
    if (file.size > DOCUMENT_INTAKE_MAX_BYTES) {
      return `${file.name} 超过 32MB，无法附加。`
    }
  }
  return null
}
