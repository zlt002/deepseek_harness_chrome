import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Scope, ScopeOptions, ScopeSnapshot } from './bridge.ts'
import { scopeLabels } from './labels.js'
import css from './KnowledgeScope.module.css'

export interface KnowledgeScopeInjected {
  hooks: {
    knowledgeScope: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<ScopeSnapshot | undefined>
    knowledgeScopePanel: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<'code' | 'knowledge' | null>
  }
  request: (sessionId: string, scope?: Scope, options?: ScopeOptions) => void
  setPanel: (panel: 'code' | 'knowledge' | null) => void
}

type StripProps = PropsRuntime<'conversation.composer.above'> & InjectFace<KnowledgeScopeInjected>
type PanelProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<KnowledgeScopeInjected>
const emptyScope = (): Scope => ({ domainId: '', systemIds: [], repositoryIds: [] })
const scoped = (snapshot: ScopeSnapshot | undefined, sessionId: string): Scope => snapshot?.sessionId === sessionId ? snapshot.scope ?? emptyScope() : emptyScope()
const toggle = (ids: readonly string[], id: string, enabled: boolean): string[] => enabled ? [...new Set([...ids, id])] : ids.filter(item => item !== id)
const typeLabel = (type: string | undefined): string | undefined => type === 'frontend' ? '前端' : type === 'backend' ? '后端' : type

/** Selected-source strip. Full labels stay in the accessible name and title. */
export function KnowledgeScopeStrip({ session, useKnowledgeScope, useKnowledgeScopePanel, request, setPanel }: StripProps) {
  const snapshot = useKnowledgeScope(value => value)
  const panel = useKnowledgeScopePanel(value => value)
  const sessionId = String(session.sessionId)
  useEffect(() => { request(sessionId) }, [request, sessionId])
  const catalog = snapshot?.catalog ?? { domains: [], systems: [], repositories: [] }
  const currentScope = scoped(snapshot, sessionId)
  // The picker already resolved these names once. Keep them while a later
  // catalog refresh is incomplete, rather than making the selected scope look
  // empty and falling back to “选择代码库”. IDs remain the only saved authority.
  const repositoryNames = useRef(new Map<string, string>())
  for (const repository of catalog.repositories) {
    if (currentScope.repositoryIds.includes(repository.id)) repositoryNames.current.set(repository.id, repository.name)
  }
  const labelsCatalog = {
    ...catalog,
    repositories: [
      ...catalog.repositories,
      ...currentScope.repositoryIds.flatMap((id) => {
        if (catalog.repositories.some((repository) => repository.id === id)) return []
        const name = repositoryNames.current.get(id)
        return name === undefined ? [] : [{ id, name }]
      }),
    ],
  }
  const { repositories, knowledge } = scopeLabels(currentScope, labelsCatalog)
  const enabled = snapshot?.enabled === true
  const ready = snapshot?.serviceState === 'ready'
  return <><div className={css.strip} aria-label="知识检索范围">
    <button className={css.switch} type="button" role="switch" aria-label="启用知识查询" aria-checked={enabled} onClick={() => request(sessionId, currentScope, { enabled: !enabled })}><span className={css.switchTrack} aria-hidden><span /></span></button>
    <button className={css.trigger} type="button" disabled={!enabled || !ready} aria-label={repositories === undefined ? '选择代码库' : `选择代码库：${repositories}`} title={repositories} aria-expanded={panel === 'code'} onClick={() => setPanel(panel === 'code' ? null : 'code')}><span aria-hidden>⌘</span><span className={css.label}>{repositories ?? '选择代码库'}</span><span aria-hidden>⌃</span></button>
    <button className={css.trigger} type="button" disabled={!enabled || !ready} aria-label={`选择知识范围：${knowledge}`} title={knowledge} aria-expanded={panel === 'knowledge'} onClick={() => setPanel(panel === 'knowledge' ? null : 'knowledge')}><span aria-hidden>⌘</span><span className={css.label}>{knowledge}</span><span aria-hidden>⌃</span></button>
  </div>{snapshot?.serviceState !== 'ready' && <output className={css.notice}>{snapshot?.serviceState === 'unauthenticated' ? <>知识库登录已失效，请<button type="button" onClick={() => request(sessionId, undefined, { action: 'login' })}>重新登录</button></> : snapshot?.serviceState === 'unavailable' ? <>知识服务暂不可用，请<button type="button" onClick={() => request(sessionId, undefined, { action: 'retry' })}>重新检测</button></> : '正在连接知识服务…'}</output>}</>
}

/** Public overlay-slot picker. The extension remains authoritative after each request. */
export function KnowledgeScopePanel({ sessionId, useKnowledgeScope, useKnowledgeScopePanel, request, setPanel }: PanelProps) {
  const snapshot = useKnowledgeScope(value => value)
  const panel = useKnowledgeScopePanel(value => value)
  const id = String(sessionId)
  const currentScope = scoped(snapshot, id)
  const [draft, setDraft] = useState(currentScope)
  const scopeKey = `${currentScope.domainId}|${currentScope.systemIds.join(',')}|${currentScope.repositoryIds.join(',')}`
  useEffect(() => { setDraft(currentScope) }, [snapshot?.sessionId, scopeKey])
  if (panel === null) return null
  const catalog = snapshot?.catalog ?? { domains: [], systems: [], repositories: [] }
  const update = (next: Scope): void => { setDraft(next); request(id, next) }
  const code = panel === 'code'
  return <section className={css.panel} role="dialog" aria-label={code ? '代码库范围' : '知识范围'}>
    <header className={css.header}><strong>{code ? '选择代码库' : '知识范围'}</strong><button className={css.close} type="button" aria-label="关闭范围选择" onClick={() => setPanel(null)}>×</button></header>
    {code ? <div className={css.section}><p className={css.hint}>代码查询仅使用这里勾选的远程仓库。</p><div className={css.list}>{catalog.repositories.map(repository => <div className={css.row} key={repository.id}><input id={`scope-repository-${repository.id}`} type="checkbox" checked={draft.repositoryIds.includes(repository.id)} onChange={event => update({ ...draft, repositoryIds: toggle(draft.repositoryIds, repository.id, event.target.checked) })}/><label htmlFor={`scope-repository-${repository.id}`}>{repository.name}</label>{typeLabel(repository.type) !== undefined && <span className={css.type}>{typeLabel(repository.type)}</span>}</div>)}</div></div>
      : <><div className={css.section}><p className={css.hint}>选择一个领域，再勾选需要查询的知识库系统。</p><div className={css.list}>{catalog.domains.map(domain => <div className={css.row} key={domain.id}><input id={`scope-domain-${domain.id}`} type="radio" name="scope-domain" checked={draft.domainId === domain.id} onChange={() => update({ ...draft, domainId: domain.id, systemIds: [] })}/><label htmlFor={`scope-domain-${domain.id}`}>{domain.name}</label></div>)}</div></div><div className={css.section}><div className={css.sectionTitle}><strong>知识系统</strong><span>{draft.systemIds.length} 项已选</span></div><div className={css.list}>{catalog.systems.filter(system => system.domainId === undefined || system.domainId === draft.domainId).map(system => <div className={css.row} key={system.id}><input id={`scope-system-${system.id}`} type="checkbox" disabled={draft.domainId === ''} checked={draft.systemIds.includes(system.id)} onChange={event => update({ ...draft, systemIds: toggle(draft.systemIds, system.id, event.target.checked) })}/><label htmlFor={`scope-system-${system.id}`}>{system.name}</label></div>)}</div></div></>}
  </section>
}
