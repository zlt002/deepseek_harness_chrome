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
  /** The original Browser Target where the Side Panel should be reopened. */
  sidePanelTabId?: number
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

/**
 * An editor-native anchor. `from`/`to` are ProseMirror positions, never
 * Markdown character offsets. This is what keeps a dirty visual draft and a
 * cross-block/table/code selection addressable without inventing a mapping.
 */
export interface VisualSelectionAnchor {
  version: 2
  editorRevision: number
  from: number
  to: number
  quote: string
  blocks: Array<{ kind: string; text: string }>
  table?: VisualTableContext
  sourceFingerprint: string
}
export interface VisualTableContext {
  from: number
  to: number
  rowCount: number
  columnCount: number
  selectedRowStart: number
  selectedRowEnd: number
  selectedColumnStart: number
  selectedColumnEnd: number
  isWholeTable: boolean
  header: string[]
  rows: string[][]
}

export type MarkdownSelectionAnchor = SelectionAnchor | VisualSelectionAnchor

export interface MarkdownReviewAnnotation {
  id: string
  anchor: MarkdownSelectionAnchor
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

/** A bounded request to act in the session that opened this Review Tab. */
export interface SessionActionRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-session-action-request'
  requestId: string
  reviewId: string
  harnessSessionId: string
  resourceId: string
  displayPath: string
  revision: string
  fingerprint: string
  action: 'rewrite' | 'accept'
}

export interface ProposalsRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-proposals-request'
  requestId: string
  reviewId: string
  afterSequence: number
}

export interface PrepareWriteRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-prepare-write-request'
  requestId: string
  reviewId: string
  expected: Pick<ReviewResourceIdentity, 'resourceId' | 'revision' | 'fingerprint'>
  content: string
}

export interface CommitWriteRequest {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-commit-write-request'
  requestId: string
  reviewId: string
  approval: string
  idempotencyKey: string
  content: string
}

export type MarkdownReviewPortRequest = SnapshotRequest | DeliverRequest | SessionActionRequest | ProposalsRequest | PrepareWriteRequest | CommitWriteRequest

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
  targetSessionId?: string
  targetSessionTitle?: string
  status?: 'queued' | 'processing'
  error?: MarkdownReviewError
}

export interface SessionActionResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-session-action-response'
  requestId: string
  ok: boolean
  action?: 'rewrite' | 'accept'
  targetSessionId?: string
  targetSessionTitle?: string
  status?: 'draft_ready'
  error?: MarkdownReviewError
}

interface MarkdownReviewProposalBase {
  proposalId: string
  selectionId: string
  sequence: number
  baseFingerprint: string
  summary: string
}
export interface MarkdownReviewDocumentProposal extends MarkdownReviewProposalBase {
  kind: 'document'
  candidateMarkdown: string
}
export interface MarkdownReviewSelectionProposal extends MarkdownReviewProposalBase {
  kind: 'selection'
  replacementMarkdown: string
  editorRevision: number
  from: number
  to: number
}
export type MarkdownReviewProposal = MarkdownReviewDocumentProposal | MarkdownReviewSelectionProposal

export interface ProposalsResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-proposals-response'
  requestId: string
  ok: boolean
  reviewId?: string
  proposals?: MarkdownReviewProposal[]
  error?: MarkdownReviewError
}

export interface PreparedWrite {
  status: 'prepared'
  approval: string
  contentHash: string
  expiresAt: number
}
export interface WriteConflict {
  status: 'conflict'
  latest: Omit<MarkdownReviewSnapshot, 'harnessSessionId'>
}
export type PrepareWriteResult = PreparedWrite | WriteConflict
export interface VerifiedWrite {
  status: 'verified_write'
  resource: ReviewResourceIdentity
  contentHash: string
}
export interface UncertainWrite { status: 'uncertain'; message: string }
export type CommitWriteResult = VerifiedWrite | WriteConflict | UncertainWrite

