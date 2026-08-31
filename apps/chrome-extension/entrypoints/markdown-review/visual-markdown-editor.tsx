import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { acceptAllDiffsCmd, clearDiffReviewCmd, diffPluginKey, getPendingChanges, startDiffReviewCmd, startDiffReviewFromDocCmd } from '@milkdown/kit/plugin/diff'
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { endStreamingCmd, pushChunkCmd, startStreamingCmd } from '@milkdown/kit/plugin/streaming'
import { NodeSelection, Plugin, PluginKey, TextSelection, type Selection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type React from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { VisualSelection } from './visual-selection'
import { canRestoreVisualSelection, isCompleteTableMarkdown, visualSelectionFor } from './visual-selection'
import { renderMermaidSvg } from './mermaid-renderer.mjs'
import { fitMermaidPreview, wireMermaidFullscreen, wireMermaidViewer, wireMermaidViewToggle } from './mermaid-view.mjs'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'

export type AnnotationDeliveryStatus = 'sending' | 'queued' | 'processing' | 'candidate' | 'delivered' | 'failed'

export interface VisualReviewAnnotation {
  id: string
  selection: VisualSelection
  deliveryStatus: AnnotationDeliveryStatus | 'settled'
  comment?: string
  lastError?: string
}

type AnnotationPluginState = { annotations: VisualReviewAnnotation[]; decorations: DecorationSet }
const annotationPluginKey = new PluginKey<AnnotationPluginState>('markdown-review-annotations')

function deliveryLabel(annotation: VisualReviewAnnotation): string {
  if (annotation.deliveryStatus === 'sending') return '正在提交给 AI'
  if (annotation.deliveryStatus === 'queued') return '已排队，等待当前会话完成'
  if (annotation.deliveryStatus === 'processing') return 'AI 正在处理'
  if (annotation.deliveryStatus === 'candidate') return 'AI 候选已返回，等待审阅'
  if (annotation.deliveryStatus === 'settled') return '本次局部优化已结算'
  if (annotation.deliveryStatus === 'failed') return `提交给 AI 失败${annotation.lastError === undefined ? '' : `：${annotation.lastError}`}`
  return '已提交给 AI'
}

function annotationDecorations(
  doc: Parameters<typeof DecorationSet.create>[0],
  annotations: VisualReviewAnnotation[],
  current: DecorationSet = DecorationSet.empty,
  previousAnnotations: VisualReviewAnnotation[] = [],
): DecorationSet {
  const currentRanges = new Map<string, { from: number; to: number }>()
  for (const decoration of current.find()) {
    const annotationId = decoration.spec.reviewAnnotationId
    if (typeof annotationId === 'string') currentRanges.set(annotationId, { from: decoration.from, to: decoration.to })
  }
  const previousIds = new Set(previousAnnotations.map(({ id }) => id))
  return DecorationSet.create(doc, annotations.flatMap((annotation) => {
    const range = currentRanges.get(annotation.id)
      ?? (previousIds.has(annotation.id) ? undefined : annotation.selection)
    if (range === undefined) return []
    const { from, to } = range
    if (from < 0 || to <= from || to > doc.content.size) return []
    return [Decoration.inline(from, to, {
      class: `review-annotation-highlight is-${annotation.deliveryStatus}`,
      'data-review-annotation-id': annotation.id,
      title: deliveryLabel(annotation),
    }, { reviewAnnotationId: annotation.id })]
  }))
}

const reviewAnnotationPlugin = $prose(() => new Plugin<AnnotationPluginState>({
  key: annotationPluginKey,
  state: {
    init: () => ({ annotations: [], decorations: DecorationSet.empty }),
    apply: (transaction, value) => {
      const mapped = value.decorations.map(transaction.mapping, transaction.doc)
      const annotations = transaction.getMeta(annotationPluginKey) as VisualReviewAnnotation[] | undefined
      if (annotations !== undefined) {
        return {
          annotations,
          decorations: annotationDecorations(transaction.doc, annotations, mapped, value.annotations),
        }
      }
      return { annotations: value.annotations, decorations: mapped }
    },
  },
  props: { decorations: (state) => annotationPluginKey.getState(state)?.decorations ?? DecorationSet.empty },
}))

function mermaidPreview(source: string, sourceId: string): HTMLElement {
  const block = document.createElement('section')
  block.className = 'mermaid-block'
  block.setAttribute('contenteditable', 'false')
  block.dataset.mermaidSource = sourceId
  const controls = document.createElement('div')
  controls.className = 'mermaid-view-toggle'
  controls.setAttribute('role', 'group')
  controls.setAttribute('aria-label', 'Mermaid 显示方式')
  const visualButton = document.createElement('button')
  visualButton.type = 'button'
  visualButton.textContent = '可视化'
  const sourceButton = document.createElement('button')
  sourceButton.type = 'button'
  sourceButton.textContent = '源码'
  const viewerControls = document.createElement('div')
  viewerControls.className = 'mermaid-viewer-controls'
  viewerControls.setAttribute('role', 'group')
  viewerControls.setAttribute('aria-label', 'Mermaid 查看器')
  const zoomOutButton = document.createElement('button')
  zoomOutButton.type = 'button'
  zoomOutButton.textContent = '−'
  zoomOutButton.title = '缩小'
  zoomOutButton.setAttribute('aria-label', '缩小流程图')
  const zoomInButton = document.createElement('button')
  zoomInButton.type = 'button'
  zoomInButton.textContent = '+'
  zoomInButton.title = '放大'
  zoomInButton.setAttribute('aria-label', '放大流程图')
  const resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.textContent = '适应'
  resetButton.title = '重置并适应画布'
  resetButton.setAttribute('aria-label', '重置并适应流程图')
  const fullscreenButton = document.createElement('button')
  fullscreenButton.type = 'button'
  fullscreenButton.textContent = '全屏'
  fullscreenButton.title = '全屏查看流程图'
  fullscreenButton.setAttribute('aria-label', '全屏查看流程图')
  const closeFullscreenButton = document.createElement('button')
  closeFullscreenButton.type = 'button'
  closeFullscreenButton.textContent = '退出全屏'
  closeFullscreenButton.title = '退出全屏查看'
  closeFullscreenButton.setAttribute('aria-label', '退出全屏查看流程图')
  closeFullscreenButton.hidden = true
  const toolbar = document.createElement('div')
  toolbar.className = 'mermaid-toolbar'
  const preview = document.createElement('div')
  preview.className = 'mermaid-preview mermaid-loading'
  preview.textContent = '正在渲染 Mermaid 图…'
  const setView = wireMermaidViewToggle(block, sourceId, visualButton, sourceButton)
  controls.append(visualButton, sourceButton)
  viewerControls.append(zoomOutButton, zoomInButton, resetButton, fullscreenButton, closeFullscreenButton)
  toolbar.append(controls, viewerControls)
  block.append(toolbar, preview)
  setView('visual')
  void renderMermaidSvg(source).then((svg) => {
    preview.className = 'mermaid-preview'
    preview.replaceChildren()
    const canvas = document.createElement('div')
    canvas.className = 'mermaid-canvas'
    // `renderMermaidSvg` parses and removes executable/external SVG content.
    canvas.insertAdjacentHTML('afterbegin', svg)
    preview.append(canvas)
    fitMermaidPreview(preview)
    wireMermaidViewer(block, preview, canvas, zoomInButton, zoomOutButton, resetButton)
    wireMermaidFullscreen(block, fullscreenButton, closeFullscreenButton, visualButton, sourceButton)
  }).catch(() => {
    preview.className = 'mermaid-preview mermaid-fallback'
    preview.replaceChildren('Mermaid 图无法渲染；已保留源码。')
    setView('source')
  })
  return block
}

/** Renders a non-editable, sanitized preview after each Mermaid source block. */
const mermaidPreviewPlugin = $prose(() => new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = []
      state.doc.descendants((node, position) => {
        if (node.type.name === 'code_block' && node.attrs.language === 'mermaid' && node.textContent.trim() !== '') {
          const sourceId = `mermaid-source-${position}`
          decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'mermaid-source-hidden', 'data-mermaid-source': sourceId }))
          // Before the node keeps the toolbar above both the visual canvas and
          // the revealed code block; after-node widgets jump below source mode.
          decorations.push(Decoration.widget(position, () => mermaidPreview(node.textContent, sourceId), { side: -1, key: `mermaid:${position}:${node.textContent}` }))
        }
      })
      return DecorationSet.create(state.doc, decorations)
    },
  },
}))

