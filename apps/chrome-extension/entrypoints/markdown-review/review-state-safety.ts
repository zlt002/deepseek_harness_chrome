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

/** Only work that still needs a response may block a final PRD adoption. */
export function pendingAnnotationCount(items: ReadonlyArray<{ readonly deliveryStatus: string }>): number {
  return items.filter(item => ['sending', 'queued', 'processing'].includes(item.deliveryStatus)).length
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
  if (work.annotationCount > 0) return '仍有局部优化请求正在处理中，请等待 AI 返回后接受或拒绝修改，再采纳。'
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
