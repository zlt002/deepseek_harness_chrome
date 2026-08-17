import { useRef } from 'react'
import { IconAgentPresetOutline16, Tooltip, useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import css from './CompactPresetPresentation.module.css'

/** The product visual only; selection still invokes the upstream seat controller. */
export function CompactPresetPresentation(owner: AgentPresetPresentationOwnerProps) {
  const close = useRef<() => void>(() => {})
  const panel = (
    <div className={css.panel} role="menu" aria-label={owner.label}>
      {owner.options.map(option => (
        <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === owner.state.current}
          className={option.id === owner.state.current ? `${css.option} ${css.optionSelected}` : css.option}
          onClick={() => { close.current(); void owner.select(option.id) }}>
          <span className={css.name}>{option.name}</span><span className={css.description}>{option.description}</span>
        </button>
      ))}
    </div>
  )
  const overlay = useComposerOverlay('agent-preset', panel)
  close.current = overlay.close
  return (
    <Tooltip label={owner.state.error ?? owner.label} side="top" delayMs={500}>
      <button type="button" className={css.trigger} data-preset={owner.state.current}
        data-composer-overlay-trigger aria-label={owner.state.error ?? owner.label} aria-haspopup="menu"
        aria-expanded={overlay.open} disabled={owner.state.busy} onClick={() => { overlay.toggle() }}>
        <IconAgentPresetOutline16 className={owner.introducing ? `${css.icon} ${css.introIcon}` : css.icon} />
        <span className={css.visuallyHidden}>{owner.shownLabel}</span>
      </button>
    </Tooltip>
  )
}
