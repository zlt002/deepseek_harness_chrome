import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function load(sourcePath) {
  const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}-${Math.random()}`)
}

test('only projects a completed authoritative turn/end after thirty seconds', async () => {
  const { workspaceDesktopNotificationProjection } = await load('../src/index.ts')
  let state = workspaceDesktopNotificationProjection.init()
  state = workspaceDesktopNotificationProjection.apply(state, { type: 'turn/start', seq: 4, time: 100, data: { turn: 2 } })
  state = workspaceDesktopNotificationProjection.apply(state, { type: 'turn/end', seq: 9, time: 30_099, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(workspaceDesktopNotificationProjection.view(state), { v: 1 })
  state = workspaceDesktopNotificationProjection.apply(workspaceDesktopNotificationProjection.init(), { type: 'turn/start', seq: 10, time: 100, data: { turn: 3 } })
  state = workspaceDesktopNotificationProjection.apply(state, { type: 'turn/end', seq: 15, time: 30_100, data: { turn: 3, reason: { kind: 'completed' } } })
  assert.deepEqual(workspaceDesktopNotificationProjection.view(state), { v: 1, completed: { turn: 3, eventSeq: 15, durationMs: 30_000 } })
  assert.deepEqual(workspaceDesktopNotificationProjection.view(workspaceDesktopNotificationProjection.apply(state, { type: 'turn/end', seq: 16, time: 31_000, data: { turn: 3, reason: { kind: 'blocked' } } })), { v: 1 })
})

test('keeps stable question/approval identities and excludes subagent completion', async () => {
  const { collectWorkspaceNotificationEvents } = await load('../src/client/protocol.ts')
  const entries = [
    { sessionId: 'parent', projectionValues: { workspaceDesktopNotification: { v: 1, completed: { eventSeq: 9, durationMs: 30_000 } } } },
    { sessionId: 'child', origin: 'subagent', projectionValues: { workspaceDesktopNotification: { v: 1, completed: { eventSeq: 10, durationMs: 40_000 } } } },
  ]
  const pending = [{ key: 'q:stable', kind: 'question', payload: { questions: [{ detail: 'review', intent: { kind: 'plan-review', approve: 'Approve' }, options: [{ label: 'Approve' }] }] } }, { key: 'a:stable', kind: 'approval' }]
  assert.deepEqual(collectWorkspaceNotificationEvents(entries, id => id === 'parent' ? pending : []), [
    { sessionId: 'parent', eventId: 'turn:9', kind: 'completed' },
    { sessionId: 'parent', eventId: 'q:stable', kind: 'plan-review' },
    { sessionId: 'parent', eventId: 'a:stable', kind: 'approval' },
  ])
})

test('projects the current Harness session list shape before collecting notification events', async () => {
  const { collectWorkspaceNotificationEventsFromSessionList } = await load('../src/client/protocol.ts')
  const list = {
    ids: ['parent', 'child'],
    byId: {
      parent: { id: 'parent', projectionValues: { workspaceDesktopNotification: { v: 1, completed: { eventSeq: 12, durationMs: 30_000 } } } },
      child: { id: 'child', origin: 'subagent' },
    },
  }

  assert.deepEqual(collectWorkspaceNotificationEventsFromSessionList(list, () => []), [
    { sessionId: 'parent', eventId: 'turn:12', kind: 'completed' },
  ])
})

test('falls back to the authoritative list pending signal while a Session binding is unavailable', async () => {
  const { collectWorkspaceNotificationEventsFromSessionList } = await load('../src/client/protocol.ts')
  const list = {
    ids: ['question', 'approval', 'review'],
    byId: {
      question: { id: 'question', updatedAt: 123, pendingInteraction: 'question' },
      approval: { id: 'approval', updatedAt: 124, pendingInteraction: 'approval' },
      review: { id: 'review', updatedAt: 125, pendingInteraction: 'plan-review' },
    },
  }

  assert.deepEqual(collectWorkspaceNotificationEventsFromSessionList(list, () => undefined), [
    { sessionId: 'question', eventId: 'summary:question:123', kind: 'question' },
    { sessionId: 'approval', eventId: 'summary:approval:124', kind: 'approval' },
    { sessionId: 'review', eventId: 'summary:plan-review:125', kind: 'plan-review' },
  ])
})

test('prefers the stable live request key over the list fallback', async () => {
  const { collectWorkspaceNotificationEventsFromSessionList } = await load('../src/client/protocol.ts')
  const list = { ids: ['session'], byId: { session: { id: 'session', updatedAt: 123, pendingInteraction: 'question' } } }
  assert.deepEqual(collectWorkspaceNotificationEventsFromSessionList(list, () => [{ key: 'q:stable', kind: 'question' }]), [
    { sessionId: 'session', eventId: 'q:stable', kind: 'question' },
  ])
})

test('snapshot keeps initial pending live while permanently suppressing only initial completion history', async () => {
  const { activeWorkspaceNotificationSnapshot } = await load('../src/client/protocol.ts')
  const history = new Set()
  const oldCompletion = { sessionId: 'session', eventId: 'turn:1', kind: 'completed' }
  const liveQuestion = { sessionId: 'session', eventId: 'question:1', kind: 'question' }
  assert.deepEqual(activeWorkspaceNotificationSnapshot([oldCompletion, liveQuestion], history, true), [liveQuestion])

  const nextCompletion = { sessionId: 'session', eventId: 'turn:2', kind: 'completed' }
  assert.deepEqual(activeWorkspaceNotificationSnapshot([oldCompletion, nextCompletion], history, false), [nextCompletion])
})