export interface VisualMarkdownEditorHandle {
  reviewCandidateMarkdown: (candidateMarkdown: string) => boolean
  reviewSelectionReplacement: (selection: VisualSelection, replacementMarkdown: string) => boolean
  acceptCandidate: () => boolean
  rejectCandidate: () => boolean
  isCandidateReviewActive: () => boolean
  isReady: () => boolean
  undo: () => boolean
  redo: () => boolean
  getMarkdown: () => string
}

export interface VisualMarkdownEditorProps {
  initialMarkdown: string
  readOnly: boolean
  annotations: VisualReviewAnnotation[]
  canAnnotate: boolean
  onSubmitAnnotation: (selection: VisualSelection, comment: string) => boolean
  onRetryAnnotation: (annotationId: string) => void
  onSettleAnnotation: (annotationId: string) => void
  onMarkdownChange: (markdown: string) => void
  onSelectionChange?: (selection: VisualSelection | undefined) => void
  onCandidateReviewChange?: (active: boolean) => void
  onReady?: () => void
}

type FloatingSelection = VisualSelection & { top: number; left: number; menuMaxWidth: number }

const AI_SELECTION_QUICK_ACTIONS = [
  { id: 'polish', label: '润色', instruction: '润色所选内容：提升表达清晰度与专业性，保持原意、事实和现有 Markdown 结构。' },
  { id: 'concise', label: '精简', instruction: '精简所选内容：删除冗余表达，保留关键信息、约束和现有 Markdown 结构。' },
  { id: 'expand', label: '扩写', instruction: '扩写所选内容：补充必要细节与上下文，不虚构事实，并保持现有 Markdown 结构。' },
  { id: 'acceptance', label: '转验收标准', instruction: '将所选内容改写为清晰、可验证的验收标准，保留原有约束并使用合适的 Markdown 结构。' },
] as const

