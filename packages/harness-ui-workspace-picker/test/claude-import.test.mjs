import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ClaudeImportDirectory, defaultRegistryPath, parseClaudeSession } from '../src/claude-import.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-import-'))
  const projects = path.join(directory, 'projects')
  const registryPath = path.join(directory, 'data', 'imports.json')
  await mkdir(path.join(projects, '-tmp-demo'), { recursive: true })
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) })
  return { projects, registryPath, importer: new ClaudeImportDirectory({ root: projects, registryPath }) }
}

function line(value) { return `${JSON.stringify(value)}\n` }

test('keeps the established Claude import registry path across upgrades', () => {
  const environment = { ACCRUI_CONNECTOR_STATE_DIR: '/accrui/state', DSH_CONNECTOR_STATE_DIR: '/other-harness/state' }
  assert.equal(defaultRegistryPath(environment, 'darwin', '/Users/test'), '/Users/test/Library/Application Support/DeepSeekHarness/claude-code-imports.json')
  assert.equal(defaultRegistryPath(environment, 'win32', 'C:\\Users\\test'), path.win32.join('C:\\Users\\test', 'DeepSeekHarness', 'claude-code-imports.json'))
  assert.equal(defaultRegistryPath(environment, 'linux', '/home/test'), '/home/test/.local/share/DeepSeekHarness/claude-code-imports.json')
})

test('indexes only directory metadata and parses one selected session on demand', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = '12345678-abcd'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'user', sessionId, timestamp: '2026-08-20T01:00:00Z', message: { content: '修复当前问题' } }),
    line({ type: 'assistant', sessionId, timestamp: '2026-08-20T01:01:00Z', message: { content: [{ type: 'text', text: '已经定位原因' }, { type: 'tool_use', name: 'Bash', input: { secret: 'must-not-migrate' } }] } }),
  ].join(''))
  const projectsIndex = await importer.listProjects()
  assert.deepEqual(projectsIndex.projects.map(project => ({ key: project.key, sessionCount: project.sessionCount })), [{ key: '-tmp-demo', sessionCount: 1 }])
  const sessions = await importer.listSessions('-tmp-demo')
  assert.equal(sessions.sessions[0].title, '修复当前问题')
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.equal(prepared.kind, 'prepared')
  const seed = JSON.stringify(prepared.seed)
  assert.match(seed, /修复当前问题/)
  assert.match(seed, /已经定位原因/)
  assert.doesNotMatch(seed, /must-not-migrate/)
})

