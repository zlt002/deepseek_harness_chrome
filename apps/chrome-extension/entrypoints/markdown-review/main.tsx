import '@vitejs/plugin-react/preamble'
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  MARKDOWN_REVIEW_PORT,
  MARKDOWN_REVIEW_PROTOCOL_VERSION,
  isMarkdownReviewId,
  isMarkdownReviewPortResponse,
  type MarkdownReviewAnnotation,
  type MarkdownSelectionAnchor,
  type MarkdownReviewPortRequest,
  type MarkdownReviewPortResponse,
  type MarkdownReviewProposal,
  type MarkdownReviewSnapshot,
  type PreparedWrite,
} from './protocol'
import { reduceReviewState, type ReviewState } from './review-state'
import { VisualMarkdownEditor, type VisualMarkdownEditorHandle } from './visual-markdown-editor'
import type { VisualSelection } from './visual-selection'
import './style.css'

type LocalAnnotation = MarkdownReviewAnnotation & { selection: VisualSelection; delivered: boolean; lastError?: string }
type PendingRequest = { kind: 'snapshot' } | { kind: 'deliver'; annotationId: string } | { kind: 'proposals' } | { kind: 'prepare'; content: string } | { kind: 'commit'; content: string }

const initialState: ReviewState = { status: 'initializing' }

function requestId(): string { return crypto.randomUUID() }

function reviewIdFromLocation(location: Pick<Location, 'search'> = window.location): string | undefined {
  const reviewId = new URLSearchParams(location.search).get('reviewId')
  return isMarkdownReviewId(reviewId) ? reviewId : undefined
}

/** Never reinterpret ProseMirror positions as Markdown source offsets. */
function visualAnchorFor(snapshot: MarkdownReviewSnapshot | undefined, selection: VisualSelection | undefined): MarkdownSelectionAnchor | undefined {
  if (snapshot === undefined || snapshot.truncated || selection === undefined) return undefined
  return {
    version: 2,
    editorRevision: selection.editorRevision,
    from: selection.from,
    to: selection.to,
    quote: selection.quote,
    blocks: selection.blocks.map(({ kind, text }) => ({ kind, text })),
    sourceFingerprint: snapshot.resource.fingerprint,
  }
}

