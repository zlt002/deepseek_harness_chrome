import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ConversationPresentation.module.css'

/** AccrUI's root-scroll composition. Harness supplies opaque render callbacks and owns all state. */
export function ConversationPresentation({ matched: owner }: PropsRuntime<'conversation.presentation'> & {
  matched: ConversationPresentationOwnerProps
}) {
  const hero = owner.renderHero()
  return (
    <div className={css.root} data-phase={owner.phase} data-conversation-presentation="accrui">
      <div className={css.headerSeat}>{owner.renderHeader()}</div>
      <div className={css.scrollBody} data-conversation-scroll="">
        {hero !== null && <div className={css.heroTitleSeat}>{hero}</div>}
        {owner.renderSession()}
      </div>
      {owner.renderComposer()}
    </div>
  )
}
