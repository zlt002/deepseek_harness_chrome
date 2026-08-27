import { useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerFileIntake } from './intake.ts'
import { ACCEPT } from './intake.ts'
import css from './AttachDocumentControl.module.css'

export interface AttachDocumentInjected {
  intake: ComposerFileIntake
}

type ControlProps = PropsRuntime<'conversation.input.left'> & InjectFace<AttachDocumentInjected>

/** Small paperclip in the composer tool row; paste and drop use the same intake. */
export function AttachDocumentControl({ sessionId, intake }: ControlProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        className={css.trigger}
        type="button"
        aria-label="附加文档"
        title="附加 Office、PDF 或常见文本/代码/配置文件"
        data-document-intake-control
        onMouseDown={event => { event.preventDefault() }}
        onClick={() => { inputRef.current?.click() }}
      >
        <span aria-hidden="true"><IconPaperclipOutline16 size={14} /></span>
      </button>
      <input
        ref={inputRef}
        className={css.hidden}
        type="file"
        multiple
        accept={ACCEPT}
        aria-hidden="true"
        tabIndex={-1}
        onChange={event => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          if (files.length === 0) return
          const rejected = intake.accept(sessionId, files)
          if (rejected !== null) window.alert(rejected)
        }}
      />
    </>
  )
}
