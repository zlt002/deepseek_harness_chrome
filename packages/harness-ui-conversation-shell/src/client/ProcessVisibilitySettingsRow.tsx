import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ProcessVisibilitySettingsRow.module.css'

export interface ProcessVisibilitySettingsRowInjected {
  readonly hooks: { showProcess: SnapshotStore<boolean> }
  readonly setShowProcess: (showProcess: boolean) => void
}

type Props = PropsRuntime<'settings.general.item'> & InjectFace<ProcessVisibilitySettingsRowInjected>

/** General Settings row for whether completed process records remain expanded. */
export function ProcessVisibilitySettingsRow({ useShowProcess, setShowProcess }: Props) {
  const showProcess = useShowProcess(state => state)
  return <label className={css.row}>
    <span className={css.copy}>
      <span className={css.title}>显示会话过程</span>
      <span className={css.description}>显示已完成的上下文注入、远程检索和工具调用过程。</span>
    </span>
    <input
      className={css.switch}
      type="checkbox"
      checked={showProcess}
      aria-label="显示会话过程"
      onChange={(event) => { setShowProcess(event.currentTarget.checked) }}
    />
  </label>
}
