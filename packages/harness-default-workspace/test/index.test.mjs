import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, ensureDefaultWorkspace, resolveDefaultWorkspacePath } from '../src/index.mjs'

test('first-run Workspace is launcher-opt-in and never replaces a user Workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-default-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'workspace', 'project')
  assert.equal(resolveDefaultWorkspacePath({}), undefined)
  assert.equal(resolveDefaultWorkspacePath({ DSH_DEFAULT_WORKSPACE: workspacePath }), workspacePath)

  const entries = []
  const registry = {
    list: () => entries,
    async resolveByPath(path) { return entries.find((entry) => entry.path === path) },
    async create(path) { const entry = { id: 'project', path }; entries.push(entry); return entry },
  }
  assert.deepEqual(await ensureDefaultWorkspace(registry, workspacePath), {
    created: true, workspace: { id: 'project', path: workspacePath },
  })
  assert.equal((await stat(workspacePath)).isDirectory(), true)
  assert.deepEqual(await ensureDefaultWorkspace(registry, join(root, 'ignored')), {
    created: false, skipped: 'existing-workspace',
  })
})

test('plugin waits for registration before its host startup completes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-default-workspace-apply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'workspace', 'project')
  const entries = []
  const ctx = {
    inject: async (_deps, callback) => callback({
      workspaceRegistry: {
        list: () => entries,
        resolveByPath: async () => undefined,
        create: async (path) => { entries.push({ path }) },
      },
      effect: async (effect) => effect(),
    }),
  }
  await apply(ctx, { env: { DSH_DEFAULT_WORKSPACE: workspacePath } })
  assert.deepEqual(entries, [{ path: workspacePath }])
})
