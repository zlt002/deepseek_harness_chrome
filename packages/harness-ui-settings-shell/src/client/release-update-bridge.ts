import type { ReleaseUpdate } from './ReleaseUpdateSection.tsx'

export type ReleaseUpdateCandidate = { version: string, sha256: string, packageUrl: string }

export function createReleaseUpdateBridge(nonce: string, parentOrigin: string) {
  let sequence = 0
  const pending = new Map<string, { resolve: (value: ReleaseUpdate) => void, reject: (reason: Error) => void, timer: ReturnType<typeof setTimeout>, cancelTimer?: ReturnType<typeof setTimeout>, parent: WindowProxy, abort?: () => void, cancelling: boolean }>()
  return {
    accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean {
      const message = event.data as { type?: unknown, nonce?: unknown, requestId?: unknown, update?: unknown, error?: unknown }
      if (event.source !== parent || event.origin !== parentOrigin || message?.nonce !== nonce || typeof message.requestId !== 'string') return false
      const request = pending.get(message.requestId); if (request === undefined) return false
      if (message.type === 'release-update-cancel-too-late/v1') {
        clearTimeout(request.cancelTimer)
        request.cancelling = false
        request.timer = setTimeout(() => {
          if (pending.get(message.requestId) !== request) return
          pending.delete(message.requestId); request.abort?.()
          request.reject(new Error('在线更新状态未知；请查看更新状态'))
        }, 10_000)
        return true
      }
      pending.delete(message.requestId); clearTimeout(request.timer); clearTimeout(request.cancelTimer); request.abort?.()
      if (message.type === 'release-update-result/v1' && typeof message.update === 'object' && message.update !== null) request.resolve(message.update as ReleaseUpdate)
      else request.reject(new Error(typeof message.error === 'string' ? message.error : '在线更新请求失败'))
      return true
    },
    request(action: 'check' | 'prepare', candidate?: ReleaseUpdateCandidate, parent: WindowProxy = window.parent, signal?: AbortSignal): Promise<ReleaseUpdate> {
      if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('在线更新请求已取消'))
      const requestId = crypto.randomUUID(); sequence += 1
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const request = pending.get(requestId)
          if (request === undefined || request.cancelling) return
          request.cancelling = true
          clearTimeout(request.timer)
          parent.postMessage({ type: 'release-update-command/v1', nonce, sequence, requestId, action: 'cancel' }, parentOrigin)
          request.cancelTimer = setTimeout(() => {
            if (pending.get(requestId) !== request) return
            pending.delete(requestId); request.abort?.()
            reject(new Error('在线更新状态未知；请查看更新状态'))
          }, 5_000)
        }
        const abort = () => cancel()
        const timer = setTimeout(cancel, action === 'prepare' ? 180_000 : 45_000)
        pending.set(requestId, { resolve, reject, timer, parent, cancelling: false, abort: () => signal?.removeEventListener('abort', abort) }); signal?.addEventListener('abort', abort, { once: true })
        parent.postMessage({ type: 'release-update-command/v1', nonce, sequence, requestId, action, ...(candidate === undefined ? {} : { candidate }) }, parentOrigin)
      })
    },
  }
}
