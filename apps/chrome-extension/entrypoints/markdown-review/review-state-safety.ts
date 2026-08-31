/**
 * Pure guards for the review surface.  The Port may notify us about an
 * external update at any point, so these decisions must not depend on React's
 * asynchronous state snapshots.
 */
export interface LocalReviewWork {
  snapshotContent: string | undefined
  editorMarkdown: string
  annotationCount: number
  candidateReviewActive: boolean
  preparedWrite: boolean
  committing: boolean
}

/** The only selection identity that may be replayed into a review Diff. */
export interface SubmittedSelection {
  editorRevision: number
  from: number
  to: number
}

export type SelectionProposalReviewResult = 'candidate' | 'selection-changed' | 'mount-rejected'

/**
 * Verify the submission identity before invoking the editor. The mount
 * callback is deliberately injected so this pure guard remains testable while
 * main.tsx still calls the real Milkdown selection-Diff operation.
 */
export function reviewSelectionProposal(
  saved: SubmittedSelection | undefined,
  proposal: SubmittedSelection,
  mount: () => boolean,
): SelectionProposalReviewResult {
  if (saved === undefined || saved.editorRevision !== proposal.editorRevision || saved.from !== proposal.from || saved.to !== proposal.to) return 'selection-changed'
  return mount() ? 'candidate' : 'mount-rejected'
}

/** Update one annotation without creating a second, test-only state model. */
export function updateAnnotationDeliveryStatus<T extends { id: string; deliveryStatus: string; lastError?: string }>(
  items: ReadonlyArray<T>,
  annotationId: string,
  deliveryStatus: T['deliveryStatus'],
  lastError?: string,
): T[] {
  return items.map((item) => item.id === annotationId
    && item.deliveryStatus !== 'settled'
    ? { ...item, deliveryStatus, lastError }
    : item) as T[]
}

/** A settled annotation is terminal; absent annotations cannot be resurrected. */
export function canUpdateAnnotationDeliveryStatus(
  items: ReadonlyArray<{ readonly id: string; readonly deliveryStatus: string }>,
  annotationId: string,
): boolean {
  return items.some((item) => item.id === annotationId && item.deliveryStatus !== 'settled')
}

/** Verified writes retain unresolved work as explicit recovery items. */
export function failUnsettledAnnotations<T extends { id: string; deliveryStatus: string; lastError?: string }>(items: ReadonlyArray<T>, reason: string): T[] {
  return items.map((item) => item.deliveryStatus === 'settled'
    ? item
    : { ...item, deliveryStatus: 'failed', lastError: reason }) as T[]
}

export function verifiedWriteCleanupAllowed(work: { annotationCount: number; candidateReviewActive: boolean }): boolean {
  return work.annotationCount === 0 && !work.candidateReviewActive
}

/** Any annotation without an explicit accept/reject settlement blocks adoption. */
export function pendingAnnotationCount(items: ReadonlyArray<{ readonly deliveryStatus: string }>): number {
  return items.filter(item => item.deliveryStatus !== 'settled').length
}

/** Saving a draft must not discard review work that still needs a decision. */
export function reviewSaveBlockedReason(work: { annotationCount: number; candidateReviewActive: boolean }): string | undefined {
  if (work.candidateReviewActive) return '请先接受或拒绝 AI 修改，再保存草稿。'
  if (work.annotationCount > 0) return '仍有未结算的局部优化请求。请重新发送、接受、拒绝或放弃后再保存草稿。'
  return undefined
}

export function shouldProtectLocalReviewWork(work: LocalReviewWork): boolean {
  return work.snapshotContent !== undefined && (
    work.editorMarkdown !== work.snapshotContent ||
    work.annotationCount > 0 ||
    work.candidateReviewActive ||
    work.preparedWrite ||
    work.committing
  )
}

/** A PRD adoption may only name the exact file state currently shown as saved. */
export function adoptionBlockedReason(work: LocalReviewWork & { externalUpdatePending: boolean; truncated: boolean }): string | undefined {
  if (work.truncated) return '文件快照已截断，不能安全采纳。请缩小文件或重新生成完整 PRD。'
  if (work.externalUpdatePending) return '文件已在外部更新，请重新读取并审核后再采纳。'
  if (work.candidateReviewActive) return '请先接受或拒绝 AI 修改，再采纳。'
  if (work.preparedWrite || work.committing) return '草稿正在保存，请等待同一文件回读验证完成后再采纳。'
  if (work.annotationCount > 0) return '仍有未结算的局部优化请求。请重新发送并接受或拒绝 AI 修改后再采纳。'
  if (work.snapshotContent === undefined || work.editorMarkdown !== work.snapshotContent) return '请先保存草稿，并等待同一文件回读验证完成后再采纳。'
  return undefined
}

/** A commit is a single acknowledgement wait for one Approval Grant. */
export interface CommitAttempt {
  token: string
  idempotencyKey: string
  content: string
}

export function beginCommit(current: CommitAttempt | undefined, next: CommitAttempt): { active: CommitAttempt; started: boolean } {
  return current === undefined ? { active: next, started: true } : { active: current, started: false }
}

export function isCurrentCommit(current: CommitAttempt | undefined, token: string): boolean {
  return current?.token === token
}

/** Only the active request may release the write confirmation UI. */
export function settleCommit(current: CommitAttempt | undefined, token: string): CommitAttempt | undefined {
  return isCurrentCommit(current, token) ? undefined : current
}
