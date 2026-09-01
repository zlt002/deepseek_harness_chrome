export interface SessionRunSnapshot {
  running: boolean
  queue: readonly unknown[]
  /** True only when the Host log has never accepted a prompt for this session. */
  blank?: boolean
}

export interface RestoredSessionRunLifecycle {
  observedActivity: boolean
}

/** Product-side state for one Browser Target captured before a session starts running. */
export class BrowserTargetSessionRunLock {
  accepted = false
  observedActivity = false
  restored = false

  constructor(readonly submissionId: string) {}

  /** Recreate an acknowledged lock without mistaking an initial idle snapshot for completion. */
  static restore(submissionId: string, lifecycle: RestoredSessionRunLifecycle): BrowserTargetSessionRunLock {
    const lock = new BrowserTargetSessionRunLock(submissionId)
    lock.accepted = true
    lock.observedActivity = lifecycle.observedActivity
    lock.restored = true
    return lock
  }

  accept(snapshot: SessionRunSnapshot): boolean {
    this.accepted = true
    return this.observe(snapshot)
  }

  /** Returns true only after this accepted Run's running or queue activity becomes completely idle. */
  observe(snapshot: SessionRunSnapshot): boolean {
    if (snapshot.running || snapshot.queue.length > 0) this.observedActivity = true
    const idle = !snapshot.running && snapshot.queue.length === 0
    const restoredPromptNeverAccepted = this.restored && snapshot.blank === true
    return this.accepted && idle && (this.observedActivity || restoredPromptNeverAccepted)
  }
}

/** A stale-idle sweep cannot release a submitted target before its Run was observed. */
export function shouldReconcileSessionRunTarget(snapshot: SessionRunSnapshot, lock?: BrowserTargetSessionRunLock): boolean {
  const completed = lock?.observe(snapshot)
  return !snapshot.running && snapshot.queue.length === 0 && (lock === undefined || completed === true)
}

/** Pending or active work keeps the Browser Target chosen when that lifecycle began. */
export function shouldCaptureSessionRunTarget(snapshot: SessionRunSnapshot, hasLock: boolean): boolean {
  return !hasLock && !snapshot.running && snapshot.queue.length === 0
}
