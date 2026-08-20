import type { OpenWorkspaceReview } from '../protocol.ts'

export interface WorkspaceReviewBridgeConfig {
  readonly nonce: string
  readonly parentOrigin: string
}

/** A dedicated bridge config prevents this capability handoff from sharing Browser Target messages. */
export function workspaceReviewBridgeConfig(location: Location = window.location): WorkspaceReviewBridgeConfig | undefined {
  const query = new URLSearchParams(location.search)
  const nonce = query.get('dshWorkspaceReviewNonce')
  const parentOrigin = query.get('dshWorkspaceReviewParentOrigin')
  if (nonce === null || parentOrigin === null) return undefined
  try {
    const origin = new URL(parentOrigin)
    return origin.protocol === 'chrome-extension:' && origin.host !== '' && `${origin.protocol}//${origin.host}` === parentOrigin
      ? { nonce, parentOrigin }
      : undefined
  } catch { return undefined }
}

/** Capability is transferred only to the verified extension parent, never encoded in a URL or browser storage. */
export function requestOpenReview(parent: Window, config: WorkspaceReviewBridgeConfig, review: OpenWorkspaceReview): void {
  parent.postMessage({ type: 'markdown-review-open/v1', nonce: config.nonce, review }, config.parentOrigin)
}

export interface MarkdownReviewFeedback {
  readonly id: string
  readonly harnessSessionId: string
  readonly reviewId: string
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
  readonly startUtf16: number
  readonly endUtf16: number
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly comment: string
}

export function feedbackMessage(event: MessageEvent, parent: Window, config: WorkspaceReviewBridgeConfig): MarkdownReviewFeedback | undefined {
  const value: unknown = event.data
  if (event.source !== parent || event.origin !== config.parentOrigin || value === null || typeof value !== 'object') return undefined
  const data = value as { type?: unknown; nonce?: unknown; feedback?: unknown }
  if (data.type !== 'markdown-review-feedback/v1' || data.nonce !== config.nonce || !feedback(data.feedback)) return undefined
  return data.feedback
}

export interface WorkspaceReviewRehydrateRequest {
  readonly requestId: string
  readonly reviewId: string
  readonly resourceId: string
  readonly harnessSessionId: string
}

export function rehydrateMessage(event: MessageEvent, parent: Window, config: WorkspaceReviewBridgeConfig): WorkspaceReviewRehydrateRequest | undefined {
  const value: unknown = event.data
  if (event.source !== parent || event.origin !== config.parentOrigin || value === null || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  if (data.type !== 'markdown-review-rehydrate/v1' || data.nonce !== config.nonce) return undefined
  return ['requestId', 'reviewId', 'resourceId', 'harnessSessionId'].every(key => typeof data[key] === 'string' && (data[key] as string).length > 0 && (data[key] as string).length <= 160)
    ? { requestId: data.requestId as string, reviewId: data.reviewId as string, resourceId: data.resourceId as string, harnessSessionId: data.harnessSessionId as string }
    : undefined
}

export function respondRehydrate(parent: Window, config: WorkspaceReviewBridgeConfig, requestId: string, review?: OpenWorkspaceReview, error?: string): void {
  parent.postMessage({ type: 'markdown-review-rehydrate-response/v1', nonce: config.nonce, requestId, ...(review === undefined ? { error: error ?? 'review rehydrate failed' } : { review }) }, config.parentOrigin)
}

function feedback(value: unknown): value is MarkdownReviewFeedback {
  if (value === null || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return ['id', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'quote', 'prefix', 'suffix', 'comment'].every(key => typeof item[key] === 'string')
    && Number.isInteger(item.startUtf16) && Number.isInteger(item.endUtf16)
    && (item.startUtf16 as number) >= 0 && (item.endUtf16 as number) >= (item.startUtf16 as number)
}
