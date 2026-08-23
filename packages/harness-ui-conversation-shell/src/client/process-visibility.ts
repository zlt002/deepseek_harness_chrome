import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_CONVERSATION_PRESENTATION_SETTINGS,
  SHOW_PROCESS_FIELD,
  type ConversationPresentationSettings,
} from '../presentation-settings.ts'

/** Mirrors the durable presentation preference while retaining the visible-by-default fallback. */
export class ProcessVisibility {
  readonly showProcess: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_CONVERSATION_PRESENTATION_SETTINGS.showProcess)

  constructor(private readonly settings: SettingsScope<ConversationPresentationSettings>) {
    settings.subscribe(() => { this.adopt() })
    this.adopt()
  }

  setShowProcess(showProcess: boolean): void {
    if (this.showProcess.getSnapshot() === showProcess) return
    this.showProcess.set(showProcess)
    void this.settings.set(SHOW_PROCESS_FIELD, showProcess)
  }

  private adopt(): void {
    const value = this.settings.getSnapshot().value?.showProcess
    if (value === undefined || this.showProcess.getSnapshot() === value) return
    this.showProcess.set(value)
  }
}
