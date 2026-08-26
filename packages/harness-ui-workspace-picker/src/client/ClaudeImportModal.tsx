import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClaudeProject, ClaudeSession } from './claude-import-api.ts'
import { claudeImportRequest } from './claude-import-api.ts'
import css from './CompactWorkspacePicker.module.css'

export interface ClaudeImportController {
  importSession(input: { sourceRoot: string; projectKey: string; session: ClaudeSession; workspaceId: string; workspacePath: string; forceCopy?: boolean; signal?: AbortSignal; onCreating(): void }): Promise<'opened-existing' | 'existing-unavailable' | 'imported'>
}

export function ClaudeImportModal({ open, onClose, workspace, controller }: {
  open: boolean
  onClose: () => void
  workspace: { id: string; title: string; path: string } | undefined
  controller: ClaudeImportController | undefined
}) {
  const [projects, setProjects] = useState<ClaudeProject[]>([])
  const [projectKey, setProjectKey] = useState<string>()
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sourceRoot, setSourceRoot] = useState('default')
  const [sourceDraft, setSourceDraft] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState<'idle' | 'projects' | 'sessions' | 'preparing' | 'creating' | 'duplicate' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string>()
  const [duplicateUnavailable, setDuplicateUnavailable] = useState(false)
  const abortRef = useRef<AbortController>()
  const irreversibleRef = useRef(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const selected = sessions.find(session => session.sessionId === selectedSessionId)
  const visibleSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized === '' ? sessions : sessions.filter(session => session.title.toLowerCase().includes(normalized) || session.sessionId.toLowerCase().includes(normalized))
  }, [query, sessions])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController(); abortRef.current = abort; irreversibleRef.current = false
    setPhase('projects'); setError(undefined); setDuplicateUnavailable(false); setProjects([]); setSessions([]); setSessionsTotal(0); setProjectKey(undefined); setSelectedSessionId(undefined); setQuery(''); setSourceRoot('default'); setSourceDraft('')
    void claudeImportRequest<{ sourceRoot: string; projects: ClaudeProject[] }>({ action: 'projects', sourceRoot: 'default' }, abort.signal).then(result => {
      setSourceRoot(result.sourceRoot); setSourceDraft(result.sourceRoot); setProjects(result.projects); setPhase('idle')
      if (result.projects[0] !== undefined) selectProject(result.projects[0].key, result.sourceRoot)
    }).catch(reason => { if (!abort.signal.aborted) fail(reason) })
    return () => abort.abort()
  }, [open])

  const selectProject = (key: string, explicitRoot = sourceRoot) => {
    abortRef.current?.abort()
    const abort = new AbortController(); abortRef.current = abort
    setProjectKey(key); setSessions([]); setSessionsTotal(0); setSelectedSessionId(undefined); setPhase('sessions'); setError(undefined)
    void (async () => {
      let offset = 0
      let collected: ClaudeSession[] = []
      while (true) {
        const result = await claudeImportRequest<{ sourceRoot: string; sessions: ClaudeSession[]; total: number; nextOffset: number; done: boolean }>({
          action: 'sessions', sourceRoot: explicitRoot, projectKey: key, offset, limit: 64,
        }, abort.signal)
        collected = [...collected, ...result.sessions]
        setSourceRoot(result.sourceRoot); setSourceDraft(result.sourceRoot); setSessions(collected); setSessionsTotal(result.total)
        if (result.done) break
        offset = result.nextOffset
      }
      setSelectedSessionId(collected[0]?.sessionId); setPhase('idle')
    })().catch(reason => { if (!abort.signal.aborted) fail(reason) })
  }
  const loadSource = (requestedRoot: string) => {
    abortRef.current?.abort()
    const abort = new AbortController(); abortRef.current = abort
    setPhase('projects'); setError(undefined); setProjects([]); setSessions([]); setSessionsTotal(0); setProjectKey(undefined); setSelectedSessionId(undefined)
    void claudeImportRequest<{ sourceRoot: string; projects: ClaudeProject[] }>({ action: 'projects', sourceRoot: requestedRoot }, abort.signal).then(result => {
      setSourceRoot(result.sourceRoot); setSourceDraft(result.sourceRoot); setProjects(result.projects); setPhase('idle')
      if (result.projects[0] !== undefined) selectProject(result.projects[0].key, result.sourceRoot)
    }).catch(reason => { if (!abort.signal.aborted) fail(reason) })
  }
  const fail = (reason: unknown) => { setPhase('error'); setError(reason instanceof Error ? reason.message : String(reason)) }
  const runImport = (forceCopy = false) => {
    if (workspace === undefined || projectKey === undefined || selected === undefined) return
    if (controller === undefined) { fail('Claude Code 导入功能正在重新连接，请刷新侧边栏后重试'); return }
    const abort = new AbortController(); abortRef.current = abort; setPhase('preparing'); setError(undefined)
    void controller.importSession({ sourceRoot, projectKey, session: selected, workspaceId: workspace.id, workspacePath: workspace.path, forceCopy, signal: abort.signal, onCreating: () => { irreversibleRef.current = true; setPhase('creating') } }).then(result => {
      irreversibleRef.current = false
      if (result !== 'imported') { setDuplicateUnavailable(result === 'existing-unavailable'); setPhase('duplicate'); return }
      setPhase('done'); window.setTimeout(onClose, 500)
    }).catch(reason => { irreversibleRef.current = false; if (!abort.signal.aborted) fail(reason) })
  }
  const close = () => { if (irreversibleRef.current) return; abortRef.current?.abort(); onClose() }

  useEffect(() => {
    if (!open) return
    closeButton.current?.focus()
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('keydown', closeEscape) }
  }, [open, onClose])

  if (!open) return null
  return createPortal(<div className={css.importOverlay} role="presentation" data-testid="claude-import-overlay">
    <section className={css.importPanel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className={css.importHeader}>
        <div className={css.importTitleBlock}>
          <h2 id={titleId}>从 Claude Code 导入</h2>
          <span>选择一个历史会话，在当前 Harness 工作区继续</span>
        </div>
        <button ref={closeButton} type="button" className={css.importClose} aria-label="关闭" disabled={phase === 'creating'} onClick={close}><IconCloseOutline16 size={14} /></button>
      </header>
      <main className={css.importMain}>
        <div className={css.importTarget}>目标工作区：<strong>{workspace?.title ?? '未选择'}</strong><span>{workspace?.path}</span></div>
        <div className={css.importSource}>
          <input value={sourceDraft} onChange={event => setSourceDraft(event.target.value)} placeholder="Claude projects 绝对路径" aria-label="Claude projects 来源目录" disabled={phase === 'creating'} />
          <Button variant="outline" disabled={phase === 'creating' || sourceDraft.trim() === ''} onClick={() => loadSource(sourceDraft.trim())}>使用目录</Button>
          <Button variant="outline" disabled={phase === 'creating'} onClick={() => loadSource('default')}>恢复默认</Button>
        </div>
        <div className={css.importGrid}>
          <section className={css.importColumn} aria-label="Claude Code 项目">
            <div className={css.importHeading}>Claude Code 项目</div>
            <div className={css.importScroll}>
              {projects.map(project => <button key={project.key} type="button" className={classes(css.importRow, project.key === projectKey && css.importRowActive)} onClick={() => selectProject(project.key)}><span>{project.label}</span><small>{project.sessionCount}</small></button>)}
              {phase !== 'projects' && projects.length === 0 && <div className={css.empty}>未发现 Claude Code 项目</div>}
            </div>
          </section>
          <section className={css.importColumn} aria-label="Claude Code 会话">
            <div className={css.importSearchBar}><input className={css.importSearch} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索 Claude Code 会话" /></div>
            <div className={css.importSessionHeader} aria-hidden="true"><span>标题</span><span>日期</span></div>
            <div className={css.importScroll}>
              {visibleSessions.map(session => <button key={session.sessionId} type="button" className={classes(css.importRow, css.importSessionRow, session.sessionId === selectedSessionId && css.importRowActive)} onClick={() => setSelectedSessionId(session.sessionId)}><span>{session.title}</span><small>{formatSessionDate(session.updatedAt).map(part => <span key={part}>{part}</span>)}</small></button>)}
              {phase !== 'sessions' && sessions.length === 0 && projectKey !== undefined && <div className={css.empty}>此项目没有可导入会话</div>}
            </div>
          </section>
        </div>
        {phase === 'projects' && <div className={css.importStatus} role="status">正在读取 Claude 项目…</div>}
        {phase === 'sessions' && <div className={css.importStatus} role="status">
          <span>已读取 {sessions.length} / {sessionsTotal === 0 ? '…' : sessionsTotal}</span>
          {sessionsTotal > 0 && <progress className={css.importProgress} value={sessions.length} max={sessionsTotal} />}
        </div>}
        {phase === 'preparing' && <div className={css.importStatus} role="status" data-import-stage="prepare">1 / 3　读取并整理记录，可取消…</div>}
        {phase === 'creating' && <div className={css.importStatus} role="status" data-import-stage="create">2 / 3　创建会话并提交上下文，此阶段不能撤回…</div>}
        {phase === 'duplicate' && <div className={css.importStatus} role="status">{duplicateUnavailable ? '以前导入的会话已不可用，可以重新导入为副本。' : '该记录已经导入，已打开已有会话。也可以重新导入为副本。'}</div>}
        {phase === 'done' && <div className={css.importStatus} role="status" data-import-stage="done">3 / 3　导入完成，正在打开新会话…</div>}
        {phase === 'error' && <div className={css.renameError} role="alert">{error}</div>}
      </main>
      <footer className={css.importFooter}>
        <Button variant="outline" disabled={phase === 'creating'} onClick={close}>取消</Button>
        {phase === 'duplicate'
          ? <Button variant="primary" onClick={() => runImport(true)}>重新导入为副本</Button>
          : <Button variant="primary" disabled={controller === undefined || selected === undefined || workspace === undefined || phase === 'projects' || phase === 'sessions' || phase === 'preparing' || phase === 'creating'} onClick={() => runImport(false)}>导入并继续</Button>}
      </footer>
    </section>
  </div>, document.body)
}

function classes(...values: Array<string | false | null | undefined>): string { return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ') }

function formatSessionDate(value: string): [string, string] {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return [value, '']
  return [
    `${String(date.getFullYear()).padStart(4, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`,
  ]
}
