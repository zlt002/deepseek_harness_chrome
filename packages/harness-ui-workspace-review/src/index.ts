/** Host half: bounded, read-only Markdown review capabilities rooted in session.header.cwd. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  WORKSPACE_REVIEW_COMMIT_WRITE_PATH,
  WORKSPACE_REVIEW_LIST_PATH,
  WORKSPACE_REVIEW_OPEN_PATH,
  WORKSPACE_REVIEW_PREPARE_WRITE_PATH,
  WORKSPACE_REVIEW_PROPOSALS_PATH,
  WORKSPACE_REVIEW_REHYDRATE_PATH,
  WORKSPACE_REVIEW_SELECTION_PATH,
  WORKSPACE_REVIEW_SNAPSHOT_PATH,
} from './protocol.ts'
import { WorkspaceReviewRuntime } from './workspace.mjs'

export const name = 'accrui-workspace-review'
export const inject = ['sessions', 'tools']

export * from './protocol.ts'
export { WorkspaceReviewRuntime } from './workspace.mjs'

interface SessionLookup {
  get(id: string): { header: { cwd?: string } } | undefined
}

interface WebServerLookup {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

interface HostContext {
  sessions: SessionLookup
  tools: { register(definition: unknown): () => void }
  webServer: WebServerLookup
  inject(deps: readonly string[], callback: (ctx: HostContext) => void): void
  effect(callback: () => () => void, name: string): void
}

interface ProposeEditArgs { review_id: string; selection_id: string; replacement_markdown: string; summary?: string }
interface ToolExecutionContext { agent?: { id: string } }

/** Same-origin session-intake routes and bearer background routes deliberately have separate guards. */
export function apply(ctx: HostContext): void {
  const reviews = new WorkspaceReviewRuntime()
  ctx.tools.register({
    name: 'propose_workspace_markdown_edit',
    description: 'Return an AI edit proposal to the open visual Markdown Review Tab. Use this when workspace_markdown_annotations includes review_id and selection_id. This queues a reviewable visual diff and never writes the file.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['review_id', 'selection_id', 'replacement_markdown'], properties: {
        review_id: { type: 'string', description: 'Opaque review_id from the user-selected Markdown annotation.' },
        selection_id: { type: 'string', description: 'Opaque selection_id from the user-selected Markdown annotation.' },
        replacement_markdown: { type: 'string', description: 'Markdown fragment that replaces exactly the selected content.' },
        summary: { type: 'string', description: 'Short user-facing summary of the proposed change.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['status', 'proposalId', 'reviewId', 'selectionId'], properties: {
          status: { type: 'string', const: 'queued' },
          proposalId: { type: 'string' },
          reviewId: { type: 'string' },
          selectionId: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { proposalId: string }) => [{ type: 'text', text: `Queued visual Markdown proposal ${value.proposalId}; the user can accept or reject it in the Review Tab.` }],
    },
    execute(args: unknown, exec: ToolExecutionContext) {
      if (exec.agent === undefined) throw new Error('propose_workspace_markdown_edit requires an owning Harness session')
      const parsed = proposeEditArgs(args)
      return reviews.proposeEdit(String(exec.agent.id), parsed.review_id, parsed.selection_id, parsed.replacement_markdown, parsed.summary ?? '')
    },
    presentCall: (args: unknown) => ({
      card: 'generic',
      title: args !== null && typeof args === 'object' && !Array.isArray(args) && typeof (args as Record<string, unknown>).summary === 'string'
        ? ((args as Record<string, string>).summary.trim() || '提出 Markdown 修改')
        : '提出 Markdown 修改',
      kind: 'edit',
    }),
  })
  ctx.inject(['webServer'], webCtx => {
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path, handler: (req, res) => {
        void handler(req, res).catch(error => {
          if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          else res.destroy()
        })
      } }),
      `accrui-workspace-review: ${path}`,
    )
    register(WORKSPACE_REVIEW_LIST_PATH, async (req, res) => {
      const body = await trustedBody(req, res)
      if (body === undefined) return
      const session = sessionFor(webCtx, body.sessionId)
      json(res, 200, await reviews.list(session.cwd, optionalString(body.relativePath)))
    })
    register(WORKSPACE_REVIEW_OPEN_PATH, async (req, res) => {
      const body = await trustedBody(req, res)
      if (body === undefined) return
      const session = sessionFor(webCtx, body.sessionId)
      json(res, 200, await reviews.open(session.id, session.cwd, requiredString(body.relativePath, 'relativePath')))
    })
    register(WORKSPACE_REVIEW_REHYDRATE_PATH, async (req, res) => {
      const body = await trustedBody(req, res)
      if (body === undefined) return
      const session = sessionFor(webCtx, body.sessionId)
      json(res, 200, await reviews.rehydrate(session.id, session.cwd, requiredString(body.reviewId, 'reviewId'), requiredString(body.resourceId, 'resourceId')))
    })
    register(WORKSPACE_REVIEW_SNAPSHOT_PATH, async (req, res) => {
      if (req.method !== 'POST') return void json(res, 405, { error: 'workspace review snapshot accepts POST only' })
      const body = await parseBody(req)
      const capability = bearer(req)
      if (capability === undefined) return void json(res, 401, { error: 'workspace review capability is required' })
      json(res, 200, await reviews.snapshot(requiredString(body.reviewId, 'reviewId'), capability))
    })
    register(WORKSPACE_REVIEW_SELECTION_PATH, async (req, res) => {
      if (req.method !== 'POST') return void json(res, 405, { error: 'workspace review selection accepts POST only' })
      const body = await parseBody(req); const capability = bearer(req)
      if (capability === undefined) return void json(res, 401, { error: 'workspace review capability is required' })
      json(res, 200, await reviews.registerSelection(requiredString(body.reviewId, 'reviewId'), capability, body.selection))
    })
    register(WORKSPACE_REVIEW_PROPOSALS_PATH, async (req, res) => {
      if (req.method !== 'POST') return void json(res, 405, { error: 'workspace review proposals accepts POST only' })
      const body = await parseBody(req); const capability = bearer(req)
      if (capability === undefined) return void json(res, 401, { error: 'workspace review capability is required' })
      json(res, 200, reviews.proposals(requiredString(body.reviewId, 'reviewId'), capability, optionalInteger(body.afterSequence) ?? 0))
    })
    register(WORKSPACE_REVIEW_PREPARE_WRITE_PATH, async (req, res) => {
      if (req.method !== 'POST') return void json(res, 405, { error: 'workspace review prepare-write accepts POST only' })
      const body = await parseBody(req); const capability = bearer(req)
      if (capability === undefined) return void json(res, 401, { error: 'workspace review capability is required' })
      json(res, 200, await reviews.prepareWrite(requiredString(body.reviewId, 'reviewId'), capability, body.expected, requiredStringAllowEmpty(body.content, 'content')))
    })
    register(WORKSPACE_REVIEW_COMMIT_WRITE_PATH, async (req, res) => {
      if (req.method !== 'POST') return void json(res, 405, { error: 'workspace review commit-write accepts POST only' })
      const body = await parseBody(req); const capability = bearer(req)
      if (capability === undefined) return void json(res, 401, { error: 'workspace review capability is required' })
      json(res, 200, await reviews.commitWrite(requiredString(body.reviewId, 'reviewId'), capability, requiredString(body.approval, 'approval'), requiredString(body.idempotencyKey, 'idempotencyKey'), requiredStringAllowEmpty(body.content, 'content')))
    })
  })
}

