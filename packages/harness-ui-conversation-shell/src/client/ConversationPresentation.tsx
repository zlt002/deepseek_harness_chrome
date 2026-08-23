import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ConversationPresentation.module.css'

/** AccrUI's root-scroll composition. Harness supplies opaque render callbacks and owns all state. */
interface ConversationPresentationInjected {
  readonly hooks: {
    showProcess: SnapshotStore<boolean>
    composerFullscreen: SnapshotStore<boolean>
  }
}

export function ConversationPresentation({ matched: owner, useShowProcess, useComposerFullscreen }: PropsRuntime<'conversation.presentation'> & InjectFace<ConversationPresentationInjected> & {
  matched: ConversationPresentationOwnerProps
}) {
  const showProcess = useShowProcess(state => state)
  const composerFullscreen = useComposerFullscreen(state => state)
  const hero = owner.renderHero()
  return (
    <div className={css.root} data-phase={owner.phase} data-show-process={showProcess} data-composer-fullscreen={composerFullscreen} data-conversation-presentation="accrui">
      <div className={css.headerSeat}>{owner.renderHeader()}</div>
      <div className={css.scrollBody} data-conversation-scroll="">
        {hero !== null && <div className={css.heroTitleSeat}>{hero}</div>}
        {owner.renderSession()}
      </div>
      {owner.renderComposer()}
    </div>
  )
}
