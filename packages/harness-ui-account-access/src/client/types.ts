export type AccountAccessStatus = 'guest' | 'authenticated' | 'unavailable'
export type AccountAccessCommand = 'refresh' | 'login' | 'logout'

/**
 * A company gateway model as discovered or drafted in the settings form.
 *
 * Profiles are intentionally structurally open: model adapters add fields over
 * time, and editing an id/name here must not erase a field this card does not
 * own (for example a hand-configured capability or capacity).
 */
export interface CompanyGatewayModel {
  id: string
  name?: string
  description?: string
  input?: unknown
  [key: string]: unknown
}
export interface CompanyGatewayQuota { usagePercent: number | null; nextResetTime: string | null; resetCycle: 'daily' | 'weekly' | 'monthly' | 'unlimited' }
export interface CompanyGatewayMetadata { models: CompanyGatewayModel[]; quota: CompanyGatewayQuota; checkedAt: string }
export type CompanyGatewayProbeSnapshot =
  | { requestId: string; status: 'ready'; gateway: CompanyGatewayMetadata }
  | { requestId: string; status: 'error'; error: string }

export interface AccountAccessSnapshot {
  status: AccountAccessStatus
  displayName?: string
  knowledgeAccess: boolean
  codeAccess: boolean
  modelMode: 'manual' | 'company-pending'
  gateway?: CompanyGatewayMetadata
  message?: string
}
