import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConversationPresentation } from './ConversationPresentation.tsx'

/**
 * AccrUI's compact header has no room for the stock view tabs.  It uses the
 * official view bridge to change the existing per-session store, rather than
 * maintaining a second selected-view state in the product package.
 */
export const inject = ['slots', 'settingsQuickActions', 'conversationViewState']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.presentation', () => ctx.slots.register({
    name: 'conversation.presentation',
    id: 'accrui-conversation-presentation',
    order: 0,
  }, ConversationPresentation))
  const views = ctx.get('conversationViewState')!
  const quickActions = ctx.get('settingsQuickActions')!
  ctx.effect(() => quickActions.register({
    id: 'trajectory',
    label: '轨迹',
    order: 10,
    run: (sessionId: SessionId) => { views.setView(sessionId, 'trajectory') },
  }), 'accrui-conversation-shell: compact trajectory action')
  ctx.effect(() => quickActions.register({
    id: 'conversation',
    label: '对话',
    order: 11,
    run: (sessionId: SessionId) => { views.setView(sessionId, 'chat') },
  }), 'accrui-conversation-shell: compact conversation action')
}

export { ConversationPresentation } from './ConversationPresentation.tsx'
