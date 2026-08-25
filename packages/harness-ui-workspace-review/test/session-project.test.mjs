import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/session-project.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
Function('module', 'exports', compiled)(module, module.exports)
const { resolveSessionProject } = module.exports

test('resolves a cold workspace session from the durable workspace registry', () => {
  const project = resolveSessionProject({
    sessions: { get: () => undefined },
    workspaceRegistry: {
      list: () => [{ path: '/Users/me/one', sessionIds: ['cold-session'] }],
    },
  }, 'cold-session')

  assert.deepEqual(project, { id: 'cold-session', cwd: '/Users/me/one' })
})

test('prefers a live session cwd and rejects an unaccounted cwd-less session', () => {
  assert.deepEqual(resolveSessionProject({
    sessions: { get: () => ({ header: { cwd: '/Users/me/live' } }) },
    workspaceRegistry: { list: () => [] },
  }, 'live-session'), { id: 'live-session', cwd: '/Users/me/live' })

  assert.throws(() => resolveSessionProject({
    sessions: { get: () => ({ header: {} }) },
    workspaceRegistry: { list: () => [] },
  }, 'legacy-session'), /has no project cwd/)
})
