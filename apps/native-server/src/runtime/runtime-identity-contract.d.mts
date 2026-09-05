export interface RuntimeIdentitySummary {
  format: 'accrui-harness-runtime-identity-v1'
  upstreamRevision: string
  productHash: string
  assetHash: string
  assetFileCount: number
  pluginHash?: string
  pluginFileCount?: number
  bootEntries: string[]
  productBootEntries: string[]
  installRoot?: string
}

export const RUNTIME_IDENTITY_FORMAT: 'accrui-harness-runtime-identity-v1'
export function validRuntimeIdentitySummary(value: unknown): value is RuntimeIdentitySummary
export function sameRuntimeReleaseIdentity(left: unknown, right: unknown): boolean
