import { useEffect, useRef, useState } from 'react'
import {
  DisclosureRow, IconSearchOutline16, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SearchProgress } from './bridge.ts'
import css from './RemoteSearchToolRow.module.css'

interface RemoteSearchToolInjected {
  hooks: { searchProgress: SnapshotStore<readonly SearchProgress[]> }
}

type RemoteSearchToolProps = ToolCallViewProps & InjectFace<RemoteSearchToolInjected>

function settledText(block: RemoteSearchToolProps['block']): string {
  if (block.kind !== 'tool-result') return ''
  return block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('')
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

function friendlySearchError(text: string): string {
  if (text.includes('knowledge_scope_requires_domain') || text.includes('没有选择知识范围')) return '还没选择知识范围，请先点「选择知识范围」'
  if (text.includes('knowledge_scope_requires_repository') || text.includes('没有选择远程代码库')) return '还没选择代码库，请先点「选择代码库」'
  if (text.includes('knowledge_query_disabled') || text.includes('知识查询开关已关闭')) return '知识查询开关已关闭'
  if (text.includes('knowledge_scope_missing') || text.includes('还没有知识/代码范围记录')) return '当前会话还没有选择远程范围'
  if (text.includes('knowledge_login_required')) return '知识库登录已失效，请重新登录'
  if (text.includes('空闲超时') || text.includes('UND_ERR_BODY_TIMEOUT')) return '远程检索流因空闲超时中断，请重试一次'
  if (text.includes('网络传输中断') || text.includes('fetch failed') || text.includes('Failed to fetch')) return '远程检索流中断，请重试一次'
  return text.replace(/^Error:\s*/u, '')
}

function waitingSummary(kind: 'code_search' | 'knowledge_search', eventType: string | undefined, seconds: number, process?: string): string {
  if (process !== undefined && process.trim().length > 0) return latestLine(process)
  const waited = seconds > 0 ? `已等待 ${seconds} 秒，` : ''
  if (eventType === 'connected' || eventType === 'reasoning' || eventType === 'thinking' || eventType === 'thought' || eventType === 'agent_thought') {
    return `${waited}${kind === 'code_search' ? '远程仓库正在检索，首个结果还没返回…' : '知识库正在检索，首个结果还没返回…'}`
  }
  return seconds >= 8
    ? `${waited}${kind === 'code_search' ? '远程仓库仍在检索，尚未返回正文…' : '知识库仍在检索，尚未返回正文…'}`
    : '正在连接远程检索服务…'
}

/** Selected-source Tool row whose running body follows extension SSE checkpoints. */
export function RemoteSearchToolRow({ toolName, block, sessionId, useSearchProgress, inspect }: RemoteSearchToolProps) {
  const progress = useSearchProgress(value => value)
  const running = block.kind !== 'tool-result'
  const expectedTool = toolName === 'search_selected_remote_code' || toolName === 'mcp__chrome__code_search' ? 'code_search' : 'knowledge_search'
  const matches = running ? progress.filter(item => item.tool === expectedTool && (item.harnessSessionId === sessionId || item.harnessParentSessionId === sessionId)) : []
  const [binding, setBinding] = useState<{ callId: string; requestId: string } | undefined>(undefined)
  const candidate = binding?.callId === block.callId
    ? matches.find(item => item.requestId === binding.requestId)
    : matches.at(-1)
  useEffect(() => {
    if (candidate === undefined || binding?.callId === block.callId) return
    setBinding({ callId: block.callId, requestId: candidate.requestId })
  }, [binding, block.callId, candidate])
  const live = binding?.callId === block.callId ? candidate : undefined
  const text = live?.content ?? settledText(block)
  const process = live?.process ?? ''
  const active = running && (live === undefined || live.phase === 'querying' || live.phase === 'streaming')
  const failed = block.kind === 'tool-result' && block.isError
  const title = expectedTool === 'code_search' ? '远程代码检索' : '知识库检索'
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active || text !== '') {
      setSeconds(0)
      return
    }
    const started = Date.now()
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active, text, block.callId])
  const summary = text === ''
    ? active ? waitingSummary(expectedTool, live?.eventType, seconds, process) : failed ? '检索失败' : '等待远程检索…'
    : failed ? friendlySearchError(text) : latestLine(text)
  const [expanded, setExpanded] = useState(false)
  const openedForRequest = useRef<string | undefined>(undefined)
  const processLogRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if ((live?.content === '' && process === '') || live === undefined || openedForRequest.current === live.requestId) return
    openedForRequest.current = live.requestId
    setExpanded(true)
  }, [live, process])
  useEffect(() => {
    const node = processLogRef.current
    if (node === null || process === '') return
    node.scrollTop = node.scrollHeight
  }, [process])
  const expandable = text !== '' || process !== ''
  const open = expandable && expanded
  const icon = failed ? <StateDot state="error" /> : <IconSearchOutline16 size={14} />

  return (
    <div className={css.root} data-state={active ? 'running' : failed ? 'error' : 'ok'}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={icon}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} title={summary}>{summary}</span>
          </>
        )}
      >
        <div className={css.body} aria-live={active ? 'polite' : undefined}>
          {process !== '' && (
            <div className={css.process} data-streaming={active && text === '' ? 'true' : undefined}>
              <p className={css.processLabel}>远程检索过程</p>
              <pre className={css.processLog} ref={processLogRef}>{process}</pre>
            </div>
          )}
          {text !== '' && <MarkdownText text={text} streaming={active} />}
        </div>
      </DisclosureRow>
      {open && inspect !== undefined && <button className={css.inspect} type="button" onClick={inspect}>查看详情</button>}
    </div>
  )
}
