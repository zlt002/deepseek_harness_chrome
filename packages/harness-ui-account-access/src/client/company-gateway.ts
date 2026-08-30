import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { CompanyGatewayMetadata, CompanyGatewayModel, CompanyGatewayProtocol } from './types.ts'

export const COMPANY_GATEWAY_PROVIDER = 'annto-company-gateway'
export const COMPANY_GATEWAY_CREDENTIAL_REF = 'ANNTO_COMPANY_GATEWAY_API_KEY'
export const COMPANY_GATEWAY_ANTHROPIC_BASE_URL = 'https://anapi-uat.annto.com/api-sse-anthropic'
export const COMPANY_GATEWAY_OPENAI_BASE_URL = 'https://anapi-uat.annto.com/api-sse-anthropic/v1'
export const COMPANY_GATEWAY_KEY_PORTAL_URL = 'https://anapi-uat.annto.com/api-key-portal'

type GatewayApi = Pick<IApiClient, 'settings' | 'credentials'>

export function companyGatewayBaseUrl(protocol: CompanyGatewayProtocol): string {
  return protocol === 'anthropic-messages'
    ? COMPANY_GATEWAY_ANTHROPIC_BASE_URL
    : COMPANY_GATEWAY_OPENAI_BASE_URL
}

export function companyGatewayProtocolFromNamespaces(value: unknown): CompanyGatewayProtocol | undefined {
  if (!Array.isArray(value)) return undefined
  const namespace = value.find(item => item !== null && typeof item === 'object'
    && (item as { ns?: unknown }).ns === 'llm-pi-ai') as { value?: unknown } | undefined
  const root = namespace?.value
  if (root === null || typeof root !== 'object') return undefined
  const providers = (root as { providers?: unknown }).providers
  if (providers === null || typeof providers !== 'object') return undefined
  const profile = (providers as Record<string, unknown>)[COMPANY_GATEWAY_PROVIDER]
  if (profile === null || typeof profile !== 'object') return undefined
  const protocol = (profile as { api?: unknown }).api
  return protocol === 'anthropic-messages' || protocol === 'openai-completions' ? protocol : undefined
}

/** Read the saved company model rows without exposing any credential fields. */
export function companyGatewayModelsFromNamespaces(value: unknown): CompanyGatewayModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const namespace = value.find(item => item !== null && typeof item === 'object'
    && (item as { ns?: unknown }).ns === 'llm-pi-ai') as { value?: unknown } | undefined
  const root = namespace?.value
  if (root === null || typeof root !== 'object') return undefined
  const providers = (root as { providers?: unknown }).providers
  if (providers === null || typeof providers !== 'object') return undefined
  const profile = (providers as Record<string, unknown>)[COMPANY_GATEWAY_PROVIDER]
  if (profile === null || typeof profile !== 'object') return undefined
  const models = (profile as { models?: unknown }).models
  if (!Array.isArray(models)) return undefined
  const restored = models.flatMap((model): CompanyGatewayModel[] => {
    if (model === null || typeof model !== 'object' || Array.isArray(model)) return []
    const row = model as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.trim().length === 0 || row.id.length > 160) return []
    return [{
      ...row,
      id: row.id,
      ...(Array.isArray(row.input) ? { input: [...row.input] } : {}),
    }]
  })
  return restored.length === models.length ? restored : undefined
}

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

/** Parse a token capacity written as a plain count, K, or M. */
export function parseCompanyGatewayCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/** Keep saved capacities readable while preserving exact token counts. */
export function formatCompanyGatewayCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
  if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
  return String(value)
}

function profileModel(model: CompanyGatewayModel) {
  const { id, name, ...fields } = model
  const modelId = id.trim()
  const displayName = typeof name === 'string' ? name.trim() : ''
  const contextWindow = model.contextWindow
  const maxTokens = model.maxTokens
  return {
    ...fields,
    id: modelId,
    ...(displayName.length === 0 ? {} : { name: displayName }),
    ...(typeof contextWindow === 'number' ? {} : { contextWindow: 200_000 }),
    ...(typeof maxTokens === 'number' ? {} : { maxTokens: 64_000 }),
  }
}

export function companyGatewayProfile(models: readonly CompanyGatewayModel[], protocol: CompanyGatewayProtocol) {
  return {
    apiKeyEnv: COMPANY_GATEWAY_CREDENTIAL_REF,
    api: protocol,
    baseURL: companyGatewayBaseUrl(protocol),
    defaultContextWindow: 200_000,
    defaultMaxTokens: 64_000,
    models: models.map(profileModel),
  }
}

