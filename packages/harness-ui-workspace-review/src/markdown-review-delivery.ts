type Reply = (response: unknown) => void
type Message =
  | { type: 'markdown-review-feedback/v1'; feedback: { id: string } }
  | { type: 'markdown-review-session-action/v1'; requestId: string; action: { action: 'rewrite' | 'accept' } }

interface DeliveryEnvironment {
  postMessage(message: Message): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(timer: number): void
  randomUUID(): string
  timeoutMs: number
}

interface Pending {
  message: Message
  reply: Reply
  timeout: number
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && value.trim() !== ''
}

/** Owns review delivery waiting, not AI execution or cancellation. The caller
 * validates incoming payloads and authenticates iframe messages before entry. */
export class MarkdownReviewDelivery {
  #ready = false
  #feedback = new Map<string, Pending>()
  #actions = new Map<string, Pending>()

  constructor(private readonly environment: DeliveryEnvironment) {}

  feedback(feedback: { id: string }, reply: Reply): void {
    this.#register(this.#feedback, feedback.id, { type: 'markdown-review-feedback/v1', feedback }, reply,
      'Harness 未在 15 秒内确认 AI 请求；可以重试，同一批注不会重复发送。')
  }

  action(action: { action: 'rewrite' | 'accept' }, reply: Reply): void {
    const requestId = this.environment.randomUUID()
    this.#register(this.#actions, requestId, { type: 'markdown-review-session-action/v1', requestId, action }, reply,
      'Harness 未在 15 秒内确认审阅动作。请重试。')
  }

  resetReady(): void { this.#ready = false }

  /** Accept only messages already checked against the iframe source/origin/nonce. */
  accept(value: Record<string, unknown>): boolean {
    if (value.type === 'workspace-review-bridge-ready/v1') {
      this.#ready = true
      this.#flush(this.#feedback)
      this.#flush(this.#actions)
      return true
    }
    const feedback = value.type === 'markdown-review-feedback-accepted/v1'
    const action = value.type === 'markdown-review-session-action-accepted/v1'
    const id = feedback ? value.deliveryId : value.requestId
    if ((!feedback && !action) || !boundedString(id, 160)) return false
    const pendingMap = feedback ? this.#feedback : this.#actions
    const pending = pendingMap.get(id)
    if (pending === undefined) return true
    pendingMap.delete(id)
    this.environment.clearTimeout(pending.timeout)
    const accepted = value.accepted === true
      && boundedString(value.targetSessionId, 160) && boundedString(value.targetSessionTitle, 2_048)
      && (value.status === 'queued' || value.status === 'processing' || (action && value.status === 'draft_ready'))
      && (!action || (pending.message.type === 'markdown-review-session-action/v1' && value.action === pending.message.action.action))
    pending.reply(accepted
      ? { ok: true, ...(action ? { action: value.action } : {}), targetSessionId: value.targetSessionId, targetSessionTitle: value.targetSessionTitle, status: value.status }
      : { ok: false, error: boundedString(value.error, 4_000) ? value.error : feedback ? 'Harness rejected the Markdown annotation.' : 'Harness 未接受审阅动作。' })
    return true
  }

  close(): void {
    this.#close(this.#feedback, 'The Harness Side Panel closed before accepting Markdown feedback.')
    this.#close(this.#actions, '侧边栏在确认审阅动作前已关闭。')
  }

  #register(pendingMap: Map<string, Pending>, id: string, message: Message, reply: Reply, timeoutError: string): void {
    const timeout = this.environment.setTimeout(() => {
      const pending = pendingMap.get(id)
      if (pending === undefined) return
      pendingMap.delete(id)
      pending.reply({ ok: false, error: timeoutError })
    }, this.environment.timeoutMs)
    // Preserve existing ID replacement and replay semantics; deduplication and
    // cancellation are separate behavior changes, not part of this extraction.
    pendingMap.set(id, { message, reply, timeout })
    this.#flush(pendingMap)
  }

  #flush(pendingMap: Map<string, Pending>): void {
    if (!this.#ready) return
    for (const pending of pendingMap.values()) this.environment.postMessage(pending.message)
  }

  #close(pendingMap: Map<string, Pending>, error: string): void {
    for (const pending of pendingMap.values()) {
      this.environment.clearTimeout(pending.timeout)
      pending.reply({ ok: false, error })
    }
    pendingMap.clear()
  }
}
