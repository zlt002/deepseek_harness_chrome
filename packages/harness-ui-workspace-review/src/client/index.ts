import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { feedbackMessage, rehydrateMessage, respondFeedback, respondRehydrate, type MarkdownReviewFeedback, workspaceReviewBridgeConfig } from './bridge.ts'
import { rehydrateWorkspaceMarkdown } from './api.ts'
import { createWorkspaceReviewHeaderAction } from './WorkspaceReviewAction.tsx'
import { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
import type { WorkspacePickerDirectoryProps } from './directory-slot.ts'
import { selectReadyWorkspaceDirectorySession } from './directory-session.ts'

interface ReviewFeedback {
  /** Create one immediate AI request in the feedback item's explicitly bound Harness session. */
  submitWorkspaceMarkdown(sessionId: string, feedback: MarkdownReviewFeedback): Promise<void>
}

export const inject = ['slots', 'reviewFeedback', 'sessions', 'workspaces']

/** File discovery is same-origin; pending composer feedback belongs to the shared reviewFeedback service. */
export function apply(ctx: ClientContext): void {
  const bridge = workspaceReviewBridgeConfig(); const reviewFeedback = ctx.get('reviewFeedback') as ReviewFeedback
  if (bridge !== undefined) ctx.effect(() => {
    const receive = (event: MessageEvent): void => {
      const feedback = feedbackMessage(event, window.parent, bridge)
      if (feedback !== undefined) {
        void reviewFeedback.submitWorkspaceMarkdown(feedback.harnessSessionId, feedback)
          .then(() => respondFeedback(window.parent, bridge, feedback.id, true))
          .catch(error => respondFeedback(window.parent, bridge, feedback.id, false, error instanceof Error ? error.message : String(error)))
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
  const useSessionForWorkspace = (workspaceId: string | undefined): string | undefined => {
    const workspaces = useSyncExternalStore(ctx.workspaces.list.subscribe, ctx.workspaces.list.getSnapshot, ctx.workspaces.list.getSnapshot)
    const sessions = useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot, ctx.sessions.list.getSnapshot)
    return selectReadyWorkspaceDirectorySession(workspaces.items, sessions, workspaceId)
  }
  ctx.slots.inject('accrui.workspace-picker.directory', () => ctx.slots.register({
    name: 'accrui.workspace-picker.directory', id: 'accrui-workspace-review-directory', order: 0,
  }, function WorkspacePickerDirectory({ workspaceId, onClose }: WorkspacePickerDirectoryProps) {
    const sessionId = useSessionForWorkspace(workspaceId)
    return createElement(WorkspaceReviewTree, { sessionId, bridge, onClose })
  }))
  ctx.slots.inject('sidebar.workspaces.header.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.header.action', id: 'accrui-workspace-review-directory', order: 10,
  }, createWorkspaceReviewHeaderAction(bridge, useSessionForWorkspace)))
}

export { WorkspaceReviewHeaderAction } from './WorkspaceReviewAction.tsx'
export { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
export { selectReadyWorkspaceDirectorySession } from './directory-session.ts'
export { workspaceReviewBridgeConfig, requestOpenReview, rehydrateMessage, respondFeedback, respondRehydrate } from './bridge.ts'
