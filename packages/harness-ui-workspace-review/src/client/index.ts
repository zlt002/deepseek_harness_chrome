import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { feedbackMessage, rehydrateMessage, respondRehydrate, type MarkdownReviewFeedback, workspaceReviewBridgeConfig } from './bridge.ts'
import { rehydrateWorkspaceMarkdown } from './api.ts'
import { WorkspaceReviewAction, type WorkspaceReviewActionInjected } from './WorkspaceReviewAction.tsx'

interface ReviewFeedback {
  /** Import a background-verified Markdown annotation into its explicitly bound Harness session. */
  importWorkspaceMarkdown(sessionId: string, feedback: MarkdownReviewFeedback): boolean
}

export const inject = ['slots', 'reviewFeedback']

/** File discovery is same-origin; pending composer feedback belongs to the shared reviewFeedback service. */
export function apply(ctx: ClientContext): void {
  const bridge = workspaceReviewBridgeConfig(); const reviewFeedback = ctx.get('reviewFeedback') as ReviewFeedback
  if (bridge !== undefined) ctx.effect(() => {
    const receive = (event: MessageEvent): void => {
      const feedback = feedbackMessage(event, window.parent, bridge)
      if (feedback !== undefined) {
        const accepted = reviewFeedback.importWorkspaceMarkdown(feedback.harnessSessionId, feedback)
        window.parent.postMessage({ type: 'markdown-review-feedback-accepted/v1', nonce: bridge.nonce, deliveryId: feedback.id, accepted }, bridge.parentOrigin)
        return
      }
      const request = rehydrateMessage(event, window.parent, bridge)
      if (request === undefined) return
      void rehydrateWorkspaceMarkdown(request.harnessSessionId, request.reviewId, request.resourceId)
        .then(review => respondRehydrate(window.parent, bridge, request.requestId, review))
        .catch(error => respondRehydrate(window.parent, bridge, request.requestId, undefined, error instanceof Error ? error.message : String(error)))
    }
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive)
  }, 'accrui-workspace-review: feedback bridge')
  const injected = (): WorkspaceReviewActionInjected => ({ bridge })
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({ name: 'sidebar.compact.action', id: 'workspace-markdown-files', order: 15, inject: injected }, WorkspaceReviewAction))
}

export { WorkspaceReviewAction } from './WorkspaceReviewAction.tsx'
export { workspaceReviewBridgeConfig, requestOpenReview, rehydrateMessage, respondRehydrate } from './bridge.ts'
