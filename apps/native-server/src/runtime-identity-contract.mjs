export const RUNTIME_IDENTITY_FORMAT = 'accrui-harness-runtime-identity-v1'

const sha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function validRuntimeIdentitySummary(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.format === RUNTIME_IDENTITY_FORMAT
    && typeof value.upstreamRevision === 'string' && /^[0-9a-f]{40}$/.test(value.upstreamRevision)
    && sha256(value.productHash) && sha256(value.assetHash)
    && Number.isSafeInteger(value.assetFileCount) && value.assetFileCount > 0
    && (value.pluginHash === undefined || (sha256(value.pluginHash)
      && Number.isSafeInteger(value.pluginFileCount) && value.pluginFileCount > 0))
    && Array.isArray(value.bootEntries) && value.bootEntries.length > 0
    && value.bootEntries.every((entry) => typeof entry === 'string' && entry.length > 0)
    && Array.isArray(value.productBootEntries) && value.productBootEntries.length > 0
    && value.productBootEntries.every((entry) => typeof entry === 'string' && entry.length > 0)
    && (value.installRoot === undefined || (typeof value.installRoot === 'string' && value.installRoot.length > 0))
}

/** Compare only values that are intentionally identical across Extension and Native artifacts. */
export function sameRuntimeReleaseIdentity(left, right) {
  return validRuntimeIdentitySummary(left) && validRuntimeIdentitySummary(right)
    && left.upstreamRevision === right.upstreamRevision
    && left.productHash === right.productHash
    && left.pluginHash !== undefined && left.pluginHash === right.pluginHash
    && left.productBootEntries.length === right.productBootEntries.length
    && left.productBootEntries.every((entry, index) => entry === right.productBootEntries[index])
}
