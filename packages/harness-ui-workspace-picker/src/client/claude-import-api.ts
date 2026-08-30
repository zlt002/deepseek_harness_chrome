import { claudeImportRequest as request } from './claude-import-request.mjs'

export interface ClaudeProject { key: string; label: string; sessionCount: number; updatedAt: string }
export interface ClaudeSession { sessionId: string; title: string; updatedAt: string; size: number }
export interface ClaudeSessionDetail {
  title: string
  sourceUpdatedAt: string
  truncated: boolean
  cwd?: string
  model?: string
  details?: {
    toolCount: number
    unsupported: string[]
    orphanToolResults: number
    orphanAssistantMessages: number
    unknownToolResults: number
    interruptedTurns: number
    truncated: boolean
  }
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>
}
export type PreparedImport =
  | { kind: 'existing'; sourceKey: string; sessionId: string }
  | { kind: 'prepared'; sourceKey: string; title: string; sourceUpdatedAt: string }
  | { kind: 'append'; sourceKey: string; sessionId: string; title: string; sourceUpdatedAt: string }
  | { kind: 'conflict'; sourceKey: string; sessionId: string; reason: string }
export type NativeImportResult =
  | { kind: 'existing'; sessionId: string; status: string }
  | { kind: 'imported'; sessionId: string; status: 'seeded' | 'appended' }
  | { kind: 'conflict'; sessionId: string; reason: string }

export interface ClaudeImportRequestOptions { timeoutMs?: number }

export async function claudeImportRequest<T>(body: unknown, signal?: AbortSignal, options?: ClaudeImportRequestOptions): Promise<T> {
  return request(body, signal, options) as Promise<T>
}
