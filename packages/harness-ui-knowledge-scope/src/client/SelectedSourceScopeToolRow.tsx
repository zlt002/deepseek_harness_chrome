import { useEffect, useState } from 'react'
import { DisclosureRow, IconSearchOutline16, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { friendlySearchError } from './error-message.js'
import css from './SelectedSourceScopeToolRow.module.css'

function resultText(block: ToolCallViewProps['block']): string {
  if (block.kind !== 'tool-result') return ''
  return block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Localized presentation for the read-only selected-source scope echo. */
export function SelectedSourceScopeToolRow({ block, inspect }: ToolCallViewProps) {
  const running = block.kind !== 'tool-result'
  const failed = block.kind === 'tool-result' && block.isError
  const text = resultText(block)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (failed) setExpanded(true)
  }, [failed])
  const displayText = failed ? friendlySearchError(text) : text
  const summary = text === ''
    ? running ? '正在读取已选范围…' : failed ? '读取范围失败' : '已读取范围'
    : firstLine(displayText)
  const expandable = displayText !== ''

  return (
    <div className={css.root} data-state={running ? 'running' : failed ? 'error' : 'ok'}>
      <DisclosureRow
        rowClassName={css.row}
        titleClassName={css.title}
        icon={failed ? <StateDot state="error" /> : <IconSearchOutline16 size={14} />}
        title="已选远程范围"
        open={expandable && expanded}
        expandable={expandable}
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={<span className={css.summary} title={summary}>{summary}</span>}
      >
        <div className={css.body}><MarkdownText text={displayText} streaming={running} /></div>
      </DisclosureRow>
      {expanded && inspect !== undefined && <button className={css.inspect} type="button" onClick={inspect}>查看详情</button>}
    </div>
  )
}
