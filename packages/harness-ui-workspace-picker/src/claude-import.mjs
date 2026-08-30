import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export const CLAUDE_IMPORT_PATH = '/api/claude-code.import'
export const MAX_PROJECTS = 500
export const MAX_SESSIONS = 2_000
export const MAX_SESSION_PAGE_SIZE = 64
const MAX_PREVIEW_BYTES = 64 * 1024
const MAX_LINES = 20_000
const MAX_TEXT_CHARS = 120_000
const MAX_NATIVE_CONTENT_CHARS = 512_000
const MAX_NATIVE_RECORDS = 2_000
const MAX_TOOL_BLOCKS = 128
const MAX_TOOL_CONTENT_CHARS = 4_000

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
    const info = await stat(sourceFile)
    if (!info.isFile()) throw new Error('Claude Code 会话文件不存在')
    const revision = await sourceRevision(sourceFile, info, signal)
    const registry = await this.readRegistry()
    const existing = registry[sourceKey]
    if (!forceCopy && existing?.pending !== undefined) {
      const parsed = await parseClaudeSessionFile(sourceFile, signal)
      const after = await stat(sourceFile)
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Claude Code 会话在读取时发生变化，请稍后重试。')
      if (parsed.sourceSessionId !== undefined && parsed.sourceSessionId !== sessionId) {
        throw new Error('所选文件是 Claude Code 辅助或子代理记录，不会作为独立主会话导入。')
      }
      if (!sameRevision(existing.source, revision) || !seedPrefixMatches({ seedSignature: existing.seedSignature, seedEventCount: existing.seedEventCount }, parsed.seed)) {
        return { kind: 'conflict', sourceKey, sessionId: existing.sessionId, reason: '上次导入未完成且 Claude Code 来源已变化；为避免把历史错序写入现有会话，请重新导入为副本。' }
      }
      const pending = existing.pending
      if (!isPendingImport(pending) || !Number.isSafeInteger(existing.harnessNextSeq)) {
        return { kind: 'conflict', sourceKey, sessionId: existing.sessionId, reason: '上次导入恢复记录不完整；请重新导入为副本。' }
      }
      const previousSeedEventCount = pending.mode === 'append' ? pending.previousSeedEventCount : 0
      if (!Number.isSafeInteger(previousSeedEventCount) || previousSeedEventCount < 0 || previousSeedEventCount > parsed.seed.length) {
        return { kind: 'conflict', sourceKey, sessionId: existing.sessionId, reason: '上次导入恢复记录无效；请重新导入为副本。' }
      }
      return {
        kind: 'pending', sourceKey, sessionId: existing.sessionId, title: parsed.title, createdAt: parsed.createdAt,
        seed: pending.mode === 'append' ? parsed.seed.slice(previousSeedEventCount) : parsed.seed,
        seedSignature: existing.seedSignature, sourceIdentity: sourceIdentity(parsed), revision,
        seedEventCount: existing.seedEventCount, harnessNextSeq: existing.harnessNextSeq,
        pending, details: parsed.details,
      }
    }
    if (!forceCopy && existing !== undefined && existing.source === undefined) return { kind: 'existing', sourceKey, sessionId: existing.sessionId }
    if (!forceCopy && existing !== undefined && sameRevision(existing.source, revision)) return { kind: 'existing', sourceKey, sessionId: existing.sessionId }
    const parsed = await parseClaudeSessionFile(sourceFile, signal)
    const after = await stat(sourceFile)
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Claude Code 会话在读取时发生变化，请稍后重试。')
    if (parsed.sourceSessionId !== undefined && parsed.sourceSessionId !== sessionId) {
      throw new Error('所选文件是 Claude Code 辅助或子代理记录，不会作为独立主会话导入。')
    }
    if (!forceCopy && existing !== undefined) {
      if (await isStrictAppend(sourceFile, existing.source, revision, parsed.seed.length, existing.seedEventCount, signal) && seedPrefixMatches(existing, parsed.seed)) {
        return { kind: 'append', sourceKey, sessionId: existing.sessionId, title: parsed.title, seed: parsed.seed.slice(existing.seedEventCount), seedSignature: seedSignature(parsed.seed), sourceIdentity: sourceIdentity(parsed), revision, sourceUpdatedAt: info.mtime.toISOString() }
      }
      return { kind: 'conflict', sourceKey, sessionId: existing.sessionId, reason: 'Claude Code 来源已缩短或被原地修改；为避免把历史错序写入现有会话，请重新导入为副本。' }
    }
    return { kind: 'prepared', sourceKey, title: parsed.title, createdAt: parsed.createdAt, seed: parsed.seed, seedSignature: seedSignature(parsed.seed), sourceIdentity: sourceIdentity(parsed), revision, sourceUpdatedAt: info.mtime.toISOString(), details: parsed.details }
  }

  async detail({ projectKey, sessionId, sourceRoot = this.root, signal }) {
    const root = await this.canonicalRoot(sourceRoot)
    const sourceFile = this.sessionFile(projectKey, sessionId, root)
    const info = await stat(sourceFile)
    if (!info.isFile()) throw new Error('Claude Code 会话文件不存在')
    const parsed = await parseClaudeSessionFile(sourceFile, signal)
    if (parsed.sourceSessionId !== undefined && parsed.sourceSessionId !== sessionId) {
      throw new Error('所选文件是 Claude Code 辅助或子代理记录，不会作为独立主会话导入。')
    }
    return { title: parsed.title, messages: parsed.messages, truncated: parsed.truncated, sourceUpdatedAt: info.mtime.toISOString(), details: parsed.details, cwd: parsed.cwd, model: parsed.model }
  }

  async commit({ sourceKey, sessionId, sourceRoot = this.root, source, sourceIdentity: identity, seed, seedSignatureValue, seedEventCount, harnessNextSeq }) {
    return this.writeRecord({ sourceKey, sessionId, sourceRoot, source, sourceIdentity: identity, seed, seedSignatureValue, seedEventCount, harnessNextSeq })
  }

  async reserve({ sourceKey, sessionId, sourceRoot = this.root, source, sourceIdentity: identity, seed, seedSignatureValue, seedEventCount, harnessNextSeq, pending }) {
    if (!isPendingImport(pending)) throw new Error('导入恢复状态无效')
    return this.writeRecord({ sourceKey, sessionId, sourceRoot, source, sourceIdentity: identity, seed, seedSignatureValue, seedEventCount, harnessNextSeq, pending })
  }

  async writeRecord({ sourceKey, sessionId, sourceRoot = this.root, source, sourceIdentity: identity, seed, seedSignatureValue, seedEventCount, harnessNextSeq, pending }) {
    if (!/^[a-f0-9]{64}$/.test(sourceKey) || typeof sessionId !== 'string' || sessionId.length < 8) throw new Error('导入提交标识无效')
    await this.canonicalRoot(sourceRoot)
    const operation = this.registryMutation.then(async () => {
      const registry = await this.readRegistry()
      registry[sourceKey] = {
        sessionId, importedAt: new Date().toISOString(),
        ...source === undefined ? {} : { source },
        ...identity === undefined ? {} : { sourceIdentity: identity },
        ...Number.isSafeInteger(seedEventCount) ? { seedEventCount } : {},
        ...Array.isArray(seed) ? { seedSignature: seedSignature(seed) } : typeof seedSignatureValue === 'string' ? { seedSignature: seedSignatureValue } : {},
        ...Number.isSafeInteger(harnessNextSeq) ? { harnessNextSeq } : {},
        ...pending === undefined ? {} : { pending },
      }
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

function isPendingImport(value) {
  return value !== null && typeof value === 'object'
    && (value.mode === 'seed' || (value.mode === 'append' && Number.isSafeInteger(value.previousHarnessNextSeq) && Number.isSafeInteger(value.previousSeedEventCount)))
}

export function parseClaudeSession(raw) {
  const parser = createClaudeSessionParser()
  const lines = raw.split(/\r?\n/)
  if (lines.length > MAX_LINES) throw new Error(`Claude Code 会话超过 ${String(MAX_LINES)} 行安全上限`)
  lines.forEach((line, index) => parser.push(line, index + 1))
  return parser.finish()
}

async function parseClaudeSessionFile(file, signal) {
  const stream = createReadStream(file, { encoding: 'utf8', signal })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const parser = createClaudeSessionParser()
  let lineNumber = 0
  try {
    for await (const line of reader) {
      lineNumber += 1
      if (lineNumber > MAX_LINES) throw new Error(`Claude Code 会话超过 ${String(MAX_LINES)} 行安全上限`)
      parser.push(line, lineNumber)
    }
    return parser.finish()
  } finally {
    reader.close()
    stream.destroy()
  }
}

function createClaudeSessionParser() {
  const sourceRecords = []
  const unsupported = new Set()
  let retainedChars = 0
  let truncated = false
  let title
  let aiTitle
  let customTitle
  let sourceSessionId
  let cwd
  let model
  let createdAt
  let toolBlocks = 0
  let droppedRecords = 0
  return {
    push(line, lineNumber) {
      if (line.trim() === '') return
      let record
      try { record = JSON.parse(line) } catch (error) { throw new Error(`Claude Code JSONL 第 ${String(lineNumber)} 行无效：${error instanceof Error ? error.message : String(error)}`) }
      if (sourceSessionId === undefined && typeof record.sessionId === 'string') sourceSessionId = record.sessionId
      if (cwd === undefined && typeof record.cwd === 'string') cwd = record.cwd
      if (model === undefined && typeof record?.message?.model === 'string') model = record.message.model
      if (createdAt === undefined) {
        const timestamp = Date.parse(record?.timestamp)
        if (Number.isSafeInteger(timestamp) && timestamp >= 0) createdAt = timestamp
      }
      if (record?.type === 'ai-title' && typeof record.aiTitle === 'string' && aiTitle === undefined) aiTitle = record.aiTitle
      if (record?.type === 'summary') {
        const candidate = typeof record.summary === 'string' && record.summary.trim() !== ''
          ? record.summary
          : typeof record.title === 'string' && record.title.trim() !== '' ? record.title : undefined
        if (candidate !== undefined) customTitle = candidate
      }
      if (record?.type === 'permission') unsupported.add('permission')
      if (record?.isSidechain === true || typeof record?.agentId === 'string') {
        unsupported.add('subagent')
        return
      }
      if (record.type !== 'user' && record.type !== 'assistant') return
      const content = sourceContent(record, Math.max(0, MAX_TOOL_BLOCKS - toolBlocks))
      toolBlocks += content.tools.length + content.results.length
      for (const item of content.unsupported) unsupported.add(item)
      if (content.truncated) truncated = true
      if (content.text === '' && content.tools.length === 0 && content.results.length === 0 && content.thinking === '') return
      if (title === undefined && record.type === 'user' && content.text !== '') title = titlePreview(content.text).slice(0, 80)
      const sourceRecord = {
        role: record.type,
        timestamp: timestampOf(record),
        ...record.type === 'assistant' && typeof record?.message?.model === 'string' ? { model: record.message.model } : {},
        ...content,
      }
      sourceRecords.push(sourceRecord)
      retainedChars += sourceRecordChars(sourceRecord)
      while (sourceRecords.length > 1 && (sourceRecords.length > MAX_NATIVE_RECORDS || retainedChars > MAX_NATIVE_CONTENT_CHARS)) {
        const removed = sourceRecords.shift()
        retainedChars -= sourceRecordChars(removed)
        droppedRecords += 1
        truncated = true
      }
      if (sourceRecords.length === 1 && retainedChars > MAX_NATIVE_CONTENT_CHARS) {
        const bounded = boundSourceRecord(sourceRecords[0], MAX_NATIVE_CONTENT_CHARS)
        sourceRecords[0] = bounded.record
        retainedChars = sourceRecordChars(bounded.record)
        if (bounded.truncated) { unsupported.add('content-limit'); truncated = true }
      }
    },
    finish() {
      if (sourceRecords.length === 0 && unsupported.has('subagent')) {
        throw new Error('所选文件是 Claude Code 辅助或子代理记录，不会作为独立主会话导入。')
      }
      if (sourceRecords.length === 0) throw new Error('Claude Code 会话没有可迁移的用户或助手文本')
      if (droppedRecords > 0) unsupported.add('record-limit')
      const finalTitle = normalizeTitle(customTitle ?? aiTitle ?? title ?? '从 Claude Code 导入')
      const messages = boundedDetailMessages(sourceRecords)
      const parsed = { sourceSessionId, cwd, model, createdAt, title: finalTitle, messages, truncated, sourceRecords, unsupported: [...unsupported] }
      const built = buildHarnessSeed(parsed)
      if (built.turnCount === 0) throw new Error('Claude Code 会话没有可迁移的主对话轮次')
      return { ...parsed, seed: built.events, details: importDetails(parsed, built) }
    },
  }
}

function sourceContent(record, remainingTools) {
  if (record?.isMeta === true) return emptySourceContent()
  const content = record?.message?.content
  if (typeof content === 'string') {
    const bounded = redactAndBound(stripSyntheticPrefix(content), MAX_TEXT_CHARS, true)
    return { text: bounded.text, thinking: '', tools: [], results: [], unsupported: [], truncated: bounded.truncated }
  }
  if (!Array.isArray(content)) return emptySourceContent()
  const output = { text: [], thinking: [], tools: [], results: [], unsupported: [], truncated: false }
  let acceptedTools = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const bounded = redactAndBound(stripSyntheticPrefix(block.text), MAX_TEXT_CHARS, true)
      output.text.push(bounded.text); output.truncated ||= bounded.truncated
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      const bounded = redactAndBound(block.thinking, MAX_TOOL_CONTENT_CHARS)
      output.thinking.push(bounded.text); output.truncated ||= bounded.truncated
    } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      if (acceptedTools >= remainingTools) { output.unsupported.push('tool-limit'); output.truncated = true; continue }
      const bounded = redactAndBound(block.input, MAX_TOOL_CONTENT_CHARS)
      output.tools.push({ id: block.id, name: block.name, input: bounded.text }); output.truncated ||= bounded.truncated; acceptedTools += 1
    } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      if (acceptedTools >= remainingTools) { output.unsupported.push('tool-limit'); output.truncated = true; continue }
      const result = toolResultText(block.content)
      const bounded = redactAndBound(result.text, MAX_TOOL_CONTENT_CHARS)
      output.results.push({ id: block.tool_use_id, content: bounded.text, isError: block.is_error === true })
      output.unsupported.push(...result.unsupported); output.truncated ||= bounded.truncated || result.truncated; acceptedTools += 1
    } else if (block?.type !== undefined) output.unsupported.push(String(block.type))
  }
  const text = redactAndBound(output.text.filter(Boolean).join('\n'), MAX_TEXT_CHARS, true)
  const thinking = redactAndBound(output.thinking.filter(Boolean).join('\n'), MAX_TOOL_CONTENT_CHARS)
  return { text: text.text, thinking: thinking.text, tools: output.tools, results: output.results, unsupported: output.unsupported, truncated: output.truncated || text.truncated || thinking.truncated }
}

