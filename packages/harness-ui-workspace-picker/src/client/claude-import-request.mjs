const PATH = '/api/claude-code.import'
const ACTION_LABELS = { projects: '读取 Claude 项目', sessions: '读取项目会话', detail: '读取会话详情', prepare: '准备所选会话', commit: '记录导入结果' }
const ACTION_TIMEOUTS = { projects: 5_000, sessions: 8_000, detail: 15_000, prepare: 15_000, commit: 8_000 }

/** Shared request seam. Fetch injection keeps transport timeout behavior deterministic in tests. */
export async function claudeImportRequest(body, signal, options = {}) {
  const fetcher = options.fetcher ?? fetch
  const action = typeof body?.action === 'string' ? body.action : 'unknown'
  const label = ACTION_LABELS[action] ?? 'Claude Code 导入请求'
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUTS[action] ?? 8_000
  const controller = new AbortController()
  let rejectCancellation
  const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject })
  const callerAbort = () => {
    controller.abort(signal?.reason)
    rejectCancellation(new Error(`${label}已取消`))
  }
  if (signal?.aborted === true) callerAbort()
  else signal?.addEventListener('abort', callerAbort, { once: true })
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`${label}超时`, 'TimeoutError'))
      reject(new Error(`${label}超时（${String(timeoutMs)}ms），请确认 Native Host 仍在线后重试`))
    }, timeoutMs)
  })
  try {
    const operation = (async () => {
      let response
      try {
        response = await fetcher(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      } catch (error) {
        if (signal?.aborted === true) throw new Error(`${label}已取消`)
        if (controller.signal.reason?.name === 'TimeoutError') throw new Error(`${label}超时（${String(timeoutMs)}ms），请确认 Native Host 仍在线后重试`)
        throw new Error(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `${label}失败：HTTP ${String(response.status)}`)
      return payload
    })()
    return await Promise.race([operation, deadline, cancellation])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', callerAbort)
  }
}
