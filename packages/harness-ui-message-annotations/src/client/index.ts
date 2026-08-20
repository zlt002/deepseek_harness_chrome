import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { annotationsPrompt } from './annotation-format.js'
import { AnnotationStore } from './AnnotationStore.ts'
import { AnnotationComposer, AnnotationStrip } from './MessageAnnotations.tsx'

export const inject = ['slots', 'composerSubmissionTransforms']

/** Register the complete browser-local annotation loop through public slots and the submit seam. */
export function apply(ctx: ClientContext): void {
  const annotations = new AnnotationStore()
  const transforms = ctx.get('composerSubmissionTransforms')!
  const injected = () => ({ hooks: { annotations: annotations.snapshot }, annotations })
  ctx.effect(() => transforms.register({
    id: 'message-annotations',
    prepare: (sessionId, text) => {
      const items = annotations.annotations(String(sessionId))
      if (items.length === 0) return { text }
      const ids = items.map(item => item.id)
      return {
        text: annotationsPrompt(text, items),
        accept: () => annotations.accept(String(sessionId), ids),
      }
    },
  }), 'accrui-message-annotations: submit transform')
  ctx.slots.inject('conversation.composer.above', () => ctx.slots.register({
    name: 'conversation.composer.above', id: 'message-annotation-strip', order: 25, inject: injected,
  }, AnnotationStrip))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'message-annotation-composer', order: 25, inject: injected,
  }, AnnotationComposer))
}

export { AnnotationStore } from './AnnotationStore.ts'
export { annotationsPrompt } from './annotation-format.js'
