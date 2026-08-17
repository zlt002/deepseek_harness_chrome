import { useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './bridge.ts'
import { scopeLabels } from './labels.js'
import css from './KnowledgeScope.module.css'

export interface KnowledgeScopeInjected {
  hooks: { knowledgeScope: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<ScopeSnapshot | undefined> }
  request: (sessionId: string, scope?: Scope, options?: ScopeOptions) => void
}

type StripProps = PropsRuntime<'conversation.composer.above'> & InjectFace<KnowledgeScopeInjected>
type PanelProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<KnowledgeScopeInjected>
const emptyCatalog: Catalog = { domains: [], systems: [], repositories: [] }
const emptyScope = (): Scope => ({ domainId: '', systemIds: [], repositoryIds: [] })
const scoped = (snapshot: ScopeSnapshot | undefined, sessionId: string): Scope => snapshot?.sessionId === sessionId ? snapshot.scope ?? emptyScope() : emptyScope()
const toggle = (ids: readonly string[], id: string, enabled: boolean): string[] => enabled ? [...new Set([...ids, id])] : ids.filter(item => item !== id)
const typeLabel = (type: string | undefined): string | undefined => type === 'frontend' ? '前端' : type === 'backend' ? '后端' : type

interface RepositoryGroup { domainId: string; domainName: string; systems: Array<{ id: string; name: string; repositories: Catalog['repositories'] }> }

function repositoryGroups(catalog: Catalog): RepositoryGroup[] {
  const domainNames = new Map(catalog.domains.map(domain => [domain.id, domain.name]))
  const systemNames = new Map(catalog.systems.map(system => [system.id, system.name]))
  const domains = new Map<string, Map<string, Catalog['repositories']>>()
  for (const repository of catalog.repositories) {
    const domainId = repository.domainId ?? 'unassigned'
    const systemId = repository.systemId ?? 'unassigned'
    const systems = domains.get(domainId) ?? new Map<string, Catalog['repositories']>()
    systems.set(systemId, [...(systems.get(systemId) ?? []), repository])
    domains.set(domainId, systems)
  }
  return [...domains].map(([domainId, systems]) => ({
    domainId,
    domainName: domainNames.get(domainId) ?? (domainId === 'unassigned' ? '未分组领域' : domainId),
    systems: [...systems].map(([id, repositories]) => ({ id, name: systemNames.get(id) ?? (id === 'unassigned' ? '未分组系统' : id), repositories })),
  }))
}

/** Selected-source strip. The two scope cells always receive equal remaining width. */
export function KnowledgeScopeStrip({ session, useKnowledgeScope, request }: StripProps) {
  const snapshot = useKnowledgeScope(value => value)
  const knowledgeOverlay = useComposerOverlay('knowledge-scope')
  const repositoryOverlay = useComposerOverlay('repository-scope')
  const sessionId = String(session.sessionId)
  useEffect(() => { request(sessionId) }, [request, sessionId])
  const catalog = snapshot?.catalog ?? emptyCatalog
  const currentScope = scoped(snapshot, sessionId)
  const repositoryNames = useRef(new Map<string, string>())
  for (const repository of catalog.repositories) {
    if (currentScope.repositoryIds.includes(repository.id)) repositoryNames.current.set(repository.id, repository.name)
  }
  const labelsCatalog = {
    ...catalog,
    repositories: [
      ...catalog.repositories,
      ...currentScope.repositoryIds.flatMap((id) => {
        if (catalog.repositories.some(repository => repository.id === id)) return []
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
    <button className={css.trigger} type="button" disabled={!enabled || !ready} aria-label={repositories === undefined ? '选择代码库' : `选择代码库：${repositories}`} title={repositories} aria-expanded={repositoryOverlay.open} data-composer-overlay-trigger onMouseDown={event => event.preventDefault()} onClick={repositoryOverlay.toggle}><span className={css.triggerIcon} aria-hidden>⌘</span><span className={css.label}>{repositories ?? '选择代码库'}</span><span className={css.triggerIcon} aria-hidden>⌃</span></button>
    <button className={css.trigger} type="button" disabled={!enabled || !ready} aria-label={`选择知识范围：${knowledge}`} title={knowledge} aria-expanded={knowledgeOverlay.open} data-composer-overlay-trigger onMouseDown={event => event.preventDefault()} onClick={knowledgeOverlay.toggle}><span className={css.triggerIcon} aria-hidden>⌘</span><span className={css.label}>{knowledge}</span><span className={css.triggerIcon} aria-hidden>⌃</span></button>
  </div>{snapshot?.serviceState !== 'ready' && <output className={css.notice}>{snapshot?.serviceState === 'unauthenticated' ? <>知识库登录已失效，请<button type="button" onClick={() => request(sessionId, undefined, { action: 'login' })}>重新登录</button></> : snapshot?.serviceState === 'unavailable' ? <>知识服务暂不可用，请<button type="button" onClick={() => request(sessionId, undefined, { action: 'retry' })}>重新检测</button></> : '正在连接知识服务…'}</output>}</>
}

function KnowledgeScopePanelBody({ sessionId, useKnowledgeScope, request, section, close }: PanelProps & { section: 'knowledge' | 'repositories'; close: () => void }) {
  const snapshot = useKnowledgeScope(value => value)
  const id = String(sessionId)
  const catalog = snapshot?.catalog ?? emptyCatalog
  const currentScope = scoped(snapshot, id)
  const [draft, setDraft] = useState(currentScope)
  const scopeKey = `${currentScope.domainId}|${currentScope.systemIds.join(',')}|${currentScope.repositoryIds.join(',')}`
  useEffect(() => { setDraft(currentScope) }, [snapshot?.sessionId, scopeKey])
  const update = (next: Scope): void => { setDraft(next); request(id, next) }
  const [expandedSystems, setExpandedSystems] = useState<Set<string>>(() => new Set())
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set())
  const groups = useMemo(() => repositoryGroups(catalog), [catalog])
  const knowledge = section === 'knowledge'
  return <section className={css.panel} role="dialog" aria-label={knowledge ? '知识范围' : '代码库范围'}>
    <header className={css.panelHeader}><strong>{knowledge ? '知识范围' : '选择代码库'}</strong><span>{knowledge ? `${draft.systemIds.length} 项已选` : `${draft.repositoryIds.length} 个已选`}</span><button className={css.close} type="button" aria-label="关闭范围选择" onClick={close}>×</button></header>
    {knowledge ? <div className={css.section} aria-label="知识库范围"><p className={css.sectionHint}>选择一个领域，再勾选需要查询的知识库系统。</p><div className={css.tree}>{catalog.domains.map(domain => {
      const expanded = expandedDomains.has(domain.id)
      const selected = draft.domainId === domain.id
      const systems = catalog.systems.filter(system => system.domainId === undefined || system.domainId === domain.id)
      return <div key={domain.id} className={css.systemGroup}><div className={css.systemRow}><input aria-label={domain.name} type="radio" name="knowledge-domain" checked={selected} onChange={() => update({ domainId: domain.id, systemIds: [], repositoryIds: draft.repositoryIds })}/><button type="button" className={css.expand} aria-label={`${expanded ? '收起' : '展开'}${domain.name}`} onClick={() => setExpandedDomains(current => { const next = new Set(current); if (next.has(domain.id)) next.delete(domain.id); else next.add(domain.id); return next })}><span className={css.expandIcon} aria-hidden>{expanded ? '⌄' : '›'}</span></button><span>{domain.name}</span><span className={css.count}>({systems.length})</span></div>{expanded && <div className={css.repositoryList}>{systems.map(system => <label key={system.id} className={css.option}><input aria-label={system.name} type="checkbox" disabled={!selected} checked={selected && draft.systemIds.includes(system.id)} onChange={event => update({ ...draft, systemIds: toggle(draft.systemIds, system.id, event.target.checked) })}/><span>{system.name}</span></label>)}</div>}</div>
    })}</div></div> : <div className={css.section} aria-label="代码库范围"><p className={css.sectionHint}>可多选；代码查询仅使用这里勾选的远程仓库。</p><div className={css.tree}>{groups.map(domain => <div key={domain.domainId} className={css.domainGroup}><div className={css.domainTitle}>{domain.domainName}</div>{domain.systems.map(system => {
      const key = `${domain.domainId}:${system.id}`
      const expanded = expandedSystems.has(key)
      const repositoryIds = system.repositories.map(repository => repository.id)
      const selected = repositoryIds.filter(repositoryId => draft.repositoryIds.includes(repositoryId)).length
      return <div key={key} className={css.systemGroup}><div className={css.systemRow}><input aria-label={`${system.name}全部代码库`} type="checkbox" checked={repositoryIds.length > 0 && selected === repositoryIds.length} onChange={event => update({ ...draft, repositoryIds: event.target.checked ? [...new Set([...draft.repositoryIds, ...repositoryIds])] : draft.repositoryIds.filter(repositoryId => !repositoryIds.includes(repositoryId)) })}/><button type="button" className={css.expand} aria-label={`${expanded ? '收起' : '展开'}${system.name}`} onClick={() => setExpandedSystems(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}><span className={css.expandIcon} aria-hidden>{expanded ? '⌄' : '›'}</span></button><span>{system.name}</span><span className={css.count}>({repositoryIds.length})</span></div>{expanded && <div className={css.repositoryList}>{system.repositories.map(repository => <label key={repository.id} className={css.option}><input aria-label={repository.name} type="checkbox" checked={draft.repositoryIds.includes(repository.id)} onChange={event => update({ ...draft, repositoryIds: toggle(draft.repositoryIds, repository.id, event.target.checked) })}/><span className={css.repositoryName}>{repository.name}</span>{typeLabel(repository.type) !== undefined && <span className={css.repositoryType}>{typeLabel(repository.type)}</span>}</label>)}</div>}</div>
    })}</div>)}</div></div>}
  </section>
}

/** Register both pickers in the shared surface so transcript scrolling cannot clip them. */
export function KnowledgeScopePanel(props: PanelProps) {
  const closeKnowledge = useRef<() => void>(() => {})
  const closeRepositories = useRef<() => void>(() => {})
  const knowledge = useComposerOverlay('knowledge-scope', <KnowledgeScopePanelBody {...props} section="knowledge" close={() => closeKnowledge.current()} />)
  const repositories = useComposerOverlay('repository-scope', <KnowledgeScopePanelBody {...props} section="repositories" close={() => closeRepositories.current()} />)
  closeKnowledge.current = knowledge.close
  closeRepositories.current = repositories.close
  if (knowledge.available || repositories.available) return null
  return knowledge.open ? <KnowledgeScopePanelBody {...props} section="knowledge" close={knowledge.close} /> : repositories.open ? <KnowledgeScopePanelBody {...props} section="repositories" close={repositories.close} /> : null
}
