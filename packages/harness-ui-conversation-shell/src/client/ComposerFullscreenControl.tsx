import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutline16, IconFullscreenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ComposerFullscreenControl.module.css'

export interface ComposerFullscreenControlInjected {
  readonly hooks: { composerFullscreen: SnapshotStore<boolean> }
  readonly toggleComposerFullscreen: () => void
  readonly exitComposerFullscreen: () => void
}

type Props = PropsRuntime<'conversation.input.right'> & InjectFace<ComposerFullscreenControlInjected>

/** Expands only the composer surface; it never requests browser or tab fullscreen. */
export function ComposerFullscreenControl({ useComposerFullscreen, toggleComposerFullscreen, exitComposerFullscreen }: Props) {
  const fullscreen = useComposerFullscreen(value => value)

  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') exitComposerFullscreen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [exitComposerFullscreen, fullscreen])

  const label = fullscreen ? '退出输入框全屏（Esc）' : '全屏编辑输入内容'
  return <Tooltip label={label} side="top" delayMs={500}>
    <button
      className={css.control}
      type="button"
      aria-label={label}
      aria-pressed={fullscreen}
      data-composer-fullscreen-control
      onMouseDown={event => { event.preventDefault() }}
      onClick={toggleComposerFullscreen}
    >
      {fullscreen ? <IconCloseOutline16 size={16} /> : <IconFullscreenOutline16 size={16} />}
    </button>
  </Tooltip>
}
