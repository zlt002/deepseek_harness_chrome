import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { Catalog, Scope, ScopeOptions, ScopeSnapshot } from './bridge.ts'
import css from './KnowledgeScope.module.css'

export interface KnowledgeScopeInjected { hooks: { knowledgeScope: SnapshotStore<ScopeSnapshot | undefined> }; request: (sessionId: string, scope?: Scope, options?: ScopeOptions) => void }
type StripProps = PropsRuntime<'conversation.composer.above'> & InjectFace<KnowledgeScopeInjected>
type PanelProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<KnowledgeScopeInjected>
const emptyCatalog: Catalog = { domains: [], systems: [], repositories: [] }
const scopeFor = (snapshot: ScopeSnapshot | undefined, sessionId: string) => snapshot?.sessionId === sessionId ? snapshot.scope : undefined
const toggle = (values: readonly string[], id: string, checked: boolean) => checked ? [...new Set([...values, id])] : values.filter(value => value !== id)

/** Preserve all chosen source names; the trigger truncates visually only when needed. */
function selectedSourceLabel(ids: readonly string[], entries: ReadonlyArray<{ id: string; name: string }>): string | undefined {
  const names = ids.flatMap(id => {
    const name = entries.find(entry => entry.id === id)?.name
    return name === undefined ? [] : [name]
  })
  if (names.length === 0) return undefined
  return names.join('、')
}

interface RepositoryGroup { domainId: string; domainName: string; systems: Array<{ id: string; name: string; repositories: Catalog['repositories'] }> }

function repositoryGroups(catalog: Catalog): RepositoryGroup[] {
  const domainNames = new Map(catalog.domains.map(domain => [domain.id, domain.name]))
  const systemNames = new Map(catalog.systems.map(system => [system.id, system.name]))
  const domains = new Map<string, Map<string, Catalog['repositories']>>()
  for (const repository of catalog.repositories) {
    const domainId = repository.domainId ?? 'unassigned'
    const systemId = repository.systemId ?? 'unassigned'
    const systems = domains.get(domainId) ?? new Map<string, Catalog['repositories']>()
    const entries = systems.get(systemId) ?? []
    entries.push(repository)
    systems.set(systemId, entries)
    domains.set(domainId, systems)
  }
  return [...domains].map(([domainId, systems]) => ({
    domainId,
    domainName: domainNames.get(domainId) ?? (domainId === 'unassigned' ? '未分组领域' : domainId),
    systems: [...systems].map(([id, repositories]) => ({ id, name: systemNames.get(id) ?? (id === 'unassigned' ? '未分组系统' : id), repositories })),
  }))
}

function typeLabel(type: string | undefined): string | undefined {
  if (type === 'frontend') return '前端'
  if (type === 'backend') return '后端'
  return type
}