/** Return a user-visible refusal before a malformed model list reaches settings. */
export function companyGatewayModelDraftFailure(models: readonly CompanyGatewayModel[]): string | undefined {
  if (models.length === 0) return '模型目录不能为空。'
  const ids = models.map(model => model.id.trim())
  if (ids.some(id => id.length === 0)) return '模型 ID 不能为空。'
  if (new Set(ids).size !== ids.length) return '模型 ID 不能重复。'
  for (const [index, model] of models.entries()) {
    for (const [key, label] of [['contextWindow', '上下文窗口'], ['maxTokens', '最大输出 token']] as const) {
      const value = model[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
        return `第 ${index + 1} 个模型的${label}必须是正整数。`
      }
    }
  }
  return undefined
}

/**
 * The fresh gateway directory is authoritative. A retired id must not survive
 * from a previous cache or form draft; the selected current model is merely
 * moved to the front because Harness uses the first profile model by default.
 */
export function companyGatewayModelsForSelection(
  models: readonly CompanyGatewayModel[],
  selectedModelId: string | undefined,
): CompanyGatewayModel[] {
  const selected = selectedModelId === undefined ? undefined : models.find(model => model.id === selectedModelId)
  return selected === undefined ? [...models] : [selected, ...models.filter(model => model !== selected)]
}

/** Merge a fresh gateway catalog with saved edits, dropping retired model ids. */
export function mergeCompanyGatewayModels(
  saved: readonly CompanyGatewayModel[],
  latest: readonly CompanyGatewayModel[],
): CompanyGatewayModel[] {
  const savedById = new Map(saved.map(model => [model.id.trim(), model]))
  return latest.map(model => {
    const previous = savedById.get(model.id.trim())
    return previous === undefined
      ? { ...model }
      : { ...model, ...previous, id: model.id }
  })
}

/** Use the saved provider profile when reopening the editor, retaining live quota metadata when available. */
export function companyGatewayMetadataForEditing(
  savedModels: readonly CompanyGatewayModel[],
  gateway: CompanyGatewayMetadata | undefined,
): CompanyGatewayMetadata | undefined {
  if (savedModels.length === 0) return gateway
  const models = savedModels.map(model => ({
    ...model,
    ...(Array.isArray(model.input) ? { input: [...model.input] } : {}),
  }))
  return gateway === undefined
    ? { models, quota: { usagePercent: null, nextResetTime: null, resetCycle: 'unlimited' }, checkedAt: '' }
    : { ...gateway, models }
}

export function companyGatewayApiKeyFailure(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return '请输入公司网关 API Key。'
  if (trimmed.length > 512 || !/^[\x21-\x7E]+$/.test(trimmed)) return 'API Key 格式无效，请只输入 Key 本身。'
  return undefined
}

/** The public per-session selection surface used after a company profile is saved. */
export interface CompanyGatewayModelDirectory {
  load(): Promise<unknown>
  select(selection: { provider: string; model: string }): Promise<void>
}

/** Select the first configured model through the official session seam, never raw settings. */
export async function selectCompanyGatewayInitialModel(
  directory: CompanyGatewayModelDirectory | undefined,
  models: readonly CompanyGatewayModel[],
): Promise<string | undefined> {
  if (directory === undefined) return undefined
  const failure = companyGatewayModelDraftFailure(models)
  if (failure !== undefined) return failure
  try {
    await directory.load()
    await directory.select({ provider: COMPANY_GATEWAY_PROVIDER, model: models[0].id.trim() })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Persist connection facts and the secret. Initial selection belongs to session.selectModel. */
export async function saveCompanyGateway(
  api: GatewayApi,
  models: readonly CompanyGatewayModel[],
  apiKey?: string,
  protocol: CompanyGatewayProtocol = 'anthropic-messages',
): Promise<string | undefined> {
  const draftFailure = companyGatewayModelDraftFailure(models)
  if (draftFailure !== undefined) return draftFailure
  const profile = await api.settings.mutate({
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', COMPANY_GATEWAY_PROVIDER], value: companyGatewayProfile(models, protocol) }],
  })
  if (!profile.result.ok) return profile.result.error.message
  if (apiKey !== undefined) {
    const credential = await api.credentials.set({ ref: COMPANY_GATEWAY_CREDENTIAL_REF, value: apiKey })
    if (!credential.result.ok) return credential.result.error.message
  }
  return undefined
}
