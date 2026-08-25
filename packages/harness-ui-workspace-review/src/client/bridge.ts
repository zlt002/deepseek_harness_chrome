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

interface MarkdownReviewFeedbackBase {
  readonly id: string
  readonly selectionId: string
  readonly harnessSessionId: string
  readonly reviewId: string
  readonly resourceId: string
  readonly displayPath: string
  readonly revision: string
  readonly fingerprint: string
  readonly quote: string
  readonly comment: string
}
export interface SourceMarkdownReviewFeedback extends MarkdownReviewFeedbackBase {
  readonly anchorKind: 'source'
  readonly startUtf16: number
  readonly endUtf16: number
  readonly prefix: string
  readonly suffix: string
}
export interface VisualMarkdownReviewFeedback extends MarkdownReviewFeedbackBase {
  readonly anchorKind: 'visual'
  readonly editorRevision: number
  readonly from: number
  readonly to: number
  readonly blocks: ReadonlyArray<{ readonly kind: string; readonly text: string }>
}
export type MarkdownReviewFeedback = SourceMarkdownReviewFeedback | VisualMarkdownReviewFeedback

export function feedbackMessage(event: MessageEvent, parent: Window, config: WorkspaceReviewBridgeConfig): MarkdownReviewFeedback | undefined {
  const value: unknown = event.data
  if (event.source !== parent || event.origin !== config.parentOrigin || value === null || typeof value !== 'object') return undefined
  const data = value as { type?: unknown; nonce?: unknown; feedback?: unknown }
  if (data.type !== 'markdown-review-feedback/v1' || data.nonce !== config.nonce || !feedback(data.feedback)) return undefined
  return data.feedback
}

/** Return bounded delivery status to the extension review page. */
export function respondFeedback(parent: Window, config: WorkspaceReviewBridgeConfig, deliveryId: string, accepted: boolean, error?: unknown): void {
  const message = typeof error === 'string' ? error.trim().slice(0, 4_000) : ''
  parent.postMessage({
    type: 'markdown-review-feedback-accepted/v1',
    nonce: config.nonce,
    deliveryId,
    accepted,
    ...(accepted || message === '' ? {} : { error: message }),
  }, config.parentOrigin)
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
  const base = ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'quote', 'comment'].every(key => typeof item[key] === 'string' && (item[key] as string).length > 0)
  if (!base) return false
  if (item.anchorKind === 'source') {
    return Object.keys(item).every(key => ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'anchorKind', 'startUtf16', 'endUtf16', 'quote', 'prefix', 'suffix', 'comment'].includes(key))
      && typeof item.prefix === 'string' && typeof item.suffix === 'string'
      && Number.isInteger(item.startUtf16) && Number.isInteger(item.endUtf16)
      && (item.startUtf16 as number) >= 0 && (item.endUtf16 as number) > (item.startUtf16 as number)
  }
  return item.anchorKind === 'visual'
    && Object.keys(item).every(key => ['id', 'selectionId', 'harnessSessionId', 'reviewId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'anchorKind', 'quote', 'editorRevision', 'from', 'to', 'blocks', 'comment'].includes(key))
    && Number.isSafeInteger(item.editorRevision) && (item.editorRevision as number) >= 0
    && Number.isSafeInteger(item.from) && Number.isSafeInteger(item.to) && (item.from as number) >= 0 && (item.to as number) > (item.from as number)
    && Array.isArray(item.blocks) && item.blocks.length <= 24 && item.blocks.every(block => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return false
      const entry = block as Record<string, unknown>
      return Object.keys(entry).every(key => ['kind', 'text'].includes(key))
        && typeof entry.kind === 'string' && entry.kind.length > 0 && entry.kind.length <= 32
        && typeof entry.text === 'string' && entry.text.length <= 2_000
    })
}
