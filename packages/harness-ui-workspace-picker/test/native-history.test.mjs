import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { handleImport } from '../src/index.ts'
import { openImportedSession } from '../src/client/open-imported-session.mjs'
import { importNativeHistory, rebaseSeed } from '../src/native-history.mjs'

const sourceKey = 'a'.repeat(64)
const seed = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]

function preparedDirectory(overrides = {}) {
  return {
    prepare: async () => ({ kind: 'prepared', sourceKey, title: '源标题', seed, revision: { hash: 'x' }, sourceIdentity: {}, ...overrides }),
    reserve: async () => {},
    commit: async () => {},
  }
}

function hostContext(calls = []) {
  return {
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async id => calls.push(['attach', id]) }) },
    agentPresets: { resolve: async () => ({ id: 'default-preset' }) },
    sessions: {
      get: () => undefined,
      prepare: (id, options) => {
        calls.push(['prepare-session', id, options])
        return {
          header: { version: 0, id, createdAt: 1, cwd: options.meta.cwd, agentPreset: options.meta.agentPreset, seedLength: options.seed.length },
          events: [...options.seed, { type: 'session/end-seed', seq: options.seed.length, time: 2, data: {} }],
        }
      },
    },
    sessionPersistence: {
      create: async header => calls.push(['persistence-create', header]),
      inspect: async () => ({ events: [] }),
      append: async (id, events) => calls.push(['persistence-append', id, events]),
    },
  }
}

test('Host native import validates, persists, attaches, commits, and never creates a live Agent', async () => {
  const calls = []
  const directory = preparedDirectory({ createdAt: 123 })
  directory.reserve = async input => calls.push(['reserve', input])
  directory.commit = async input => calls.push(['commit', input])
  const result = await importNativeHistory(directory, hostContext(calls), { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' })

  assert.equal(result.status, 'seeded')
  const prepared = calls.find(([kind]) => kind === 'prepare-session')
  assert.deepEqual(prepared[2].meta, { cwd: '/tmp/selected', agentPreset: 'default-preset', seedLength: seed.length, createdAt: 123 })
  assert.deepEqual(calls.map(([kind]) => kind), ['prepare-session', 'reserve', 'persistence-create', 'persistence-append', 'attach', 'commit'])
  assert.equal(calls.some(([kind]) => kind === 'agent-create' || kind === 'prompt'), false)
})

test('native import HTTP action receives the injected Host context', async t => {
  const calls = []
  const server = createServer((req, res) => { void handleImport(preparedDirectory(), hostContext(calls), req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error === undefined ? resolve() : reject(error))
  }))
  const address = server.address()
  assert.equal(typeof address, 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}/api/claude-code.import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ action: 'import', projectKey: '-tmp-demo', sessionId: 'source-session', sourceRoot: '/tmp/source', workspacePath: '/tmp/selected' }),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.status, 'seeded')
  assert.equal(calls.some(([kind]) => kind === 'persistence-append'), true)
})

test('two concurrent first imports create only one persisted session', async () => {
  let existingSessionId
  let createCount = 0
  const directory = preparedDirectory()
  directory.prepare = async () => existingSessionId === undefined
    ? { kind: 'prepared', sourceKey, title: '源标题', seed, revision: { hash: 'x' }, sourceIdentity: {} }
    : { kind: 'existing', sourceKey, sessionId: existingSessionId }
  directory.reserve = async input => { existingSessionId = input.sessionId }
  directory.commit = async () => {}
  const ctx = hostContext()
  ctx.sessionPersistence.create = async () => { createCount += 1 }

  const results = await Promise.all([
    importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' }),
    importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' }),
  ])
  assert.equal(createCount, 1)
  assert.deepEqual(results.map(result => result.status).sort(), ['seeded', 'unchanged-source'])
  assert.equal(results[0].sessionId, results[1].sessionId)
})