function selectionLimitMessage(selection: VisualSelection): string | undefined {
  if (selection.limitReason === 'quote_too_long') return '选区超过 8,000 字，请缩小范围'
  if (selection.limitReason === 'too_many_blocks') return '选区超过 24 个内容块，请缩小范围'
  if (selection.limitReason === 'multiple_tables') return '一次只能批注一张表格，请缩小选区'
  if (selection.limitReason === 'invalid_table_structure') return '该表格结构无法安全修改，请改用完整、规范的 Markdown 表格'
  if (selection.limitReason === 'table_context_too_large') return '表格内容过大，暂不能安全提交给 AI；请缩小到一张较小表格'
  return undefined
}

function floatingSelectionFor(view: EditorView, selection: Selection, editorRevision: number): FloatingSelection | undefined {
  const visualSelection = visualSelectionFor(view.state.doc, selection, editorRevision)
  if (visualSelection === undefined) return undefined
  // `head` is the end where the user's pointer/caret actually stopped. Using
  // `to` makes a reverse drag place the action at the opposite end of the range.
  const anchor = view.coordsAtPos(selection.head)
  const shell = view.dom.closest<HTMLElement>('.visual-editor-shell')
  const shellBounds = shell?.getBoundingClientRect()
  if (shellBounds === undefined) return undefined
  const menuMaxWidth = Math.min(520, Math.max(0, shellBounds.width - 16))
  return {
    ...visualSelection,
    top: Math.min(window.innerHeight - 44, anchor.bottom + 8),
    left: Math.max(shellBounds.left + 8, Math.min(anchor.left, shellBounds.right - menuMaxWidth - 8)),
    menuMaxWidth,
  }
}

function currentVisualSelection(view: EditorView): Selection {
  const domSelection = window.getSelection()
  if (
    domSelection === null
    || domSelection.isCollapsed
    || domSelection.anchorNode === null
    || domSelection.focusNode === null
    || !view.dom.contains(domSelection.anchorNode)
    || !view.dom.contains(domSelection.focusNode)
  ) return view.state.selection

  try {
    const anchor = view.posAtDOM(domSelection.anchorNode, domSelection.anchorOffset)
    const head = view.posAtDOM(domSelection.focusNode, domSelection.focusOffset)
    return anchor === head ? view.state.selection : TextSelection.create(view.state.doc, anchor, head)
  } catch (error: unknown) {
    // A NodeView may replace itself between selectionchange and pointerup.
    // Falling back to the editor state keeps that transient DOM race harmless.
    return view.state.selection
  }
}

