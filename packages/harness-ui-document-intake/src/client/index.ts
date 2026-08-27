import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachDocumentControl, type AttachDocumentInjected } from './AttachDocumentControl.tsx'
import { DocumentAttachmentStrip, type DocumentAttachmentInjected } from './DocumentAttachmentStrip.tsx'
import { createDocumentIntake } from './intake.ts'
import { documentSubmissionPrompt, PendingDocuments } from './pending-documents.mjs'

export const inject = ['slots', 'composerSubmissionTransforms']

/** Accept composer documents through the generic file-intake seam and a paperclip control. */
export function apply(ctx: ClientContext): void {
  const documents = new PendingDocuments()
  const intake = createDocumentIntake(ctx, documents)
  const transforms = ctx.get('composerSubmissionTransforms')!
  ctx.provide('composerFileIntake', intake)
  ctx.effect(() => transforms.register({
    id: 'document-intake',
    emptySubmission: sessionId => documents.availability(sessionId),
    prepare: (sessionId, text) => {
      const files = documents.ready(sessionId)
      const ids = files.map(file => file.id)
      return {
        text: documentSubmissionPrompt(text, files),
        ...(ids.length === 0 ? {} : { accept: () => documents.accept(sessionId, ids) }),
      }
    },
  }), 'accrui-document-intake: submit transform')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'accrui-document-intake',
    order: 20,
    inject: (): AttachDocumentInjected => ({ intake }),
  }, AttachDocumentControl))
  ctx.slots.inject('conversation.composer.above', () => ctx.slots.register({
    name: 'conversation.composer.above',
    id: 'accrui-document-intake-strip',
    order: 30,
    inject: (): DocumentAttachmentInjected => ({ documents }),
  }, DocumentAttachmentStrip))
}

export { AttachDocumentControl } from './AttachDocumentControl.tsx'
export type { AttachDocumentInjected } from './AttachDocumentControl.tsx'
export { DocumentAttachmentStrip } from './DocumentAttachmentStrip.tsx'
export type { DocumentAttachmentInjected } from './DocumentAttachmentStrip.tsx'
export { ACCEPT, classify, createDocumentIntake } from './intake.ts'
export { documentSubmissionPrompt, PendingDocuments } from './pending-documents.mjs'
