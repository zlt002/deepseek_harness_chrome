import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export const name = 'accrui-default-workspace'
export const DEFAULT_WORKSPACE_ENV = 'DSH_DEFAULT_WORKSPACE'

function configuredPath(env) {
  const value = env[DEFAULT_WORKSPACE_ENV]
  return typeof value === 'string' && value.trim() !== '' ? resolve(value) : undefined
}

export function resolveDefaultWorkspacePath(env = process.env) {
  return configuredPath(env)
}

/** Create and register only the first product Workspace; never change user state. */
export async function ensureDefaultWorkspace(workspaceRegistry, workspacePath) {
  if (workspaceRegistry.list().length > 0) return { created: false, skipped: 'existing-workspace' }
  await mkdir(workspacePath, { recursive: true })
  const existing = await workspaceRegistry.resolveByPath(workspacePath)
  if (existing !== undefined) return { created: false, skipped: 'registered-workspace' }
  return { created: true, workspace: await workspaceRegistry.create(workspacePath) }
}

export async function apply(ctx, input = {}) {
  const workspacePath = resolveDefaultWorkspacePath(input.env ?? process.env)
  if (workspacePath === undefined) return
  await ctx.inject(['workspaceRegistry'], async (workspaceCtx) => {
    await workspaceCtx.effect(async () => {
      await ensureDefaultWorkspace(workspaceCtx.workspaceRegistry, workspacePath)
      return () => {}
    }, 'accrui-default-workspace: first-run registration')
  })
}
