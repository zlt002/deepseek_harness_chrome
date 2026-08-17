import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { unzipSync } from 'fflate/browser'

export type CopySessionLogStatus = 'copying' | 'copied' | 'error'

export interface CopySessionLogEntry {
  readonly open: boolean
  readonly status: CopySessionLogStatus
  readonly error: string | null
}

export interface CopySessionLogState {
  bySession: Record<string, CopySessionLogEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Clipboard = { writeText: (text: string) => Promise<void> }

const INITIAL: CopySessionLogState = { bySession: {} }

function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns the AccrUI-only current-session raw-log copy flow. */
export class CopySessionLogController {
  readonly store: SnapshotStore<CopySessionLogState> = createSnapshotStore(INITIAL)
  private readonly copies = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly clipboard: Clipboard | undefined = globalThis.navigator?.clipboard,
  ) {}

  copy(sessionId: SessionId): Promise<void> {
    const existing = this.copies.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.copyRaw(sessionId, abort.signal).finally(() => { this.copies.delete(sessionId) })
    this.copies.set(sessionId, { abort, done })
    return done
  }

  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current?.open === true) this.publish(sessionId, { ...current, open: false })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const copies = [...this.copies.values()]
    for (const operation of copies) operation.abort.abort()
    await Promise.allSettled(copies.map(operation => operation.done))
  }

  private async copyRaw(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'copying', error: null })
    try {
      if (this.clipboard === undefined) throw new Error('Clipboard access is unavailable')
      const url = new URL('/api/session.export', hostBase())
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'false')
      const response = await this.fetcher(url, { signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
      const entries = Object.entries(files).filter(([path]) => !path.startsWith('subagents/') && !path.startsWith('media/'))
      if (entries.length !== 1) throw new Error('The Session export did not contain one raw log')
      await this.clipboard.writeText(new TextDecoder().decode(entries[0]![1] as Uint8Array))
      this.publish(sessionId, { open: this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true, status: 'copied', error: null })
    } catch (error: unknown) {
      if (!signal.aborted) this.publish(sessionId, { open: this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: CopySessionLogEntry): void {
    this.store.update(state => { state.bySession = { ...state.bySession, [String(sessionId)]: entry } })
  }
}
