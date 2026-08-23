import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PrototypeProjectStore } from './prototype-store.mjs'
import { PROTOTYPE_STUDIO_OPEN_PATH, PROTOTYPE_STUDIO_RESTORE_PATH, PROTOTYPE_STUDIO_SNAPSHOT_PATH } from './protocol.ts'
import { createTrustedRevision, validateReferenceEvidence, verifyReferenceEvidenceFingerprint, verifyTrustedRevision } from './prototype-document.ts'

export const name = 'accrui-prototype-studio'
export const inject = ['sessions', 'tools']

interface HostContext {
  tools: { register(definition: unknown): () => void }
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void }
  inject(deps: readonly string[], callback: (ctx: HostContext) => void): void
  effect(callback: () => () => void, name: string): void
}
interface ToolExecutionContext { agent?: { id: string } }

const store = new PrototypeProjectStore(process.env.DSH_PROTOTYPE_STORE?.trim() || join(homedir(), '.accrui', 'prototype-studio'), { validateReferenceEvidence, verifyReferenceEvidenceFingerprint, createTrustedRevision, verifyTrustedRevision })

export function apply(ctx: HostContext): void {
  ctx.tools.register({
    name: 'save_product_prototype',
    description: 'Validate and save one interactive product prototype revision for the current Prototype Studio project. The payload is bounded JSON only; JavaScript, React source, HTML and network behavior are rejected. Read the project id and current revision id from the user request.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['project_id', 'design_spec', 'document', 'change_summary'], properties: {
        project_id: { type: 'string', description: 'Opaque prototype project id supplied by Prototype Studio.' },
        expected_revision_id: { type: 'string', description: 'Current revision id. Omit only for the first saved version.' },
        design_spec: { type: 'object', additionalProperties: true, description: 'V1 design specification based only on the authorized reference evidence.' },
        document: { type: 'object', additionalProperties: true, description: 'V1 safe prototype document containing fixed components and actions only.' },
        change_summary: { type: 'string', description: 'Short user-facing summary of this revision.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['status', 'projectId', 'revisionId', 'documentFingerprint', 'changeSummary'], properties: { status: { type: 'string', const: 'verified_write' }, projectId: { type: 'string' }, revisionId: { type: 'string' }, documentFingerprint: { type: 'string' }, changeSummary: { type: 'string' } } },
      render: (_args: unknown, value: { revisionId: string }) => [{ type: 'text', text: `Prototype revision ${value.revisionId} was validated, saved, and read back.` }],
    },
    execute(args: unknown, exec: ToolExecutionContext) {
      if (exec.agent === undefined) throw new Error('save_product_prototype requires an owning Harness session.')
      const value = prototypeSaveArgs(args)
      return store.save({ projectId: value.project_id, sessionId: String(exec.agent.id), ...(value.expected_revision_id === undefined ? {} : { expectedRevisionId: value.expected_revision_id }), designSpec: value.design_spec, document: value.document, changeSummary: value.change_summary })
    },
    presentCall: () => ({ card: 'generic', title: '生成产品原型', kind: 'edit' }),
  })
  ctx.inject(['webServer'], webCtx => {
    const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: (req, res) => { void handler(req, res).catch(error => json(res, 400, { error: error instanceof Error ? error.message : String(error) })) } }), `accrui-prototype-studio: ${path}`)
    route(PROTOTYPE_STUDIO_OPEN_PATH, async (req, res) => {
      const body = await bodyOf(req); const capability = bearer(req)
      json(res, 200, await store.open({ projectId: stringOf(body.projectId, 'projectId'), sessionId: stringOf(body.sessionId, 'sessionId'), capability, evidence: body.evidence }))
    })
    route(PROTOTYPE_STUDIO_SNAPSHOT_PATH, async (req, res) => {
      const body = await bodyOf(req); const capability = bearer(req)
      json(res, 200, await store.authorizedSnapshot(stringOf(body.projectId, 'projectId'), capability))
    })
    route(PROTOTYPE_STUDIO_RESTORE_PATH, async (req, res) => {
      const body = await bodyOf(req); const capability = bearer(req)
      json(res, 200, await store.restore({ projectId: stringOf(body.projectId, 'projectId'), capability, targetRevisionId: stringOf(body.targetRevisionId, 'targetRevisionId'), expectedCurrentRevisionId: stringOf(body.expectedCurrentRevisionId, 'expectedCurrentRevisionId') }))
    })
  })
}

function prototypeSaveArgs(value: unknown): { project_id: string; expected_revision_id?: string; design_spec: unknown; document: unknown; change_summary: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('save_product_prototype arguments must be an object.')
  const item = value as Record<string, unknown>
  if (typeof item.project_id !== 'string' || (item.expected_revision_id !== undefined && typeof item.expected_revision_id !== 'string') || typeof item.change_summary !== 'string' || item.design_spec === null || typeof item.design_spec !== 'object' || item.document === null || typeof item.document !== 'object') throw new Error('save_product_prototype arguments are invalid.')
  return { project_id: item.project_id, ...(typeof item.expected_revision_id === 'string' ? { expected_revision_id: item.expected_revision_id } : {}), design_spec: item.design_spec, document: item.document, change_summary: item.change_summary }
}
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') throw new Error('Prototype Studio routes accept POST only.')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const bytes = chunk as Buffer; size += bytes.byteLength; if (size > 300_000) throw new Error('Prototype Studio request is too large.'); chunks.push(bytes) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prototype Studio request must be an object.')
  return value as Record<string, unknown>
}
function bearer(req: IncomingMessage): string { const value = req.headers.authorization; if (typeof value !== 'string' || !value.startsWith('Bearer ') || value.length < 40 || value.length > 300) throw new Error('Prototype Studio capability is required.'); return value.slice(7) }
function stringOf(value: unknown, name: string): string { if (typeof value !== 'string' || value.length === 0 || value.length > 160) throw new Error(`Prototype Studio requires ${name}.`); return value }
function json(res: ServerResponse, status: number, value: unknown): void { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }

export { PrototypeProjectStore, prototypeProjectId } from './prototype-store.mjs'
export * from './protocol.ts'
export * from './prototype-document'
