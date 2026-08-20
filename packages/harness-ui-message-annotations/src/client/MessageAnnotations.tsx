import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReviewFeedback, ReviewFeedbackSnapshot } from './AnnotationStore.ts'
import { ReviewFeedbackStore } from './AnnotationStore.ts'
import { shouldClosePopover } from './popover-close.js'
import { popoverPortalHost } from './popover-portal.js'
import { assistantMessageIdForRange, popoverPosition, selectionAnchor } from './selection-geometry.js'
import css from './MessageAnnotations.module.css'

interface AnnotationInjected {
  readonly useAnnotations: SnapshotSelectorHook<ReviewFeedbackSnapshot>
  readonly annotations: ReviewFeedbackStore
}

type ComposerProps = PropsRuntime<'conversation.composer.above'> & InputZone & AnnotationInjected
type OverlayProps = PropsRuntime<'conversation.input.overlay'> & AnnotationInjected

interface SelectionDraft {
  readonly messageId: string
  readonly quote: string
  readonly range: Range
}

const SELECTION_STABILITY_DELAY_MS = 500

function feedbackQuote(item: ReviewFeedback): string {
  return item.source === 'assistant-message' ? item.selectedText : item.anchor.quote
}

function feedbackLabel(item: ReviewFeedback, index: number): string {
  if (item.source === 'assistant-message') return `对话引用 ${String(index + 1)}`
  const name = item.displayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.displayPath
  return `Markdown · ${name}`
}

function currentSelection(): SelectionDraft | undefined {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  const quote = selection.toString().trim()
  const messageId = quote === '' ? undefined : assistantMessageIdForRange(range)
  return messageId === undefined ? undefined : { messageId, quote, range: range.cloneRange() }
}

/** Composer-adjacent summary with a readable quote preview and independent removal. */
export function AnnotationStrip({ session, useAnnotations, annotations }: ComposerProps) {
  const snapshot = useAnnotations(value => value)
  const sessionId = String(session.sessionId)
  const items = snapshot.bySession.get(sessionId) ?? []
  const chipRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8, placement: 'above' })
  const placePreview = () => {
    const anchor = chipRef.current?.getBoundingClientRect()
    if (anchor === undefined) return setExpanded(false)
    const size = previewRef.current?.getBoundingClientRect() ?? { width: 264, height: 160 }
    setPosition(popoverPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight }, { preferAbove: true }))
  }
  useEffect(() => {
    if (!expanded) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (chipRef.current?.contains(target) !== true && previewRef.current?.contains(target) !== true) setExpanded(false)
    }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('keydown', closeEscape)
    }
  }, [expanded])
  useLayoutEffect(() => {
    if (!expanded) return
    placePreview()
    window.addEventListener('resize', placePreview)
    window.addEventListener('scroll', placePreview, true)
    return () => {
      window.removeEventListener('resize', placePreview)
      window.removeEventListener('scroll', placePreview, true)
    }
  }, [expanded, items.length])
  if (items.length === 0) return null
  const preview = !expanded ? null : <div ref={previewRef} className={`${css.panel} ${css.trayPopover}`} role="dialog" aria-label="批注预览" data-placement={position.placement} style={{ left: position.left, top: position.top }}>
    <header><strong>{items.length} 条批注</strong><button type="button" onClick={() => setExpanded(false)} aria-label="关闭批注预览">×</button></header>
    <ul>{items.map((item, index) => <li key={item.id}>
      <div><b title={item.source === 'workspace-markdown' ? item.displayPath : undefined}>{feedbackLabel(item, index)}</b><p className={css.trayQuote}>{feedbackQuote(item)}</p></div>
      <p className={css.trayComment}>{item.comment}</p>
      <button type="button" onClick={() => annotations.remove(sessionId, item.id)} aria-label={`删除第 ${index + 1} 条批注`}>删除</button>
    </li>)}</ul>
  </div>
  return <div className={css.tray}>
    <button ref={chipRef} type="button" className={css.trayChip} aria-label="查看批注" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{items.length} 条批注</button>
    {preview !== null && createPortal(preview, popoverPortalHost(document))}
  </div>
}

/** Selection-following annotation entry; only Range boundaries inside one assistant marker are accepted. */
export function AnnotationComposer({ sessionId, annotations }: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const selectionTimerRef = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<SelectionDraft | undefined>()
  const [editing, setEditing] = useState(false)
  const [comment, setComment] = useState('')
  const [position, setPosition] = useState({ left: 8, top: 8, placement: 'below' })
  const close = () => { setDraft(undefined); setEditing(false); setComment('') }
  const place = (next: SelectionDraft | undefined) => {
    if (next === undefined) return close()
    const anchor = selectionAnchor(next.range)
    if (shouldClosePopover({ rangeRectValid: anchor !== undefined })) return close()
    const size = panelRef.current?.getBoundingClientRect() ?? { width: editing ? 280 : 112, height: editing ? 188 : 34 }
    setPosition(popoverPosition(anchor!, size, { width: window.innerWidth, height: window.innerHeight }, { preferInline: !editing }))
  }
  useEffect(() => {
    const clearSelectionTimer = () => {
      if (selectionTimerRef.current === undefined) return
      window.clearTimeout(selectionTimerRef.current)
      selectionTimerRef.current = undefined
    }
    const select = () => {
      if (editing) return
      clearSelectionTimer()
      const next = currentSelection()
      if (next === undefined) return close()
      selectionTimerRef.current = window.setTimeout(() => {
        selectionTimerRef.current = undefined
        if (editing) return
        const stable = currentSelection()
        if (stable === undefined) return close()
        setDraft(stable)
        place(stable)
      }, SELECTION_STABILITY_DELAY_MS)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (shouldClosePopover({ key: event.key })) close() }
    const onPointerDown = (event: PointerEvent) => {
      if (shouldClosePopover({ targetInsidePanel: panelRef.current?.contains(event.target as Node) === true })) close()
    }
    document.addEventListener('selectionchange', select)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      clearSelectionTimer()
      document.removeEventListener('selectionchange', select)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [editing])
  useLayoutEffect(() => {
    if (draft === undefined) return
    const reposition = () => place(draft)
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [draft, editing])
  if (draft === undefined) return null
  const save = () => {
    annotations.add(sessionId, draft.messageId, draft.quote, comment)
    close()
  }
  const panel = <div ref={panelRef} className={`${css.panel} ${editing ? css.editorPanel : css.entryPanel}`} role="dialog" aria-label="添加批注" data-placement={position.placement} style={{ left: position.left, top: position.top }}>
    {editing ? <>
      <header><strong>添加批注</strong><button type="button" onClick={close} aria-label="关闭批注">×</button></header>
      <p className={css.selectionSummary}>已选择 {draft.quote.length} 字</p>
      <p className={css.selectionPreview}>{draft.quote}</p>
      <label>批注<textarea autoFocus value={comment} placeholder="说明你希望如何修改或处理这段内容" onChange={event => setComment(event.target.value)} /></label>
      <footer><button type="button" onClick={close}>取消</button><button type="button" disabled={comment.trim() === ''} onClick={save}>保存批注</button></footer>
    </> : <button type="button" className={css.entry} onMouseDown={event => event.preventDefault()} onClick={() => setEditing(true)}>添加批注</button>}
  </div>
  return createPortal(panel, popoverPortalHost(document))
}
