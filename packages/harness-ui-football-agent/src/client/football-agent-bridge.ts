import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createFootballAgentMessage, parentOriginFromReferrer, parseFootballContextMessage } from './protocol.js'

export interface FootballMatch {
  readonly id: string
  readonly league: string
  readonly time: string
  readonly home: string
  readonly away: string
  readonly status: string
  readonly score?: string
  readonly probabilities?: readonly number[]
}

export interface FootballAnalysis {
  readonly status: 'idle' | 'running' | 'completed' | 'failed'
  readonly runId?: string
  readonly executionMode?: string
  readonly provider?: string
  readonly modelVersion?: string
  readonly errorMessage?: string
  readonly evidenceCount?: number
  readonly conflictCount?: number
  readonly summary?: string
  readonly prediction?: {
    readonly predictedScore: string
    readonly probabilities: readonly number[]
    readonly confidence: number
    readonly verdict: string
  }
  readonly evidence?: readonly {
    readonly ordinal: number
    readonly title: string
    readonly summary: string
    readonly sourceName: string
    readonly sourceUrl: string
    readonly credibility: number
    readonly verificationStatus: string
  }[]
}

export interface FootballAgentSnapshot {
  readonly match?: FootballMatch
  readonly analysis: FootballAnalysis
}

const EMPTY_SNAPSHOT: FootballAgentSnapshot = { analysis: { status: 'idle' } }

/** Browser-only bridge: the parent window remains the authority for football data and analysis. */
export class FootballAgentBridge {
  readonly snapshot: SnapshotStore<FootballAgentSnapshot> = createSnapshotStore(EMPTY_SNAPSHOT)
  private parentOrigin: string | undefined

  connect(): () => void {
    if (window.parent === window) return () => {}
    this.parentOrigin = parentOriginFromReferrer(document.referrer)
    if (this.parentOrigin === undefined) return () => {}
    const receive = (event: MessageEvent): void => {
      const message = parseFootballContextMessage(event, window.parent, this.parentOrigin)
      if (message === undefined) return
      this.snapshot.set({ match: message.payload.match, analysis: message.payload.analysis })
    }
    window.addEventListener('message', receive)
    this.post('football-agent/ready')
    return () => { window.removeEventListener('message', receive) }
  }

  requestAnalysis(): void {
    const match = this.snapshot.getSnapshot().match
    if (match === undefined) return
    this.post('football-agent/request-analysis', { matchId: match.id })
  }

  openRecords(): void {
    const matchId = this.snapshot.getSnapshot().match?.id
    this.post('football-agent/open-records', matchId === undefined ? {} : { matchId })
  }

  private post(type: 'football-agent/ready' | 'football-agent/request-analysis' | 'football-agent/open-records', payload: Record<string, string> = {}): void {
    if (this.parentOrigin === undefined || window.parent === window) return
    window.parent.postMessage(createFootballAgentMessage(type, payload), this.parentOrigin)
  }
}
