import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillSettingsInjected } from './index.ts'
import css from './section.module.css'

type Mode = 'enabled' | 'manual-only' | 'disabled'
type View = { writable: boolean, revision: number, modes: Record<string, Mode>, skills: readonly SkillEntry[] }
const NS = 'skill-settings'
const MODE_OPTIONS = [
  { value: 'enabled', label: 'enabled' },
  { value: 'manual-only', label: 'manual' },
  { value: 'disabled', label: 'disabled' },
] as const
function modesOf(value: unknown): Record<string, Mode> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const modes = (value as { modes?: unknown }).modes
  if (modes === null || typeof modes !== 'object' || Array.isArray(modes)) return {}
  return Object.fromEntries(Object.entries(modes).filter((entry): entry is [string, Mode] => entry[1] === 'enabled' || entry[1] === 'manual-only' || entry[1] === 'disabled'))
}

export function SkillSettingsSection({ api, t, useSessions }: SkillSettingsInjected): ReactNode {
  const sessionId = useSessions(state => state.current)
  const [view, setView] = useState<View>()
  const [failure, setFailure] = useState(false)
  const [request, setRequest] = useState(0)
  const [pending, setPending] = useState<string>()
  useEffect(() => {
    let active = true
    if (sessionId === undefined) { setView(undefined); setFailure(false); return () => { active = false } }
    setFailure(false)
    void Promise.all([api.skills.list({ sessionId, includeUnavailable: true }), api.settings.describe({})]).then(([skills, settings]) => {
      if (!active) return
      const section = settings.result.ok ? settings.result.value.namespaces.find(item => item.ns === NS) : undefined
      if (!skills.result.ok || section === undefined) { setFailure(true); return }
      setView({ writable: settings.result.value.writable, revision: section.revision, modes: modesOf(section.value), skills: skills.result.value.skills })
    }, () => { if (active) setFailure(true) })
    return () => { active = false }
  }, [api, request, sessionId])
  if (sessionId === undefined) return <p className={css.status}>{t('noSession')}</p>
  if (failure) return <div className={css.status}><p role="alert">{view === undefined ? t('loadFailed') : t('saveFailed')}</p><button type="button" onClick={() => setRequest(value => value + 1)}>{t('retry')}</button></div>
  if (view === undefined) return <p className={css.status}>{t('loading')}</p>
  const change = (skill: SkillEntry, mode: Mode): void => {
    if (!view.writable || pending !== undefined) return
    setPending(skill.name)
    void api.settings.update({ ns: NS, patch: { modes: { [skill.name]: mode } }, expectedRevision: view.revision }).then(result => {
      if (!result.result.ok) setFailure(true)
      else setRequest(value => value + 1)
    }, () => setFailure(true)).finally(() => setPending(undefined))
  }
  return <section className={css.section}><h2>{t('title')}</h2><p className={css.intro}>{t('intro')}</p>{view.skills.length === 0 ? <p className={css.status}>{t('empty')}</p> : <ul className={css.rows}>{view.skills.map(skill => {
    const mode = view.modes[skill.name] ?? 'enabled'
    const disabled = !view.writable || pending !== undefined
    return <li key={skill.name} className={css.row}><div><strong>{skill.name}</strong><p>{skill.description}</p>{skill.authoredModelInvocable === false ? <span>{t('authorModel')}</span> : null}{skill.authoredUserInvocable === false ? <span>{t('authorUser')}</span> : null}</div>
      <div className={css.modeControl} role="radiogroup" aria-label={skill.name}>{MODE_OPTIONS.map(option => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={mode === option.value}
        tabIndex={mode === option.value ? 0 : -1}
        className={css.modeButton}
        disabled={disabled}
        onClick={() => change(skill, option.value)}
        onKeyDown={(event) => {
          const index = MODE_OPTIONS.findIndex(candidate => candidate.value === option.value)
          let next = index
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODE_OPTIONS.length
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + MODE_OPTIONS.length - 1) % MODE_OPTIONS.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = MODE_OPTIONS.length - 1
          else return
          event.preventDefault()
          const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
          buttons?.[next]?.focus()
          change(skill, MODE_OPTIONS[next].value)
        }}
      >{t(option.label)}</button>)}</div>
    </li>
  })}</ul>}</section>
}
