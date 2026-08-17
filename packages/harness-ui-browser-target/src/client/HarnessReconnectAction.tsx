import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './HarnessReconnectAction.module.css'

export interface HarnessReconnectActionInjected {
  reconnectHarness: () => void
}

type HarnessReconnectActionProps = PropsRuntime<'sidebar.compact.action'> & InjectFace<HarnessReconnectActionInjected>

/** The e327 compact-header reconnect position, not the deprecated footer action. */
export function HarnessReconnectAction({ reconnectHarness }: HarnessReconnectActionProps) {
  return <Tooltip label="重新连接 Harness" delayMs={500}>
    <button type="button" className={css.action} aria-label="重新连接 Harness" onClick={reconnectHarness}>
      <IconRefreshOutline16 size={18} />
    </button>
  </Tooltip>
}