function App(): React.JSX.Element {
  const reviewId = useMemo(() => reviewIdFromLocation(), [])
  const [state, dispatch] = useReducer(reduceReviewState, initialState)
  const [draft, setDraft] = useState('')
  const [selection, setSelection] = useState<VisualSelection>()
  const [comment, setComment] = useState('')
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([])
  const [reviewPanelOpen, setReviewPanelOpen] = useState(true)
  const [proposalNotice, setProposalNotice] = useState<string>()
  const [candidateReviewActive, setCandidateReviewActive] = useState(false)
  const [preparedWrite, setPreparedWrite] = useState<{ preparation: PreparedWrite; content: string }>()
  const [saveNotice, setSaveNotice] = useState<string>()
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined)
  const pendingRef = useRef(new Map<string, PendingRequest>())
  const editorRef = useRef<VisualMarkdownEditorHandle | null>(null)
  const snapshotRef = useRef<MarkdownReviewSnapshot | undefined>(undefined)
  const draftRef = useRef('')
  const proposalSequenceRef = useRef(0)
  const proposalQueueRef = useRef<MarkdownReviewProposal[]>([])
  const annotationSelectionsRef = useRef(new Map<string, VisualSelection>())

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

  const applyQueuedProposal = useCallback(() => {
    const editor = editorRef.current
    const snapshot = snapshotRef.current
    if (editor === null || snapshot === undefined || editor.isCandidateReviewActive()) return
    const proposal = proposalQueueRef.current.shift()
    if (proposal === undefined) return
    if (proposal.baseFingerprint !== snapshot.resource.fingerprint) {
      setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：文件已在外部变化，请重新读取后再请求。`)
      return
    }
    if (proposal.kind === 'document') {
      if (draftRef.current !== snapshot.content) {
        setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：本地草稿已变化。重新选择后再请求。`)
      } else if (editor.reviewCandidateMarkdown(proposal.candidateMarkdown)) setProposalNotice(`AI 候选待审阅：${proposal.summary}`)
      else setProposalNotice(`AI 候选“${proposal.summary}”无法进入审阅；当前编辑器正忙。`)
      return
    }
    const saved = annotationSelectionsRef.current.get(proposal.selectionId)
    if (saved === undefined || saved.editorRevision !== proposal.editorRevision || saved.from !== proposal.from || saved.to !== proposal.to) {
      setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：选区已变化，请重新选择后再请求。`)
    } else if (editor.reviewSelectionReplacement(saved, proposal.replacementMarkdown)) {
      setProposalNotice(`AI 针对当前选区的候选待审阅：${proposal.summary}`)
    } else {
      setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：编辑版本、范围或选中文本已变化。`)
    }
  }, [])

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
          draftRef.current = message.snapshot.content
          snapshotRef.current = message.snapshot
          proposalSequenceRef.current = 0
          proposalQueueRef.current = []
          annotationSelectionsRef.current.clear()
          setCandidateReviewActive(false)
          setSelection(undefined)
          setPreparedWrite(undefined)
        } else if (message.error !== undefined) dispatch({ type: 'request-failed', error: message.error })
      }
      if (message.type === 'markdown-review-proposals-response' && expected.kind === 'proposals') {
        if (message.ok && message.reviewId === reviewId && message.proposals !== undefined) {
          for (const proposal of message.proposals) {
            proposalSequenceRef.current = Math.max(proposalSequenceRef.current, proposal.sequence)
            proposalQueueRef.current.push(proposal)
          }
          applyQueuedProposal()
        } else if (message.error !== undefined) setProposalNotice(`无法读取 AI 候选：${message.error.message}`)
      }
      if (message.type === 'markdown-review-deliver-response' && expected.kind === 'deliver') {
        if (message.ok && message.deliveryId !== undefined) {
          setAnnotations((items) => items.map((item) => item.id === message.deliveryId ? { ...item, delivered: true, lastError: undefined } : item))
        } else if (message.error !== undefined) {
          const error = message.error
          setAnnotations((items) => items.map((item) => item.id === expected.annotationId ? { ...item, lastError: error.message } : item))
          if (error.reopenRequired) dispatch({ type: 'request-failed', error })
        }
      }
      if (message.type === 'markdown-review-prepare-write-response' && expected.kind === 'prepare') {
        if (!message.ok || message.preparation === undefined) {
          setSaveNotice(`无法准备保存：${message.error?.message ?? '未知错误'}`)
        } else if (message.preparation.status === 'conflict') {
          setPreparedWrite(undefined)
          setSaveNotice('文件已被外部修改，未覆盖任何内容。请重新读取后合并。')
        } else {
          setPreparedWrite({ preparation: message.preparation, content: expected.content })
          setSaveNotice('已核对文件版本。请确认后写入；确认只在一分钟内有效。')
        }
      }
      if (message.type === 'markdown-review-commit-write-response' && expected.kind === 'commit') {
        setPreparedWrite(undefined)
        if (!message.ok || message.result === undefined) {
          setSaveNotice(`保存未完成：${message.error?.message ?? '未知错误'}`)
        } else if (message.result.status === 'verified_write') {
          const prior = snapshotRef.current
          if (prior === undefined) { setSaveNotice('保存已验证；请重新读取文件。'); return }
          const next = { ...prior, resource: message.result.resource, content: expected.content }
          snapshotRef.current = next
          draftRef.current = expected.content
          setDraft(expected.content)
          dispatch({ type: 'snapshot-loaded', snapshot: next })
          setSelection(undefined)
          annotationSelectionsRef.current.clear()
          setSaveNotice('已保存，并已按同一资源回读验证。')
        } else if (message.result.status === 'conflict') {
          setSaveNotice('文件已被外部修改，未覆盖任何内容。请重新读取后合并。')
        } else {
          setSaveNotice(`写入状态不确定：${message.result.message} 请重新读取，不会自动重试。`)
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

  useEffect(() => {
    if (reviewId === undefined || state.snapshot === undefined || state.status !== 'ready') return
    const poll = () => {
      if ([...pendingRef.current.values()].some((pending) => pending.kind === 'proposals')) return
      const proposalRequestId = requestId()
      pendingRef.current.set(proposalRequestId, { kind: 'proposals' })
      if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-proposals-request', requestId: proposalRequestId, reviewId, afterSequence: proposalSequenceRef.current })) {
        pendingRef.current.delete(proposalRequestId)
      }
    }
    poll()
    const timer = window.setInterval(poll, 1_000)
    return () => window.clearInterval(timer)
  }, [post, reviewId, state.snapshot, state.status])

  const snapshot: MarkdownReviewSnapshot | undefined = state.snapshot
  const dirty = snapshot !== undefined && draft !== snapshot.content
  const anchor = visualAnchorFor(snapshot, selection)
  const onMarkdownChange = useCallback((markdown: string) => {
    draftRef.current = markdown
    setDraft(markdown)
  }, [])
  const addAnnotation = () => {
    if (selection === undefined || anchor === undefined || comment.trim() === '') return
    const annotation: LocalAnnotation = { id: requestId(), anchor, selection, comment: comment.trim(), delivered: false }
    annotationSelectionsRef.current.set(annotation.id, selection)
    setAnnotations((items) => [annotation, ...items])
    setComment('')
  }
  const deliver = (annotation: LocalAnnotation) => {
    if (snapshot === undefined || reviewId === undefined) return
    const request = requestId()
    pendingRef.current.set(request, { kind: 'deliver', annotationId: annotation.id })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-deliver-request', requestId: request, reviewId, harnessSessionId: snapshot.harnessSessionId, deliveryId: annotation.id, annotation: { id: annotation.id, anchor: annotation.anchor, comment: annotation.comment } })) {
      pendingRef.current.delete(request)
      dispatch({ type: 'port-disconnected' })
    }
  }
  const acceptCandidate = () => {
    if (editorRef.current?.acceptCandidate() !== true) {
      setProposalNotice('当前没有可接受的 AI 修改。')
      return
    }
    setCandidateReviewActive(false)
    setProposalNotice('已接受 AI 修改；当前内容仍是本地草稿，尚未写入文件。')
    queueMicrotask(applyQueuedProposal)
  }
  const rejectCandidate = () => {
    if (editorRef.current?.rejectCandidate() !== true) {
      setProposalNotice('当前没有可拒绝的 AI 修改。')
      return
    }
    setCandidateReviewActive(false)
    setProposalNotice('已拒绝 AI 修改。')
    queueMicrotask(applyQueuedProposal)
  }
  const prepareSave = () => {
    if (snapshot === undefined || reviewId === undefined || snapshot.truncated || !dirty || preparedWrite !== undefined) return
    const request = requestId()
    const content = draftRef.current
    pendingRef.current.set(request, { kind: 'prepare', content })
    setSaveNotice(undefined)
    const expected = { resourceId: snapshot.resource.resourceId, revision: snapshot.resource.revision, fingerprint: snapshot.resource.fingerprint }
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-prepare-write-request', requestId: request, reviewId, expected, content })) {
      pendingRef.current.delete(request); dispatch({ type: 'port-disconnected' })
    }
  }
  const commitSave = () => {
    if (snapshot === undefined || reviewId === undefined || preparedWrite === undefined) return
    if (draftRef.current !== preparedWrite.content) {
      setPreparedWrite(undefined); setSaveNotice('草稿在确认前已改变，请重新保存并确认。'); return
    }
    const request = requestId()
    pendingRef.current.set(request, { kind: 'commit', content: preparedWrite.content })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-commit-write-request', requestId: request, reviewId, approval: preparedWrite.preparation.approval, idempotencyKey: requestId(), content: preparedWrite.content })) {
      pendingRef.current.delete(request); dispatch({ type: 'port-disconnected' })
    }
  }

  return <main className="review-shell">
    <header className="review-header">
      <div className="review-title"><strong>Markdown 审阅</strong><span title={snapshot?.resource.displayPath}>{snapshot?.resource.displayPath ?? '正在确认已绑定的文件…'}</span></div>
      <div className="review-header-actions">{snapshot !== undefined && <span className="session-status" title={`固定投递到会话 ${snapshot.harnessSessionId}`}>已绑定会话</span>}<span className={dirty ? 'status draft' : 'status'}>{dirty ? '本地草稿未保存' : '已与文件同步'}</span>{dirty && snapshot?.truncated !== true && <button type="button" onClick={prepareSave} disabled={preparedWrite !== undefined || state.status === 'reopen-required'}>保存草稿</button>}<button className="secondary" type="button" onClick={loadSnapshot} disabled={state.status === 'loading' || state.status === 'reopen-required'}>重新读取</button></div>
    </header>
    {state.error !== undefined && <section className="notice" role="alert">{state.error.message}{state.status !== 'reopen-required' && <><br /><button className="secondary" type="button" onClick={loadSnapshot}>重试</button></>}</section>}
    {proposalNotice !== undefined && <section className="proposal-notice" role="status">{proposalNotice}</section>}
    {saveNotice !== undefined && <section className="proposal-notice" role="status">{saveNotice}</section>}
    {preparedWrite !== undefined && <section className="save-confirm" role="alert"><span>将把当前草稿写入已核对的文件版本。</span><button type="button" onClick={() => setPreparedWrite(undefined)} className="secondary">取消</button><button type="button" onClick={commitSave}>确认写入</button></section>}
    <section className={reviewPanelOpen ? 'review-main' : 'review-main review-panel-collapsed'}>
      <section className="document-workspace" aria-label="Markdown 文档">
        <div className="workspace-toolbar"><span className="workspace-hint">在排版后的正文中直接编辑；标题、段落、列表、表格、代码块和跨块选区都可作为 AI 上下文。</span>{candidateReviewActive && <span className="candidate-actions" role="group" aria-label="AI 修改审阅"><button type="button" onClick={rejectCandidate} className="secondary">拒绝修改</button><button type="button" onClick={acceptCandidate}>接受修改</button></span>}{snapshot?.truncated === true && <span className="truncated">内容已截断</span>}<span className="rendering-notice">HTML 和 Mermaid 保留为安全文本/代码块，不执行。</span></div>
        <div className="document-canvas">{snapshot === undefined ? <div className="loading">正在读取受限文件快照…</div> : <VisualMarkdownEditor ref={editorRef} key={`${snapshot.resource.revision}:${snapshot.resource.fingerprint}`} initialMarkdown={snapshot.content} readOnly={false} /* Host readOnly means no direct disk capability; local drafts stay editable. */ onMarkdownChange={onMarkdownChange} onSelectionChange={setSelection} onCandidateReviewChange={(active) => { setCandidateReviewActive(active); if (!active) queueMicrotask(applyQueuedProposal) }} />}</div>
      </section>
      <aside className={reviewPanelOpen ? 'annotation-panel' : 'annotation-panel collapsed'} aria-label="审阅批注">
        <div className="annotation-panel-head"><div><strong>审阅批注</strong><span>{annotations.length === 0 ? '暂无批注' : `${annotations.length} 条批注`}</span></div><button className="icon-button" type="button" onClick={() => setReviewPanelOpen((open) => !open)} aria-expanded={reviewPanelOpen} aria-label={reviewPanelOpen ? '收起审阅栏' : '展开审阅栏'}>{reviewPanelOpen ? '›' : '‹'}</button></div>
        <div className="annotation-panel-content">
          <form className="annotation-form" onSubmit={(event) => { event.preventDefault(); addAnnotation() }}>
            <label>文档选区</label>
            <pre className="selection-quote">{selection?.quote ?? '请在排版后的正文中选择内容。'}</pre>
            {selection !== undefined && <p className="selection-context">编辑版本 {selection.editorRevision} · {selection.blocks.map((block) => block.kind).join('、') || '跨块文本'}<br />这是编辑器结构锚点，不是 Markdown 文件字符偏移。{anchor === undefined && ' 文件内容已截断，不能安全送入会话。'}</p>}
            <label htmlFor="review-comment">批注</label>
            <textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={8_000} placeholder="描述希望 AI 关注或修改的内容" />
            <div className="annotation-actions"><button type="submit" disabled={anchor === undefined || comment.trim() === ''}>添加批注</button></div>
          </form>
          <div className="annotation-list">
            {annotations.map((item) => <article className="annotation-card" key={item.id}><p>{item.comment}</p><code>{item.selection.quote}</code><footer className={item.delivered ? '' : 'pending'}><span>{item.lastError ?? (item.delivered ? '已送入固定会话；AI 候选会在正文内等待审阅。' : '尚未送入会话。')}</span><button className="secondary" type="button" onClick={() => deliver(item)} disabled={state.status === 'reopen-required'}>{item.delivered ? '重新送入' : '送入会话'}</button></footer></article>)}
          </div>
        </div>
      </aside>
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
