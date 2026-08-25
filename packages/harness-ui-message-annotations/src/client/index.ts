import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { reviewFeedbackPrompt } from './review-feedback-format.js'
import { ReviewFeedbackService } from './ReviewFeedbackService.ts'
import { AnnotationComposer, AnnotationStrip } from './MessageAnnotations.tsx'

export const inject = ['slots', 'composerSubmissionTransforms', 'sessions']

/** Register one browser-local review loop for assistant messages and workspace Markdown. */
export function apply(ctx: ClientContext): void {
  const annotations = new ReviewFeedbackService(ctx.sessions)
  const transforms = ctx.get('composerSubmissionTransforms')!
  ctx.provide('reviewFeedback', annotations)
  const injected = () => ({ hooks: { annotations: annotations.snapshot }, annotations })
  ctx.effect(() => transforms.register({
    id: 'review-feedback',
    emptySubmission: (sessionId) => ({
      getSnapshot: () => annotations.feedback(String(sessionId)).length > 0,
      subscribe: listener => annotations.snapshot.subscribe(listener),
    }),
    prepare: (sessionId, text) => {
      const items = annotations.feedback(String(sessionId))
      if (items.length === 0) return { text }
      const ids = items.map(item => item.id)
      return {
        text: reviewFeedbackPrompt(text, items),
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

export { AnnotationStore, ReviewFeedbackStore } from './AnnotationStore.ts'
export { ReviewFeedbackService } from './ReviewFeedbackService.ts'
export type { MarkdownSelectionAnchor, VisualMarkdownSelectionAnchor, WorkspaceMarkdownAnchor, MessageAnnotation, ReviewFeedback, ReviewFeedbackSnapshot, WorkspaceMarkdownFeedback, WorkspaceMarkdownFeedbackInput, SourceWorkspaceMarkdownFeedbackInput, VisualWorkspaceMarkdownFeedbackInput } from './AnnotationStore.ts'
export { annotationsPrompt } from './annotation-format.js'
export { reviewFeedbackPrompt } from './review-feedback-format.js'
