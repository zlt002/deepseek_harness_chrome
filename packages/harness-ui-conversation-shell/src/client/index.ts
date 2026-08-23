import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConversationPresentation } from './ConversationPresentation.tsx'
import { ComposerFullscreenControl } from './ComposerFullscreenControl.tsx'
import { ComposerFullscreen } from './composer-fullscreen.ts'
import { ProcessVisibilitySettingsRow } from './ProcessVisibilitySettingsRow.tsx'
import { ProcessVisibility } from './process-visibility.ts'
import { CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE, type ConversationPresentationSettings } from '../presentation-settings.ts'
import { companyGatewayFirst } from './model-order.ts'
import { permissionLabel } from './permission-labels.ts'

/**
 * AccrUI's compact header has no room for the stock view tabs.  It uses the
 * official view bridge to change the existing per-session store, rather than
 * maintaining a second selected-view state in the product package.
 */
export const inject = ['slots', 'connection', 'remote', 'settingsScope', 'settingsQuickActions', 'conversationViewState', 'modelDirectories', 'sessions', 'permissionLabels']

export function apply(ctx: ClientContext): void {
  const composerFullscreen = new ComposerFullscreen()
  const processVisibility = new ProcessVisibility(ctx.settingsScope.bind<ConversationPresentationSettings>({
    namespace: CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE,
  }))
  const permissionLabels = ctx.get('permissionLabels')!
  ctx.effect(() => permissionLabels.register(permissionLabel), 'accrui-conversation-shell: Chinese permission labels')
  ctx.slots.inject('conversation.presentation', () => ctx.slots.register({
    name: 'conversation.presentation',
    id: 'accrui-conversation-presentation',
    order: 0,
    select: owner => owner,
    inject: () => ({ hooks: { showProcess: processVisibility.showProcess, composerFullscreen: composerFullscreen.active } }),
  }, ConversationPresentation))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'composer-fullscreen-control',
    order: 5,
    inject: () => ({
      hooks: { composerFullscreen: composerFullscreen.active },
      toggleComposerFullscreen: () => { composerFullscreen.toggle() },
      exitComposerFullscreen: () => { composerFullscreen.exit() },
    }),
  }, ComposerFullscreenControl))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'process-visibility',
    order: 21,
    inject: () => ({
      hooks: { showProcess: processVisibility.showProcess },
      setShowProcess: (showProcess: boolean) => { processVisibility.setShowProcess(showProcess) },
    }),
  }, ProcessVisibilitySettingsRow))
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

  // The stock ModelSelect reads this public per-session store. Reorder only
  // its presentation snapshot, after every Host refresh, so Host routing and
  // every non-company provider's order remain untouched.
  ctx.inject(['modelDirectories', 'sessions'], (scope: ClientContext) => {
    let activeSessionId: SessionId | undefined
    let stopDirectory: (() => void) | undefined
    const attach = (): void => {
      const sessionId = scope.sessions.list.getSnapshot().current
      if (sessionId === activeSessionId) return
      stopDirectory?.()
      activeSessionId = sessionId
      if (sessionId === undefined) return
      const directory = scope.modelDirectories.directoryFor(sessionId)
      const order = (): void => {
        const groups = directory.store.getSnapshot().groups
        const ordered = companyGatewayFirst(groups)
        if (ordered === groups) return
        directory.store.update((state) => { state.groups = [...ordered] })
      }
      order()
      stopDirectory = directory.store.subscribe(order)
    }
    const stopSessions = scope.sessions.list.subscribe(attach)
    attach()
    scope.effect(() => () => {
      stopSessions()
      stopDirectory?.()
    }, 'accrui-conversation-shell: company gateway model order')
  })
}

export { ConversationPresentation } from './ConversationPresentation.tsx'
