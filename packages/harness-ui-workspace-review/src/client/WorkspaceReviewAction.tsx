import { useEffect, useRef, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceTreeEntry } from '../protocol.ts'
import { listWorkspaceMarkdown, openWorkspaceMarkdown } from './api.ts'
import { requestOpenReview, type WorkspaceReviewBridgeConfig } from './bridge.ts'
import css from './WorkspaceReviewAction.module.css'

export interface WorkspaceReviewActionInjected {
  readonly bridge: WorkspaceReviewBridgeConfig | undefined
  readonly hooks: { open: SnapshotStore<boolean> }
  readonly close: () => void
}

type Props = PropsRuntime<'sidebar.compact.action'> & InjectFace<WorkspaceReviewActionInjected>

interface TreeState { readonly loading: boolean; readonly entries: readonly WorkspaceTreeEntry[]; readonly error?: string }

/** Narrow overlay drawer: directories load only when the user expands them. */
export function WorkspaceReviewAction({ useSessions, bridge, close, useOpen }: Props) {
  const sessionId = useSessions(state => state.current)
  const sessionRef = useRef(sessionId); sessionRef.current = sessionId
  const open = useOpen(state => state)
  const [trees, setTrees] = useState<ReadonlyMap<string, TreeState>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set()); const [error, setError] = useState<string | undefined>()
  useEffect(() => { setTrees(new Map()); setExpanded(new Set()); setError(undefined); close() }, [close, sessionId])
  useEffect(() => { if (!open || sessionId === undefined || trees.has('')) return; void load('') }, [open, sessionId])
  const load = async (path: string) => {
    if (sessionId === undefined) return
    const requestedSession = sessionId
    setTrees(current => new Map(current).set(path, { loading: true, entries: current.get(path)?.entries ?? [] }))
    try {
      const listing = await listWorkspaceMarkdown(String(sessionId), path === '' ? undefined : path)
      if (sessionRef.current !== requestedSession) return
      setTrees(current => new Map(current).set(path, { loading: false, entries: listing.entries }))
    } catch (reason) {
      if (sessionRef.current !== requestedSession) return
      setTrees(current => new Map(current).set(path, { loading: false, entries: [], error: reason instanceof Error ? reason.message : String(reason) }))
    }
  }
  const toggle = (path: string) => {
    setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else { next.add(path); if (!trees.has(path)) void load(path) }; return next })
  }
  const refresh = () => {
    setTrees(new Map()); setExpanded(new Set()); setError(undefined); void load('')
  }
  const openMarkdown = async (path: string) => {
    if (sessionId === undefined) return
    if (bridge === undefined) { setError('审阅 Tab bridge 尚未连接；请从已配置的 Harness Side Panel 重试。'); return }
    try {
      const review = await openWorkspaceMarkdown(String(sessionId), path)
      requestOpenReview(window.parent, bridge, review)
      close()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const render = (path: string): React.ReactNode => {
    const state = trees.get(path)
    if (state === undefined || state.loading) return <p className={css.status}>正在读取…</p>
    if (state.error !== undefined) return <p className={css.status}>{state.error}</p>
    return <div className={path === '' ? undefined : css.nested}>{state.entries.map(entry => entry.kind === 'directory'
      ? <div key={entry.displayPath}><button className={css.entry} type="button" onClick={() => toggle(entry.displayPath)}>{expanded.has(entry.displayPath) ? '▾' : '▸'} 📁 {entry.name}</button>{expanded.has(entry.displayPath) ? render(entry.displayPath) : null}</div>
      : <button key={entry.displayPath} className={css.entry} type="button" onClick={() => { void openMarkdown(entry.displayPath) }}>📝 {entry.name}</button>,
    )}</div>
  }
  return <div className={css.root}>
    {open ? <aside className={css.drawer} aria-label="工作区 Markdown 文件">
      <header className={css.header}><strong>Markdown 文件</strong><span className={css.headerActions}><button type="button" aria-label="刷新文件树" title="刷新文件树" onClick={refresh}>↻</button><button type="button" aria-label="关闭文件树" title="关闭文件树" onClick={close}>×</button></span></header>
      {sessionId === undefined ? <p className={css.status}>请先打开一个 Harness 会话。</p> : <div className={css.tree}>{render('')}</div>}
      {error === undefined ? null : <p className={css.status}>{error}</p>}
    </aside> : null}
  </div>
}
