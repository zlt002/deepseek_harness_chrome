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
import { beginCommit, isCurrentCommit, settleCommit, shouldProtectLocalReviewWork, type CommitAttempt } from './review-state-safety'
import { VisualMarkdownEditor, type VisualMarkdownEditorHandle, type VisualReviewAnnotation } from './visual-markdown-editor'
import type { VisualSelection } from './visual-selection'
import { MARKDOWN_REVIEW_DELIVERY_TIMEOUT_MS } from './delivery-timeouts'
import './style.css'

type LocalAnnotation = MarkdownReviewAnnotation & VisualReviewAnnotation
type PreparedWriteState = { preparation: PreparedWrite; content: string; idempotencyKey: string }
type PendingRequest = { kind: 'snapshot'; discardLocalWork: boolean } | { kind: 'deliver'; annotationId: string } | { kind: 'proposals' } | { kind: 'prepare'; content: string } | { kind: 'commit'; content: string; token: string }

const initialState: ReviewState = { status: 'initializing' }

function requestId(): string { return crypto.randomUUID() }

function reviewIdFromLocation(location: Pick<Location, 'search'> = window.location): string | undefined {
  const reviewId = new URLSearchParams(location.search).get('reviewId')
  return isMarkdownReviewId(reviewId) ? reviewId : undefined
}

/** Never reinterpret ProseMirror positions as Markdown source offsets. */
function visualAnchorFor(snapshot: MarkdownReviewSnapshot | undefined, selection: VisualSelection | undefined): MarkdownSelectionAnchor | undefined {
  if (snapshot === undefined || snapshot.truncated || selection === undefined || selection.limitReason !== undefined) return undefined
  return {
    version: 2,
    editorRevision: selection.editorRevision,
    from: selection.from,
    to: selection.to,
    quote: selection.quote,
    blocks: selection.blocks.map(({ kind, text }) => ({ kind, text })),
    ...(selection.table === undefined ? {} : { table: selection.table }),
    sourceFingerprint: snapshot.resource.fingerprint,
  }
}

function reviewQuoteFor(selection: VisualSelection): string {
  return selection.table === undefined
    ? selection.quote
    : [selection.table.header, ...selection.table.rows].map(row => row.join(' | ')).join('\n')
}

