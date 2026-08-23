import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import {
  acceptAllDiffsCmd,
  clearDiffReviewCmd,
  diffPluginKey,
  startDiffReviewCmd,
} from '@milkdown/kit/plugin/diff'
import { endStreamingCmd, pushChunkCmd, startStreamingCmd } from '@milkdown/kit/plugin/streaming'
import { TextSelection } from '@milkdown/kit/prose/state'
import type React from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { VisualSelection } from './visual-selection'
import { canRestoreVisualSelection, visualSelectionFor } from './visual-selection'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/classic.css'

export interface VisualMarkdownEditorHandle {
  /** Starts Milkdown's first-party, in-document candidate diff review. */
  reviewCandidateMarkdown: (candidateMarkdown: string) => boolean
  /** Replaces the live visual selection through first-party streaming + diff. */
  reviewSelectionReplacement: (selection: VisualSelection, replacementMarkdown: string) => boolean
  acceptCandidate: () => boolean
  /** Rejects all pending candidate changes and restores editable state. */
  rejectCandidate: () => boolean
  isCandidateReviewActive: () => boolean
  getMarkdown: () => string
}

export interface VisualMarkdownEditorProps {
  initialMarkdown: string
  readOnly: boolean
  onMarkdownChange: (markdown: string) => void
  onSelectionChange: (selection: VisualSelection | undefined) => void
  onCandidateReviewChange?: (active: boolean) => void
}

/**
 * A Markdown-first WYSIWYG surface. This owns only the in-Tab draft and never
 * receives a Host capability or performs any disk write.
 */
export const VisualMarkdownEditor = forwardRef<VisualMarkdownEditorHandle, VisualMarkdownEditorProps>(function VisualMarkdownEditor({ initialMarkdown, readOnly, onMarkdownChange, onSelectionChange, onCandidateReviewChange }, ref): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const crepeRef = useRef<Crepe | undefined>(undefined)
  const revisionRef = useRef(0)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onCandidateReviewChangeRef = useRef(onCandidateReviewChange)
  onMarkdownChangeRef.current = onMarkdownChange
  onSelectionChangeRef.current = onSelectionChange
  onCandidateReviewChangeRef.current = onCandidateReviewChange

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown,
      features: {
        // AI is enabled without an LLM provider: it supplies the audited
        // first-party streaming/diff transaction API only.
        [CrepeFeature.AI]: true,
      },
    })
    crepeRef.current = crepe
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        revisionRef.current += 1
        onMarkdownChangeRef.current(markdown)
      })
      listener.selectionUpdated((ctx, selection) => {
        const visual = ctx.get(editorViewCtx).state.doc
        onSelectionChangeRef.current(visualSelectionFor(visual, selection, revisionRef.current))
      })
      listener.updated((ctx) => {
        const active = diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active === true
        onCandidateReviewChangeRef.current?.(active)
      })
    })
    void crepe.create().then(() => crepe.setReadonly(readOnly))
    return () => {
      if (crepeRef.current === crepe) crepeRef.current = undefined
      void crepe.destroy()
    }
  // The parent intentionally remounts this component when a new Host snapshot arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { crepeRef.current?.setReadonly(readOnly) }, [readOnly])

  useImperativeHandle(ref, (): VisualMarkdownEditorHandle => ({
    reviewCandidateMarkdown(candidateMarkdown) {
      const crepe = crepeRef.current
      if (crepe === undefined || candidateMarkdown.length > 2_000_000) return false
      return crepe.editor.action((ctx) => ctx.get(commandsCtx).call(startDiffReviewCmd.key, candidateMarkdown))
    },
    reviewSelectionReplacement(selection, replacementMarkdown) {
      const crepe = crepeRef.current
      if (crepe === undefined || replacementMarkdown.length > 2_000_000) return false
      // Crepe's AI feature exposes first-party streaming; use a single chunk
      // for an externally supplied completed replacement, then enter diff.
      return crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        if (!canRestoreVisualSelection(view.state.doc, selection, revisionRef.current)) return false
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.from, selection.to)))
        const commands = ctx.get(commandsCtx)
        const start = commands.call(startStreamingCmd.key, { insertAt: 'selection' })
        return start
          && commands.call(pushChunkCmd.key, replacementMarkdown)
          && commands.call(endStreamingCmd.key, { diffReview: true })
      })
    },
    acceptCandidate() {
      const crepe = crepeRef.current
      return crepe === undefined ? false : crepe.editor.action((ctx) => ctx.get(commandsCtx).call(acceptAllDiffsCmd.key))
    },
    rejectCandidate() {
      const crepe = crepeRef.current
      return crepe === undefined ? false : crepe.editor.action((ctx) => ctx.get(commandsCtx).call(clearDiffReviewCmd.key))
    },
    isCandidateReviewActive() {
      const crepe = crepeRef.current
      return crepe === undefined ? false : crepe.editor.action((ctx) => diffPluginKey.getState(ctx.get(editorViewCtx).state)?.active === true)
    },
    getMarkdown() { return crepeRef.current?.getMarkdown() ?? initialMarkdown },
  }), [initialMarkdown])

  return <div ref={rootRef} className="visual-markdown-editor" aria-label="可视化 Markdown 编辑器" />
})
