import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatFileMentions, IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolFileLinkProvider } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { feedbackMessage, rehydrateMessage, requestOpenReview, respondFeedback, respondRehydrate, respondSessionAction, sessionActionMessage, type MarkdownReviewFeedback, type WorkspaceReviewFeedbackDelivery, type WorkspaceReviewSessionAction, type WorkspaceReviewSessionActionDelivery, workspaceReviewBridgeConfig } from './bridge.ts'
import { openWorkspaceMarkdown, rehydrateWorkspaceMarkdown } from './api.ts'
import { createWorkspaceReviewHeaderAction } from './WorkspaceReviewAction.tsx'
import { WorkspaceReviewDirectoryActions } from './WorkspaceReviewDirectoryActions.tsx'
import { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
import { workspaceFilePath } from './workspace-file-path.mjs'
import { workspaceMarkdownLink } from './workspace-markdown-link.mjs'
import type { WorkspacePickerDirectoryActionsProps, WorkspacePickerDirectoryProps } from './directory-slot.ts'
import { sameWorkspaceCwd, selectReadyWorkspaceDirectorySession, workspacePathForDirectory } from './directory-session.ts'

interface ReviewFeedback {
  /** Create one queued AI request in the current Harness session. */
  submitWorkspaceMarkdown(sessionId: string, feedback: MarkdownReviewFeedback): Promise<void>
}

function boundWorkspaceReviewTarget(ctx: ClientContext, harnessSessionId: string): WorkspaceReviewFeedbackDelivery {
  const sessions = ctx.sessions.list.getSnapshot()
  const target = sessions.byId[harnessSessionId as SessionId]
  if (target === undefined) throw new Error('此 Markdown 绑定的 Harness 会话当前不可用；请重新打开文档后重试。')
  return { targetSessionId: harnessSessionId, targetSessionTitle: target.displayTitle, status: target.running ? 'queued' : 'processing' }
}

function rewriteDraft(action: WorkspaceReviewSessionAction): string {
  return [
    `请基于当前会话中的 PRD 重新整理文档：${action.displayPath}。先不要开始执行，等待我补充下面的信息后再重写。`,
    '重写原因：[请补充]',
    '存在问题：[请补充]',
    '期望调整：[请补充]',
  ].join('\n')
}

function acceptPrompt(action: WorkspaceReviewSessionAction): string {
  return `我已采纳当前审阅的 PRD（${action.displayPath}）。请按当前 Skill 的下一步继续；如涉及远程文档写入，仍须先预览目标和变更、取得确认、写入后回读验证。`
}

interface ProducedFileFact {
  readonly seq: number
  readonly path: string
}

/** Preserve the unique full path behind a basename shown in closing prose. */
function producedMarkdownMention(owner: Parameters<ChatFileMentions['forClosing']>[0], value: string): string | undefined {
  const deliverables = owner.turn.data.get('deliverables') as { readonly produced?: readonly ProducedFileFact[] } | undefined
  const paths = deliverables?.produced
    ?.filter(produced => produced.seq <= owner.seq && typeof produced.path === 'string')
    .map(produced => produced.path) ?? []
  if (paths.includes(value)) return value
  const matches = [...new Set(paths.filter(path => {
    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return path.slice(separator + 1) === value
  }))]
  if (matches.length === 0) return value
  return matches.length === 1 ? matches[0] : undefined
}

// Conversation and Tool UI own the composable resolver registries. Both are
// hard dependencies: an optional one-shot lookup would silently skip a route
// when this product plugin starts before its registry is provided.
export const inject = ['slots', 'reviewFeedback', 'sessions', 'workspaces', 'chatFileMentions', 'toolFileLinks']

/** File discovery is same-origin; pending composer feedback belongs to the shared reviewFeedback service. */
export function apply(ctx: ClientContext): void {
  const bridge = workspaceReviewBridgeConfig(); const reviewFeedback = ctx.get('reviewFeedback') as ReviewFeedback
  const notifyOpenFailure = (sessionId: string, message: string): void => {
    const conversation = ctx.get('conversation') as IConversation | undefined
    const sessions = ctx.get('sessions') as ISessions | undefined
    const binding = sessions?.binding(sessionId as SessionId)
    if (conversation === undefined || binding === undefined) return
    try { conversation.input.for(binding.ctx).notify('error', message) } catch { /* the session may have closed while opening */ }
  }
  const resolveWorkspaceMarkdown = (sessionId: string, cwd: string | undefined, value: string) => {
    if (bridge === undefined) return undefined
    // A cold persisted session can have an identity before its cwd reaches the
    // chat owner. Relative paths remain safe: the Host resolves them against
    // that session's registered workspace. An absolute path still needs cwd
    // proof, so the `.` sentinel deliberately leaves it unclaimed.
    const displayPath = workspaceMarkdownLink(cwd ?? '.', value)
    if (displayPath === undefined) return undefined
    const label = `在 Markdown 审阅 Tab 中打开 ${displayPath}`
    return {
      label,
      title: label,
      open: () => {
        void openWorkspaceMarkdown(sessionId, displayPath)
          .then(review => { requestOpenReview(window.parent, bridge, review) })
          .catch(error => {
            const message = error instanceof Error ? error.message : String(error)
            notifyOpenFailure(sessionId, message)
            console.warn('workspace Markdown link open rejected:', error)
          })
      },
    }
  }
  const conversationMarkdown: ChatFileMentions = {
    forClosing(owner) {
      const resolveReview = (value: string) => {
        const producedPath = producedMarkdownMention(owner, value)
        return producedPath === undefined ? undefined : resolveWorkspaceMarkdown(String(owner.sessionId), owner.cwd, producedPath)
      }
      return { resolve: resolveReview, resolveLink: resolveReview }
    },
  }
  const toolMarkdown: ToolFileLinkProvider = {
    resolve(owner, value) {
      if (owner.sessionId === undefined) return undefined
      return resolveWorkspaceMarkdown(String(owner.sessionId), owner.cwd, value)
    },
  }
  ctx.effect(() => ctx.get('chatFileMentions')?.register(conversationMarkdown) ?? (() => {}), 'accrui-workspace-review: conversation Markdown links')
  ctx.effect(() => ctx.get('toolFileLinks')?.register(toolMarkdown) ?? (() => {}), 'accrui-workspace-review: Tool Markdown links')
  if (bridge !== undefined) ctx.effect(() => {
    const receive = (event: MessageEvent): void => {
      const feedback = feedbackMessage(event, window.parent, bridge)
      if (feedback !== undefined) {
        let target: WorkspaceReviewFeedbackDelivery
        try {
          target = boundWorkspaceReviewTarget(ctx, feedback.harnessSessionId)
          ctx.sessions.open(feedback.harnessSessionId as SessionId)
        } catch (error) {
          respondFeedback(window.parent, bridge, feedback.id, false, error instanceof Error ? error.message : String(error))
          return
        }
        void reviewFeedback.submitWorkspaceMarkdown(target.targetSessionId, feedback)
          .then(() => respondFeedback(window.parent, bridge, feedback.id, true, undefined, target))
          .catch(error => respondFeedback(window.parent, bridge, feedback.id, false, error instanceof Error ? error.message : String(error)))
        return
      }
      const actionRequest = sessionActionMessage(event, window.parent, bridge)
      if (actionRequest !== undefined) {
        const { requestId, action } = actionRequest
        let target: WorkspaceReviewFeedbackDelivery
        try {
          target = boundWorkspaceReviewTarget(ctx, action.harnessSessionId)
          ctx.sessions.open(action.harnessSessionId as SessionId)
          const binding = ctx.sessions.binding(action.harnessSessionId as SessionId)
          const conversation = ctx.get('conversation') as IConversation | undefined
          if (binding === undefined || conversation === undefined) throw new Error('绑定的 Harness 对话当前不可用；请重试。')
          if (action.action === 'rewrite') {
            const input = conversation.input.for(binding.ctx)
            const existing = input.state.getSnapshot().draft
            const addition = rewriteDraft(action)
            input.setDraft(existing.trim() === '' ? addition : `${existing}\n\n---\n\n${addition}`)
            const delivery: WorkspaceReviewSessionActionDelivery = { action: 'rewrite', targetSessionId: target.targetSessionId, targetSessionTitle: target.targetSessionTitle, status: 'draft_ready' }
            respondSessionAction(window.parent, bridge, requestId, true, undefined, delivery)
            return
          }
          const scoped = ctx.sessions.scope(action.harnessSessionId as SessionId)
          const scopedConversation = scoped?.get('conversation') as IConversation | undefined
          if (scopedConversation === undefined) throw new Error('绑定的 Harness 对话当前不可用；请重试。')
          void scopedConversation.send(acceptPrompt(action))
            .then(() => respondSessionAction(window.parent, bridge, requestId, true, undefined, { action: 'accept', targetSessionId: target.targetSessionId, targetSessionTitle: target.targetSessionTitle, status: target.status }))
            .catch(error => respondSessionAction(window.parent, bridge, requestId, false, error instanceof Error ? error.message : String(error)))
        } catch (error) {
          respondSessionAction(window.parent, bridge, requestId, false, error instanceof Error ? error.message : String(error))
        }
        return
      }
      const request = rehydrateMessage(event, window.parent, bridge)
      if (request === undefined) return
      void rehydrateWorkspaceMarkdown(request.harnessSessionId, request.reviewId, request.resourceId)
        .then(review => respondRehydrate(window.parent, bridge, request.requestId, review))
        .catch(error => respondRehydrate(window.parent, bridge, request.requestId, undefined, error instanceof Error ? error.message : String(error)))
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'workspace-review-bridge-ready/v1', nonce: bridge.nonce }, bridge.parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, 'accrui-workspace-review: feedback bridge')
  const useSessionForWorkspace = (workspaceId: string | undefined): string | undefined => {
    const workspaces = useSyncExternalStore(ctx.workspaces.list.subscribe, ctx.workspaces.list.getSnapshot, ctx.workspaces.list.getSnapshot)
    const sessions = useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot, ctx.sessions.list.getSnapshot)
    return selectReadyWorkspaceDirectorySession(workspaces.items, sessions, workspaceId)
  }
  ctx.slots.inject('accrui.workspace-picker.directory', () => ctx.slots.register({
    name: 'accrui.workspace-picker.directory', id: 'accrui-workspace-review-directory', order: 0,
  }, function WorkspacePickerDirectory({ workspaceId, refreshGeneration, onClose }: WorkspacePickerDirectoryProps) {
    const sessionId = useSessionForWorkspace(workspaceId)
    const workspaces = useSyncExternalStore(ctx.workspaces.list.subscribe, ctx.workspaces.list.getSnapshot, ctx.workspaces.list.getSnapshot)
    const workspacePath = workspacePathForDirectory(workspaces.items, workspaceId)
    return createElement(WorkspaceReviewTree, {
      sessionId,
      bridge,
      onOpenFile: async displayPath => {
        if (workspacePath === undefined) throw new Error('工作区路径尚未就绪，请重试。')
        await ctx.workspaces.openPath(workspaceFilePath(workspacePath, displayPath))
      },
      refreshGeneration,
      onClose,
    })
  }))
  ctx.slots.inject('accrui.workspace-picker.directory.actions', () => ctx.slots.register({
    name: 'accrui.workspace-picker.directory.actions', id: 'accrui-workspace-review-directory-actions', order: 0,
  }, function WorkspacePickerDirectoryActions({ workspacePath, refreshDirectory }: WorkspacePickerDirectoryActionsProps) {
    return createElement(WorkspaceReviewDirectoryActions, { onOpenWorkspace: () => ctx.workspaces.openPath(workspacePath), onRefresh: refreshDirectory })
  }))
  ctx.slots.inject('sidebar.workspaces.header.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.header.action', id: 'accrui-workspace-review-directory', order: 10,
  }, createWorkspaceReviewHeaderAction(bridge, useSessionForWorkspace, path => ctx.workspaces.openPath(path))))
}

export { WorkspaceReviewHeaderAction } from './WorkspaceReviewAction.tsx'
export { WorkspaceReviewTree } from './WorkspaceReviewTree.tsx'
export { sameWorkspaceCwd, selectReadyWorkspaceDirectorySession, workspacePathForDirectory } from './directory-session.ts'
export { workspaceReviewBridgeConfig, requestOpenReview, rehydrateMessage, respondFeedback, respondRehydrate, sessionActionMessage, respondSessionAction } from './bridge.ts'
