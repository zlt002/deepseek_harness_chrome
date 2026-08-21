import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { CompanyGatewayModel, CompanyGatewayProtocol } from './types.ts'

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

function profileModel(model: CompanyGatewayModel) {
  const { id, name, ...fields } = model
  const modelId = id.trim()
  const displayName = typeof name === 'string' ? name.trim() : ''
  return {
    ...fields,
    id: modelId,
    ...(displayName.length === 0 ? {} : { name: displayName }),
    ...(typeof model.contextWindow === 'number' ? {} : { contextWindow: 200_000 }),
    ...(typeof model.maxTokens === 'number' ? {} : { maxTokens: 64_000 }),
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
  return undefined
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
