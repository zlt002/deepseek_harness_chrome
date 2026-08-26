import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'

export const CLAUDE_IMPORT_PATH = '/api/claude-code.import'
export const MAX_PROJECTS = 500
export const MAX_SESSIONS = 2_000
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const MAX_SESSION_PAGE_SIZE = 64
const MAX_PREVIEW_BYTES = 64 * 1024
const MAX_LINES = 20_000
const MAX_TEXT_CHARS = 120_000

export class ClaudeImportDirectory {
  constructor(options = {}) {
    this.root = path.resolve(options.root ?? path.join(homedir(), '.claude', 'projects'))
    this.registryPath = options.registryPath ?? defaultRegistryPath()
    this.registryMutation = Promise.resolve()
  }

  async listProjects(sourceRoot = this.root) {
    const root = await this.canonicalRoot(sourceRoot, true)
    const entries = await safeDirectory(root)
    const projects = []
    for (const entry of entries.slice(0, MAX_PROJECTS)) {
      if (!entry.isDirectory() || !safeSegment(entry.name)) continue
      const directory = path.join(root, entry.name)
      const sessions = (await safeDirectory(directory)).filter(item => item.isFile() && item.name.endsWith('.jsonl') && safeSessionFile(item.name))
      if (sessions.length === 0) continue
      const newest = (await stat(directory)).mtime.toISOString()
      projects.push({ key: entry.name, label: projectLabel(entry.name), sessionCount: Math.min(sessions.length, MAX_SESSIONS), updatedAt: newest })
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { sourceRoot: root, projects, truncated: entries.length > MAX_PROJECTS }
  }

  async listSessions(projectKey, sourceRoot = this.root, options = {}) {
    const root = await this.canonicalRoot(sourceRoot)
    const directory = this.projectDirectory(projectKey, root)
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries.filter(item => item.isFile() && item.name.endsWith('.jsonl') && safeSessionFile(item.name)).slice(0, MAX_SESSIONS)
    const offset = boundedInteger(options.offset, 0, MAX_SESSIONS, 0, 'offset')
    const limit = boundedInteger(options.limit, 1, MAX_SESSION_PAGE_SIZE, MAX_SESSION_PAGE_SIZE, 'limit')
    const metadata = await mapLimit(files, 32, async entry => ({ entry, info: await stat(path.join(directory, entry.name)) }))
    metadata.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.entry.name.localeCompare(b.entry.name))
    const page = metadata.slice(offset, offset + limit)
    const sessions = await mapLimit(page, 16, async ({ entry, info }) => {
      const file = path.join(directory, entry.name)
      const preview = await readPrefix(file, MAX_PREVIEW_BYTES)
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      return { sessionId, title: previewTitle(preview) ?? `Claude 会话 ${sessionId.slice(0, 8)}`, updatedAt: info.mtime.toISOString(), size: info.size }
    })
    const nextOffset = offset + sessions.length
    return { sourceRoot: root, sessions, total: metadata.length, offset, nextOffset, done: nextOffset >= metadata.length, truncated: entries.length > MAX_SESSIONS }
  }

  async prepare({ projectKey, sessionId, workspacePath, sourceRoot = this.root, forceCopy = false, signal }) {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('目标工作区必须是绝对路径')
    const root = await this.canonicalRoot(sourceRoot)
    const sourceFile = this.sessionFile(projectKey, sessionId, root)
    const sourceKey = stableSourceKey(root, projectKey, sessionId, workspacePath)
    const registry = await this.readRegistry()
    if (!forceCopy && registry[sourceKey] !== undefined) return { kind: 'existing', sourceKey, sessionId: registry[sourceKey].sessionId }
    const info = await stat(sourceFile)
    if (!info.isFile()) throw new Error('Claude Code 会话文件不存在')
    if (info.size > MAX_SOURCE_BYTES) throw new Error(`Claude Code 会话超过 ${String(MAX_SOURCE_BYTES / 1024 / 1024)} MB 安全上限`)
    const raw = await readFile(sourceFile, { encoding: 'utf8', signal })
    const parsed = parseClaudeSession(raw)
    return { kind: 'prepared', sourceKey, title: parsed.title, prompt: continuationPrompt(parsed), sourceUpdatedAt: info.mtime.toISOString() }
  }

