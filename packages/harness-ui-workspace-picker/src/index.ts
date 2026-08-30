/** Host half: bounded Claude Code discovery and on-demand conversion. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLAUDE_IMPORT_PATH, ClaudeImportDirectory } from './claude-import.mjs'
import { importNativeHistory } from './native-history.mjs'

export const name = 'accrui-workspace-picker'

interface HostContext {
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void }
  inject(deps: readonly string[], callback: (ctx: HostContext) => void): void
  effect(callback: () => () => void, name: string): void
  sessions: {
    get(id: string): unknown
    prepare(id: string, options: { seed: readonly unknown[]; meta: { cwd: string; createdAt?: number; seedLength?: number; agentPreset?: string } }): {
      header: unknown
      events: readonly unknown[]
    }
  }
  workspaceRegistry: { resolveByPath(path: string): Promise<{ attachSession(id: string): Promise<void> } | undefined> }
  sessionPersistence: {
    create(header: unknown): Promise<void>
    inspect(id: string): Promise<{ events: readonly unknown[] }>
    append(id: string, events: readonly unknown[]): Promise<void>
  }
  agentPresets: { resolve(id?: string): Promise<{ id: string }> }
}

export function apply(ctx: HostContext): void {
  const directory = new ClaudeImportDirectory()
  ctx.inject(['webServer', 'sessions', 'workspaceRegistry', 'sessionPersistence', 'agentPresets'], webCtx => webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact', path: CLAUDE_IMPORT_PATH, handler: (req, res) => { void handleImport(directory, webCtx, req, res) },
  }), 'accrui-workspace-picker: Claude Code import route'))
}

export async function handleImport(directory: ClaudeImportDirectory, hostCtx: HostContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'Claude Code import accepts POST only' })
  if (!trusted(req)) return json(res, 403, { error: 'Claude Code import is loopback same-origin only' })
  const controller = new AbortController()
  const requestAborted = () => controller.abort(new DOMException('Claude Code 导入请求连接已关闭', 'AbortError'))
  const requestClosed = () => { if (!req.complete) requestAborted() }
  const responseClosed = () => { if (!res.writableEnded) requestAborted() }
  req.once('aborted', requestAborted); req.once('close', requestClosed); res.once('close', responseClosed)
  try {
    const body = await parseBody(req)
    const action = body.action
    const sourceRoot = required(body.sourceRoot, 'sourceRoot')
    if (action === 'projects') return json(res, 200, await directory.listProjects(sourceRoot))
    if (action === 'sessions') return json(res, 200, await directory.listSessions(required(body.projectKey, 'projectKey'), sourceRoot, {
      offset: optionalInteger(body.offset), limit: optionalInteger(body.limit),
    }))
    if (action === 'detail') return json(res, 200, await directory.detail({
      projectKey: required(body.projectKey, 'projectKey'), sessionId: required(body.sessionId, 'sessionId'), sourceRoot, signal: controller.signal,
    }))
    if (action === 'prepare') return json(res, 200, publicPrepare(await directory.prepare({
      projectKey: required(body.projectKey, 'projectKey'), sessionId: required(body.sessionId, 'sessionId'),
      workspacePath: required(body.workspacePath, 'workspacePath'), sourceRoot, forceCopy: body.forceCopy === true, signal: controller.signal,
    })))
    if (action === 'import') return json(res, 200, await importNativeHistory(directory, hostCtx, {
      projectKey: required(body.projectKey, 'projectKey'), sessionId: required(body.sessionId, 'sessionId'),
      workspacePath: required(body.workspacePath, 'workspacePath'), sourceRoot, forceCopy: body.forceCopy === true, signal: controller.signal,
    }))
    return json(res, 400, { error: '未知的 Claude Code 导入操作' })
  } catch (error) {
    if (!res.destroyed) return json(res, controller.signal.aborted ? 499 : 400, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    req.off('aborted', requestAborted); req.off('close', requestClosed); res.off('close', responseClosed)
  }
}

function publicPrepare(prepared: any): any {
  if (prepared.kind === 'prepared') return { kind: prepared.kind, sourceKey: prepared.sourceKey, title: prepared.title, sourceUpdatedAt: prepared.sourceUpdatedAt }
  if (prepared.kind === 'append') return { kind: prepared.kind, sourceKey: prepared.sourceKey, sessionId: prepared.sessionId, title: prepared.title, sourceUpdatedAt: prepared.sourceUpdatedAt }
  return prepared
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let received = 0
  for await (const chunk of req) { const bytes = chunk as Buffer; received += bytes.byteLength; if (received > 64 * 1024) throw new Error('Claude Code 导入请求过大'); chunks.push(bytes) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 导入请求必须是对象')
  return value as Record<string, unknown>
}
function required(value: unknown, name: string): string { if (typeof value !== 'string' || value === '') throw new Error(`Claude Code 导入缺少 ${name}`); return value }
function optionalInteger(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined }
function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return typeof value === 'string' ? value : undefined }
function trusted(req: IncomingMessage): boolean {
  const host = header(req, 'host'); if (host === undefined || header(req, 'sec-fetch-site') === 'cross-site') return false
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false
  const origin = header(req, 'origin'); if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}
function json(res: ServerResponse, status: number, body: unknown): void { const payload = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength }); res.end(payload) }

export { CLAUDE_IMPORT_PATH, ClaudeImportDirectory, parseClaudeSession } from './claude-import.mjs'