export interface PrepareWriteResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-prepare-write-response'
  requestId: string
  ok: boolean
  preparation?: PrepareWriteResult
  error?: MarkdownReviewError
}
export interface CommitWriteResponse {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-commit-write-response'
  requestId: string
  ok: boolean
  result?: CommitWriteResult
  error?: MarkdownReviewError
}

/** Sent when background reuses a live Tab after Host refreshed its target. */
export interface TargetUpdatedNotification {
  v: typeof MARKDOWN_REVIEW_PROTOCOL_VERSION
  type: 'markdown-review-target-updated'
  requestId: string
  reviewId: string
}

export type MarkdownReviewPortResponse = SnapshotResponse | DeliverResponse | SessionActionResponse | ProposalsResponse | PrepareWriteResponse | CommitWriteResponse | TargetUpdatedNotification

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

export function isVisualSelectionAnchor(value: unknown): value is VisualSelectionAnchor {
  if (!isRecord(value)) return false
  return value.version === 2
    && Number.isSafeInteger(value.editorRevision) && (value.editorRevision as number) >= 0
    && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
    && (value.from as number) >= 0 && (value.to as number) > (value.from as number)
    && boundedText(value.quote, MAX_QUOTE_LENGTH)
    && Array.isArray(value.blocks) && value.blocks.length <= 24 && value.blocks.every(block => isRecord(block)
      && Object.keys(block).every(key => ['kind', 'text'].includes(key))
      && boundedText(block.kind, 32) && boundedText(block.text, 2_000, true))
    && (value.table === undefined || isVisualTableContext(value.table))
    && isMarkdownReviewId(value.sourceFingerprint)
    && Object.keys(value).every(key => ['version', 'editorRevision', 'from', 'to', 'quote', 'blocks', 'table', 'sourceFingerprint'].includes(key))
}

function isVisualTableContext(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every(key => ['from', 'to', 'rowCount', 'columnCount', 'selectedRowStart', 'selectedRowEnd', 'selectedColumnStart', 'selectedColumnEnd', 'isWholeTable', 'header', 'rows'].includes(key))) return false
  const table = value as Record<string, unknown>
  return Number.isSafeInteger(table.from) && Number.isSafeInteger(table.to) && (table.from as number) >= 0 && (table.to as number) > (table.from as number)
    && Number.isSafeInteger(table.rowCount) && (table.rowCount as number) > 0
    && Number.isSafeInteger(table.columnCount) && (table.columnCount as number) > 0
    && Number.isSafeInteger(table.selectedRowStart) && Number.isSafeInteger(table.selectedRowEnd)
    && (table.selectedRowStart as number) >= 0 && (table.selectedRowEnd as number) >= (table.selectedRowStart as number) && (table.selectedRowEnd as number) < (table.rowCount as number)
    && Number.isSafeInteger(table.selectedColumnStart) && Number.isSafeInteger(table.selectedColumnEnd)
    && (table.selectedColumnStart as number) >= 0 && (table.selectedColumnEnd as number) >= (table.selectedColumnStart as number) && (table.selectedColumnEnd as number) < (table.columnCount as number)
    && typeof table.isWholeTable === 'boolean'
    && validTableRow(table.header, table.columnCount as number)
    && Array.isArray(table.rows) && table.rows.length + 1 === table.rowCount && table.rows.every(row => validTableRow(row, table.columnCount as number))
}

function validTableRow(value: unknown, columnCount: number): boolean {
  return Array.isArray(value) && value.length === columnCount && value.every(cell => boundedText(cell, 2_000, true))
}

export function isMarkdownSelectionAnchor(value: unknown): value is MarkdownSelectionAnchor {
  return isSelectionAnchor(value) || isVisualSelectionAnchor(value)
}

export function isMarkdownReviewAnnotation(value: unknown): value is MarkdownReviewAnnotation {
  return isRecord(value)
    && Object.keys(value).every((key) => ['id', 'anchor', 'comment'].includes(key))
    && isMarkdownReviewId(value.id)
    && isMarkdownSelectionAnchor(value.anchor)
    && boundedText(value.comment, MAX_COMMENT_LENGTH)
}

