import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FootballAnalysisDock, type FootballAnalysisDockInjected } from './FootballAnalysisDock.tsx'
import { FootballAgentBridge } from './football-agent-bridge.ts'

export const inject = ['slots']

/** Extend the official composer with football context; it never replaces a Harness-owned seat. */
export function apply(ctx: ClientContext): void {
  const bridge = new FootballAgentBridge()
  ctx.effect(() => bridge.connect(), 'accrui-football-agent: parent match context bridge')
  const injected = (): FootballAnalysisDockInjected => ({
    hooks: { footballAgent: bridge.snapshot },
    requestAnalysis: () => { bridge.requestAnalysis() },
    openRecords: () => { bridge.openRecords() },
  })
  ctx.slots.inject('conversation.composer.above', () => ctx.slots.register({
    name: 'conversation.composer.above',
    id: 'accrui-football-agent',
    order: 35,
    inject: injected,
  }, FootballAnalysisDock))
}

export { FootballAnalysisDock } from './FootballAnalysisDock.tsx'
export { FootballAgentBridge } from './football-agent-bridge.ts'
export { FOOTBALL_AGENT_SOURCE, FOOTBALL_AGENT_VERSION, createFootballAgentMessage, parentOriginFromReferrer, parseFootballContextMessage } from './protocol.js'
export type { FootballAgentSnapshot, FootballAnalysis, FootballMatch } from './football-agent-bridge.ts'
