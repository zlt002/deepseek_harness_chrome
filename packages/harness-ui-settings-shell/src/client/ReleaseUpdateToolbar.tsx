import { useEffect, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReleaseUpdate } from './ReleaseUpdateSection.tsx'
import { checkedReleaseToolbarState, releaseToolbarAction, type ReleaseToolbarState } from './release-update-toolbar-state.ts'
import css from './ReleaseUpdateToolbar.module.css'

export interface ReleaseUpdateToolbarInjected { request: (action: 'check' | 'prepare') => Promise<ReleaseUpdate> }
type Props = PropsRuntime<'sidebar.compact.action'> & InjectFace<ReleaseUpdateToolbarInjected>

/** A zero-footprint compact-header action until Native reports an upgrade. */
export function ReleaseUpdateToolbar({ request }: Props) {
  const [state, setState] = useState<ReleaseToolbarState>({ phase: 'checking' })
  useEffect(() => {
    let active = true
    void request('check').then(update => { if (active) setState(checkedReleaseToolbarState(update)) }, error => { if (active) setState({ phase: 'hidden' }) })
    return () => { active = false }
  }, [request])
  const action = releaseToolbarAction(state)
  if (action === undefined) {
    return state.phase === 'error' ? <span className={css.error} role="alert">{state.error}</span> : null
  }
  const start = (): void => {
    setState({ phase: 'preparing' })
    void request('prepare').then(() => setState({ phase: 'hidden' }), error => setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) }))
  }
  const label = state.version === undefined ? '发现 Harness Windows Lite 更新，开始升级' : `发现 Harness Windows Lite ${state.version} 更新，开始升级`
  return <Tooltip label={label} delayMs={500}><button type="button" className={css.action} aria-label={label} onClick={start}>
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12-5 5m5-5 5 5M5 15v4h14v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button></Tooltip>
}
