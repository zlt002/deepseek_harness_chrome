import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DOCUMENT_INTAKE_PATH,
  DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS,
  DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES,
  classifyDocuments,
  documentDraftLine,
} from '../formats.ts'

export interface ComposerFileIntake {
  accept(sessionId: SessionId, files: readonly File[]): string | null
}

export const ACCEPT = [...DOCUMENT_INTAKE_ACCEPTED_EXTENSIONS, ...DOCUMENT_INTAKE_ACCEPTED_MEDIA_TYPES].join(',')

/**
 * Session-scoped document remainder of composer paste/drop.
 * @param ctx - client root context; conversation and sessions are read at call time.
 * @returns the optional composerFileIntake face.
 */
export function createDocumentIntake(ctx: ClientContext): ComposerFileIntake {
  return {
    accept(sessionId, files) {
      const rejected = classify(files)
      if (rejected !== null) return rejected
      void upload(ctx, sessionId, files)
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

async function upload(ctx: ClientContext, sessionId: SessionId, files: readonly File[]): Promise<void> {
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
    const body = await response.json() as { error?: string; files?: ReadonlyArray<{ relativePath: string; kind: 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'md' | 'txt' }> }
    if (!response.ok || body.files === undefined) {
      throw new Error(body.error ?? `文档上传失败：HTTP ${String(response.status)}`)
    }
    if (input === undefined) return
    const current = input.state.getSnapshot().draft
    const lines = body.files.map(file => documentDraftLine(file.relativePath, file.kind))
    const next = current.trim() === '' ? lines.join('\n') : `${current.replace(/\s+$/u, '')}\n${lines.join('\n')}`
    input.setDraft(next)
  } catch (error) {
    input?.notify('error', error instanceof Error ? error.message : String(error))
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
