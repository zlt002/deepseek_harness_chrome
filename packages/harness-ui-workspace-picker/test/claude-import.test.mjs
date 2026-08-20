import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ClaudeImportDirectory, parseClaudeSession } from '../src/claude-import.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-import-'))
  const projects = path.join(directory, 'projects')
  const registryPath = path.join(directory, 'data', 'imports.json')
  await mkdir(path.join(projects, '-tmp-demo'), { recursive: true })
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) })
  return { projects, registryPath, importer: new ClaudeImportDirectory({ root: projects, registryPath }) }
}

function line(value) { return `${JSON.stringify(value)}\n` }

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
  assert.match(prepared.prompt, /修复当前问题/)
  assert.match(prepared.prompt, /已经定位原因/)
  assert.doesNotMatch(prepared.prompt, /must-not-migrate/)
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
  assert.doesNotMatch(prepared.prompt, /synthetic browser payload|synthetic reminder/)
  assert.match(prepared.prompt, /如何修复真实问题？/)
  const ordinary = parseClaudeSession(line({ type: 'user', message: { content: '<browser_context> 是普通用户要解释的标签' } }))
  assert.equal(ordinary.title, '<browser_context> 是普通用户要解释的标签')
  assert.throws(() => parseClaudeSession(line({ type: 'user', isMeta: true, message: { content: 'synthetic only' } })), /没有可迁移/)
})

test('parser keeps only bounded user and assistant text', () => {
  const parsed = parseClaudeSession([
    line({ type: 'progress', data: 'ignored' }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '问题' }, { type: 'tool_result', content: 'large output' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '答案' }] } }),
  ].join(''))
  assert.deepEqual(parsed.messages.map(message => message.text), ['问题', '答案'])
})
