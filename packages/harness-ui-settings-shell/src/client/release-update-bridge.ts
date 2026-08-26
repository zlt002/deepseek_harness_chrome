import type { ReleaseUpdate } from './ReleaseUpdateSection.tsx'

export function createReleaseUpdateBridge(nonce: string, parentOrigin: string) {
  let sequence = 0
  const pending = new Map<string, { resolve: (value: ReleaseUpdate) => void, reject: (reason: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  return {
    accept(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, parent: WindowProxy): boolean {
      const message = event.data as { type?: unknown, nonce?: unknown, requestId?: unknown, update?: unknown, error?: unknown }
      if (event.source !== parent || event.origin !== parentOrigin || message?.nonce !== nonce || typeof message.requestId !== 'string') return false
      const request = pending.get(message.requestId); if (request === undefined) return false
      pending.delete(message.requestId); clearTimeout(request.timer)
      if (message.type === 'release-update-result/v1' && typeof message.update === 'object' && message.update !== null) request.resolve(message.update as ReleaseUpdate)
      else request.reject(new Error(typeof message.error === 'string' ? message.error : '在线更新请求失败'))
      return true
    },
    request(action: 'check' | 'prepare', parent: WindowProxy = window.parent): Promise<ReleaseUpdate> {
      const requestId = crypto.randomUUID(); sequence += 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (pending.delete(requestId)) reject(new Error('在线更新请求超时；请确认 Native Host 仍在线。')) }, action === 'prepare' ? 180_000 : 45_000)
        pending.set(requestId, { resolve, reject, timer }); parent.postMessage({ type: 'release-update-command/v1', nonce, sequence, requestId, action }, parentOrigin)
      })
    },
  }
}
