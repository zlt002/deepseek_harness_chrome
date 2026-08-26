import { useEffect, useState } from 'react'
import { IconDownloadOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReleaseUpdate } from './ReleaseUpdateSection.tsx'
import { checkedReleaseToolbarState, releaseToolbarAction, type ReleaseToolbarState } from './release-update-toolbar-state.ts'
import css from './ReleaseUpdateToolbar.module.css'

export interface ReleaseUpdateToolbarInjected { request: (action: 'check' | 'prepare') => Promise<ReleaseUpdate> }
type Props = PropsRuntime<'sidebar.compact.action'> & InjectFace<ReleaseUpdateToolbarInjected>

/** A zero-footprint compact-header action until Native reports an upgrade. */
export function ReleaseUpdateToolbar({ request }: Props) {
  const [state, setState] = useState<ReleaseToolbarState>({ phase: 'checking' })
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    let active = true
    void request('check').then(update => { if (active) setState(checkedReleaseToolbarState(update)) }, error => { if (active) setState({ phase: 'hidden' }) })
    return () => { active = false }
  }, [request])
  const action = releaseToolbarAction(state)
  if (action === undefined) return null
  const start = (): void => {
    const version = state.phase === 'ready' ? state.version : undefined
    setFailure(undefined)
    setState({ phase: 'preparing' })
    void request('prepare').then(() => setState({ phase: 'hidden' }), error => {
      setFailure(error instanceof Error ? error.message : String(error))
      setState({ phase: 'ready', ...(version === undefined ? {} : { version }) })
    })
  }
  const label = failure === undefined
    ? state.version === undefined ? '发现 Harness Windows Lite 更新，开始升级' : `发现 Harness Windows Lite ${state.version} 更新，开始升级`
    : `升级失败：${failure}`
  return <Tooltip label={label} delayMs={500}><button type="button" className={css.action} aria-label={label} onClick={start}>
    <IconDownloadOutline16 size={18} />
  </button></Tooltip>
}
