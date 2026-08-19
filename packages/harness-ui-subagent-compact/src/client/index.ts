import type { ClientContext, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { CompactSubagentAction, type CompactSubagentActionInjected } from './CompactSubagentAction.tsx'
import {
  CompactSubagentHeaderActions, type CompactSubagentHeaderActionsInjected,
} from './CompactSubagentHeaderActions.tsx'
import {
  CompactTrajectoryHeaderActions, type CompactTrajectoryHeaderActionsInjected,
} from './CompactTrajectoryHeaderActions.tsx'
import { en, NS, zh, type CompactSubagentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    productSubagentCompact: CompactSubagentKey
  }
}

export const inject = [
  'slots', 'sessions', 'locale', 'settingsQuickActions', 'conversationViewState',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'product-subagent-compact: dictionaries')
  const sessions = ctx.sessions
  const compactActions = (): CompactSubagentActionInjected => ({
    openChild(address: SubagentAddress) {
      sessions.openSubagent(address)
    },
  })
  const compactHeaderActions = (): CompactSubagentHeaderActionsInjected => ({
    hooks: {
      quickActions: ctx.get('settingsQuickActions')!.store,
      view: ctx.get('conversationViewState')!.currentSource(ctx.sessions.list),
    },
  })
  const compactTrajectoryActions = (): CompactTrajectoryHeaderActionsInjected => ({
    hooks: {
      quickActions: ctx.get('settingsQuickActions')!.store,
      view: ctx.get('conversationViewState')!.currentSource(ctx.sessions.list),
    },
  })
  ctx.slots.inject('sidebar.compact.action', () => ctx.slots.register({
    name: 'sidebar.compact.action',
    id: 'running-subagents',
    order: 0,
    locale: NS,
    inject: compactActions,
  }, CompactSubagentAction))
  ctx.slots.inject('sidebar.compact.subagent.action', () => ctx.slots.register({
    name: 'sidebar.compact.subagent.action',
    id: 'subagent-detail-actions',
    order: 0,
    locale: NS,
    inject: compactHeaderActions,
  }, CompactSubagentHeaderActions))
  ctx.slots.inject('sidebar.compact.trajectory.action', () => ctx.slots.register({
    name: 'sidebar.compact.trajectory.action',
    id: 'trajectory-detail-actions',
    order: 0,
    locale: NS,
    inject: compactTrajectoryActions,
  }, CompactTrajectoryHeaderActions))
}

export { CompactSubagentAction } from './CompactSubagentAction.tsx'
export { CompactSubagentHeaderActions } from './CompactSubagentHeaderActions.tsx'
export { CompactTrajectoryHeaderActions } from './CompactTrajectoryHeaderActions.tsx'
