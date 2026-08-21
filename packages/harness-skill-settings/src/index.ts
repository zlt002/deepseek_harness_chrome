/** Product-owned Host plugin for durable Skill invocation modes. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SkillInvocationPolicy, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_INSTALL_MAX_ARCHIVE_BYTES, SKILL_INSTALL_PATH, deleteInstalledSkill, installSkill, waitForInstalledSkill, waitForRemovedSkill } from './installer.mjs'

export const name = 'accrui-skill-settings'
export const inject = ['skills', 'sessions']
export const SETTINGS_NAMESPACE = 'skill-settings' as SettingsNamespace
export type SkillSettingMode = 'enabled' | 'manual-only' | 'disabled'
export interface SkillSettingsConfig { readonly modes: Record<string, SkillSettingMode> }

export function invocationForMode(mode: SkillSettingMode): SkillInvocationPolicy {
  switch (mode) {
    case 'enabled': return { modelInvocable: true, userInvocable: true }
    case 'manual-only': return { modelInvocable: false, userInvocable: true }
    case 'disabled': return { modelInvocable: false, userInvocable: false }
  }
}

interface WebServerLookup {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

interface SessionLookup {
  get(id: string): { header: { cwd?: string } } | undefined
}

export function modeFor(config: SkillSettingsConfig, skill: Pick<SkillSummary, 'name'>): SkillSettingMode {
  return config.modes[skill.name] ?? 'enabled'
}

/** Register one durable local policy; Registry always intersects author policy. */
export async function apply(ctx: Context): Promise<void> {
  const schemastery = process.env.DSH_PRODUCT_SCHEMATERY_URL
  if (schemastery === undefined) throw new Error('DSH_PRODUCT_SCHEMATERY_URL is required for @accrui/harness-skill-settings')
  const z = (await import(schemastery)).default
  const Config = z.object({ modes: z.dict(z.union(['enabled', 'manual-only', 'disabled'])).default({}) })
  let settings: SkillSettingsConfig = { modes: {} }
  ctx.effect(() => ctx.skills.registerInvocationPolicy({
    resolve(skill) { return invocationForMode(modeFor(settings, skill)) },
  }), 'accrui skill invocation policy')
  ctx.inject(['settings'], (settingsCtx) => {
    const scope: SettingsScope<SkillSettingsConfig> = settingsCtx.settings.register(SETTINGS_NAMESPACE, Config, {
      configurationExposed: true,
    })
    const publish = (next: SkillSettingsConfig): void => {
      settings = next
      ctx.skills.invalidateInvocationPolicy()
    }
    publish(scope.get())
    scope.watch(publish)
  })
  ctx.inject(['webServer'], (webCtx: Context & { webServer: WebServerLookup }) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: SKILL_INSTALL_PATH,
      handler: (req, res) => { void handleInstall(ctx as Context & { sessions: SessionLookup }, req, res) },
    }), 'accrui skill settings: skill install route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/settings.skill.delete',
      handler: (req, res) => { void handleDelete(ctx as Context & { sessions: SessionLookup }, req, res) },
    }), 'accrui skill settings: skill delete route')
  })
}

async function handleDelete(ctx: Context & { sessions: SessionLookup }, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: '技能删除仅支持 POST' })
  if (!trusted(req)) return json(res, 403, { error: '技能删除仅允许本机同源请求' })
  try {
    const request = JSON.parse(await readBody(req, 16 * 1024)) as { sessionId?: unknown, name?: unknown }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
    const name = typeof request.name === 'string' ? request.name : ''
    const cwd = ctx.sessions.get(sessionId)?.header.cwd
    if (cwd === undefined || cwd === '') throw new Error('技能删除需要一个已打开的项目会话')
    const deleted = await deleteInstalledSkill(productSkillsRoot(), name)
    // Invalidate before readback so the bounded confirmation does not rely on
    // the filesystem watcher's eventual event alone.
    ctx.skills.invalidateInvocationPolicy()
    try {
      const confirmation = await waitForRemovedSkill(deleted.name, options => ctx.skills.list(options), cwd)
      json(res, 200, confirmation.disappeared
        ? deleted
        : { ...deleted, refreshWarning: `技能 /${deleted.name} 的文件夹已删除，但列表仍显示同名技能；它可能来自其他来源。` })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      json(res, 200, { ...deleted, refreshWarning: `技能 /${deleted.name} 的文件夹已删除，但 Harness 列表刷新确认失败：${detail}` })
    }
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleInstall(ctx: Context & { sessions: SessionLookup }, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: '技能安装仅支持 POST' })
  if (!trusted(req)) return json(res, 403, { error: '技能安装仅允许本机同源请求' })
  try {
    const request = JSON.parse(await readBody(req, SKILL_INSTALL_MAX_ARCHIVE_BYTES * 3)) as { sessionId?: unknown }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
    const cwd = ctx.sessions.get(sessionId)?.header.cwd
    if (cwd === undefined || cwd === '') throw new Error('技能安装需要一个已打开的项目会话')
    const installed = await installSkill(productSkillsRoot(), request)
    // This policy seam invalidates the Registry's collect cache synchronously;
    // the following read therefore does not depend solely on Chokidar timing.
    ctx.skills.invalidateInvocationPolicy()
    try {
      await waitForInstalledSkill(installed.name, options => ctx.skills.list(options), cwd)
      json(res, 200, installed)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      json(res, 200, { ...installed, refreshWarning: `技能 /${installed.name} 已落盘，但 Harness 刷新确认超时：${detail}` })
    }
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function productSkillsRoot(env = process.env): string {
  const configured = env.DSH_PRODUCT_SKILLS_ROOT?.trim()
  if (configured !== undefined && configured !== '') return resolve(configured)
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../skills')
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []; let received = 0
  for await (const chunk of req) {
    const bytes = chunk as Buffer; received += bytes.byteLength
    if (received > maxBytes) throw new Error('技能安装请求过大')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function trusted(req: IncomingMessage): boolean {
  const host = header(req, 'host')
  if (host === undefined || header(req, 'sec-fetch-site') === 'cross-site') return false
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength })
  res.end(payload)
}
