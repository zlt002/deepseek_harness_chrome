import type { MarkdownReviewError, MarkdownReviewSnapshot } from './protocol'

export type ReviewConnectionState = 'initializing' | 'loading' | 'ready' | 'offline' | 'reopen-required' | 'error'

export interface ReviewState {
  status: ReviewConnectionState
  snapshot?: MarkdownReviewSnapshot
  error?: MarkdownReviewError
}

export type ReviewEvent =
  | { type: 'connect' }
  | { type: 'snapshot-requested' }
  | { type: 'snapshot-loaded'; snapshot: MarkdownReviewSnapshot }
  | { type: 'request-failed'; error: MarkdownReviewError }
  | { type: 'port-disconnected' }

export function reduceReviewState(state: ReviewState, event: ReviewEvent): ReviewState {
  if (event.type === 'connect') return { ...state, status: state.snapshot === undefined ? 'initializing' : 'ready', error: undefined }
  if (event.type === 'snapshot-requested') return { ...state, status: 'loading', error: undefined }
  if (event.type === 'snapshot-loaded') return { status: 'ready', snapshot: event.snapshot }
  if (event.type === 'port-disconnected') {
    return { ...state, status: 'reopen-required', error: { code: 'host_unavailable', message: '连接已断开。请从文件树重新打开；尚未送出的批注仍保留在此 Tab 中。', reopenRequired: true } }
  }
  return { ...state, status: event.error.reopenRequired ? 'reopen-required' : 'error', error: event.error }
}
