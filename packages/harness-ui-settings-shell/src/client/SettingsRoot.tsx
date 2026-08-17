import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16, IconEllipsisOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16, IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsPresentationOwnerProps, SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  if (id === 'accrui-skills') return <IconSkillOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsPresentationOwnerProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation" data-testid="settings-overlay">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="settings-panel">
        <nav className={css.nav} data-testid="settings-nav">
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={classes(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header} data-testid="settings-header">
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options} data-testid="settings-options">
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Product-owned settings presentation. Feature settings still arrive through public slots. */
export function SettingsPresentation(props: SettingsPresentationOwnerProps) {
  const { wide, compact, useSections, useOnboardingSteps, useQuickActions, useSessions, renderSlot } = props
  const [open, setOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const quickRoot = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  const rows = useSections(state => state)
  const onboardingSteps = useOnboardingSteps(state => state)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const currentSessionId = useSessions(state => state.current)
  const quickActions = useQuickActions(actions => actions)
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (!onboardingActive) setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding(previous => previous.has(id) ? previous : new Set([...previous, id]))
  }, [])
  const closeQuick = useCallback(() => { setQuickOpen(false) }, [])
  const runQuickAction = useCallback((action: typeof quickActions[number]) => {
    if (currentSessionId !== undefined) void action.run(currentSessionId)
    closeQuick()
  }, [closeQuick, currentSessionId])
  const compactQuickActions = quickActions.filter(action => action.id !== 'conversation')

  useEffect(() => {
    if (!quickOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !quickRoot.current?.contains(event.target)) closeQuick()
    }
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeQuick()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [closeQuick, quickOpen])

  return (
    <>
      <div
        className={classes(css.triggerWrap, compact && css.compactWrap)}
        ref={quickRoot}
        onBlur={compact ? event => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          closeQuick()
        } : undefined}
      >
        <button
          type="button"
          className={classes(css.trigger, !wide && css.rail, compact && css.compact)}
          aria-haspopup={compact ? 'menu' : 'dialog'}
          aria-expanded={compact ? quickOpen : open}
          onClick={() => {
            if (compact) setQuickOpen(previous => !previous)
            else setOpen(true)
          }}
        >
          {compact
            ? <IconEllipsisOutline16 className={css.compactMoreIcon} size={18} />
            : renderSlot('settings.trigger', { wide })}
        </button>
        {compact && quickOpen && (
          <div className={css.quickMenu} role="menu" aria-label="快捷操作">
            <button type="button" role="menuitem" className={css.quickItem} onClick={() => {
              closeQuick()
              setOpen(true)
            }}>设置</button>
            {compactQuickActions.map(action => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className={css.quickItem}
                disabled={currentSessionId === undefined}
                onClick={() => { runQuickAction(action) }}
              >{action.label}</button>
            ))}
          </div>
        )}
      </div>
      {open && <SettingsPanel rows={rows} renderSlot={renderSlot} activeId={activeId} onSelect={setActiveId} onClose={close} />}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}

/** Selected `settings.presentation` chain entry. */
export function SettingsRoot({ matched }: SettingsRootComponentProps) {
  return <SettingsPresentation {...matched} />
}
