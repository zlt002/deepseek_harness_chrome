export interface SessionRunSnapshot {
  running: boolean
  queue: readonly unknown[]
}

/** Product-side state for one Browser Target captured before a session starts running. */
export class BrowserTargetSessionRunLock {
  accepted = false
  observedRunning = false

  constructor(readonly submissionId: string) {}

  accept(snapshot: SessionRunSnapshot): boolean {
    this.accepted = true
    return this.observe(snapshot)
  }

  /** Returns true only after this accepted run has become completely idle. */
  observe(snapshot: SessionRunSnapshot): boolean {
    if (snapshot.running) this.observedRunning = true
    return this.accepted && this.observedRunning && !snapshot.running && snapshot.queue.length === 0
  }
}

/** Pending or active work keeps the Browser Target chosen when that lifecycle began. */
export function shouldCaptureSessionRunTarget(snapshot: SessionRunSnapshot, hasLock: boolean): boolean {
  return !hasLock && !snapshot.running && snapshot.queue.length === 0
}
