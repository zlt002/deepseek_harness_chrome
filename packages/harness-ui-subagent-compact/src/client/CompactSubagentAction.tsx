import { useEffect, useMemo, useRef, useState } from 'react'
import { IconAgentPresetOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionId, SessionProjectionMap, SessionSummary, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS } from './locales.ts'
import css from './CompactSubagentAction.module.css'

export interface CompactSubagentActionInjected {
  openChild: (address: SubagentAddress) => void
}

export type CompactSubagentActionProps =
  PropsRuntime<'sidebar.compact.action'> & CompactSubagentActionInjected & PropsLocale<typeof NS>

type CompactEntry = {
  readonly id: SessionId
  readonly label: string
  readonly mode: SubagentAddress['mode']
  readonly summary: SessionSummary | undefined
  readonly running: boolean
}

function formatTokens(value: number): string {
  const scaled = (next: number): string => next >= 100
    ? String(Math.round(next))
    : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

function tokenTotal(usage: SessionProjectionMap['tokenUsage'] | undefined): number | undefined {
  return usage === undefined
    ? undefined
    : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function activityDuration(summary: SessionSummary | undefined, now: number): number | undefined {
  const timing = summary?.projectionValues?.subagentTiming
  if (timing === undefined) return undefined
  if (timing.active === undefined) return timing.settledMs
  return timing.settledMs + Math.max(0, now - timing.active.since)
}

function formatDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const seconds = Math.floor(Math.max(0, ms) / 1_000)
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return t('duration.seconds', { seconds })
  if (minutes < 60) return t('duration.minutes', { minutes, seconds: seconds % 60 })
  return t('duration.hours', {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, '0'),
    seconds: String(seconds % 60).padStart(2, '0'),
  })
}

export function CompactSubagentAction({ useSessions, openChild, t }: CompactSubagentActionProps) {
  const currentSessionId = useSessions(state => state.current)
  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const entries = useMemo<readonly CompactEntry[]>(() => {
    if (currentSessionId === undefined) return []
    const catalog = catalogs[currentSessionId]
    if (catalog === undefined) return []
    return catalog.entries.flatMap((entry): CompactEntry[] => {
      if (entry.kind !== 'child') return []
      const summary = summaries[entry.id]
      return [{
        id: entry.id,
        label: entry.label ?? summary?.displayTitle ?? entry.id,
        mode: entry.mode,
        summary,
        running: entry.activity === 'running' && summary?.running === true,
      }]
    })
  }, [catalogs, currentSessionId, summaries])

  useEffect(() => {
    if (entries.length > 0) return
    setOpen(false)
  }, [entries.length])

  useEffect(() => {
    if (!open || entries.length === 0) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [entries.length, open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  if (entries.length === 0 || currentSessionId === undefined) return null
  const triggerKey = entries.length === 1 ? 'count.total.one' : 'count.total.other'

  return (
    <div
      ref={rootRef}
      className={css.root}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setOpen(false)
      }}
    >
      <button
        type="button"
        className={css.trigger}
        aria-label={t(triggerKey, { count: entries.length })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(previous => !previous) }}
      >
        <IconAgentPresetOutline16 size={17} />
        <span className={css.badge}>{entries.length}</span>
      </button>
      {open && (
        <div className={css.menu} role="menu" aria-label={t('compact.menu.aria')}>
          {entries.map(entry => {
            const tokens = tokenTotal(entry.summary?.projectionValues?.tokenUsage)
            const duration = activityDuration(entry.summary, now)
            const status = entry.running ? t('activity.running') : t('activity.inactive')
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={css.item}
                aria-label={`${entry.label} ${status}`}
                onClick={() => {
                  openChild({ parentSessionId: currentSessionId, childSessionId: entry.id, mode: entry.mode })
                  setOpen(false)
                }}
              >
                <StateDot state={entry.running ? 'ongoing' : 'done'} />
                <span className={css.copy}>
                  <span className={css.label}>{entry.label}</span>
                  <span className={css.status}>{status}</span>
                </span>
                {(tokens !== undefined || duration !== undefined) && (
                  <span className={css.metrics}>
                    {tokens !== undefined && <span>{formatTokens(tokens)} tok</span>}
                    {duration !== undefined && <span>{formatDuration(duration, t)}</span>}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
