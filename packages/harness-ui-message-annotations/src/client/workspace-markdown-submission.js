import { reviewFeedbackPrompt } from './review-feedback-format.js'

/**
 * One-shot delivery for review-page feedback.  The ordinary composer transform
 * stays available for assistant-message annotations; this path deliberately
 * sends only the Markdown annotation that the user just submitted.
 */
export class WorkspaceMarkdownSubmitter {
  #inFlight = new Map()
  #completed = new Set()

  constructor(store, sessions) {
    this.store = store
    this.sessions = sessions
  }

  submit(sessionId, feedback) {
    const key = `${sessionId}\u0000${feedback.id}`
    if (this.#completed.has(key)) return Promise.resolve()
    const existing = this.#inFlight.get(key)
    if (existing !== undefined) return existing

    const pending = this.#submit(sessionId, feedback)
    this.#inFlight.set(key, pending)
    pending.then(
      () => {
        this.#rememberCompleted(key)
        if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key)
      },
      () => { if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key) },
    )
    return pending
  }

  #rememberCompleted(key) {
    this.#completed.add(key)
    while (this.#completed.size > 512) this.#completed.delete(this.#completed.values().next().value)
  }

  async #submit(sessionId, feedback) {
    if (!this.store.importWorkspaceMarkdown(sessionId, feedback)) {
      throw new Error('Markdown 批注无效，未发送给 AI。')
    }
    const item = this.store.feedback(sessionId).find(candidate => candidate.id === feedback.id && candidate.source === 'workspace-markdown')
    if (item === undefined) throw new Error('Markdown 批注没有保存在当前 Harness 会话中。')

    const scope = this.sessions.scope(sessionId)
    if (scope === undefined) throw new Error('目标 Harness 会话当前不可用；请回到侧边栏重新打开该文档后重试。')
    const conversation = scope.get('conversation')
    if (conversation === undefined || typeof conversation.send !== 'function') {
      throw new Error('目标 Harness 会话没有可用的对话服务；请重新连接 Harness 后重试。')
    }

    // The caller resolves the side panel's current session at click time; this
    // public scoped conversation service keeps the prompt in that same session.
    await conversation.send(reviewFeedbackPrompt('', [item]))
    this.store.accept(sessionId, [feedback.id])
  }
}