async function trustedBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  if (req.method !== 'POST') { json(res, 405, { error: 'workspace review routes accept POST only' }); return undefined }
  if (!isTrustedSessionRequest(req)) { json(res, 403, { error: 'workspace review session route is loopback same-origin only' }); return undefined }
  return parseBody(req)
}

function sessionFor(ctx: HostContext, value: unknown): { id: string; cwd: string } {
  const id = requiredString(value, 'sessionId')
  const cwd = ctx.sessions.get(id)?.header.cwd
  if (cwd === undefined || cwd === '') throw new Error(`session "${id}" has no project cwd`)
  return { id, cwd }
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let received = 0
  for await (const chunk of req) {
    const bytes = chunk as Buffer; received += bytes.byteLength
    if (received > 64 * 1024) throw new Error('workspace review request is too large')
    chunks.push(bytes)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('workspace review request must be an object')
  return parsed as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`workspace review requires ${name}`)
  return value
}
function requiredStringAllowEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`workspace review requires ${name}`)
  return value
}
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function optionalInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) ? value as number : undefined }
function proposeEditArgs(value: unknown): ProposeEditArgs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('propose_workspace_markdown_edit requires an object')
  const item = value as Record<string, unknown>
  if (typeof item.review_id !== 'string' || typeof item.selection_id !== 'string' || typeof item.replacement_markdown !== 'string'
    || (item.summary !== undefined && typeof item.summary !== 'string')) throw new Error('propose_workspace_markdown_edit arguments are invalid')
  return { review_id: item.review_id, selection_id: item.selection_id, replacement_markdown: item.replacement_markdown, ...(typeof item.summary === 'string' ? { summary: item.summary } : {}) }
}
function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return typeof value === 'string' ? value : undefined }
function bearer(req: IncomingMessage): string | undefined { const value = header(req, 'authorization'); return value?.startsWith('Bearer ') === true ? value.slice(7) : undefined }
function isTrustedSessionRequest(req: IncomingMessage): boolean {
  const host = header(req, 'host'); if (!isLoopbackHost(host) || header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin'); if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '').toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength }); res.end(payload)
}