test('rejects traversal and malformed selected JSONL with exact line evidence', async t => {
  const { projects, importer } = await fixture(t)
  await assert.rejects(importer.listSessions('../escape'), /项目标识无效/)
  const sessionId = 'broken-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), `${line({ type: 'user', message: { content: 'ok' } })}{bad}\n`)
  await assert.rejects(importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' }), /第 2 行无效/)
})

test('commits a stable source id and detects duplicate imports without reading the session again', async t => {
  const { projects, registryPath, importer } = await fixture(t)
  const sessionId = 'stable-session'
  const file = path.join(projects, '-tmp-demo', `${sessionId}.jsonl`)
  await writeFile(file, line({ type: 'user', sessionId, message: { content: 'continue' } }))
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.equal(prepared.kind, 'prepared')
  await importer.commit({ sourceKey: prepared.sourceKey, sessionId: 'harness-session-123' })
  await writeFile(file, '{now-invalid')
  const duplicate = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.deepEqual(duplicate, { kind: 'existing', sourceKey: prepared.sourceKey, sessionId: 'harness-session-123' })
  assert.equal(JSON.parse(await readFile(registryPath, 'utf8'))[prepared.sourceKey].sessionId, 'harness-session-123')
})

test('canonical source root participates in identity and concurrent commits preserve both records', async t => {
  const { projects, registryPath, importer } = await fixture(t)
  const sessionId = 'parallel-session'
  const source = line({ type: 'user', sessionId, message: { content: 'continue' } })
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), source)
  const backup = path.join(path.dirname(projects), 'backup-projects')
  await mkdir(path.join(backup, '-tmp-demo'), { recursive: true })
  await writeFile(path.join(backup, '-tmp-demo', `${sessionId}.jsonl`), source)
  const first = await importer.prepare({ sourceRoot: projects, projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/one' })
  const second = await importer.prepare({ sourceRoot: backup, projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/one' })
  assert.notEqual(first.sourceKey, second.sourceKey)
  await Promise.all([
    importer.commit({ sourceRoot: projects, sourceKey: first.sourceKey, sessionId: 'harness-session-one' }),
    importer.commit({ sourceRoot: backup, sourceKey: second.sourceKey, sessionId: 'harness-session-two' }),
  ])
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(registry[first.sourceKey].sessionId, 'harness-session-one')
  assert.equal(registry[second.sourceKey].sessionId, 'harness-session-two')
})

test('manual source root must resolve to an existing absolute directory', async t => {
  const { importer } = await fixture(t)
  await assert.rejects(importer.listProjects('relative/projects'), /必须是绝对路径/)
  await assert.rejects(importer.listProjects('/definitely/missing/claude-projects'), /无法打开 Claude projects 目录/)
})

test('session index is paged in bounded batches with real totals', async t => {
  const { projects, importer } = await fixture(t)
  const directory = path.join(projects, '-tmp-demo')
  await Promise.all(Array.from({ length: 70 }, (_, index) => writeFile(
    path.join(directory, `session-${String(index).padStart(3, '0')}.jsonl`),
    line({ type: 'user', message: { content: `question ${String(index)}` } }),
  )))
  const first = await importer.listSessions('-tmp-demo', projects, { offset: 0, limit: 64 })
  assert.equal(first.sessions.length, 64)
  assert.equal(first.total, 70)
  assert.equal(first.nextOffset, 64)
  assert.equal(first.done, false)
  const second = await importer.listSessions('-tmp-demo', projects, { offset: first.nextOffset, limit: 64 })
  assert.equal(second.sessions.length, 6)
  assert.equal(second.total, 70)
  assert.equal(second.done, true)
})

test('synthetic Claude wrappers do not become titles or migrated user text', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'wrapped-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'user', message: { content: '<browser_context>synthetic browser payload</browser_context>' } }),
    line({ type: 'user', message: { content: '<system-reminder>synthetic reminder</system-reminder>\n如何修复真实问题？' } }),
    line({ type: 'assistant', message: { content: '真实回答' } }),
  ].join(''))
  const listing = await importer.listSessions('-tmp-demo')
  assert.equal(listing.sessions[0].title, '如何修复真实问题？')
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.doesNotMatch(JSON.stringify(prepared.seed), /synthetic browser payload|synthetic reminder/)
  assert.match(JSON.stringify(prepared.seed), /如何修复真实问题？/)
  const ordinary = parseClaudeSession(line({ type: 'user', message: { content: '<browser_context> 是普通用户要解释的标签' } }))
  assert.equal(ordinary.title, '<browser_context> 是普通用户要解释的标签')
  assert.throws(() => parseClaudeSession(line({ type: 'user', isMeta: true, message: { content: 'synthetic only' } })), /没有可迁移/)
})

test('language instruction wrappers do not become titles or migrated user text', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'language-wrapper-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'user', message: { content: '<language_instruction>请始终使用中文进行对话</language_instruction>\n帮我整理这份需求' } }),
    line({ type: 'assistant', message: { content: '好的' } }),
    line({ type: 'user', message: { content: '<language_instruction>请始终使用中文进行对话</language_instruction>' } }),
    line({ type: 'user', message: { content: '第二段真实用户输入' } }),
  ].join(''))
  const listing = await importer.listSessions('-tmp-demo')
  assert.equal(listing.sessions[0].title, '帮我整理这份需求')
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.doesNotMatch(JSON.stringify(prepared.seed), /请始终使用中文进行对话/)
  assert.match(JSON.stringify(prepared.seed), /帮我整理这份需求|第二段真实用户输入/)
  const ordinary = parseClaudeSession(line({ type: 'user', message: { content: '请解释 <language_instruction> 这个标签的用途' } }))
  assert.equal(ordinary.title, '请解释 <language_instruction> 这个标签的用途')
})

test('user-request wrappers keep their contents without exposing wrapper tags', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'user-request-wrapper-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'user', message: { content: '<用户原始请求>检索 mobileinvitewxkfi 的问题</用户原始请求>\n后续补充说明' } }),
    line({ type: 'assistant', message: { content: '收到' } }),
  ].join(''))
  const listing = await importer.listSessions('-tmp-demo')
  assert.equal(listing.sessions[0].title, '检索 mobileinvitewxkfi 的问题')
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.match(JSON.stringify(prepared.seed), /检索 mobileinvitewxkfi 的问题/)
  assert.doesNotMatch(JSON.stringify(prepared.seed), /<用户原始请求>|<\/用户原始请求>/)
  const ordinary = parseClaudeSession(line({ type: 'user', message: { content: '请解释 <用户原始请求> 这个标签的用途' } }))
  assert.equal(ordinary.title, '请解释 <用户原始请求> 这个标签的用途')
})

test('parser keeps only bounded user and assistant text', () => {
  const parsed = parseClaudeSession([
    line({ type: 'progress', data: 'ignored' }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '问题' }, { type: 'tool_result', content: 'large output' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '答案' }] } }),
  ].join(''))
  assert.deepEqual(parsed.messages.map(message => message.text), ['问题', '答案'])
})

