import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronRightOutline14, IconFolderClose16, IconFolderOpenOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceTreeEntry } from '../protocol.ts'
import { listWorkspaceMarkdown, openWorkspaceMarkdown } from './api.ts'
import { requestOpenReview, type WorkspaceReviewBridgeConfig } from './bridge.ts'
import { WorkspaceTreeRequestGeneration } from './tree-request-generation.ts'
import css from './WorkspaceReviewAction.module.css'

interface TreeState { readonly loading: boolean; readonly entries: readonly WorkspaceTreeEntry[]; readonly error?: string }

export interface WorkspaceReviewTreeProps {
  readonly sessionId: string | undefined
  readonly bridge: WorkspaceReviewBridgeConfig | undefined
  readonly onClose: () => void
}

/** Read-only, lazily loaded Markdown tree. A generation makes an old workspace response inert. */
export function WorkspaceReviewTree({ sessionId, bridge, onClose }: WorkspaceReviewTreeProps) {
  const generation = useRef(new WorkspaceTreeRequestGeneration())
  const inFlight = useRef(new Set<string>())
  const [trees, setTrees] = useState<ReadonlyMap<string, TreeState>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>()

  const load = async (path: string, requestedSession = sessionId, requestedGeneration = generation.current.value): Promise<void> => {
    if (requestedSession === undefined) return
    const requestKey = `${String(requestedGeneration)}:${path}`
    if (inFlight.current.has(requestKey)) return
    inFlight.current.add(requestKey)
    setTrees(current => new Map(current).set(path, { loading: true, entries: current.get(path)?.entries ?? [] }))
    try {
      const listing = await listWorkspaceMarkdown(requestedSession, path === '' ? undefined : path)
      if (!generation.current.isCurrent(requestedGeneration)) return
      setTrees(current => new Map(current).set(path, { loading: false, entries: listing.entries }))
    } catch (reason) {
      if (!generation.current.isCurrent(requestedGeneration)) return
      setTrees(current => new Map(current).set(path, {
        loading: false, entries: [], error: reason instanceof Error ? reason.message : String(reason),
      }))
    } finally {
      if (generation.current.isCurrent(requestedGeneration)) inFlight.current.delete(requestKey)
    }
  }

  useEffect(() => {
    const nextGeneration = generation.current.reset()
    inFlight.current.clear()
    setTrees(new Map())
    setExpanded(new Set())
    setError(undefined)
    if (sessionId !== undefined) void load('', sessionId, nextGeneration)
    return () => {
      if (!generation.current.isCurrent(nextGeneration)) return
      generation.current.reset()
      inFlight.current.clear()
    }
  }, [sessionId])

  const toggle = (path: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!trees.has(path)) void load(path)
      }
      return next
    })
  }
  const refresh = () => {
    const nextGeneration = generation.current.reset()
    inFlight.current.clear()
    setTrees(new Map())
    setExpanded(new Set())
    setError(undefined)
    if (sessionId !== undefined) void load('', sessionId, nextGeneration)
  }
  const openMarkdown = async (path: string) => {
    if (sessionId === undefined) return
    if (bridge === undefined) { setError('审阅 Tab bridge 尚未连接；请从已配置的 Harness Side Panel 重试。'); return }
    const requestedSession = sessionId
    const requestedGeneration = generation.current.value
    try {
      const review = await openWorkspaceMarkdown(requestedSession, path)
      if (!generation.current.isCurrent(requestedGeneration)) return
      requestOpenReview(window.parent, bridge, review)
      onClose()
    } catch (reason) {
      if (!generation.current.isCurrent(requestedGeneration)) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const render = (path: string): ReactNode => {
    const state = trees.get(path)
    if (state === undefined || state.loading) return <p className={css.status}>正在读取…</p>
    if (state.error !== undefined) return <p className={css.status}>{state.error}</p>
    if (state.entries.length === 0 && path === '') return <p className={css.status}>此工作区没有可审阅的 Markdown 文件。</p>
    return <div className={path === '' ? undefined : css.nested}>{state.entries.map(entry => entry.kind === 'directory'
      ? <div key={entry.displayPath}><button className={css.entry} type="button" onClick={() => toggle(entry.displayPath)}><IconChevronRightOutline14 className={expanded.has(entry.displayPath) ? css.chevronExpanded : undefined} />{expanded.has(entry.displayPath) ? <IconFolderOpenOutline16 /> : <IconFolderClose16 />}{entry.name}</button>{expanded.has(entry.displayPath) ? render(entry.displayPath) : null}</div>
      : <button key={entry.displayPath} className={css.entry} type="button" onClick={() => { void openMarkdown(entry.displayPath) }}><span className={css.markdownMark}>MD</span>{entry.name}</button>,
    )}</div>
  }
  if (sessionId === undefined) return <p className={css.status}>正在等待工作区目录就绪…</p>
  return <div className={css.tree} aria-label="工作区 Markdown 文件">
    <div className={css.treeToolbar}><span>Markdown 文件</span><button type="button" aria-label="刷新文件树" title="刷新文件树" onClick={refresh}><IconRefreshOutline16 size={15} /></button></div>
    {render('')}
    {error === undefined ? null : <p className={css.status}>{error}</p>}
  </div>
}
