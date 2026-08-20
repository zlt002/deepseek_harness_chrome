import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadHandoff() {
  const source = await readFile(new URL('../src/client/session-handoff.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

test('a synchronous session-list notification cannot recursively reopen the restored session', async () => {
  const { restoreHandoffSession } = await loadHandoff()
  const listeners = new Set()
  const state = { current: undefined, byId: {} }
  let opens = 0
  let reports = 0
  const list = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      listener()
      return () => listeners.delete(listener)
    },
  }
  const emit = () => { for (const listener of [...listeners]) listener() }

  restoreHandoffSession({
    sessionId: 'session-current',
    list,
    open: (id) => {
      opens += 1
      state.current = id
      emit()
    },
    reportApplied: () => { reports += 1 },
  })
  state.byId['session-current'] = {}
  emit()

  assert.equal(opens, 1, 'the sync notification after open must see current and not call open again')
  assert.equal(reports, 1, 'the extension Tab may close only after one confirmed restore')
  assert.equal(listeners.size, 0, 'the handoff subscription is removed after restore')
})
