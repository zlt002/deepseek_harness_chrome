import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CompactPresetPresentation } from './CompactPresetPresentation.tsx'
import { PresetFooter, type PresetFooterInjected, type PresetFooterState, type PresetOption } from './PresetFooter.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const api = (ctx.get('connection') as ConnectionHandle).api
  const store = createSnapshotStore<PresetFooterState>({ status: 'idle', options: [] })
  let pending: Promise<void> | undefined
  const load = (): Promise<void> => {
    if (store.getSnapshot().status === 'ready') return Promise.resolve()
    if (pending !== undefined) return pending
    store.set({ status: 'loading', options: store.getSnapshot().options })
    pending = api.agentPresets.list({}).then(response => {
      if (!response.result.ok) throw new Error(response.result.error.message)
      const options: PresetOption[] = response.result.value.presets.map(preset => ({
        id: preset.id,
        trust: preset.trust,
        ...(preset.name === undefined ? {} : { name: preset.name }),
      }))
      store.set({ status: 'ready', options })
    }).catch(error => {
      store.set({ status: 'error', options: [], error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { pending = undefined })
    return pending
  }
  const injected = (): PresetFooterInjected => ({
    hooks: { productAgentPresets: store },
    load,
  })
  ctx.slots.inject('agent-preset.presentation', () => ctx.slots.register({
    name: 'agent-preset.presentation',
    id: 'accrui-agent-preset-presentation',
    order: 0,
    select: owner => owner,
  }, CompactPresetPresentation))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'accrui-agent-preset',
    order: -10,
    locale: 'settings.agentPreset',
    inject: injected,
  }, PresetFooter))
}

export { PresetFooter }
export type { PresetFooterInjected, PresetFooterState, PresetOption } from './PresetFooter.tsx'