test('native seed keeps record timestamps, pairs parallel out-of-order tools, redacts secrets, and marks unsupported data', () => {
  const parsed = parseClaudeSession([
    line({ type: 'user', timestamp: '2026-08-20T01:00:00.000Z', message: { content: [{ type: 'text', text: '请检查' }] } }),
    line({ type: 'assistant', timestamp: '2026-08-20T01:01:00.000Z', message: { model: 'claude-test', content: [
      { type: 'thinking', thinking: '先分析' }, { type: 'text', text: '开始处理' },
      { type: 'tool_use', id: 'call-a', name: 'Read', input: { api_key: 'sk-supersecret123456' } },
      { type: 'tool_use', id: 'call-b', name: 'Bash', input: { token: 'private-token' } }, { type: 'image', source: 'not-migrated' },
    ] } }),
    line({ type: 'user', timestamp: '2026-08-20T01:02:00.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'call-b', content: 'B'.repeat(13_000) },
    ] } }),
    line({ type: 'assistant', timestamp: '2026-08-20T01:03:00.000Z', message: { content: [{ type: 'text', text: '完成' }] } }),
  ].join(''))
  assert.deepEqual(parsed.seed.filter(event => event.type === 'turn/start').map(event => event.time), [Date.parse('2026-08-20T01:00:00.000Z')])
  assert.equal(parsed.seed.find(event => event.type === 'assistant/message').data.message.content.some(block => block.type === 'reasoning'), true)
  const results = parsed.seed.filter(event => event.type === 'tool/result')
  assert.equal(results.find(event => event.data.message.source.callId === 'call-b').data.message.content[0].content[0].text.includes('[已裁剪]'), true)
  assert.match(results.find(event => event.data.message.source.callId === 'call-a').data.message.content[0].content[0].text, /未知结果/)
  for (const result of results) {
    const callId = result.data.message.source.callId
    const call = parsed.seed.find(event => event.type === 'tool/call' && event.data.callId === callId)
    assert.deepEqual(result.sourceEventSeqs, [call.seq])
  }
  const serialized = JSON.stringify(parsed.seed)
  assert.doesNotMatch(serialized, /supersecret|private-token/)
  assert.deepEqual(parsed.details.unsupported, ['image'])
})

test('native seed keeps each assistant model and does not claim a tool-ended transcript completed', () => {
  const parsed = parseClaudeSession([
    line({ type: 'user', message: { content: '执行检查' } }),
    line({ type: 'assistant', message: { model: 'claude-first', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/tmp/a' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] } }),
    line({ type: 'user', message: { content: '继续说明' } }),
    line({ type: 'assistant', message: { model: 'claude-second', content: [{ type: 'text', text: '最终说明' }] } }),
  ].join(''))
  assert.deepEqual(parsed.seed.filter(event => event.type === 'assistant/message').map(event => event.data.message.source.model), ['claude-first', 'claude-second'])
  assert.deepEqual(parsed.seed.filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'interrupted' }, { kind: 'completed' }])
  assert.equal(parsed.details.interruptedTurns, 1)
})

test('native seed pairs a tool result that appears in an earlier JSONL record than its tool call', () => {
  const parsed = parseClaudeSession([
    line({ type: 'user', timestamp: '2026-08-20T01:00:00.000Z', message: { content: '请继续处理' } }),
    line({ type: 'user', timestamp: '2026-08-20T01:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'late-call', content: '已经读取' }] } }),
    line({ type: 'assistant', timestamp: '2026-08-20T01:02:00.000Z', message: { content: [{ type: 'tool_use', id: 'late-call', name: 'Read', input: { file_path: '/tmp/a' } }] } }),
    line({ type: 'assistant', timestamp: '2026-08-20T01:03:00.000Z', message: { content: '读取完成' } }),
  ].join(''))
  const result = parsed.seed.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, '已经读取')
  assert.equal(parsed.details.orphanToolResults, 0)
  assert.equal(parsed.details.unknownToolResults, 0)
  assert.equal(result.time >= parsed.seed.find(event => event.type === 'tool/call').time, true)
})

test('titles, ordinary text, and detail text redact secrets while reporting orphan results', () => {
  const parsed = parseClaudeSession([
    line({ type: 'ai-title', aiTitle: '排查 sk-ant-titleSecret123456' }),
    line({ type: 'summary', summary: '最终摘要 Authorization: Bearer title-token-123456' }),
    line({ type: 'user', message: { content: 'Authorization: Bearer user-token-123456' } }),
    line({ type: 'assistant', message: { model: 'claude-a', content: [{ type: 'text', text: 'AWS_SECRET_ACCESS_KEY=assistant-secret-123456' }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'orphan-call', content: 'COOKIE=session-cookie-123456' }] } }),
  ].join(''))
  const serialized = JSON.stringify({ title: parsed.title, messages: parsed.messages, seed: parsed.seed })
  assert.equal(parsed.title.startsWith('最终摘要'), true)
  assert.doesNotMatch(serialized, /titleSecret|title-token|user-token|assistant-secret|session-cookie/)
  assert.equal(parsed.details.orphanToolResults, 1)
})

test('native seed has an independent total-content bound across many records', () => {
  const raw = []
  for (let turn = 0; turn < 12; turn += 1) {
    raw.push(line({ type: 'user', message: { content: `问题-${turn}-${'x'.repeat(70_000)}` } }))
    raw.push(line({ type: 'assistant', message: { content: `答案-${turn}-${'y'.repeat(70_000)}` } }))
  }
  const parsed = parseClaudeSession(raw.join(''))
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.details.unsupported.includes('record-limit'), true)
  assert.equal(JSON.stringify(parsed.seed).length < 700_000, true)
})

