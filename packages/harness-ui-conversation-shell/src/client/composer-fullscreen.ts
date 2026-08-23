import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Presentation-only state: the Harness input machine keeps the draft itself. */
export class ComposerFullscreen {
  readonly active: SnapshotStore<boolean> = createSnapshotStore(false)

  toggle(): void {
    this.active.set(!this.active.getSnapshot())
  }

  exit(): void {
    if (!this.active.getSnapshot()) return
    this.active.set(false)
  }
}