  async commit({ sourceKey, sessionId, sourceRoot = this.root }) {
    if (!/^[a-f0-9]{64}$/.test(sourceKey) || typeof sessionId !== 'string' || sessionId.length < 8) throw new Error('导入提交标识无效')
    await this.canonicalRoot(sourceRoot)
    const operation = this.registryMutation.then(async () => {
      const registry = await this.readRegistry()
      registry[sourceKey] = { sessionId, importedAt: new Date().toISOString() }
      await mkdir(path.dirname(this.registryPath), { recursive: true })
      const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.registryPath)
      return { committed: true }
    })
    this.registryMutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async canonicalRoot(sourceRoot, allowMissingDefault = false) {
    const requested = sourceRoot === 'default' ? this.root : sourceRoot
    if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Claude projects 目录必须是绝对路径')
    let canonical
    try { canonical = await realpath(requested) } catch (error) {
      if (allowMissingDefault && sourceRoot === 'default' && error?.code === 'ENOENT') return this.root
      throw new Error(`无法打开 Claude projects 目录：${error instanceof Error ? error.message : String(error)}`)
    }
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('Claude projects 来源必须是目录')
    return canonical
  }

  projectDirectory(projectKey, root = this.root) {
    if (!safeSegment(projectKey)) throw new Error('Claude Code 项目标识无效')
    return boundedChild(root, projectKey)
  }