test('a main transcript keeps ai-title and summary metadata while a sidechain is rejected', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'main-session-1234'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'ai-title', aiTitle: 'AI 标题' }),
    line({ type: 'summary', summary: '摘要标题' }),
    line({ type: 'user', sessionId, message: { content: '主会话问题' } }),
    line({ type: 'assistant', sessionId, message: { content: '主会话回答' } }),
  ].join(''))
  const listing = await importer.listSessions('-tmp-demo')
  assert.equal(listing.sessions.find(session => session.sessionId === sessionId)?.title, '摘要标题')
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.equal(prepared.title, '摘要标题')

  const sidechainId = 'sidechain-1234'
  await writeFile(path.join(projects, '-tmp-demo', `${sidechainId}.jsonl`), line({ type: 'user', sessionId, isSidechain: true, message: { content: '辅助记录' } }))
  await assert.rejects(importer.prepare({ projectKey: '-tmp-demo', sessionId: sidechainId, workspacePath: '/tmp/demo' }), /辅助或子代理记录/)
})

test('session index uses ai-title before falling back to the first user message', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'ai-title-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'ai-title', aiTitle: 'Claude 原始标题' }),
    line({ type: 'user', sessionId, message: { content: '第一句用户问题' } }),
  ].join(''))
  const listing = await importer.listSessions('-tmp-demo')
  assert.equal(listing.sessions.find(session => session.sessionId === sessionId)?.title, 'Claude 原始标题')
})

test('registry distinguishes unchanged reopen, append-only import, and changed or shortened source conflicts', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'increment-session'
  const file = path.join(projects, '-tmp-demo', `${sessionId}.jsonl`)
  await writeFile(file, line({ type: 'user', message: { content: 'first' } }) + line({ type: 'assistant', message: { content: 'first answer' } }))
  const first = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  await importer.commit({ sourceKey: first.sourceKey, sessionId: 'harness-session', source: first.revision, seed: first.seed, seedEventCount: first.seed.length, harnessNextSeq: first.seed.length + 1 })
  assert.equal((await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })).kind, 'existing')
  await writeFile(file, line({ type: 'user', message: { content: 'first' } }) + line({ type: 'assistant', message: { content: 'first answer' } }) + line({ type: 'user', message: { content: 'second' } }) + line({ type: 'assistant', message: { content: 'second answer' } }))
  assert.equal((await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })).kind, 'append')
  await writeFile(file, line({ type: 'user', message: { content: 'changed' } }))
  assert.equal((await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })).kind, 'conflict')
})

test('reads selected details on demand without selecting or importing the session', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'detail-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), [
    line({ type: 'user', message: { content: '请查看详情' } }),
    line({ type: 'assistant', message: { content: '这是详细回答' } }),
  ].join(''))
  const detail = await importer.detail({ projectKey: '-tmp-demo', sessionId })
  assert.equal(detail.title, '请查看详情')
  assert.equal(detail.truncated, false)
  assert.deepEqual(detail.messages.map(message => [message.role, message.text]), [['user', '请查看详情'], ['assistant', '这是详细回答']])
})

test('prepares a selected session above the former 8 MiB source-file limit', async t => {
  const { projects, importer } = await fixture(t)
  const sessionId = 'large-session'
  await writeFile(path.join(projects, '-tmp-demo', `${sessionId}.jsonl`), line({ type: 'user', message: { content: 'x'.repeat(8 * 1024 * 1024 + 1) } }))
  const prepared = await importer.prepare({ projectKey: '-tmp-demo', sessionId, workspacePath: '/tmp/demo' })
  assert.equal(prepared.kind, 'prepared')
  assert.equal(JSON.stringify(prepared.seed).includes('x'.repeat(120_000)), true)
  const detail = await importer.detail({ projectKey: '-tmp-demo', sessionId })
  assert.equal(detail.truncated, true)
  assert.equal(detail.messages[0].text.length, 120_000)
})