function recoverableSeedDirectory({ failCommit = false } = {}) {
  let entry
  let commitFailures = failCommit ? 1 : 0
  return {
    get entry() { return entry },
    prepare: async () => {
      if (entry?.pending !== undefined) return {
        kind: 'pending', sourceKey, sessionId: entry.sessionId, seed, revision: { hash: 'x' }, sourceIdentity: {},
        seedSignature: 'source-signature', seedEventCount: seed.length, harnessNextSeq: entry.harnessNextSeq,
        pending: entry.pending, details: {},
      }
      if (entry !== undefined) return { kind: 'existing', sourceKey, sessionId: entry.sessionId }
      return { kind: 'prepared', sourceKey, title: '源标题', seed, revision: { hash: 'x' }, sourceIdentity: {} }
    },
    reserve: async input => { entry = { ...input } },
    commit: async input => {
      if (commitFailures > 0) { commitFailures -= 1; throw new Error('registry disk unavailable') }
      entry = { ...input }
    },
  }
}

function persistedHost({ failAttach = false } = {}) {
  const calls = []
  let events
  return {
    calls,
    context: {
      ...hostContext(calls),
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: async id => {
        calls.push(['attach', id])
        if (failAttach) { failAttach = false; throw new Error('workspace attach unavailable') }
      } }) },
      sessionPersistence: {
        create: async header => { calls.push(['persistence-create', header]); events = [] },
        inspect: async () => {
          if (events === undefined) throw new Error('session not found')
          return { events }
        },
        append: async (id, next) => { calls.push(['persistence-append', id, next]); events = [...events, ...next] },
      },
    },
  }
}

