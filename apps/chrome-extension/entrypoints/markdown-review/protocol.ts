/**
 * The Markdown Review Tab has no direct Host access.  This module is the
 * complete, versioned wire contract between the Tab and the background
 * service worker.  In particular, a capability is deliberately absent from
 * every type exported to the Tab.
 */
export const MARKDOWN_REVIEW_PORT = 'markdown-review/v1' as const
export const MARKDOWN_REVIEW_PROTOCOL_VERSION = 1 as const

const MAX_ID_LENGTH = 160
const MAX_PATH_LENGTH = 2_048
const MAX_CONTENT_LENGTH = 2_000_000
const MAX_QUOTE_LENGTH = 8_000
const MAX_CONTEXT_LENGTH = 512
const MAX_COMMENT_LENGTH = 8_000

export type MarkdownReviewErrorCode =
  | 'invalid_request'
  | 'review_not_found'
  | 'host_unavailable'
  | 'sidepanel_unavailable'
  | 'snapshot_unavailable'
  | 'delivery_rejected'
  | 'stale_anchor'
  | 'internal_error'

export interface MarkdownReviewError {
  code: MarkdownReviewErrorCode
  message: string
  /** A false result means the Tab must not try to recover an authorization. */
  reopenRequired?: boolean
}

export interface ReviewResourceIdentity {
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
}

export interface MarkdownReviewSnapshot {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-snapshot'
  reviewId: string
  harnessSessionId: string
  resource: ReviewResourceIdentity
  content: string
  truncated: boolean
  readOnly: boolean
}

export interface SelectionAnchor {
  version: 1
  startUtf16: number
  endUtf16: number
  quote: string
  prefix: string
  suffix: string
  sourceFingerprint: string
}

export interface MarkdownReviewAnnotation {
  id: string
  anchor: SelectionAnchor
  comment: string
}

export interface SnapshotRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-snapshot-request'
  requestId: string
  reviewId: string
}

export interface DeliverRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-deliver-request'
  requestId: string
  reviewId: string
  harnessSessionId: string
  deliveryId: string
  annotation: MarkdownReviewAnnotation
}

export type MarkdownReviewPortRequest = SnapshotRequest | DeliverRequest

export interface SnapshotResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-snapshot-response'
  requestId: string
  ok: boolean
  snapshot?: MarkdownReviewSnapshot
  error?: MarkdownReviewError
}

export interface DeliverResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-deliver-response'
  requestId: string
  ok: boolean
  deliveryId?: string
  error?: MarkdownReviewError
}

/** Sent when background reuses a live Tab after Host refreshed its target. */
export interface TargetUpdatedNotification {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-target-updated'
  requestId: string
  reviewId: string
}

export type MarkdownReviewPortResponse = SnapshotResponse | DeliverResponse | TargetUpdatedNotification

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0)
}

/** Identifiers are opaque, but bounded printable values are safe to route. */
export function isMarkdownReviewId(value: unknown): value is string {
  return boundedText(value, MAX_ID_LENGTH) && /^[A-Za-z0-9._:-]+$/.test(value)
}

export function isRequestId(value: unknown): value is string {
  return isMarkdownReviewId(value)
}

export function isSelectionAnchor(value: unknown): value is SelectionAnchor {
  if (!isRecord(value)) return false
  return value.version === 1
    && Number.isSafeInteger(value.startUtf16) && (value.startUtf16 as number) >= 0
    && Number.isSafeInteger(value.endUtf16) && (value.endUtf16 as number) >= (value.startUtf16 as number)
    && boundedText(value.quote, MAX_QUOTE_LENGTH)
    && boundedText(value.prefix, MAX_CONTEXT_LENGTH, true)
    && boundedText(value.suffix, MAX_CONTEXT_LENGTH, true)
    && isMarkdownReviewId(value.sourceFingerprint)
}

export function isMarkdownReviewAnnotation(value: unknown): value is MarkdownReviewAnnotation {
  return isRecord(value)
    && Object.keys(value).every((key) => ['id', 'anchor', 'comment'].includes(key))
    && isMarkdownReviewId(value.id)
    && isSelectionAnchor(value.anchor)
    && boundedText(value.comment, MAX_COMMENT_LENGTH)
}