/** Compact, always-visible scope summary in the card-external composer bar. */
export function KnowledgeScopeStrip({ session, useKnowledgeScope, request }: StripProps) {
  const [rememberOpen, setRememberOpen] = useState(false)
  const snapshot = useKnowledgeScope(value => value)
  const knowledgeOverlay = useComposerOverlay('knowledge-scope')
  const repositoryOverlay = useComposerOverlay('repository-scope')
  const sessionId = String(session.sessionId)
  useEffect(() => { request(sessionId) }, [request, sessionId])
  const catalog = snapshot?.catalog ?? emptyCatalog
  const scope = scopeFor(snapshot, sessionId)
  const enabled = snapshot?.enabled === true
  const serviceState = snapshot?.serviceState ?? 'checking'
  const ready = serviceState === 'ready'
  const selectedRepositories = selectedSourceLabel(scope?.repositoryIds ?? [], catalog.repositories)
  const knowledge = selectedSourceLabel(scope?.systemIds ?? [], catalog.systems)
    ?? catalog.domains.find(item => item.id === scope?.domainId)?.name
  return <><div className={css.strip} aria-label="知识检索范围">
    <span className={css.switchWrap} onMouseEnter={() => setRememberOpen(true)} onMouseLeave={() => setRememberOpen(false)}>
    <button className={css.repositoryToggle} type="button" role="switch" aria-label="启用知识查询" aria-checked={enabled} onFocus={() => setRememberOpen(true)} onClick={() => {
      request(sessionId, scope ?? { domainId: '', systemIds: [], repositoryIds: [] }, { enabled: !enabled })
    }}>
      <span aria-hidden className={css.switchTrack}><span /></span><span className={css.srOnly}>启用知识查询</span>
    </button>{rememberOpen && <label className={css.remember}><input aria-label="记住知识库开关状态" type="checkbox" checked={snapshot?.remember === true} onChange={(event) => request(sessionId, scope, { remember: event.target.checked })}/>是否记住</label>}</span>
    <button className={css.scopeTrigger} type="button" disabled={!enabled || !ready} aria-label={selectedRepositories === undefined ? '选择代码库' : `选择代码库：${selectedRepositories}`} title={selectedRepositories} aria-expanded={repositoryOverlay.open} data-composer-overlay-trigger onMouseDown={(event) => event.preventDefault()} onClick={repositoryOverlay.toggle}>
      <span aria-hidden>⌘</span><span className={css.scopeLabel}>{selectedRepositories ?? '选择代码库'}</span><span aria-hidden>⌃</span>
    </button>
    <button className={css.scopeTrigger} type="button" disabled={!enabled || !ready} aria-label={knowledge === undefined ? '选择知识范围' : `选择知识范围：${knowledge}`} title={knowledge} aria-expanded={knowledgeOverlay.open} data-composer-overlay-trigger onMouseDown={(event) => event.preventDefault()} onClick={knowledgeOverlay.toggle}>
      <span aria-hidden>⌘</span><span className={css.scopeLabel}>{knowledge ?? '选择知识范围'}</span><span aria-hidden>⌃</span>
    </button>
  </div>{serviceState !== 'ready' && <output className={css.notice}>{serviceState === 'checking'
    ? '正在连接知识服务…'
    : serviceState === 'unauthenticated'
      ? <>知识库登录已失效，请<button className={css.login} type="button" onClick={() => request(sessionId, undefined, { action: 'login' })}>重新登录</button></>
      : <>知识服务暂不可用，请<button className={css.login} type="button" onClick={() => request(sessionId, undefined, { action: 'login' })}>登录知识库</button><button className={css.login} type="button" onClick={() => request(sessionId, undefined, { action: 'retry' })}>重新检测</button></>}</output>}</>
}

