import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FootballAgentSnapshot } from './football-agent-bridge.ts'
import css from './FootballAnalysisDock.module.css'

export interface FootballAnalysisDockInjected {
  readonly hooks: { footballAgent: SnapshotStore<FootballAgentSnapshot> }
  readonly requestAnalysis: () => void
  readonly openRecords: () => void
}

type Props = PropsRuntime<'conversation.composer.above'> & InjectFace<FootballAnalysisDockInjected>

function analysisLabel(status: FootballAgentSnapshot['analysis']['status']): string {
  if (status === 'running') return '深度分析中'
  if (status === 'completed') return '分析已完成'
  if (status === 'failed') return '分析失败'
  return '等待分析'
}

/** Small product card above the official composer; Harness retains the entire chat and mobile layout. */
export function FootballAnalysisDock({ useFootballAgent, requestAnalysis, openRecords }: Props) {
  const snapshot = useFootballAgent(value => value)
  const match = snapshot.match
  const analysis = snapshot.analysis
  const canAnalyze = match !== undefined && analysis.status !== 'running'
  const subtitle = match === undefined
    ? '请先从比赛列表选择一场比赛'
    : `${match.league} · ${match.time}${match.score === undefined ? '' : ` · ${match.score}`}`
  return <section className={css.dock} aria-label="球探智策比赛分析" data-football-agent-dock>
    <div className={css.copy}>
      <strong>{match === undefined ? '未选择比赛' : `${match.home} vs ${match.away}`}</strong>
      <span>{subtitle}</span>
      {analysis.summary !== undefined && <small>{analysis.summary}</small>}
      {analysis.status === 'failed' && analysis.errorMessage !== undefined && <small className={css.error}>{analysis.errorMessage}</small>}
    </div>
    <div className={css.actions}>
      <span className={css.status} data-status={analysis.status}>{analysisLabel(analysis.status)}</span>
      <button type="button" className={css.records} onClick={openRecords}>查看记录</button>
      <button type="button" className={css.analyze} disabled={!canAnalyze} onClick={requestAnalysis}>深度分析</button>
    </div>
  </section>
}
