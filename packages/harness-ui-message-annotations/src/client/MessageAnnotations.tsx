import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnnotationSnapshot } from './AnnotationStore.ts'
import { AnnotationStore } from './AnnotationStore.ts'
import { shouldClosePopover } from './popover-close.js'
import { assistantMessageIdForRange, popoverPosition } from './selection-geometry.js'
import css from './MessageAnnotations.module.css'

interface AnnotationInjected {
  readonly useAnnotations: SnapshotSelectorHook<AnnotationSnapshot>
  readonly annotations: AnnotationStore
}

type ComposerProps = PropsRuntime<'conversation.composer.above'> & InputZone & AnnotationInjected
type OverlayProps = PropsRuntime<'conversation.input.overlay'> & AnnotationInjected

interface SelectionDraft {
  readonly messageId: string
  readonly quote: string
  readonly range: Range
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
  if (items.length === 0) return null
  return <details className={css.strip} open>
    <summary>{items.length} 条批注将随下一条消息发送</summary>
    <ul>{items.map((item, index) => <li key={item.id}>
      <div><b>引用 {index + 1}</b><q>{item.selectedText}</q></div>
      <p>{item.comment}</p>
      <button type="button" onClick={() => annotations.remove(sessionId, item.id)} aria-label={`删除第 ${index + 1} 条批注`}>删除</button>
    </li>)}</ul>
  </details>
}

/** Selection-following annotation entry; only Range boundaries inside one assistant marker are accepted. */
export function AnnotationComposer({ sessionId, annotations }: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<SelectionDraft | undefined>()
  const [editing, setEditing] = useState(false)
  const [comment, setComment] = useState('')
  const [position, setPosition] = useState({ left: 8, top: 8, placement: 'below' })
  const close = () => { setDraft(undefined); setEditing(false); setComment('') }
  const place = (next: SelectionDraft | undefined) => {
    if (next === undefined) return close()
    const rect = next.range.getBoundingClientRect()
    if (shouldClosePopover({ rangeRectValid: rect.width !== 0 || rect.height !== 0 })) return close()
    const size = panelRef.current?.getBoundingClientRect() ?? { width: editing ? 280 : 112, height: editing ? 188 : 34 }
    setPosition(popoverPosition(rect, size, { width: window.innerWidth, height: window.innerHeight }))
  }
  useEffect(() => {
    const select = () => { if (!editing) { const next = currentSelection(); setDraft(next); place(next) } }
    const onKeyDown = (event: KeyboardEvent) => { if (shouldClosePopover({ key: event.key })) close() }
    const onPointerDown = (event: PointerEvent) => {
      if (shouldClosePopover({ targetInsidePanel: panelRef.current?.contains(event.target as Node) === true })) close()
    }
    document.addEventListener('selectionchange', select)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
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
  return <div ref={panelRef} className={css.panel} role="dialog" aria-label="添加批注" data-placement={position.placement} style={{ left: position.left, top: position.top }}>
    {editing ? <>
      <header><strong>添加批注</strong><button type="button" onClick={close} aria-label="关闭批注">×</button></header>
      <blockquote>{draft.quote}</blockquote>
      <label>批注<textarea autoFocus value={comment} placeholder="说明你希望如何修改或处理这段内容" onChange={event => setComment(event.target.value)} /></label>
      <footer><button type="button" onClick={close}>取消</button><button type="button" disabled={comment.trim() === ''} onClick={save}>保存批注</button></footer>
    </> : <button type="button" className={css.entry} onMouseDown={event => event.preventDefault()} onClick={() => setEditing(true)}>添加批注</button>}
  </div>
}
