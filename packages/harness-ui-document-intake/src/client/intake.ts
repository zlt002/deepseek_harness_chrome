import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DOCUMENT_INTAKE_PATH,
  DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS,
  DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES,
  classifyDocuments,
} from '../formats.ts'
import type { PendingDocuments } from './pending-documents.mjs'

export interface ComposerFileIntake {
  accept(sessionId: SessionId, files: readonly File[]): string | null
}

export const ACCEPT = [...DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS, ...DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES].join(',')

/**
 * Session-scoped document remainder of composer paste/drop.
 * @param ctx - client root context; conversation and sessions are read at call time.
 * @returns the optional composerFileIntake face.
 */
export function createDocumentIntake(ctx: ClientContext, documents: PendingDocuments): ComposerFileIntake {
  return {
    accept(sessionId, files) {
      const rejected = classify(files)
      if (rejected !== null) return rejected
      const pending = documents.begin(sessionId, files)
      void upload(ctx, sessionId, files, pending.map(file => file.id), documents)
      return null
    },
  }
}

/**
 * Same classification used by the hidden file picker.
 * @param files - browser files.
 * @returns a user-visible refusal, or null when every file is admitted.
 */
export function classify(files: readonly File[]): string | null {
  return classifyDocuments(files)
}

async function upload(ctx: ClientContext, sessionId: SessionId, files: readonly File[], ids: readonly number[], documents: PendingDocuments): Promise<void> {
  const input = inputOf(ctx, sessionId)
  try {
    const payload = {
      sessionId: String(sessionId),
      files: await Promise.all(files.map(async file => ({
        name: file.name,
        mediaType: file.type,
        data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      }))),
    }
    const response = await fetch(DOCUMENT_INTAKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json() as { error?: string; files?: ReadonlyArray<{ name?: string; relativePath: string; kind: 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt' }> }
    if (!response.ok || body.files === undefined) {
      throw new Error(body.error ?? `文档上传失败：HTTP ${String(response.status)}`)
    }
    documents.resolve(sessionId, ids, body.files)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    documents.fail(sessionId, ids, message)
    input?.notify('error', message)
  }
}

function inputOf(ctx: ClientContext, sessionId: SessionId) {
  const conversation = ctx.get('conversation') as IConversation | undefined
  const sessions = ctx.get('sessions') as ISessions | undefined
  const binding = sessions?.binding(sessionId)
  if (conversation === undefined || binding === undefined) return undefined
  return conversation.input.for(binding.ctx)
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