test('attach failure leaves a stable pending import that retry completes without a second session', async () => {
  const directory = recoverableSeedDirectory()
  const host = persistedHost({ failAttach: true })
  await assert.rejects(importNativeHistory(directory, host.context, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' }), /workspace attach unavailable/)
  const result = await importNativeHistory(directory, host.context, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' })

  assert.equal(result.status, 'recovered')
  assert.equal(host.calls.filter(([kind]) => kind === 'persistence-create').length, 1)
  assert.equal(host.calls.filter(([kind]) => kind === 'persistence-append').length, 1)
  assert.equal(host.calls.filter(([kind]) => kind === 'attach').length, 2)
  assert.equal(directory.entry.pending, undefined)
})

test('registry commit failure reuses the persisted session and completes registration on retry', async () => {
  const directory = recoverableSeedDirectory({ failCommit: true })
  const host = persistedHost()
  await assert.rejects(importNativeHistory(directory, host.context, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' }), /registry disk unavailable/)
  const result = await importNativeHistory(directory, host.context, { workspacePath: '/tmp/selected', sourceRoot: '/tmp/source' })

  assert.equal(result.status, 'recovered')
  assert.equal(host.calls.filter(([kind]) => kind === 'persistence-create').length, 1)
  assert.equal(host.calls.filter(([kind]) => kind === 'persistence-append').length, 1)
  assert.equal(new Set(host.calls.filter(([kind]) => kind === 'persistence-create').map(([, header]) => header.id)).size, 1)
  assert.equal(directory.entry.pending, undefined)
})

test('incremental registry commit failure does not append the source suffix twice', async () => {
  const appendKey = 'd'.repeat(64)
  const suffix = [{ type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } }]
  let pending
  let commitFailures = 1
  let appendCount = 0
  let events = [{ seq: 0 }, { type: 'session/end-seed', seq: 1 }]
  const directory = {
    prepare: async () => pending === undefined
      ? { kind: 'append', sourceKey: appendKey, sessionId: 'existing-session', seed: suffix, revision: { hash: 'next' }, seedSignature: 'next-seed', sourceIdentity: {} }
      : { kind: 'pending', sourceKey: appendKey, sessionId: 'existing-session', seed: suffix, revision: { hash: 'next' }, sourceIdentity: {}, seedSignature: 'next-seed', seedEventCount: 2, harnessNextSeq: 3, pending, details: {} },
    readRegistry: async () => ({ [appendKey]: { harnessNextSeq: 2, seedEventCount: 1 } }),
    reserve: async input => { pending = input.pending },
    commit: async () => {
      if (commitFailures > 0) { commitFailures -= 1; throw new Error('registry disk unavailable') }
      pending = undefined
    },
  }
  const ctx = hostContext()
  ctx.sessionPersistence.inspect = async () => ({ events })
  ctx.sessionPersistence.append = async (_id, next) => { appendCount += 1; events = [...events, ...next] }

  await assert.rejects(importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected' }), /registry disk unavailable/)
  const result = await importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected' })
  assert.equal(result.status, 'recovered')
  assert.equal(appendCount, 1)
  assert.equal(pending, undefined)
})

test('two concurrent incremental imports append the source suffix only once', async () => {
  let committed = false
  let appendCount = 0
  const appendKey = 'c'.repeat(64)
  const suffix = [{ type: 'turn/start', seq: 1, time: 2, data: { turn: 2 } }]
  const directory = {
    prepare: async () => committed
      ? { kind: 'existing', sourceKey: appendKey, sessionId: 'existing-session' }
      : { kind: 'append', sourceKey: appendKey, sessionId: 'existing-session', seed: suffix, revision: { hash: 'next' }, seedSignature: 'next-seed', sourceIdentity: {} },
    readRegistry: async () => ({ [appendKey]: { harnessNextSeq: 2, seedEventCount: 1 } }),
    reserve: async () => {},
    commit: async () => { committed = true },
  }
  const ctx = hostContext()
  ctx.sessionPersistence.inspect = async () => ({ events: [{ seq: 0 }, { type: 'session/end-seed', seq: 1 }] })
  ctx.sessionPersistence.append = async () => { appendCount += 1 }

  const results = await Promise.all([
    importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected' }),
    importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected' }),
  ])
  assert.equal(appendCount, 1)
  assert.deepEqual(results.map(result => result.status).sort(), ['appended', 'unchanged-source'])
})

test('incremental rebasing preserves full-transcript turn numbers and fixes only moved seq references', () => {
  const previous = Array.from({ length: 7 }, (_, seq) => ({ type: seq === 6 ? 'session/end-seed' : 'prior', seq, time: seq, data: {} }))
  const suffix = [
    { type: 'turn/start', seq: 6, time: 10, data: { turn: 2 } },
    { type: 'user/message', seq: 7, time: 11, data: { id: 'u', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 8, time: 12, data: { turn: 2, step: 1, callId: 'call', name: 'Read', arguments: '{}' } },
    { type: 'tool/result', seq: 9, time: 13, data: { turn: 2, step: 1, message: {} }, surfaceOp: 'append', sourceEventSeqs: [8] },
  ]
  const rebased = rebaseSeed(suffix, previous)

  assert.deepEqual(rebased.map(event => event.seq), [7, 8, 9, 10])
  assert.equal(rebased[0].data.turn, 2)
  assert.equal(rebased[2].data.turn, 2)
  assert.deepEqual(rebased[3].sourceEventSeqs, [9])
})

test('local continuation blocks incremental persistence append', async () => {
  let appended = false
  const directory = { prepare: async () => ({ kind: 'append', sourceKey: 'b'.repeat(64), sessionId: 'existing', seed: [], revision: {}, seedSignature: 'x', sourceIdentity: {} }), readRegistry: async () => ({ ['b'.repeat(64)]: { harnessNextSeq: 1, seedEventCount: 0 } }) }
  const ctx = { workspaceRegistry: { resolveByPath: async () => ({}) }, sessions: { get: () => undefined }, sessionPersistence: { inspect: async () => ({ events: [{ seq: 0 }, { seq: 1 }] }), append: async () => { appended = true } } }
  const result = await importNativeHistory(directory, ctx, { workspacePath: '/tmp/selected' })
  assert.equal(result.kind, 'conflict')
  assert.equal(appended, false)
})

test('client refreshes the cold-session baseline before opening an imported session', async () => {
  const calls = []
  let byId = {}
  const sessions = {
    refresh: async () => { calls.push('refresh'); byId = { imported: {} } },
    list: { getSnapshot: () => ({ byId }) },
    open: id => calls.push(`open:${id}`),
  }
  assert.equal(await openImportedSession(sessions, 'imported'), true)
  assert.deepEqual(calls, ['refresh', 'open:imported'])
})