function isMarkdownReviewProposal(value: unknown): value is MarkdownReviewProposal {
  return isRecord(value)
    && isMarkdownReviewId(value.proposalId)
    && isMarkdownReviewId(value.selectionId)
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
    && isMarkdownReviewId(value.baseFingerprint)
    && boundedText(value.summary, 1_000, true)
    && ((value.kind === 'document'
      && Object.keys(value).every(key => ['proposalId', 'selectionId', 'sequence', 'baseFingerprint', 'kind', 'candidateMarkdown', 'summary'].includes(key))
      && boundedText(value.candidateMarkdown, MAX_CONTENT_LENGTH, true))
      || (value.kind === 'selection'
        && Object.keys(value).every(key => ['proposalId', 'selectionId', 'sequence', 'baseFingerprint', 'kind', 'replacementMarkdown', 'editorRevision', 'from', 'to', 'summary'].includes(key))
        && boundedText(value.replacementMarkdown, 100_000, true)
        && Number.isSafeInteger(value.editorRevision) && (value.editorRevision as number) >= 0
        && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
        && (value.from as number) >= 0 && (value.to as number) > (value.from as number)))
}

export function isMarkdownReviewPortRequest(value: unknown): value is MarkdownReviewPortRequest {
  if (!isRecord(value) || value.v !== MARKDOWN_REVIEW_PROTOCOL_VERSION || !isRequestId(value.requestId) || !isMarkdownReviewId(value.reviewId)) return false
  if (value.type === 'markdown-review-snapshot-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId'].includes(key))
  if (value.type === 'markdown-review-proposals-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId', 'afterSequence'].includes(key))
    && Number.isSafeInteger(value.afterSequence) && (value.afterSequence as number) >= 0
  if (value.type === 'markdown-review-prepare-write-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId', 'expected', 'content'].includes(key))
    && isExpectedResourceIdentity(value.expected)
    && boundedText(value.content, MAX_CONTENT_LENGTH, true)
  if (value.type === 'markdown-review-commit-write-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId', 'approval', 'idempotencyKey', 'content'].includes(key))
    && isMarkdownReviewId(value.approval) && isMarkdownReviewId(value.idempotencyKey)
    && boundedText(value.content, MAX_CONTENT_LENGTH, true)
  if (value.type === 'markdown-review-session-action-request') return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'reviewId', 'harnessSessionId', 'resourceId', 'displayPath', 'revision', 'fingerprint', 'action'].includes(key))
    && isMarkdownReviewId(value.harnessSessionId) && isMarkdownReviewId(value.resourceId) && isMarkdownReviewId(value.revision) && isMarkdownReviewId(value.fingerprint) && boundedText(value.displayPath, MAX_PATH_LENGTH) && (value.action === 'rewrite' || value.action === 'accept')
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

function isExpectedResourceIdentity(value: unknown): value is Pick<ReviewResourceIdentity, 'resourceId' | 'revision' | 'fingerprint'> {
  return isRecord(value) && Object.keys(value).every(key => ['resourceId', 'revision', 'fingerprint'].includes(key))
    && isMarkdownReviewId(value.resourceId) && isMarkdownReviewId(value.revision) && isMarkdownReviewId(value.fingerprint)
}

export function isMarkdownReviewSnapshot(value: unknown): value is MarkdownReviewSnapshot {
  return isRecord(value)
    && value.v === MARKDOWN_REVIEW_PROTOCOL_VERSION
    && value.type === 'markdown-review-snapshot'
    && isMarkdownReviewId(value.reviewId)
    && isMarkdownReviewId(value.harnessSessionId)
    && (value.sidePanelTabId === undefined || (typeof value.sidePanelTabId === 'number' && Number.isSafeInteger(value.sidePanelTabId) && value.sidePanelTabId >= 0))
    && isResourceIdentity(value.resource)
    && boundedText(value.content, MAX_CONTENT_LENGTH, true)
    && typeof value.truncated === 'boolean'
    && typeof value.readOnly === 'boolean'
}

