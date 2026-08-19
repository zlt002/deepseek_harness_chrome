/** Host half: write composer documents into the current session workspace. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DOCUMENT_INTAKE_MAX_BYTES, DOCUMENT_INTAKE_PATH } from './formats.ts'
import { saveSessionDocuments } from './save.ts'

export const name = 'accrui-document-intake'
export const inject = ['sessions']

export { DOCUMENT_INTAKE_MAX_BYTES, DOCUMENT_INTAKE_PATH, documentDraftLine, documentKindOf } from './formats.ts'
export { saveSessionDocuments } from './save.ts'

interface SessionLookup {
  get(id: string): { header: { cwd?: string } } | undefined
}

interface WebServerLookup {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

interface HostContext {
  sessions: SessionLookup
  webServer: WebServerLookup
  inject(deps: readonly string[], callback: (ctx: HostContext) => void): void
  effect(callback: () => () => void, name: string): void
}

/** Register the exact /api/composer.document write route when the Web carrier is present. */
export function apply(ctx: HostContext): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: DOCUMENT_INTAKE_PATH,
      handler: (req, res) => { void handleDocumentIntake(webCtx, req, res) },
    }), 'accrui-document-intake: composer document route')
  })
}

async function handleDocumentIntake(ctx: HostContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'composer.document accepts POST only' })
    return
  }
  if (!isTrustedComposerRequest(req)) {
    json(res, 403, { error: 'composer.document is loopback-only' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(req, DOCUMENT_INTAKE_MAX_BYTES + 1024 * 1024))
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  const sessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string'
    ? (body as { sessionId: string }).sessionId
    : ''
  const files = Array.isArray((body as { files?: unknown }).files) ? (body as { files: unknown[] }).files : []
  if (sessionId === '' || files.length === 0) {
    json(res, 400, { error: 'composer.document requires sessionId and files' })
    return
  }
  const session = ctx.sessions.get(sessionId)
  const cwd = session?.header.cwd
  if (session === undefined || cwd === undefined || cwd === '') {
    json(res, 404, { error: `session "${sessionId}" has no project cwd` })
    return
  }
  try {
    const saved = await saveSessionDocuments(cwd, files.map(decodeUpload))
    json(res, 200, { files: saved })
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function decodeUpload(value: unknown): { name: string; mediaType?: string; bytes: Uint8Array } {
  if (value === null || typeof value !== 'object') throw new Error('invalid document payload')
  const record = value as { name?: unknown; mediaType?: unknown; data?: unknown }
  if (typeof record.name !== 'string' || typeof record.data !== 'string') {
    throw new Error('each document needs name and data')
  }
  return {
    name: record.name,
    ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
    bytes: decodeBase64(record.data),
  }
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength === 0 && value.replace(/\s+/g, '') !== '') throw new Error('document data is not valid base64')
  return bytes
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxBytes) throw new Error('document request is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function isTrustedComposerRequest(req: IncomingMessage): boolean {
  const host = header(req, 'host')
  if (!isLoopbackHost(host)) return false
  if (header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '').toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength })
  res.end(payload)
}