function App(): React.JSX.Element {
  const reviewId = useMemo(() => reviewIdFromLocation(), [])
  const [state, dispatch] = useReducer(reduceReviewState, initialState)
  const [draft, setDraft] = useState('')
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([])
  const [proposalNotice, setProposalNotice] = useState<string>()
  const [candidateReviewActive, setCandidateReviewActive] = useState(false)
  const [activeDiff, setActiveDiff] = useState<{ before: string; after: string }>()
  const [preparedWrite, setPreparedWrite] = useState<PreparedWriteState>()
  const [committing, setCommitting] = useState(false)
  const [externalUpdatePending, setExternalUpdatePending] = useState(false)
  const [saveNotice, setSaveNotice] = useState<string>()
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined)
  const pendingRef = useRef(new Map<string, PendingRequest>())
  const deliveryTimeoutsRef = useRef(new Map<string, number>())
  const editorRef = useRef<VisualMarkdownEditorHandle | null>(null)
  const snapshotRef = useRef<MarkdownReviewSnapshot | undefined>(undefined)
  const draftRef = useRef('')
  const proposalSequenceRef = useRef(0)
  const proposalQueueRef = useRef<MarkdownReviewProposal[]>([])
  const annotationSelectionsRef = useRef(new Map<string, VisualSelection>())
  const annotationsRef = useRef<LocalAnnotation[]>([])
  const candidateReviewActiveRef = useRef(false)
  const preparedWriteRef = useRef<PreparedWriteState | undefined>(undefined)
  const commitRef = useRef<CommitAttempt | undefined>(undefined)

  /** Milkdown emits markdownUpdated after a debounce; persistence checks read it synchronously. */
  const syncEditorMarkdown = useCallback((): string => {
    const editor = editorRef.current
    const markdown = editor?.isReady() === true ? editor.getMarkdown() : draftRef.current
    draftRef.current = markdown
    setDraft((current) => current === markdown ? current : markdown)
    return markdown
  }, [])

  const hasLocalReviewWork = useCallback((): boolean => shouldProtectLocalReviewWork({
    snapshotContent: snapshotRef.current?.content,
    editorMarkdown: syncEditorMarkdown(),
    annotationCount: annotationsRef.current.length,
    candidateReviewActive: candidateReviewActiveRef.current,
    preparedWrite: preparedWriteRef.current !== undefined,
    committing: commitRef.current !== undefined,
  }), [syncEditorMarkdown])

  const post = useCallback((message: MarkdownReviewPortRequest): boolean => {
    const port = portRef.current
    if (port === undefined) return false
    try { port.postMessage(message); return true } catch { return false }
  }, [])

  const failSendingAnnotations = useCallback((message: string) => {
    setAnnotations((items) => {
      const next = items.map((item) => item.deliveryStatus === 'sending'
        ? { ...item, deliveryStatus: 'failed' as const, lastError: message }
        : item)
      annotationsRef.current = next
      return next
    })
  }, [])

  const loadSnapshot = useCallback((options: { discardLocalWork?: boolean } = {}) => {
    if (reviewId === undefined) return
    const id = requestId()
    pendingRef.current.set(id, { kind: 'snapshot', discardLocalWork: options.discardLocalWork === true })
    dispatch({ type: 'snapshot-requested' })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-snapshot-request', requestId: id, reviewId })) {
      pendingRef.current.delete(id)
      dispatch({ type: 'port-disconnected' })
    }
  }, [post, reviewId])

  const applyQueuedProposal = useCallback(() => {
    const editor = editorRef.current
    const snapshot = snapshotRef.current
    if (editor === null || !editor.isReady() || snapshot === undefined || editor.isCandidateReviewActive()) return
    const proposal = proposalQueueRef.current.shift()
    if (proposal === undefined) return
    if (proposal.baseFingerprint !== snapshot.resource.fingerprint) {
      setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：文件已在外部变化，请重新读取后再请求。`)
      return
    }
    if (proposal.kind === 'document') {
      if (draftRef.current !== snapshot.content) {
        setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：本地草稿已变化。重新选择后再请求。`)
      } else if (editor.reviewCandidateMarkdown(proposal.candidateMarkdown)) {
        setActiveDiff({ before: snapshot.content, after: proposal.candidateMarkdown })
        setProposalNotice(`AI 候选待审阅：${proposal.summary}`)
      }
      else setProposalNotice(`AI 候选“${proposal.summary}”无法进入审阅；当前编辑器正忙。`)
      return
    }
    const saved = annotationSelectionsRef.current.get(proposal.selectionId)
    if (saved === undefined || saved.editorRevision !== proposal.editorRevision || saved.from !== proposal.from || saved.to !== proposal.to) {
      setProposalNotice(`AI 候选“${proposal.summary}”未覆盖：选区已变化，请重新选择后再请求。`)
    } else if (editor.reviewSelectionReplacement(saved, proposal.replacementMarkdown)) {
      setActiveDiff({ before: reviewQuoteFor(saved), after: proposal.replacementMarkdown })
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
        if (message.reviewId === reviewId) {
          if (hasLocalReviewWork()) {
            setExternalUpdatePending(true)
            setSaveNotice('外部文件已更新。本地草稿、批注或 AI 修改仍被保留；请明确选择是否放弃本地更改并重新读取。')
          } else {
            loadSnapshot()
          }
        }
        return
      }
      const expected = pendingRef.current.get(message.requestId)
      if (expected === undefined) return
      pendingRef.current.delete(message.requestId)
      const deliveryTimeout = deliveryTimeoutsRef.current.get(message.requestId)
      if (deliveryTimeout !== undefined) {
        window.clearTimeout(deliveryTimeout)
        deliveryTimeoutsRef.current.delete(message.requestId)
      }
      if (message.type === 'markdown-review-snapshot-response' && expected.kind === 'snapshot') {
        if (message.ok && message.snapshot !== undefined) {
          if (!expected.discardLocalWork && hasLocalReviewWork()) {
            setExternalUpdatePending(true)
            setSaveNotice('外部文件已更新，但刚才出现了本地更改。为避免覆盖，本地内容已保留。')
            return
          }
          dispatch({ type: 'snapshot-loaded', snapshot: message.snapshot })
          // A Host snapshot is a new editing baseline and intentionally resets
          // history. A successful Verified Write does not advance this epoch:
          // the mounted editor already contains the verified content, so its
          // undo/redo history remains useful after saving.
          setEditorEpoch((epoch) => epoch + 1)
          setDraft(message.snapshot.content)
          draftRef.current = message.snapshot.content
          snapshotRef.current = message.snapshot
          proposalSequenceRef.current = 0
          proposalQueueRef.current = []
          annotationSelectionsRef.current.clear()
          setCandidateReviewActive(false)
          candidateReviewActiveRef.current = false
          setAnnotations([])
          annotationsRef.current = []
          setActiveDiff(undefined)
          setPreparedWrite(undefined)
          preparedWriteRef.current = undefined
          commitRef.current = undefined
          setCommitting(false)
          setExternalUpdatePending(false)
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
          setAnnotations((items) => {
            const next = items.map((item) => item.id === message.deliveryId ? { ...item, deliveryStatus: 'delivered' as const, lastError: undefined } : item)
            annotationsRef.current = next
            return next
          })
        } else if (message.error !== undefined) {
          const error = message.error
          setAnnotations((items) => {
            const next = items.map((item) => item.id === expected.annotationId ? { ...item, deliveryStatus: 'failed' as const, lastError: error.message } : item)
            annotationsRef.current = next
            return next
          })
          if (error.reopenRequired) dispatch({ type: 'request-failed', error })
        }
      }
      if (message.type === 'markdown-review-prepare-write-response' && expected.kind === 'prepare') {
        if (!message.ok || message.preparation === undefined) {
          setSaveNotice(`无法准备保存：${message.error?.message ?? '未知错误'}`)
        } else if (message.preparation.status === 'conflict') {
          setPreparedWrite(undefined)
          preparedWriteRef.current = undefined
          setSaveNotice('文件已被外部修改，未覆盖任何内容。请重新读取后合并。')
        } else {
          const nextPreparedWrite = { preparation: message.preparation, content: expected.content, idempotencyKey: requestId() }
          preparedWriteRef.current = nextPreparedWrite
          setPreparedWrite(nextPreparedWrite)
          setSaveNotice('已核对文件版本。请确认后写入；确认只在一分钟内有效。')
        }
      }
      if (message.type === 'markdown-review-commit-write-response' && expected.kind === 'commit') {
        if (!isCurrentCommit(commitRef.current, expected.token)) return
        commitRef.current = settleCommit(commitRef.current, expected.token)
        setCommitting(false)
        setPreparedWrite(undefined)
        preparedWriteRef.current = undefined
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
          setAnnotations([])
          annotationsRef.current = []
          setActiveDiff(undefined)
          annotationSelectionsRef.current.clear()
          setExternalUpdatePending(false)
          setSaveNotice('已保存，并已按同一资源回读验证。')
        } else if (message.result.status === 'conflict') {
          setSaveNotice('文件已被外部修改，未覆盖任何内容。请重新读取后合并。')
        } else {
          setSaveNotice(`写入状态不确定：${message.result.message} 请重新读取，不会自动重试。`)
        }
      }
    }
    const disconnected = () => {
      portRef.current = undefined
      for (const timeout of deliveryTimeoutsRef.current.values()) window.clearTimeout(timeout)
      deliveryTimeoutsRef.current.clear()
      pendingRef.current.clear()
      commitRef.current = undefined
      setCommitting(false)
      preparedWriteRef.current = undefined
      setPreparedWrite(undefined)
      failSendingAnnotations('与 Harness 会话的连接已断开')
      dispatch({ type: 'port-disconnected' })
    }
    port.onMessage.addListener(receive)
    port.onDisconnect.addListener(disconnected)
    dispatch({ type: 'connect' })
    // This is intentionally the only automatic recovery attempt.  A lost Host
    // record or Side Panel is never replaced with a newly minted authority.
    const id = requestId()
    pendingRef.current.set(id, { kind: 'snapshot', discardLocalWork: false })
    dispatch({ type: 'snapshot-requested' })
    port.postMessage({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-snapshot-request', requestId: id, reviewId } satisfies MarkdownReviewPortRequest)
    return () => {
      port.onMessage.removeListener(receive)
      port.onDisconnect.removeListener(disconnected)
      for (const timeout of deliveryTimeoutsRef.current.values()) window.clearTimeout(timeout)
      deliveryTimeoutsRef.current.clear()
      port.disconnect()
      if (portRef.current === port) portRef.current = undefined
    }
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
  const showRecoveryState = snapshot === undefined || state.status === 'reopen-required'
  const activityNotice = saveNotice ?? proposalNotice
  const dirty = snapshot !== undefined && draft !== snapshot.content
  const onMarkdownChange = useCallback((markdown: string) => {
    draftRef.current = markdown
    setDraft(markdown)
  }, [])
  const deliverAnnotation = useCallback((annotation: LocalAnnotation): boolean => {
    const activeSnapshot = snapshotRef.current
    if (activeSnapshot === undefined || reviewId === undefined) return false
    setAnnotations((items) => {
      const next = items.map((item) => item.id === annotation.id ? { ...item, deliveryStatus: 'sending' as const, lastError: undefined } : item)
      annotationsRef.current = next
      return next
    })
    const request = requestId()
    pendingRef.current.set(request, { kind: 'deliver', annotationId: annotation.id })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-deliver-request', requestId: request, reviewId, harnessSessionId: activeSnapshot.harnessSessionId, deliveryId: annotation.id, annotation: { id: annotation.id, anchor: annotation.anchor, comment: annotation.comment } })) {
      pendingRef.current.delete(request)
      failSendingAnnotations('与 Harness 会话的连接已断开')
      dispatch({ type: 'port-disconnected' })
      return false
    }
    const timeout = window.setTimeout(() => {
      deliveryTimeoutsRef.current.delete(request)
      const expected = pendingRef.current.get(request)
      if (expected?.kind !== 'deliver') return
      pendingRef.current.delete(request)
      setAnnotations((items) => {
        const next = items.map((item) => item.id === expected.annotationId
          ? { ...item, deliveryStatus: 'failed' as const, lastError: '会话未在 20 秒内确认，请重试' }
          : item)
        annotationsRef.current = next
        return next
      })
    }, MARKDOWN_REVIEW_DELIVERY_TIMEOUT_MS)
    deliveryTimeoutsRef.current.set(request, timeout)
    return true
  }, [failSendingAnnotations, post, reviewId])
  const submitAnnotation = useCallback((selection: VisualSelection, comment: string): boolean => {
    const activeSnapshot = snapshotRef.current
    const anchor = visualAnchorFor(activeSnapshot, selection)
    if (activeSnapshot === undefined || reviewId === undefined || anchor === undefined || comment.trim() === '') return false
    const annotation: LocalAnnotation = { id: requestId(), anchor, selection, comment: comment.trim(), deliveryStatus: 'sending' }
    annotationSelectionsRef.current.set(annotation.id, selection)
    setAnnotations((items) => {
      const next = [annotation, ...items]
      annotationsRef.current = next
      return next
    })
    deliverAnnotation(annotation)
    return true
  }, [deliverAnnotation, reviewId])
  const acceptCandidate = () => {
    if (editorRef.current?.acceptCandidate() !== true) {
      setProposalNotice('当前没有可接受的 AI 修改。')
      return
    }
    syncEditorMarkdown()
    setCandidateReviewActive(false)
    candidateReviewActiveRef.current = false
    setActiveDiff(undefined)
    setProposalNotice('已接受 AI 修改；当前内容仍是本地草稿，尚未写入文件。')
    queueMicrotask(applyQueuedProposal)
  }
  const rejectCandidate = () => {
    if (editorRef.current?.rejectCandidate() !== true) {
      setProposalNotice('当前没有可拒绝的 AI 修改。')
      return
    }
    syncEditorMarkdown()
    setCandidateReviewActive(false)
    candidateReviewActiveRef.current = false
    setActiveDiff(undefined)
    setProposalNotice('已拒绝 AI 修改。')
    queueMicrotask(applyQueuedProposal)
  }
  const prepareSave = () => {
    if (snapshot === undefined || reviewId === undefined || snapshot.truncated || !dirty || preparedWriteRef.current !== undefined || commitRef.current !== undefined) return
    const request = requestId()
    const content = syncEditorMarkdown()
    pendingRef.current.set(request, { kind: 'prepare', content })
    setSaveNotice(undefined)
    const expected = { resourceId: snapshot.resource.resourceId, revision: snapshot.resource.revision, fingerprint: snapshot.resource.fingerprint }
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-prepare-write-request', requestId: request, reviewId, expected, content })) {
      pendingRef.current.delete(request); dispatch({ type: 'port-disconnected' })
    }
  }
  const commitSave = () => {
    const currentPreparedWrite = preparedWriteRef.current
    if (snapshot === undefined || reviewId === undefined || currentPreparedWrite === undefined) return
    if (syncEditorMarkdown() !== currentPreparedWrite.content) {
      preparedWriteRef.current = undefined
      setPreparedWrite(undefined); setSaveNotice('草稿在确认前已改变，请重新保存并确认。'); return
    }
    const request = requestId()
    const attempt = beginCommit(commitRef.current, { token: request, idempotencyKey: currentPreparedWrite.idempotencyKey, content: currentPreparedWrite.content })
    if (!attempt.started) return
    commitRef.current = attempt.active
    setCommitting(true)
    pendingRef.current.set(request, { kind: 'commit', content: attempt.active.content, token: attempt.active.token })
    if (!post({ v: MARKDOWN_REVIEW_PROTOCOL_VERSION, type: 'markdown-review-commit-write-request', requestId: request, reviewId, approval: currentPreparedWrite.preparation.approval, idempotencyKey: attempt.active.idempotencyKey, content: attempt.active.content })) {
      pendingRef.current.delete(request)
      commitRef.current = settleCommit(commitRef.current, attempt.active.token)
      setCommitting(false)
      dispatch({ type: 'port-disconnected' })
    }
  }
  const requestSnapshotReload = () => {
    if (hasLocalReviewWork()) {
      setExternalUpdatePending(true)
      setSaveNotice('本地草稿、批注或 AI 修改仍被保留；请点击“放弃本地更改并重新读取”后再替换。')
      return
    }
    loadSnapshot()
  }
  const discardLocalWorkAndReload = () => {
    if (commitRef.current !== undefined) {
      setSaveNotice('正在确认写入结果，暂不能丢弃本地工作。')
      return
    }
    setExternalUpdatePending(false)
    loadSnapshot({ discardLocalWork: true })
  }

  return <main className="review-shell">
    <header className="review-header">
      <div className="review-title" title={snapshot?.resource.displayPath ?? 'Markdown 审阅'}><strong>Markdown 审阅</strong><span>{snapshot?.resource.displayPath ?? '正在确认已绑定的文件…'}</span></div>
      <div className="review-header-actions">
        {snapshot !== undefined && <span className="session-status" title={`固定投递到会话 ${snapshot.harnessSessionId}`}>已绑定会话</span>}
        <span className={dirty ? 'status draft' : 'status'}>{dirty ? '本地草稿未保存' : '已与文件同步'}</span>
        {snapshot?.truncated === true && <span className="status truncated" title="文件快照已截断，不能安全保存或发送完整文档">内容已截断</span>}
        <span className="history-actions" role="group" aria-label="编辑历史"><button type="button" className="secondary" title="撤销（Ctrl+Z）" aria-label="撤销（Ctrl+Z）" onClick={() => { if (editorRef.current?.undo() === true) syncEditorMarkdown() }}>撤销</button><button type="button" className="secondary" title="重做（Ctrl+Y）" aria-label="重做（Ctrl+Y）" onClick={() => { if (editorRef.current?.redo() === true) syncEditorMarkdown() }}>重做</button></span>
        {dirty && snapshot?.truncated !== true && <button type="button" onClick={prepareSave} disabled={preparedWrite !== undefined || committing || state.status === 'reopen-required'}>保存草稿</button>}
        <button className="secondary" type="button" onClick={requestSnapshotReload} disabled={state.status === 'loading' || state.status === 'reopen-required'}>重新读取</button>
      </div>
    </header>
    {state.error !== undefined && !showRecoveryState && <section className="notice" role="alert">{state.error.message}{state.status !== 'reopen-required' && <><br /><button className="secondary" type="button" onClick={requestSnapshotReload}>重试</button></>}</section>}
    {activityNotice !== undefined && <section className="proposal-notice" role="status">{activityNotice}</section>}
    {externalUpdatePending && <section className="save-confirm" role="alert"><span>外部文件已更新。本地草稿、批注和 AI 修改尚未被覆盖。</span><button type="button" onClick={discardLocalWorkAndReload} disabled={committing}>放弃本地更改并重新读取</button></section>}
    {preparedWrite !== undefined && <section className="save-confirm" role="alert"><span>将把当前草稿写入已核对的文件版本。</span><button type="button" onClick={() => { preparedWriteRef.current = undefined; setPreparedWrite(undefined) }} className="secondary" disabled={committing}>取消</button><button type="button" onClick={commitSave} disabled={committing}>{committing ? '正在确认写入…' : '确认写入'}</button></section>}
    {showRecoveryState ? <section className={`review-recovery${snapshot === undefined && state.error === undefined ? ' is-loading' : ''}`} role={state.error === undefined ? undefined : 'alert'}>
      <strong>{state.status === 'reopen-required' ? '需要重新打开文档' : snapshot === undefined && state.error === undefined ? '正在读取文档' : '暂时无法显示文档'}</strong>
      <span>{state.error?.message ?? '正在确认文件快照，请稍候…'}</span>
      {state.error !== undefined && state.status !== 'reopen-required' && <button className="secondary" type="button" onClick={requestSnapshotReload}>重试</button>}
    </section> : <section className="review-main">
      <section className="document-workspace" aria-label="Markdown 文档" title="在排版后的正文中直接编辑；标题、段落、列表、表格、代码块和跨块选区都可作为 AI 上下文。HTML 保留为安全文本；Mermaid 仅在本地安全渲染。">
        <div className="document-canvas"><VisualMarkdownEditor ref={editorRef} key={editorEpoch} initialMarkdown={snapshot.content} readOnly={false} annotations={annotations} canAnnotate={!snapshot.truncated && state.status !== 'reopen-required'} onSubmitAnnotation={submitAnnotation} onRetryAnnotation={(annotationId) => { const annotation = annotations.find((item) => item.id === annotationId); if (annotation !== undefined) deliverAnnotation(annotation) }} /* Host readOnly means no direct disk capability; local drafts stay editable. */ onMarkdownChange={onMarkdownChange} onReady={applyQueuedProposal} onCandidateReviewChange={(active) => { setCandidateReviewActive(active); candidateReviewActiveRef.current = active; if (!active) queueMicrotask(() => { syncEditorMarkdown(); applyQueuedProposal() }) }} /></div>
        {candidateReviewActive && activeDiff !== undefined && <section className="diff-review-dock" aria-label="AI 修改前后对比">
          <div><strong>修改前</strong><pre>{activeDiff.before}</pre></div><div><strong>修改后</strong><pre>{activeDiff.after}</pre></div>
          <footer><button type="button" onClick={rejectCandidate} className="secondary">拒绝修改</button><button type="button" onClick={acceptCandidate}>接受修改</button></footer>
        </section>}
      </section>
    </section>}
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