function isHostSnapshot(value: unknown): value is Omit<MarkdownReviewSnapshot, 'harnessSessionId'> {
  return isRecord(value)
    && Object.keys(value).every(key => ['v', 'type', 'reviewId', 'resource', 'content', 'truncated', 'readOnly'].includes(key))
    && value.v === MARKDOWN_REVIEW_PROTOCOL_VERSION && value.type === 'markdown-review-snapshot'
    && isMarkdownReviewId(value.reviewId) && isResourceIdentity(value.resource)
    && boundedText(value.content, MAX_CONTENT_LENGTH, true)
    && typeof value.truncated === 'boolean' && value.readOnly === true
}
function isWriteConflict(value: unknown): value is WriteConflict {
  return isRecord(value) && Object.keys(value).every(key => ['status', 'latest'].includes(key))
    && value.status === 'conflict' && isHostSnapshot(value.latest)
}
function isPrepareWriteResult(value: unknown): value is PrepareWriteResult {
  return isWriteConflict(value) || (isRecord(value)
    && Object.keys(value).every(key => ['status', 'approval', 'contentHash', 'expiresAt'].includes(key))
    && value.status === 'prepared' && isMarkdownReviewId(value.approval) && isMarkdownReviewId(value.contentHash)
    && Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > 0)
}
function isCommitWriteResult(value: unknown): value is CommitWriteResult {
  return isWriteConflict(value) || (isRecord(value) && value.status === 'verified_write'
    && Object.keys(value).every(key => ['status', 'resource', 'contentHash'].includes(key))
    && isResourceIdentity(value.resource) && isMarkdownReviewId(value.contentHash)) || (isRecord(value) && value.status === 'uncertain'
    && Object.keys(value).every(key => ['status', 'message'].includes(key)) && boundedText(value.message, 4_000))
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
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'ok', 'deliveryId', 'targetSessionId', 'targetSessionTitle', 'status', 'error'].includes(key))
      && (value.ok
        ? isMarkdownReviewId(value.deliveryId) && isMarkdownReviewId(value.targetSessionId) && boundedText(value.targetSessionTitle, MAX_PATH_LENGTH) && (value.status === 'queued' || value.status === 'processing') && value.error === undefined
        : isMarkdownReviewError(value.error) && value.deliveryId === undefined && value.targetSessionId === undefined && value.targetSessionTitle === undefined && value.status === undefined)
  }
  if (value.type === 'markdown-review-session-action-response') {
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'ok', 'action', 'targetSessionId', 'targetSessionTitle', 'status', 'error'].includes(key))
      && (value.ok
        ? (value.action === 'rewrite' || value.action === 'accept') && isMarkdownReviewId(value.targetSessionId) && boundedText(value.targetSessionTitle, MAX_PATH_LENGTH)
          && value.status === 'draft_ready' && value.error === undefined
        : isMarkdownReviewError(value.error) && value.action === undefined && value.targetSessionId === undefined && value.targetSessionTitle === undefined && value.status === undefined)
  }
  if (value.type === 'markdown-review-proposals-response') {
    return Object.keys(value).every((key) => ['v', 'type', 'requestId', 'ok', 'reviewId', 'proposals', 'error'].includes(key))
      && (value.ok
        ? isMarkdownReviewId(value.reviewId) && Array.isArray(value.proposals) && value.proposals.every(isMarkdownReviewProposal) && value.error === undefined
        : isMarkdownReviewError(value.error) && value.reviewId === undefined && value.proposals === undefined)
  }
  if (value.type === 'markdown-review-prepare-write-response') {
    return Object.keys(value).every(key => ['v', 'type', 'requestId', 'ok', 'preparation', 'error'].includes(key))
      && (value.ok ? isPrepareWriteResult(value.preparation) && value.error === undefined : isMarkdownReviewError(value.error) && value.preparation === undefined)
  }
  if (value.type === 'markdown-review-commit-write-response') {
    return Object.keys(value).every(key => ['v', 'type', 'requestId', 'ok', 'result', 'error'].includes(key))
      && (value.ok ? isCommitWriteResult(value.result) && value.error === undefined : isMarkdownReviewError(value.error) && value.result === undefined)
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
