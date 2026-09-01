export type ReleaseUpdateCandidate = { version: string, sha256: string, packageUrl: string }

export function validReleaseUpdateCandidate(value: unknown): value is ReleaseUpdateCandidate {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3
    && typeof (value as ReleaseUpdateCandidate).version === 'string' && /^\d+\.\d+\.\d+$/.test((value as ReleaseUpdateCandidate).version)
    && typeof (value as ReleaseUpdateCandidate).sha256 === 'string' && /^[a-f0-9]{64}$/i.test((value as ReleaseUpdateCandidate).sha256)
    && typeof (value as ReleaseUpdateCandidate).packageUrl === 'string' && /^https:\/\//.test((value as ReleaseUpdateCandidate).packageUrl)
}

export function releaseUpdateNativeMessage(action: unknown, requestId: unknown, candidate?: unknown) {
  if (action !== 'check' && action !== 'prepare' && action !== 'cancel') throw new Error('在线更新动作无效')
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 160) throw new Error('在线更新请求 ID 无效')
  if (action === 'prepare') {
    if (!validReleaseUpdateCandidate(candidate)) throw new Error('在线更新候选无效')
    return { type: 'release-update-prepare', requestId, candidate: { ...candidate, sha256: candidate.sha256.toLowerCase() } }
  }
  if (candidate !== undefined) throw new Error('在线更新候选只可用于安装请求')
  return { type: action === 'check' ? 'release-update-check' : 'release-update-cancel', requestId }
}

export function releaseUpdateResult(message: unknown, requestId: string) {
  if (typeof message !== 'object' || message === null || (message as { requestId?: unknown }).requestId !== requestId) return undefined
  const item = message as { type?: unknown, update?: unknown, error?: unknown }
  if (item.type === 'release_update_cancelled') return { ok: false, error: '在线更新已取消' }
  if (item.type === 'release_update_cancel_unknown') return { ok: false, error: '在线更新状态未知；请查看更新状态' }
  if (item.type === 'release_update_failed') return { ok: false, error: typeof item.error === 'string' ? item.error : '在线更新失败' }
  if (item.type !== 'release_update_checked' && item.type !== 'release_update_prepared') return undefined
  if (typeof item.update !== 'object' || item.update === null) return { ok: false, error: 'Native Host 返回的更新结果无效' }
  return { ok: true, update: item.update }
}
