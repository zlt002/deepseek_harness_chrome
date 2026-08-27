import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.NODE_PATH = fileURLToPath(new URL('../../../.generated/harness-product/node_modules/', import.meta.url))
createRequire(import.meta.url)('node:module').Module._initPaths()
const require = createRequire(import.meta.url)
let client
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { client = factory(specifier => specifier.startsWith('@deepseek-ai/') ? {} : require(specifier)) } } }
require('../lib/client.js')

const snapshots = ({ cwd } = {}) => ({
  workspaces: [{ workspaceId: 'one', path: '/Users/me/one', sessionIds: ['waiting', 'ready'] }],
  sessions: { current: 'waiting', byId: {
    waiting: { id: 'waiting', ...(cwd === undefined ? {} : { cwd }) },
    ready: { id: 'ready', cwd: '/Users/me/one' },
  } },
})

test('selects only a cwd-ready member instead of the current incomplete session', () => {
  const { workspaces, sessions } = snapshots()
  assert.equal(client.selectReadyWorkspaceDirectorySession(workspaces, sessions, 'one'), 'ready')
})

test('automatically selects the same workspace member once its cwd arrives', () => {
  const { workspaces, sessions } = snapshots()
  assert.equal(client.selectReadyWorkspaceDirectorySession(workspaces, sessions, 'one'), 'ready')
  sessions.byId.waiting.cwd = '/Users/me/one'
  assert.equal(client.selectReadyWorkspaceDirectorySession(workspaces, sessions, 'one'), 'waiting')
})

test('falls back to a durable workspace member before its live cwd arrives', () => {
  const workspaces = [{ workspaceId: 'html', path: '/Users/me/html', sessionIds: ['cold'] }]
  const sessions = { current: undefined, byId: {} }

  assert.equal(client.selectReadyWorkspaceDirectorySession(workspaces, sessions, 'html'), 'cold')
})

test('resolves the selected workspace path from the public items snapshot', () => {
  const workspaces = [{ workspaceId: 'html', path: '/Users/me/html', sessionIds: ['cold'] }]

  assert.equal(client.workspacePathForDirectory(workspaces, 'html'), '/Users/me/html')
})

test('compares Windows session cwd values without treating slash, drive-case, or trailing separator as a different workspace', () => {
  assert.equal(client.sameWorkspaceCwd('C:\\Work\\PRD\\', 'c:/work/prd'), true)
  assert.equal(client.sameWorkspaceCwd('/Users/me/one/', '/Users/me/one'), true)
  assert.equal(client.sameWorkspaceCwd('/Users/me/One', '/Users/me/one'), false)
})
