import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/workspace-markdown-review-open.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require: name => { throw new Error('unexpected module: ' + name) },
  JSON,
})

const {
  createWorkspaceMarkdownReviewOpenDefinition,
  nextWorkspaceMarkdownReviewOpenAction,
} = module.exports
const turnStart = { type: 'turn/start', seq: 9, time: 89, data: { turn: 3 } }
const call = { type: 'tool/call', seq: 10, time: 90, data: { turn: 3, callId: 'open-1', name: 'open_workspace_markdown_review', arguments: JSON.stringify({ path: 'pmd-workspace/spec/req-1/req-1_PRD.md' }) } }
const successfulResult = (time, surfaceOp = 'append') => ({
  type: 'tool/result', seq: 11, time, surfaceOp,
  data: { turn: 3, message: { source: { callId: 'open-1' }, content: [{ isError: false }] } },
})

test('a successful review-open command publishes the automatic review marker', () => {
  const definition = createWorkspaceMarkdownReviewOpenDefinition()
  const start = definition.match(turnStart)
  assert.deepEqual(JSON.parse(JSON.stringify(start)), { id: '3', role: 'start' })
  const state = definition.start({}, { event: turnStart })
  const afterCall = definition.update({ state }, { event: call })

  const live = successfulResult(99)
  const update = definition.match(live)
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { id: '3', role: 'update' })
  const updated = definition.update({ state: afterCall }, { event: live })
  assert.deepEqual(JSON.parse(JSON.stringify(definition.buildLocationData({ state: updated }, 'turn'))), {
    kind: 'turn',
    turn: 3,
    key: 'workspace-markdown-review-open',
    value: { path: 'pmd-workspace/spec/req-1/req-1_PRD.md', resultSeq: 11 },
  })
})

test('ordinary tool results remain within their turn but do not publish a review marker', () => {
  const definition = createWorkspaceMarkdownReviewOpenDefinition()
  const state = definition.start({}, { event: turnStart })
  const ordinary = { type: 'tool/result', seq: 12, time: 100, data: { turn: 3, message: { source: { callId: 'other-1' }, content: [{ isError: false }] } } }
  assert.deepEqual(JSON.parse(JSON.stringify(definition.match(ordinary))), { id: '3', role: 'update' })
  const updated = definition.update({ state }, { event: ordinary })
  assert.equal(definition.buildLocationData({ state: updated }, 'turn'), null)
})

test('the session controller baselines history, opens each newer result once, and resets for another session', () => {
  const old = { path: 'spec/old.md', resultSeq: 10 }
  const fresh = { path: 'spec/fresh.md', resultSeq: 20 }
  const later = { path: 'spec/later.md', resultSeq: 30 }

  let action = nextWorkspaceMarkdownReviewOpenAction(undefined, old)
  assert.deepEqual(JSON.parse(JSON.stringify(action)), { baseline: 10 }, 'initial history must not open')
  action = nextWorkspaceMarkdownReviewOpenAction(action.baseline, fresh)
  assert.deepEqual(JSON.parse(JSON.stringify(action)), { baseline: 20, open: fresh })
  action = nextWorkspaceMarkdownReviewOpenAction(action.baseline, fresh)
  assert.deepEqual(JSON.parse(JSON.stringify(action)), { baseline: 20 }, 'the same snapshot must not reopen')

  action = nextWorkspaceMarkdownReviewOpenAction(undefined, fresh)
  assert.deepEqual(JSON.parse(JSON.stringify(action)), { baseline: 20 }, 'a switched session establishes its own baseline')
  action = nextWorkspaceMarkdownReviewOpenAction(action.baseline, later)
  assert.deepEqual(JSON.parse(JSON.stringify(action)), { baseline: 30, open: later })
})
