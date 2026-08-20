import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import type React from 'react'

export interface SourceEditorProps {
  value: string
  onChange: (value: string) => void
  onSelectionChange: (startUtf16: number, endUtf16: number) => void
}

/**
 * CodeMirror positions are JavaScript UTF-16 code-unit offsets.  Keeping this
 * seam separate makes the M1 anchoring contract explicit and lets a later
 * editor replacement prove the same positional guarantee in one place.
 */
export function SourceEditor({ value, onChange, onSelectionChange }: SourceEditorProps): React.JSX.Element {
  return <CodeMirror
    className="source-editor"
    value={value}
    height="100%"
    extensions={[markdown()]}
    basicSetup={{ lineNumbers: true, highlightActiveLineGutter: true, foldGutter: false }}
    onChange={(next, update) => {
      onChange(next)
      const selection = update.state.selection.main
      onSelectionChange(selection.from, selection.to)
    }}
    onUpdate={(update) => {
      if (!update.selectionSet) return
      const selection = update.state.selection.main
      onSelectionChange(selection.from, selection.to)
    }}
  />
}
