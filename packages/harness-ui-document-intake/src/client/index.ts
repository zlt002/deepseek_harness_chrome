import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachDocumentControl, type AttachDocumentInjected } from './AttachDocumentControl.tsx'
import { createDocumentIntake } from './intake.ts'

export const inject = ['slots']

/** Accept composer documents through the generic file-intake seam and a paperclip control. */
export function apply(ctx: ClientContext): void {
  const intake = createDocumentIntake(ctx)
  ctx.provide('composerFileIntake', intake)
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'accrui-document-intake',
    order: 20,
    inject: (): AttachDocumentInjected => ({ intake }),
  }, AttachDocumentControl))
}

export { AttachDocumentControl } from './AttachDocumentControl.tsx'
export type { AttachDocumentInjected } from './AttachDocumentControl.tsx'
export { ACCEPT, classify, createDocumentIntake } from './intake.ts'