export function isMarkdownReviewPortRequest(value: unknown): value is MarkdownReviewPortRequest {
  if (!isRecord(value) || value.v !== MARKDOWN_REVIEW_PROTOCOL_VERSION || !isRequestId(value.requestId) || !isMarkdownReviewId(value.reviewId)) return false
  if (value.type === 'markdown-review-snapshot-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId'].includes(key))
  return value.type === 'markdown-review-deliver-request'
    && Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId', 'harnessSessionId', 'deliveryId', 'annotation'].includes(key))
    && isMarkdownReviewId(value.harnessSessionId)
    && isMarkdownReviewId(value.deliveryId)
    && isMarkdownReviewAnnotation(value.annotation)
}

function isResourceIdentity(value: unknown): value is ReviewResourceIdentity {
  return isRecord(value)
    && isMarkdownReviewId(value.resourceId)
    && boundedText(value.displayPath, MAX_PATH_LENGTH)
    && isMarkdownReviewId(value.revision)
    && isMarkdownReviewId(value.fingerprint)
}

export function isMarkdownReviewSnapshot(value: unknown): value is MarkdownReviewSnapshot {
  return isRecord(value)
    && value.v === MARKDOWN_REVIEW_PROTOCOL_VERSION
    && value.type === 'markdown-review-snapshot'
    && isMarkdownReviewId(value.reviewId)
    && isMarkdownReviewId(value.harnessSessionId)
    && isResourceIdentity(value.resource)
    && boundedText(value.content, MAX_CONTENT_LENGTH, true)
    && typeof value.truncated === 'boolean'
    && typeof value.readOnly === 'boolean'
}

export function isMarkdownReviewError(value: unknown): value is MarkdownReviewError {
  if (!isRecord(value) || !boundedText(value.message, 4_000)) return false
  return ['invalid_request', 'review_not_found', 'host_unavailable', 'sidepanel_unavailable', 'snapshot_unavailable', 'delivery_rejected', 'stale_anchor', 'internal_error'].includes(value.code as string)
    && (value.reopenRequired === undefined || typeof value.reopenRequired === 'boolean')
}

export function isMarkdownReviewPortResponse(value: unknown): value is MarkdownReviewPortResponse {
  if (!isRecord(value) || value.v !== MARKDOWN_REVIEW_PROTOCOL_VERSION || !isRequestId(value.requestId)) return false
  if (value.type === 'markdown-review-target-updated') {
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId'].includes(key))
      && isMarkdownReviewId(value.reviewId)
  }
  if (typeof value.ok !== 'boolean') return false
  if (value.type === 'markdown-review-snapshot-response') {
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'ok', 'snapshot', 'error'].includes(key))
      && (value.ok ? isMarkdownReviewSnapshot(value.snapshot) && value.error === undefined : isMarkdownReviewError(value.error) && value.snapshot === undefined)
  }
  if (value.type === 'markdown-review-deliver-response') {
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'ok', 'deliveryId', 'error'].includes(key))
      && (value.ok ? isMarkdownReviewId(value.deliveryId) && value.error === undefined : isMarkdownReviewError(value.error) && value.deliveryId === undefined)
  }
  return false
}

/** JavaScript string positions are UTF-16 code-unit offsets, matching textarea. */
export function selectionAnchorFor(source: string, startUtf16: number, endUtf16: number, sourceFingerprint: string): SelectionAnchor | undefined {
  if (!isMarkdownReviewId(sourceFingerprint)
    || !Number.isSafeInteger(startUtf16) || !Number.isSafeInteger(endUtf16)
    || startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 > source.length) return undefined
  const quote = source.slice(startUtf16, endUtf16)
  if (!boundedText(quote, MAX_QUOTE_LENGTH)) return undefined
  return {
    version: 1,
    startUtf16,
    endUtf16,
    quote,
    prefix: source.slice(Math.max(0, startUtf16 - MAX_CONTEXT_LENGTH), startUtf16),
    suffix: source.slice(endUtf16, Math.min(source.length, endUtf16 + MAX_CONTEXT_LENGTH)),
    sourceFingerprint,
  }
}
