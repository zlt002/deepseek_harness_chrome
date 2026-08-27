import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { assistantMessageFeedback, ReviewFeedbackStore, type WorkspaceMarkdownFeedbackInput } from './AnnotationStore.ts'
import { WorkspaceMarkdownSubmitter } from './workspace-markdown-submission.js'

/** Public review-feedback face shared by assistant annotations and Markdown review. */
export class ReviewFeedbackService extends ReviewFeedbackStore {
  private readonly workspaceMarkdown: WorkspaceMarkdownSubmitter

  constructor(sessions: ISessions) {
    super()
    this.workspaceMarkdown = new WorkspaceMarkdownSubmitter(this, sessions)
  }

  /** Import one verified Markdown annotation and immediately create its bound AI turn. */
  submitWorkspaceMarkdown(sessionId: string, feedback: WorkspaceMarkdownFeedbackInput): Promise<void> {
    return this.workspaceMarkdown.submit(sessionId, feedback)
  }
}

export { assistantMessageFeedback }