function KnowledgeScopePanelBody({ sessionId, useKnowledgeScope, request, section }: PanelProps & { section: 'knowledge' | 'repositories' }) {
  const snapshot = useKnowledgeScope(value => value)
  const id = String(sessionId)
  const catalog = snapshot?.catalog ?? emptyCatalog
  const scope = scopeFor(snapshot, id) ?? { domainId: '', systemIds: [], repositoryIds: [] }
  // Keep the chooser responsive while the extension snapshot makes its round trip.
  // The snapshot remains authoritative and resynchronizes this draft when it changes.
  const [draftScope, setDraftScope] = useState<Scope>(scope)
  const snapshotScopeKey = `${scope.domainId}|${scope.systemIds.join(',')}|${scope.repositoryIds.join(',')}`
  useEffect(() => { setDraftScope(scope) }, [snapshot?.sessionId, snapshotScopeKey])
  const update = (next: Scope) => { setDraftScope(next); request(id, next) }
  const [expandedSystems, setExpandedSystems] = useState<Set<string>>(() => new Set())
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set())
  const groups = useMemo(() => repositoryGroups(catalog), [catalog])
  return <div className={css.panel} role="dialog" aria-label={section === 'knowledge' ? '知识范围' : '代码库范围'}>
    <div className={css.panelHeader}><strong>{section === 'knowledge' ? '知识范围' : '选择代码库'}</strong><span>{section === 'knowledge' ? `${draftScope.systemIds.length} 项已选` : `${draftScope.repositoryIds.length} 个已选`}</span></div>
    {section === 'knowledge' ? <div className={css.section} aria-label="知识库范围">
      <p className={css.sectionHint}>选择一个领域，再勾选需要查询的知识库系统。</p>
      <div className={css.tree}>{catalog.domains.map(domain => {
        const expanded = expandedDomains.has(domain.id)
        const selected = draftScope.domainId === domain.id
        const systems = catalog.systems.filter(system => system.domainId === undefined || system.domainId === domain.id)
        return <div key={domain.id} className={css.systemGroup}>
          <div className={css.systemRow}>
            <input aria-label={domain.name} type="radio" name="knowledge-domain" checked={selected} onChange={() => update({ domainId: domain.id, systemIds: [], repositoryIds: draftScope.repositoryIds })}/>
            <button type="button" className={css.expand} aria-label={`${expanded ? '收起' : '展开'}${domain.name}`} onClick={() => setExpandedDomains(current => { const next = new Set(current); if (next.has(domain.id)) next.delete(domain.id); else next.add(domain.id); return next })}><span className={css.expandIcon} aria-hidden>{expanded ? '⌄' : '›'}</span></button>
            <span>{domain.name}</span><span className={css.count}>({systems.length})</span>
          </div>
          {expanded && <div className={css.repositoryList}>{systems.map(system => <label key={system.id} className={css.option}><input aria-label={system.name} type="checkbox" disabled={!selected} checked={selected && draftScope.systemIds.includes(system.id)} onChange={(event) => update({ ...draftScope, systemIds: toggle(draftScope.systemIds, system.id, event.target.checked) })}/><span>{system.name}</span></label>)}</div>}
        </div>
      })}</div>
    </div> : <div className={css.section} aria-label="代码库范围">
      <p className={css.sectionHint}>可多选；代码查询仅使用这里勾选的远程仓库。</p>
      <div className={css.tree}>{groups.map(domain => <div key={domain.domainId} className={css.domainGroup}>
        <div className={css.domainTitle}>{domain.domainName}</div>
        {domain.systems.map(system => {
          const key = `${domain.domainId}:${system.id}`
          const expanded = expandedSystems.has(key)
          const repositoryIds = system.repositories.map(repository => repository.id)
          const selected = repositoryIds.filter(repositoryId => draftScope.repositoryIds.includes(repositoryId)).length
          return <div key={key} className={css.systemGroup}>
            <div className={css.systemRow}>
              <input aria-label={`${system.name}全部代码库`} type="checkbox" checked={repositoryIds.length > 0 && selected === repositoryIds.length} onChange={(event) => update({ ...draftScope, repositoryIds: event.target.checked ? [...new Set([...draftScope.repositoryIds, ...repositoryIds])] : draftScope.repositoryIds.filter(repositoryId => !repositoryIds.includes(repositoryId)) })}/>
              <button type="button" className={css.expand} aria-label={`${expanded ? '收起' : '展开'}${system.name}`} onClick={() => setExpandedSystems(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}><span className={css.expandIcon} aria-hidden>{expanded ? '⌄' : '›'}</span></button>
              <span>{system.name}</span><span className={css.count}>({repositoryIds.length})</span>
            </div>
            {expanded && <div className={css.repositoryList}>{system.repositories.map(repository => <label key={repository.id} className={css.option}><input aria-label={repository.name} type="checkbox" checked={draftScope.repositoryIds.includes(repository.id)} onChange={(event) => update({ ...draftScope, repositoryIds: toggle(draftScope.repositoryIds, repository.id, event.target.checked) })}/><span className={css.repositoryName}>{repository.name}</span>{typeLabel(repository.type) !== undefined && <span className={css.repositoryType}>{typeLabel(repository.type)}</span>}</label>)}</div>}
          </div>
        })}
      </div>)}</div>
    </div>}
  </div>
}

/** Registers the chooser with InputBar's shared upward overlay surface. */
export function KnowledgeScopePanel(props: PanelProps) {
  const knowledge = useComposerOverlay('knowledge-scope', <KnowledgeScopePanelBody {...props} section="knowledge" />)
  const repositories = useComposerOverlay('repository-scope', <KnowledgeScopePanelBody {...props} section="repositories" />)
  if (knowledge.available || repositories.available) return null
  return knowledge.open ? <KnowledgeScopePanelBody {...props} section="knowledge" /> : repositories.open ? <KnowledgeScopePanelBody {...props} section="repositories" /> : null
}
