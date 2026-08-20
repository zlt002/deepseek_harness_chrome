import '@vitejs/plugin-react/preamble'
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import {
  MARKDOWN_REVIEW_PORT,
  MARKDOWN_REVIEW_PROTOCOL_VERSION,
  isMarkdownReviewId,
  isMarkdownReviewPortResponse,
  selectionAnchorFor,
  type MarkdownReviewAnnotation,
  type MarkdownReviewPortRequest,
  type MarkdownReviewPortResponse,
  type MarkdownReviewSnapshot,
} from './protocol'
import { reduceReviewState, type ReviewState } from './review-state'
import { MermaidDiagram } from './mermaid-diagram'
import { previewSelectionToSourceRange } from './preview-selection'
import { SourceEditor } from './source-editor'
import './style.css'

type LocalAnnotation = MarkdownReviewAnnotation & { delivered: boolean; lastError?: string }
type PendingRequest = { kind: 'snapshot' } | { kind: 'deliver'; annotationId: string }

const initialState: ReviewState = { status: 'initializing' }

function requestId(): string { return crypto.randomUUID() }

function reviewIdFromLocation(location: Pick<Location, 'search'> = window.location): string | undefined {
  const reviewId = new URLSearchParams(location.search).get('reviewId')
  return isMarkdownReviewId(reviewId) ? reviewId : undefined
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch { return undefined }
}

type PositionedNode = { position?: { start?: { offset?: number }; end?: { offset?: number } } }

function sourcePositionAttributes(node: PositionedNode | undefined): Record<string, string> {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return typeof start === 'number' && typeof end === 'number' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
    ? { 'data-source-start': String(start), 'data-source-end': String(end) }
    : {}
}

