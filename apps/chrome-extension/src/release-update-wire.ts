export function releaseUpdateNativeMessage(action: unknown, requestId: unknown) {
  if (action !== 'check' && action !== 'prepare') throw new Error('在线更新动作无效')
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160) throw new Error('在线更新请求 ID 无效')
  return { type: action === 'check' ? 'release-update-check' : 'release-update-prepare', requestId }
}

export function releaseUpdateResult(message: unknown, requestId: string) {
  if (typeof message !== 'object' || message === null || (message as { requestId?: unknown }).requestId !== requestId) return undefined
  const item = message as { type?: unknown, update?: unknown, error?: unknown }
  if (item.type === 'release_update_failed') return { ok: false, error: typeof item.error === 'string' ? item.error : '在线更新失败' }
  if (item.type !== 'release_update_checked' && item.type !== 'release_update_prepared') return undefined
  if (typeof item.update !== 'object' || item.update === null) return { ok: false, error: 'Native Host 返回的更新结果无效' }
  return { ok: true, update: item.update }
}