function buildHarnessSeed(parsed) {
  const turns = []
  const callSteps = new Map()
  const pendingResults = new Map()
  let current
  let orphanToolResults = 0
  let orphanAssistantMessages = 0
  for (const record of parsed.sourceRecords) {
    if (record.role === 'user') {
      for (const result of record.results) {
        const step = callSteps.get(result.id)
        if (step !== undefined && !step.results.has(result.id)) step.results.set(result.id, { ...result, timestamp: record.timestamp })
        else if (!pendingResults.has(result.id)) pendingResults.set(result.id, { ...result, timestamp: record.timestamp })
        else orphanToolResults += 1
      }
      if (record.text !== '') {
        current = { prompt: record.text, timestamp: record.timestamp, steps: [] }
        turns.push(current)
      }
      continue
    }
    if (current === undefined) { orphanAssistantMessages += 1; continue }
    const step = { record, results: new Map() }
    current.steps.push(step)
    for (const tool of record.tools) {
      if (!callSteps.has(tool.id)) {
        callSteps.set(tool.id, step)
        const pending = pendingResults.get(tool.id)
        if (pending !== undefined) {
          step.results.set(tool.id, pending)
          pendingResults.delete(tool.id)
        }
      }
    }
  }

  orphanToolResults += pendingResults.size

  const events = []; let seq = 0; let lastTime = 0; let unknownToolResults = 0; let interruptedTurns = 0
  const timeOf = value => {
    const parsedTime = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isSafeInteger(parsedTime) && parsedTime >= 0) {
      const time = Math.max(lastTime, parsedTime)
      lastTime = time
      return time
    }
    lastTime += 1
    return lastTime
  }
  const push = (type, time, data, surface) => {
    const event = { type, seq: seq++, time, data, ...surface === undefined ? {} : surface }
    events.push(event)
    lastTime = Math.max(lastTime, time)
    return event
  }
  push('session/title', timeOf(parsed.sourceRecords[0]?.timestamp), { title: parsed.title, messageSeqs: [], source: { kind: 'user' } })
  let turnNumber = 0
  for (const sourceTurn of turns) {
    turnNumber += 1
    const promptTime = timeOf(sourceTurn.timestamp)
    push('turn/start', promptTime, { turn: turnNumber })
    push('user/message', promptTime, userMessage(sourceTurn.prompt), { surfaceOp: 'append' })
    // A final tool-calling step normally requires another assistant step after
    // its results. If the transcript stops (or the next user turn starts)
    // there, preserve that as interrupted instead of claiming completion.
    let interrupted = sourceTurn.steps.length === 0 || sourceTurn.steps.at(-1)?.record.tools.length > 0
    let stepNumber = 0
    for (const sourceStep of sourceTurn.steps) {
      stepNumber += 1
      const stepTime = timeOf(sourceStep.record.timestamp)
      push('step/start', stepTime, { turn: turnNumber, step: stepNumber })
      const content = [
        ...sourceStep.record.text === '' ? [] : [{ type: 'text', text: sourceStep.record.text }],
        ...sourceStep.record.thinking === '' ? [] : [{ type: 'reasoning', text: sourceStep.record.thinking }],
        ...sourceStep.record.tools.map(tool => ({ type: 'tool-call', id: tool.id, name: tool.name, arguments: tool.input })),
      ]
      if (content.length > 0) push('assistant/message', stepTime, { turn: turnNumber, step: stepNumber, message: assistantMessage(content, sourceStep.record.model ?? parsed.model) }, { surfaceOp: 'append' })
      const callEvents = new Map()
      for (const tool of sourceStep.record.tools) {
        const call = push('tool/call', stepTime, { turn: turnNumber, step: stepNumber, callId: tool.id, name: tool.name, arguments: tool.input })
        callEvents.set(tool.id, call.seq)
      }
      let endTime = stepTime
      for (const tool of sourceStep.record.tools) {
        const result = sourceStep.results.get(tool.id)
        const callSeq = callEvents.get(tool.id)
        if (result === undefined) {
          interrupted = true; unknownToolResults += 1; endTime = timeOf(undefined)
          push('tool/result', endTime, { turn: turnNumber, step: stepNumber, message: toolResultMessage(tool.id, '未知结果：Claude Code 记录缺少该工具调用的结果，未假定执行成功。', true), error: { name: 'ClaudeToolOutcomeUnknownError', code: 'CLAUDE_TOOL_OUTCOME_UNKNOWN' } }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        } else {
          endTime = timeOf(result.timestamp)
          push('tool/result', endTime, { turn: turnNumber, step: stepNumber, message: toolResultMessage(result.id, result.content, result.isError), ...result.isError ? { error: { name: 'ClaudeToolResultError', code: 'CLAUDE_TOOL_ERROR' } } : {} }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        }
      }
      push('step/end', endTime, { turn: turnNumber, step: stepNumber })
    }
    if (interrupted) interruptedTurns += 1
    push('turn/end', lastTime + 1, { turn: turnNumber, reason: interrupted ? { kind: 'interrupted' } : { kind: 'completed' } })
  }
  return { events, turnCount: turns.length, orphanToolResults, orphanAssistantMessages, unknownToolResults, interruptedTurns }
}

function userMessage(text) { return { id: `claude-import-${randomUUID()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
function assistantMessage(content, model) { return { id: `claude-import-${randomUUID()}`, role: 'assistant', content, source: { kind: 'model', provider: 'claude-code', model: model ?? 'unknown' } } }
function toolResultMessage(callId, text, isError) { return { id: `claude-import-${randomUUID()}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] } }
function importDetails(parsed, built) {
  return {
    unsupported: parsed.unsupported,
    messageCount: parsed.messages.length,
    toolCount: parsed.sourceRecords.reduce((count, record) => count + record.tools.length, 0),
    orphanToolResults: built.orphanToolResults,
    orphanAssistantMessages: built.orphanAssistantMessages,
    unknownToolResults: built.unknownToolResults,
    interruptedTurns: built.interruptedTurns,
    truncated: parsed.truncated,
  }
}
function timestampOf(record) { return typeof record?.timestamp === 'string' ? record.timestamp : undefined }
function emptySourceContent() { return { text: '', thinking: '', tools: [], results: [], unsupported: [], truncated: false } }
function toolResultText(value) {
  if (!Array.isArray(value)) return { text: safeText(value), unsupported: [], truncated: false }
  const text = []; const unsupported = []
  for (const block of value) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block?.type !== undefined) unsupported.push(String(block.type))
  }
  return { text: text.join('\n'), unsupported, truncated: unsupported.length > 0 }
}
function safeText(value) {
  if (typeof value === 'string') return value
  const serialized = JSON.stringify(redactStructured(value))
  return typeof serialized === 'string' ? serialized : ''
}
function redactAndBound(value, limit = MAX_TOOL_CONTENT_CHARS, keepTail = false) {
  const redacted = redactSecrets(safeText(value))
  if (redacted.length <= limit) return { text: redacted, truncated: false }
  const kept = keepTail ? redacted.slice(-limit) : redacted.slice(0, limit)
  return { text: keepTail ? `[已裁剪较早内容]…${kept}` : `${kept}…[已裁剪]`, truncated: true }
}
function redactSecrets(text) {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[已隐藏私钥]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[已隐藏]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/gi, '$1[已隐藏]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[已隐藏]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie)"?\s*[:=]\s*")[^"]+/gi, '$1[已隐藏]')
    .replace(/((?:aws_secret_access_key|aws_session_token|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[已隐藏]')
}
function redactStructured(value) {
  if (Array.isArray(value)) return value.map(redactStructured)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:token|api[_-]?key|secret|password|authorization|cookie)/i.test(key) ? '[已隐藏]' : redactStructured(item)]))
  return value
}

