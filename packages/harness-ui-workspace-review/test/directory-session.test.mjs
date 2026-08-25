import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

process.env.NODE_PATH = new URL('../../../.generated/harness-product/node_modules/', import.meta.url).pathname
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
