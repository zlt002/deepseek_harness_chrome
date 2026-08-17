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
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<string>()
  useEffect(() => {
    let active = true
    if (sessionId === undefined) { setView(undefined); return () => { active = false } }
    setFailed(false)
    void Promise.all([api.skills.list({ sessionId, includeUnavailable: true }), api.settings.describe({})]).then(([skills, settings]) => {
      if (!active) return
      const section = settings.result.ok ? settings.result.value.namespaces.find(item => item.ns === NS) : undefined
      if (!skills.result.ok || section === undefined) { setFailed(true); return }
      setView({ writable: settings.result.value.writable, revision: section.revision, modes: modesOf(section.value), skills: skills.result.value.skills })
    }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [api, revision, sessionId])
  if (sessionId === undefined) return <p className={css.status}>{t('noSession')}</p>
  if (failed) return <p role="alert" className={css.status}>{t('failed')}</p>
  if (view === undefined) return <p className={css.status}>{t('loading')}</p>
  const change = (skill: SkillEntry, mode: Mode): void => {
    if (!view.writable || pending !== undefined) return
    setPending(skill.name)
    void api.settings.update({ ns: NS, patch: { modes: { [skill.name]: mode } }, expectedRevision: view.revision }).then(result => {
      if (!result.result.ok) setFailed(true)
      else setRevision(value => value + 1)
    }, () => setFailed(true)).finally(() => setPending(undefined))
  }
  return <section className={css.section}><div className={css.heading}><h2>{t('title')}</h2><p className={css.intro}>{t('intro')}</p></div><ul className={css.rows}>{view.skills.map(skill => {
    const mode = view.modes[skill.name] ?? 'enabled'
    const disabled = !view.writable || pending !== undefined
    return <li key={skill.name} className={css.row}><div className={css.skillCopy}><strong>{skill.name}</strong><p>{skill.description}</p><div className={css.restrictions}>{skill.authoredModelInvocable === false ? <span>{t('authorModel')}</span> : null}{skill.authoredUserInvocable === false ? <span>{t('authorUser')}</span> : null}</div></div>
      <div className={css.modeControl} role="radiogroup" aria-label={skill.name}>{MODE_OPTIONS.map(option => <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={mode === option.value}
        className={css.modeButton}
        disabled={disabled}
        onClick={() => change(skill, option.value)}
      >{t(option.label)}</button>)}</div>
    </li>
  })}</ul></section>
}