/** Raw HTML is never enabled; the sanitize pass is a defense-in-depth guard. */
function SafeMarkdownPreview({ content, onSelectionChange, previewRef }: { content: string; onSelectionChange: () => void; previewRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  return <div ref={previewRef} className="preview" aria-label="安全 Markdown 预览" onMouseUp={onSelectionChange} onKeyUp={onSelectionChange}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ node, href, children, ...props }) => {
          const url = typeof href === 'string' ? safeExternalUrl(href) : undefined
          const source = sourcePositionAttributes(node as PositionedNode)
          return url === undefined
            ? <span {...source}>{children}</span>
            : <a {...props} {...source} href={url} target="_blank" rel="noopener noreferrer">{children}</a>
        },
        code: ({ node, className, children, ...props }) => {
          const source = String(children).replace(/\n$/, '')
          if (className?.split(/\s+/).includes('language-mermaid')) return <MermaidDiagram source={source} />
          return <code {...props} {...sourcePositionAttributes(node as PositionedNode)} className={className}>{children}</code>
        },
        h1: ({ node, ...props }) => <h1 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        h2: ({ node, ...props }) => <h2 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        h3: ({ node, ...props }) => <h3 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        h4: ({ node, ...props }) => <h4 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        h5: ({ node, ...props }) => <h5 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        h6: ({ node, ...props }) => <h6 {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        p: ({ node, ...props }) => <p {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        li: ({ node, ...props }) => <li {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        blockquote: ({ node, ...props }) => <blockquote {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        pre: ({ node, ...props }) => <pre {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        table: ({ node, ...props }) => <table {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        thead: ({ node, ...props }) => <thead {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        tbody: ({ node, ...props }) => <tbody {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        tr: ({ node, ...props }) => <tr {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        th: ({ node, ...props }) => <th {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
        td: ({ node, ...props }) => <td {...props} {...sourcePositionAttributes(node as PositionedNode)} />,
      }}
    >{content}</ReactMarkdown>
  </div>
}

function App(): React.JSX.Element {
  const reviewId = useMemo(() => reviewIdFromLocation(), [])
  const [state, dispatch] = useReducer(reduceReviewState, initialState)
  const [draft, setDraft] = useState('')
  const [selection, setSelection] = useState<{ start: number; end: number }>()
  const [previewSelectionNotice, setPreviewSelectionNotice] = useState<string>()
  const [comment, setComment] = useState('')
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([])
  const [view, setView] = useState<'preview' | 'source'>('preview')
  const [reviewPanelOpen, setReviewPanelOpen] = useState(true)
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined)
  const pendingRef = useRef(new Map<string, PendingRequest>())
  const previewRef = useRef<HTMLDivElement | null>(null)

  const post = useCallback((message: MarkdownReviewPortRequest): boolean => {
    const port = portRef.current
    if (port === undefined) return false
    try { port.postMessage(message); return true } catch { return false }
  }, [])

  const loadSnapshot = useCallback(() => {
    if (reviewId === undefined) return
    const id = requestId()
    pendingRef.current.set(id, { kind: 'snapshot' })
    dispatch({ type: 'snapshot-requested' })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-snapshot-request', requestId: id, reviewId })) {
      pendingRef.current.delete(id)
      dispatch({ type: 'port-disconnected' })
    }
  }, [post, reviewId])

  useEffect(() => {
    if (reviewId === undefined || typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) {
      dispatch({ type: 'request-failed', error: { code: 'invalid_request', message: '缺少有效 reviewId。请从文件树重新打开。', reopenRequired: true } })
      return
    }
    const port = chrome.runtime.connect({ name: MARKDOWN_REVIEW_PORT })
    portRef.current = port
    const receive = (raw: unknown) => {
      if (!isMarkdownReviewPortResponse(raw)) return
      const message: MarkdownReviewPortResponse = raw
      if (message.type === 'markdown-review-target-updated') {
        if (message.reviewId === reviewId) loadSnapshot()
        return
      }
      const expected = pendingRef.current.get(message.requestId)
      if (expected === undefined) return
      pendingRef.current.delete(message.requestId)
      if (message.type === 'markdown-review-snapshot-response' && expected.kind === 'snapshot') {
        if (message.ok && message.snapshot !== undefined) {
          dispatch({ type: 'snapshot-loaded', snapshot: message.snapshot })
          setDraft(message.snapshot.content)
          setSelection(undefined)
          setPreviewSelectionNotice(undefined)
        } else if (message.error !== undefined) dispatch({ type: 'request-failed', error: message.error })
      }
      if (message.type === 'markdown-review-deliver-response' && expected.kind === 'deliver') {
        if (message.ok && message.deliveryId !== undefined) {
          setAnnotations((items) => items.map((item) => item.id === message.deliveryId ? { ...item, delivered: true, lastError: undefined } : item))
        } else if (message.error !== undefined) {
          setAnnotations((items) => items.map((item) => item.id === expected.annotationId ? { ...item, lastError: message.error?.message } : item))
          if (message.error.reopenRequired) dispatch({ type: 'request-failed', error: message.error })
        }
      }
    }
    const disconnected = () => { portRef.current = undefined; pendingRef.current.clear(); dispatch({ type: 'port-disconnected' }) }
    port.onMessage.addListener(receive)
    port.onDisconnect.addListener(disconnected)
    dispatch({ type: 'connect' })
    // This is intentionally the only automatic recovery attempt.  A lost Host
    // record or Side Panel is never replaced with a newly minted authority.
    const id = requestId()
    pendingRef.current.set(id, { kind: 'snapshot' })
    dispatch({ type: 'snapshot-requested' })
    port.postMessage({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-snapshot-request', requestId: id, reviewId } satisfies MarkdownReviewPortRequest)
    return () => { port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected); port.disconnect(); if (portRef.current === port) portRef.current = undefined }
  }, [reviewId])

  const snapshot: MarkdownReviewSnapshot | undefined = state.snapshot
  const dirty = snapshot !== undefined && draft !== snapshot.content
  // A draft has no Host-issued fingerprint.  Do not attach a stale snapshot
  // identity to an edited string and pretend it is a reliable source anchor.
  const anchor = selection === undefined || snapshot === undefined || dirty ? undefined : selectionAnchorFor(draft, selection.start, selection.end, snapshot.resource.fingerprint)

  const addAnnotation = () => {
    if (anchor === undefined || comment.trim() === '') return
    const annotation: LocalAnnotation = { id: requestId(), anchor, comment: comment.trim(), delivered: false }
    setAnnotations((items) => [annotation, ...items])
    setComment('')
  }
  const deliver = (annotation: LocalAnnotation) => {
    if (snapshot === undefined || reviewId === undefined) return
    const request = requestId()
    pendingRef.current.set(request, { kind: 'deliver', annotationId: annotation.id })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-deliver-request', requestId: request, reviewId, harnessSessionId: snapshot.harnessSessionId, deliveryId: annotation.id, annotation: { id: annotation.id, anchor: annotation.anchor, comment: annotation.comment } })) {
      pendingRef.current.delete(request); dispatch({ type: 'port-disconnected' })
    }
  }
  const updateSelection = (start: number, end: number) => {
    setSelection({ start, end })
    setPreviewSelectionNotice(undefined)
  }
  const onPreviewSelection = useCallback(() => {
    if (snapshot === undefined || dirty) return
    const browserSelection = window.getSelection()
    if (browserSelection === null || browserSelection.rangeCount !== 1 || browserSelection.isCollapsed) {
      setSelection(undefined)
      setPreviewSelectionNotice(undefined)
      return
    }
    const matched = previewSelectionToSourceRange(draft, browserSelection, previewRef.current)
    if (matched === undefined) {
      setSelection(undefined)
      setPreviewSelectionNotice('预览选区无法唯一对应到 Markdown 源码。请改选更精确的文本，或切换到源码视图。')
      return
    }
    setSelection(matched)
    setPreviewSelectionNotice(undefined)
  }, [dirty, draft, snapshot])

  return <main className="review-shell">
    <header className="review-header">
      <div className="review-title"><strong>Markdown 审阅</strong><span title={snapshot?.resource.displayPath}>{snapshot?.resource.displayPath ?? '正在确认已绑定的文件…'}</span></div>
      <div className="review-header-actions">{snapshot !== undefined && <span className="session-status" title={`固定投递到会话 ${snapshot.harnessSessionId}`}>已绑定会话</span>}<span className={dirty ? 'status draft' : 'status'}>{dirty ? '本地草稿未保存' : '只读快照'}</span><button className="secondary" type="button" onClick={loadSnapshot} disabled={state.status === 'loading' || state.status === 'reopen-required'}>重新读取</button></div>
    </header>
    {state.error !== undefined && <section className="notice" role="alert">{state.error.message}{state.status !== 'reopen-required' && <><br /><button className="secondary" type="button" onClick={loadSnapshot}>重试</button></>}</section>}
    <section className={reviewPanelOpen ? 'review-main' : 'review-main review-panel-collapsed'}>
      <section className="document-workspace" aria-label="Markdown 文档">
        <div className="workspace-toolbar"><div className="view-switch" role="group" aria-label="文档视图"><button className={view === 'preview' ? 'active' : ''} type="button" onClick={() => setView('preview')}>预览</button><button className={view === 'source' ? 'active' : ''} type="button" onClick={() => setView('source')}>源码</button></div><span className="workspace-hint">{view === 'source' ? '选择源码文本后即可添加批注' : '选择预览文本后即可添加批注'}</span>{snapshot?.truncated === true && <span className="truncated">内容已截断</span>}</div>
        <div className={view === 'source' ? 'document-canvas source-canvas' : 'document-canvas'}>{snapshot === undefined ? <div className="loading">正在读取受限文件快照…</div> : view === 'source' ? <SourceEditor value={draft} onChange={setDraft} onSelectionChange={updateSelection} /> : <SafeMarkdownPreview content={draft} onSelectionChange={onPreviewSelection} previewRef={previewRef} />}</div>
      </section>
      <aside className={reviewPanelOpen ? 'annotation-panel' : 'annotation-panel collapsed'} aria-label="审阅批注">
        <div className="annotation-panel-head"><div><strong>审阅批注</strong><span>{annotations.length === 0 ? '暂无批注' : `${annotations.length} 条批注`}</span></div><button className="icon-button" type="button" onClick={() => setReviewPanelOpen((open) => !open)} aria-expanded={reviewPanelOpen} aria-label={reviewPanelOpen ? '收起审阅栏' : '展开审阅栏'}>{reviewPanelOpen ? '›' : '‹'}</button></div>
        <div className="annotation-panel-content">
          <form className="annotation-form" onSubmit={(event) => { event.preventDefault(); addAnnotation() }}>
            <label>文档选区</label>
            <pre className="selection-quote">{anchor?.quote ?? (previewSelectionNotice ?? (dirty ? '本地草稿尚无权威快照身份；重新读取后再选择文本。' : '请在预览或源码视图选择一段文本。'))}</pre>
            <label htmlFor="review-comment">批注</label>
            <textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={8_000} placeholder="描述希望 AI 关注或修改的内容" />
            <div className="annotation-actions"><button type="submit" disabled={anchor === undefined || comment.trim() === ''}>添加批注</button></div>
          </form>
          <div className="annotation-list">
            {annotations.map((item) => <article className="annotation-card" key={item.id}><p>{item.comment}</p><code>{item.anchor.quote}</code><footer className={item.delivered ? '' : 'pending'}><span>{item.lastError ?? (item.delivered ? '已送入待发区；仍保留副本，可重送。' : '尚未送入待发区。')}</span><button className="secondary" type="button" onClick={() => deliver(item)} disabled={state.status === 'reopen-required'}>{item.delivered ? '重新送入' : '送入会话'}</button></footer></article>)}
          </div>
        </div>
      </aside>
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
