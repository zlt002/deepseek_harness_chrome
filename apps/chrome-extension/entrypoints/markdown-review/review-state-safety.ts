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

export function shouldProtectLocalReviewWork(work: LocalReviewWork): boolean {
  return work.snapshotContent !== undefined && (
    work.editorMarkdown !== work.snapshotContent ||
    work.annotationCount > 0 ||
    work.candidateReviewActive ||
    work.preparedWrite ||
    work.committing
  )
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