/** A Markdown-first WYSIWYG surface. It never receives a Host disk capability. */
export const VisualMarkdownEditor = forwardRef<VisualMarkdownEditorHandle, VisualMarkdownEditorProps>(function VisualMarkdownEditor({ initialMarkdown, readOnly, annotations, canAnnotate, onSubmitAnnotation, onRetryAnnotation, onSettleAnnotation, onMarkdownChange, onSelectionChange, onCandidateReviewChange, onReady }, ref): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const crepeRef = useRef<Crepe | undefined>(undefined)
  const lifecycleRef = useRef<Promise<void>>(Promise.resolve())
  const editorReadyRef = useRef(false)
  const revisionRef = useRef(0)
  const selectionFrameRef = useRef<number | undefined>(undefined)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onCandidateReviewChangeRef = useRef(onCandidateReviewChange)
  const onReadyRef = useRef(onReady)
  const annotationsRef = useRef(annotations)
  const composerOpenRef = useRef(false)
  const floatingSelectionRef = useRef<FloatingSelection | undefined>(undefined)
  const [floatingSelection, setFloatingSelection] = useState<FloatingSelection>()
  const [composerOpen, setComposerOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [annotationStatus, setAnnotationStatus] = useState<{ annotationId: string; top: number; left: number }>()
  onMarkdownChangeRef.current = onMarkdownChange
  onSelectionChangeRef.current = onSelectionChange
  onCandidateReviewChangeRef.current = onCandidateReviewChange
  onReadyRef.current = onReady
  annotationsRef.current = annotations
  composerOpenRef.current = composerOpen
  floatingSelectionRef.current = floatingSelection

  const captureSelection = () => {
    if (selectionFrameRef.current !== undefined) window.cancelAnimationFrame(selectionFrameRef.current)
    const capture = () => {
      selectionFrameRef.current = undefined
      const root = rootRef.current
      const crepe = crepeRef.current
      if (root === null || crepe === undefined || !editorReadyRef.current) return
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const selection = floatingSelectionFor(view, currentVisualSelection(view), revisionRef.current)
        onSelectionChangeRef.current?.(selection)
        if (selection === undefined) {
          if (!composerOpenRef.current) setFloatingSelection(undefined)
          return
        }
        setFloatingSelection(selection)
        setAnnotationStatus(undefined)
      })
    }
    selectionFrameRef.current = window.requestAnimationFrame(capture)
  }

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let disposed = false
    let created = false
    editorReadyRef.current = false
    const crepe = new Crepe({ root, defaultValue: initialMarkdown, features: { [CrepeFeature.AI]: true } })
    crepe.editor.use(reviewAnnotationPlugin)
    crepe.editor.use(mermaidPreviewPlugin)
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        revisionRef.current += 1
        onMarkdownChangeRef.current(markdown)
      })
      listener.selectionUpdated(() => {
        // Crepe can emit selection events before its ProseMirror view exists.
        // DOM/pointer events will capture the selection once the editor is ready.
        if (editorReadyRef.current) captureSelection()
      })
      listener.updated((ctx) => onCandidateReviewChangeRef.current?.(diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active === true))
    })
    const pointerup = () => captureSelection()
    const keyup = () => captureSelection()
    const reposition = () => { if (floatingSelectionRef.current !== undefined) captureSelection() }
    root.addEventListener('pointerup', pointerup)
    root.addEventListener('keyup', keyup)
    root.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
    const createTask = lifecycleRef.current.catch(() => undefined).then(async () => {
      if (disposed) return
      crepeRef.current = crepe
      try {
        await crepe.create()
        created = true
      } catch (error: unknown) {
        if (!disposed) console.error('[markdown-review] failed to create visual editor', error)
        return
      }
      if (disposed) return
      editorReadyRef.current = true
      crepe.setReadonly(readOnly)
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.setMeta(annotationPluginKey, annotationsRef.current))
      })
      onReadyRef.current?.()
    })
    lifecycleRef.current = createTask
    return () => {
      disposed = true
      editorReadyRef.current = false
      if (selectionFrameRef.current !== undefined) window.cancelAnimationFrame(selectionFrameRef.current)
      root.removeEventListener('pointerup', pointerup)
      root.removeEventListener('keyup', keyup)
      root.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
      const teardownTask = createTask.then(async () => {
        if (crepeRef.current === crepe) crepeRef.current = undefined
        if (!created) {
          root.replaceChildren()
          return
        }
        try {
          await crepe.destroy()
        } catch (error: unknown) {
          console.error('[markdown-review] failed to destroy visual editor', error)
        }
      })
      lifecycleRef.current = teardownTask
    }
  // The parent intentionally remounts this component for a new Host snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { crepeRef.current?.setReadonly(readOnly) }, [readOnly])
  useEffect(() => {
    if (!editorReadyRef.current) return
    crepeRef.current?.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.setMeta(annotationPluginKey, annotations))
    })
  }, [annotations])

  useImperativeHandle(ref, (): VisualMarkdownEditorHandle => {
    const readyCrepe = (): Crepe | undefined => editorReadyRef.current ? crepeRef.current : undefined
    const reportCandidateState = (crepe: Crepe): boolean => {
      const active = crepe.editor.action((ctx) => diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active === true)
      onCandidateReviewChangeRef.current?.(active)
      return active
    }
    return {
      reviewCandidateMarkdown(candidateMarkdown) {
        const crepe = readyCrepe()
        if (crepe === undefined || candidateMarkdown.length > 2_000_000) return false
        const started = crepe.editor.action((ctx) => ctx.get(commandsCtx).call(startDiffReviewCmd.key, candidateMarkdown))
        if (started) reportCandidateState(crepe)
        return started
      },
      reviewSelectionReplacement(selection, replacementMarkdown) {
        const crepe = readyCrepe()
        if (crepe === undefined || replacementMarkdown.length > 2_000_000) return false
        if (selection.table !== undefined && !isCompleteTableMarkdown(replacementMarkdown, selection.table.columnCount)) return false
        const started = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          if (!canRestoreVisualSelection(view.state.doc, selection, revisionRef.current)) return false
          const commands = ctx.get(commandsCtx)
          const replacementFrom = selection.table?.from ?? selection.from
          const replacementTo = selection.table?.to ?? selection.to
          if (replacementMarkdown === '') {
            // `pushChunkCmd('')` has no candidate document to hand to the diff
            // plugin. A deletion is nevertheless a real proposal, so create its
            // candidate directly and enter the same review state as any other AI edit.
            const candidateDoc = view.state.tr.delete(replacementFrom, replacementTo).doc
            return commands.call(startDiffReviewFromDocCmd.key, candidateDoc)
          }

          // This proposal has already finished streaming from the Harness. Build
          // its candidate in a detached EditorState, then start review against the
          // untouched visible document. That prevents an intermediate full-document
          // restore from dropping inline review decorations.
          const candidateSelection = selection.table === undefined
            ? TextSelection.create(view.state.doc, replacementFrom, replacementTo)
            : NodeSelection.create(view.state.doc, replacementFrom)
          let candidateState = view.state.apply(view.state.tr.setSelection(candidateSelection))
          const callOnCandidate = <Payload,>(key: Parameters<typeof commands.get>[0], payload: Payload): boolean => {
            const command = commands.get(key)(payload)
            return command(candidateState, (transaction) => { candidateState = candidateState.apply(transaction) })
          }
          return callOnCandidate(startStreamingCmd.key, { insertAt: 'selection' })
            && callOnCandidate(pushChunkCmd.key, replacementMarkdown)
            && callOnCandidate(endStreamingCmd.key, { diffReview: true })
        })
        return started && reportCandidateState(crepe)
      },
      acceptCandidate() {
        const crepe = readyCrepe()
        if (crepe === undefined) return false
        const accepted = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const diffState = diffPluginKey.getState(view.state)
          if (diffState === null || diffState === undefined) return false

          // The upstream fast path replaces the whole document, which makes every
          // inline annotation decoration look deleted. Applying the non-overlapping
          // diff ranges from back to front gives ProseMirror one mapping to preserve
          // unrelated annotations, while still keeping this acceptance as one undo.
          let tr = view.state.tr
          for (const change of [...getPendingChanges(diffState)].reverse()) {
            const newContent = diffState.newDoc.slice(change.fromB, change.toB)
            tr = tr.replace(change.fromA, change.toA, newContent)
          }
          view.dispatch(tr.setMeta(diffPluginKey, { type: 'acceptAll' }))
          return true
        })
        return accepted && !reportCandidateState(crepe)
      },
      rejectCandidate() {
        const crepe = readyCrepe()
        if (crepe === undefined) return false
        const rejected = crepe.editor.action((ctx) => ctx.get(commandsCtx).call(clearDiffReviewCmd.key))
        if (rejected) reportCandidateState(crepe)
        return rejected
      },
      isCandidateReviewActive() {
        const crepe = readyCrepe()
        return crepe === undefined ? false : crepe.editor.action((ctx) => diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active === true)
      },
      isReady: () => editorReadyRef.current,
      undo: () => readyCrepe()?.editor.action((ctx) => ctx.get(commandsCtx).call(undoCommand.key)) ?? false,
      redo: () => readyCrepe()?.editor.action((ctx) => ctx.get(commandsCtx).call(redoCommand.key)) ?? false,
      getMarkdown: () => readyCrepe()?.getMarkdown() ?? initialMarkdown,
    }
  }, [initialMarkdown])

  const preserveSelection = (event: React.PointerEvent | React.MouseEvent) => { event.preventDefault(); event.stopPropagation() }
  const submitAnnotation = (event: React.FormEvent) => {
    event.preventDefault()
    if (floatingSelection === undefined || floatingSelection.limitReason !== undefined || comment.trim() === '' || !canAnnotate) return
    if (onSubmitAnnotation(floatingSelection, comment.trim())) {
      setComment(''); setComposerOpen(false); setFloatingSelection(undefined)
    }
  }
  const submitQuickAction = (instruction: string) => {
    if (floatingSelection === undefined || floatingSelection.limitReason !== undefined || !canAnnotate) return
    if (onSubmitAnnotation(floatingSelection, instruction)) {
      setComment(''); setComposerOpen(false); setFloatingSelection(undefined)
    }
  }
  const showAnnotationStatus = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-review-annotation-id]') : null
    const annotation = annotations.find((item) => item.id === target?.dataset.reviewAnnotationId)
    if (annotation !== undefined) setAnnotationStatus({
      annotationId: annotation.id,
      top: Math.max(8, Math.min(window.innerHeight - 176, event.clientY + 12)),
      left: Math.max(8, Math.min(window.innerWidth - 368, event.clientX + 8)),
    })
  }
  const statusAnnotation = annotations.find((item) => item.id === annotationStatus?.annotationId)
  const selectionLimit = floatingSelection === undefined ? undefined : selectionLimitMessage(floatingSelection)

  return <div className="visual-editor-shell">
    <div ref={rootRef} className="visual-markdown-editor" aria-label="可视化 Markdown 编辑器" onClick={showAnnotationStatus} />
    {floatingSelection !== undefined && selectionLimit !== undefined && <div className="selection-limit-notice" role="alert" style={{ top: floatingSelection.top, left: Math.max(8, Math.min(floatingSelection.left, window.innerWidth - 300)) }}>{selectionLimit}</div>}
    {floatingSelection !== undefined && selectionLimit === undefined && !composerOpen && <div className="selection-action-menu" role="toolbar" aria-label="AI 修改选中内容" style={{ top: floatingSelection.top, left: floatingSelection.left, maxWidth: floatingSelection.menuMaxWidth }} onPointerDown={preserveSelection} onMouseDown={preserveSelection}>
      {AI_SELECTION_QUICK_ACTIONS.map((action) => <button key={action.id} className="selection-quick-action" type="button" title={action.instruction} onClick={() => submitQuickAction(action.instruction)} disabled={!canAnnotate}>{action.label}</button>)}
      <button className="selection-action is-comment" type="button" aria-label="添加自定义批注" onClick={() => setComposerOpen(true)} disabled={!canAnnotate}>批注…</button>
    </div>}
    {floatingSelection !== undefined && selectionLimit === undefined && composerOpen && <form className="annotation-composer" style={{ top: Math.min(floatingSelection.top, window.innerHeight - 230), left: Math.max(8, Math.min(floatingSelection.left, window.innerWidth - 352)) }} onPointerDown={(event) => event.stopPropagation()} onSubmit={submitAnnotation}>
      <strong>针对所选内容批注</strong><blockquote>{floatingSelection.quote}</blockquote>
      <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} maxLength={8_000} placeholder="告诉 AI 希望如何修改" />
      <footer><button className="secondary" type="button" onClick={() => { setComposerOpen(false); setComment('') }}>取消</button><button type="submit" disabled={comment.trim() === '' || !canAnnotate}>提交给 AI</button></footer>
    </form>}
    {annotationStatus !== undefined && statusAnnotation !== undefined && <aside className={`annotation-status-popover is-${statusAnnotation.deliveryStatus}`} style={{ top: annotationStatus.top, left: annotationStatus.left }} aria-label="批注详情">
      <header><strong>AI 批注</strong><span>{deliveryLabel(statusAnnotation)}</span><button type="button" className="secondary" aria-label="关闭批注详情" onClick={() => setAnnotationStatus(undefined)}>×</button></header>
      {statusAnnotation.comment !== undefined && <p>{statusAnnotation.comment}</p>}
      {statusAnnotation.deliveryStatus === 'failed' && <footer><button type="button" className="secondary" onClick={() => onSettleAnnotation(statusAnnotation.id)}>放弃本次优化</button><button type="button" onClick={() => onRetryAnnotation(statusAnnotation.id)}>重新发送</button></footer>}
    </aside>}
  </div>
})
