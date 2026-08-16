import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import css from './PresetFooter.module.css'

export interface PresetOption {
  id: string
  trust: 'system' | 'user'
  name?: string
}

export interface PresetFooterState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  options: readonly PresetOption[]
  error?: string
}

export interface PresetFooterInjected {
  hooks: { productAgentPresets: SnapshotStore<PresetFooterState> }
  load: () => Promise<void>
}

export type PresetFooterProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<PresetFooterInjected>

const builtInName = (id: string, t: PresetFooterProps['t']): string => {
  if (id === 'standard') return t('presetStandardName')
  if (id === 'code') return t('presetCodeName')
  if (id === 'minimal') return t('presetMinimalName')
  if (id === 'cordis') return t('presetCordisName')
  return id
}

export function PresetFooter({ sessionId, useSessions, useProductAgentPresets, load, t }: PresetFooterProps) {
  const preset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const state = useProductAgentPresets(snapshot => snapshot)

  useEffect(() => {
    if (preset !== undefined && state.status === 'idle') void load()
  }, [load, preset, state.status])

  if (preset === undefined) return null
  const option = state.options.find(item => item.id === preset)
  const name = option?.trust === 'system'
    ? builtInName(option.id, t)
    : option?.name ?? preset
  return (
    <span className={css.label} title={state.error ?? t('headerHint')} data-accrui-agent-preset={preset}>
      <IconAgentPresetOutline16 className={css.icon} size={14} />
      {name}
    </span>
  )
}