  sessionFile(projectKey, sessionId, root = this.root) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Claude Code 会话标识无效')
    return boundedChild(this.projectDirectory(projectKey, root), `${sessionId}.jsonl`)
  }

  async readRegistry() {
    try {
      const value = JSON.parse(await readFile(this.registryPath, 'utf8'))
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw new Error(`无法读取 Claude Code 导入记录：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function parseClaudeSession(raw) {
  const messages = []
  let title
  let sourceSessionId
  const lines = raw.split(/\r?\n/)
  if (lines.length > MAX_LINES) throw new Error(`Claude Code 会话超过 ${String(MAX_LINES)} 行安全上限`)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch (error) { throw new Error(`Claude Code JSONL 第 ${String(index + 1)} 行无效：${error instanceof Error ? error.message : String(error)}`) }
    if (sourceSessionId === undefined && typeof record.sessionId === 'string') sourceSessionId = record.sessionId
    if (record.type !== 'user' && record.type !== 'assistant') continue
    const text = messageText(record)
    if (text === '') continue
    if (title === undefined && record.type === 'user') title = titlePreview(text).slice(0, 80)
    messages.push({ role: record.type, text, timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined })
  }
  if (messages.length === 0) throw new Error('Claude Code 会话没有可迁移的用户或助手文本')
  return { sourceSessionId, title: title ?? '从 Claude Code 导入', messages: boundedRecent(messages) }
}

function continuationPrompt(parsed) {
  const transcript = parsed.messages.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n')
  return [
    '以下内容是用户刚刚明确选择、从 Claude Code 会话迁移来的上下文。请把它视为本会话之前已经发生的对话，并基于这些信息继续工作。不要声称你执行过其中未验证的操作；需要时重新核验当前工作区。',
    '',
    `<claude-code-migration source-session="${escapeAttribute(parsed.sourceSessionId ?? 'unknown')}">`,
    transcript,
    '</claude-code-migration>',
    '',
    '请简短确认已接续上下文，并说明当前最适合继续的下一步。',
  ].join('\n')
}

function messageText(record, allowPartialWrapper = false) {
  if (record?.isMeta === true) return ''
  const content = record?.message?.content
  if (typeof content === 'string') return stripSyntheticPrefix(content, allowPartialWrapper)
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [stripSyntheticPrefix(block.text, allowPartialWrapper)] : []).filter(Boolean).join('\n')
}

function stripSyntheticPrefix(value, allowPartialWrapper) {
  let text = value.trim()
  const wrappers = ['browser_context', 'system-reminder', 'language_instruction', 'command-name', 'local-command-caveat', 'local-command-stdout', 'ide_opened_file', 'available-deferred-tools']
  // Claude Code wraps some real user messages in this marker. Unlike the
  // synthetic wrappers above, its contents are the text the user wrote.
  const contentWrappers = ['用户原始请求']
  let changed = true
  while (changed) {
    changed = false
    for (const wrapper of wrappers) {
      const paired = new RegExp(`^<${wrapper}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${wrapper}>\\s*`, 'i')
      const selfClosing = new RegExp(`^<${wrapper}(?:\\s[^>]*)?\\s*\\/>\\s*`, 'i')
      const next = text.replace(paired, '').replace(selfClosing, '')
      if (next !== text) { text = next.trim(); changed = true }
    }
    for (const wrapper of contentWrappers) {
      const paired = new RegExp(`^<${wrapper}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${wrapper}>`, 'i')
      const next = text.replace(paired, '$1')
      if (next !== text) { text = next.trim(); changed = true }
    }
  }
  if (allowPartialWrapper && text.length > 4_096 && wrappers.some(wrapper => new RegExp(`^<${wrapper}(?:\\s|>)`, 'i').test(text))) return ''
  return text
}

function boundedRecent(messages) {
  const selected = []
  let chars = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (chars + message.text.length > MAX_TEXT_CHARS && selected.length > 0) break
    const remaining = Math.max(0, MAX_TEXT_CHARS - chars)
    selected.push({ ...message, text: message.text.slice(Math.max(0, message.text.length - remaining)) })
    chars += Math.min(message.text.length, remaining)
    if (chars >= MAX_TEXT_CHARS) break
  }
  return selected.reverse()
}

function previewTitle(raw) {
  for (const line of raw.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line)
      if (record.type !== 'user') continue
      const text = messageText(record, true)
      if (text !== '') return titlePreview(text).slice(0, 80)
    } catch { /* A partial final preview line is expected. Full parsing remains strict. */ }
  }
}

function projectLabel(key) {
  const decoded = key.replace(/^-+/, '/').replace(/-/g, '/')
  const last = decoded.split('/').filter(Boolean).at(-1)
  return last === undefined ? key : last
}
function oneLine(text) { return text.replace(/\s+/g, ' ').trim() }
function titlePreview(text) { return oneLine(text.split(/\r?\n/)[0] ?? '') }
function boundedInteger(value, min, max, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Claude Code 会话分页 ${name} 无效`)
  return value
}
function safeSegment(value) { return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') }
function safeSessionFile(value) { return /^[A-Za-z0-9_-]{8,128}\.jsonl$/.test(value) }
function boundedChild(root, child) {
  const result = path.resolve(root, child)
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Claude Code 路径越界')
  return result
}
async function safeDirectory(directory) {
  try { return await readdir(directory, { withFileTypes: true }) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
}
async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor; cursor += 1; output[index] = await mapper(values[index], index) }
  }))
  return output
}
async function readPrefix(file, bytes) {
  const handle = await open(file, 'r')
  try { const buffer = Buffer.alloc(bytes); const result = await handle.read(buffer, 0, bytes, 0); return buffer.subarray(0, result.bytesRead).toString('utf8') } finally { await handle.close() }
}
function stableSourceKey(sourceRoot, projectKey, sessionId, workspacePath) { return createHash('sha256').update(`${sourceRoot}\0${projectKey}\0${sessionId}\0${path.resolve(workspacePath)}`).digest('hex') }
function escapeAttribute(value) { return value.replace(/[&"<>]/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]) }
function defaultRegistryPath() {
  if (platform() === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness', 'claude-code-imports.json')
  if (platform() === 'win32') return path.join(process.env.APPDATA ?? homedir(), 'DeepSeekHarness', 'claude-code-imports.json')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'DeepSeekHarness', 'claude-code-imports.json')
}