function sourceRecordChars(record) {
  return record.text.length + record.thinking.length
    + record.tools.reduce((total, tool) => total + tool.input.length, 0)
    + record.results.reduce((total, result) => total + result.content.length, 0)
}
function boundSourceRecord(record, limit) {
  const bounded = { ...record, tools: [...record.tools], results: [...record.results] }
  let truncated = false
  while (sourceRecordChars(bounded) > limit && bounded.results.length > 0) { bounded.results.pop(); truncated = true }
  while (sourceRecordChars(bounded) > limit && bounded.tools.length > 0) { bounded.tools.pop(); truncated = true }
  if (sourceRecordChars(bounded) > limit && bounded.thinking !== '') {
    bounded.thinking = ''; truncated = true
  }
  if (sourceRecordChars(bounded) > limit) {
    bounded.text = `[已裁剪较早内容]…${bounded.text.slice(-limit)}`; truncated = true
  }
  return { record: bounded, truncated }
}
function boundedDetailMessages(sourceRecords) {
  const messages = sourceRecords.filter(record => record.text !== '').map(record => ({ role: record.role, text: record.text, timestamp: record.timestamp }))
  let chars = messages.reduce((total, message) => total + message.text.length, 0)
  while (messages.length > 1 && chars > MAX_TEXT_CHARS) chars -= messages.shift().text.length
  if (messages.length === 1 && chars > MAX_TEXT_CHARS) messages[0].text = messages[0].text.slice(-MAX_TEXT_CHARS)
  return messages
}
function normalizeTitle(value) {
  const normalized = redactSecrets(String(value)).replace(/\s+/g, ' ').trim()
  return normalized === '' ? '从 Claude Code 导入' : normalized.slice(0, 80)
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


function previewTitle(raw) {
  let aiTitle
  let customTitle
  let userTitle
  for (const line of raw.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line)
      if (record?.type === 'ai-title' && typeof record.aiTitle === 'string' && aiTitle === undefined) aiTitle = record.aiTitle
      if (record?.type === 'summary') {
        const candidate = typeof record.summary === 'string' && record.summary.trim() !== ''
          ? record.summary
          : typeof record.title === 'string' && record.title.trim() !== '' ? record.title : undefined
        if (candidate !== undefined) customTitle = candidate
      }
      if (record?.type === 'user' && userTitle === undefined) {
        const text = messageText(record, true)
        if (text !== '') userTitle = titlePreview(text)
      }
    } catch { /* A partial final preview line is expected. Full parsing remains strict. */ }
  }
  const candidate = customTitle ?? aiTitle ?? userTitle
  return candidate === undefined ? undefined : normalizeTitle(candidate)
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
export function defaultRegistryPath(environment = process.env, currentPlatform = platform(), home = homedir()) {
  if (currentPlatform === 'darwin') return path.join(home, 'Library', 'Application Support', 'DeepSeekHarness', 'claude-code-imports.json')
  if (currentPlatform === 'win32') return path.join(environment.APPDATA ?? home, 'DeepSeekHarness', 'claude-code-imports.json')
  return path.join(environment.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'DeepSeekHarness', 'claude-code-imports.json')
}

