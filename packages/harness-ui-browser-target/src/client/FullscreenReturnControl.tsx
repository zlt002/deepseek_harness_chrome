import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFullscreenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FullscreenReturnControl.module.css'

export interface FullscreenReturnControlInjected {
  readonly returnToSidePanel: (sessionId: SessionId) => void
}

type Props = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<FullscreenReturnControlInjected>

/** A session-header utility, so the return control shares the Session log's stable layout flow. */
export function FullscreenReturnControl({ sessionId, returnToSidePanel }: Props) {
  const label = '收起全屏'
  return <Tooltip label={label} side="bottom" delayMs={500}>
    <button className={css.control} type="button" aria-label={label} title={label} data-fullscreen-return-control onClick={() => { returnToSidePanel(sessionId) }}>
      <IconFullscreenOutline16 size={16} />
    </button>
  </Tooltip>
}
