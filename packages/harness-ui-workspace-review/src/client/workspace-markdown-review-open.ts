import type { ConversationNodeDefinition, ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

export const OPEN_WORKSPACE_MARKDOWN_REVIEW = 'open_workspace_markdown_review'
export const WORKSPACE_MARKDOWN_REVIEW_OPEN_TURN_DATA = 'workspace-markdown-review-open'

export interface WorkspaceMarkdownReviewOpenTurnData {
  readonly path: string
  /** Only the narrow PMD tool invocation is eligible for PRD telemetry. */
  readonly source?: 'pmd-prd'
  readonly resultSeq: number
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** One live, Host-validated request to open a workspace Markdown review. */
    [WORKSPACE_MARKDOWN_REVIEW_OPEN_TURN_DATA]: WorkspaceMarkdownReviewOpenTurnData
  }
}

interface WorkspaceMarkdownReviewOpenState {
  readonly turn: number
  readonly calls: ReadonlyMap<string, Pick<WorkspaceMarkdownReviewOpenTurnData, 'path' | 'source'>>
  readonly opened?: WorkspaceMarkdownReviewOpenTurnData
}

function openRequest(argumentsRaw: string): Pick<WorkspaceMarkdownReviewOpenTurnData, 'path' | 'source'> | undefined {
  try {
    const value: unknown = JSON.parse(argumentsRaw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).path === 'string') {
      const source = (value as Record<string, unknown>).source
      return { path: (value as Record<string, string>).path, ...(source === 'pmd-prd' ? { source } : {}) }
    }
  } catch { /* the Host rejects malformed tool arguments before a successful result exists */ }
  return undefined
}

/** The newest successful review-open command currently materialized for this session. */
export function latestWorkspaceMarkdownReviewOpen(timeline: ConversationTimelineSnapshot): WorkspaceMarkdownReviewOpenTurnData | undefined {
  let latest: WorkspaceMarkdownReviewOpenTurnData | undefined
  for (const turn of timeline.turns.values()) {
    const review = turn.data.get(WORKSPACE_MARKDOWN_REVIEW_OPEN_TURN_DATA)
    if (review !== undefined && (latest === undefined || review.resultSeq > latest.resultSeq)) latest = review
  }
  return latest
}

/** Advance a session-local baseline; the first snapshot is history, later results are live. */
export function nextWorkspaceMarkdownReviewOpenAction(
  baseline: number | undefined,
  review: WorkspaceMarkdownReviewOpenTurnData | undefined,
): { readonly baseline: number; readonly open?: WorkspaceMarkdownReviewOpenTurnData } {
  const resultSeq = review?.resultSeq ?? 0
  if (baseline === undefined || resultSeq <= baseline) return { baseline: Math.max(baseline ?? 0, resultSeq) }
  return { baseline: resultSeq, open: review }
}

/** Holds one mounted review overlay's activation baselines. */
export class WorkspaceMarkdownReviewOpenTracker {
  readonly #baselines = new Map<string, number>()

  /** A newly visible session waits for its timeline, then treats it as history. */
  activate(sessionId: string, timelineReady: boolean, review: WorkspaceMarkdownReviewOpenTurnData | undefined): { readonly baseline: number } | undefined {
    if (!timelineReady) return undefined
    const baseline = review?.resultSeq ?? 0
    this.#baselines.set(sessionId, baseline)
    return { baseline }
  }

  next(sessionId: string, review: WorkspaceMarkdownReviewOpenTurnData | undefined): { readonly baseline: number; readonly open?: WorkspaceMarkdownReviewOpenTurnData } {
    const action = nextWorkspaceMarkdownReviewOpenAction(this.#baselines.get(sessionId), review)
    this.#baselines.set(sessionId, action.baseline)
    return action
  }
}

/** Records successful Host commands by turn; the session-scoped controller decides whether one is live. */
export function createWorkspaceMarkdownReviewOpenDefinition(): ConversationNodeDefinition<WorkspaceMarkdownReviewOpenState> {
  return {
    kind: WORKSPACE_MARKDOWN_REVIEW_OPEN_TURN_DATA,
    match: event => {
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      if (event.type === 'tool/call' || event.type === 'tool/result') return { id: String(event.data.turn), role: 'update' }
      return null
    },
    start: (_context, match) => {
      if (match.event.type !== 'turn/start') throw new Error('workspace Markdown review open requires turn/start')
      return { turn: match.event.data.turn, calls: new Map() }
    },
    update: (context, match) => {
      if (match.event.type === 'tool/call') {
        if (match.event.data.name !== OPEN_WORKSPACE_MARKDOWN_REVIEW) return context.state
        const request = openRequest(match.event.data.arguments)
        if (request === undefined) return context.state
        const calls = new Map(context.state.calls)
        calls.set(String(match.event.data.callId), request)
        return { ...context.state, calls }
      }
      if (match.event.type !== 'tool/result' || match.event.surfaceOp !== 'append' || match.event.data.message.content[0]?.isError === true) return context.state
      const request = context.state.calls.get(String(match.event.data.message.source.callId))
      return request === undefined ? context.state : { ...context.state, opened: { ...request, resultSeq: match.event.seq } }
    },
    buildLocationData: (context, scope) => {
      if (scope !== 'turn' || context.state?.opened === undefined) return null
      return {
        kind: 'turn',
        turn: context.state.turn,
        key: WORKSPACE_MARKDOWN_REVIEW_OPEN_TURN_DATA,
        value: context.state.opened,
      }
    },
  }
}