async function sourceRevision(file, info, signal) {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { signal })
  for await (const chunk of stream) hash.update(chunk)
  return { size: info.size, mtimeMs: info.mtimeMs, hash: hash.digest('hex') }
}
function sameRevision(left, right) { return left?.size === right?.size && left?.hash === right?.hash }
function seedPrefixMatches(existing, seed) {
  return typeof existing.seedSignature === 'string' && Number.isSafeInteger(existing.seedEventCount)
    && seed.length >= existing.seedEventCount && seedSignature(seed.slice(0, existing.seedEventCount)) === existing.seedSignature
}
function sourceIdentity(parsed) { return { sourceSessionId: parsed.sourceSessionId, originalCwd: parsed.cwd, model: parsed.model, title: parsed.title } }
function seedSignature(seed) { return createHash('sha256').update(JSON.stringify(seed, (key, value) => key === 'id' && typeof value === 'string' && value.startsWith('claude-import-') ? '<message-id>' : value)).digest('hex') }
async function isStrictAppend(file, previous, next, seedCount, previousSeedCount, signal) {
  if (previous === undefined || next.size <= previous.size || seedCount < previousSeedCount || typeof previous.hash !== 'string') return false
  const hash = createHash('sha256'); let remaining = previous.size; let position = 0
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    while (remaining > 0) {
      if (signal?.aborted) throw signal.reason
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, remaining), position)
      if (bytesRead === 0) return false
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; remaining -= bytesRead
    }
    return hash.digest('hex') === previous.hash
  } finally { await handle.close() }
}
