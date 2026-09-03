import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

export const COMPANY_GATEWAY_PROVIDER = 'annto-company-gateway'

const SETTINGS_NAMESPACE = 'llm-pi-ai'

type GatewayApi = Pick<IApiClient, 'settings'>
type ModelRow = Record<string, unknown> & { id: string }

function gatewayModels(namespaces: unknown): ModelRow[] | undefined {
  if (!Array.isArray(namespaces)) return undefined
  const namespace = namespaces.find(item => item !== null && typeof item === 'object'
    && (item as { ns?: unknown }).ns === SETTINGS_NAMESPACE) as { value?: unknown } | undefined
  const providers = namespace?.value !== null && typeof namespace?.value === 'object'
    ? (namespace.value as { providers?: unknown }).providers
    : undefined
  const profile = providers !== null && typeof providers === 'object'
    ? (providers as Record<string, unknown>)[COMPANY_GATEWAY_PROVIDER]
    : undefined
  const models = profile !== null && typeof profile === 'object'
    ? (profile as { models?: unknown }).models
    : undefined
  if (!Array.isArray(models)) return undefined
  const rows = models.flatMap((model): ModelRow[] => model !== null && typeof model === 'object'
    && !Array.isArray(model) && typeof (model as { id?: unknown }).id === 'string'
    ? [{ ...(model as ModelRow) }]
    : [])
  return rows.length === models.length ? rows : undefined
}

function inputOf(model: ModelRow | undefined): string[] {
  return Array.isArray(model?.input)
    ? model.input.filter((value): value is string => typeof value === 'string')
    : []
}

/** Preserve all declared non-image modalities while changing image support. */
export function companyGatewayModelInputAfterImageToggle(inputs: readonly string[], enabled: boolean): string[] {
  const withoutImage = inputs.filter(value => value !== 'image')
  if (!enabled) return withoutImage
  return [...(withoutImage.includes('text') ? withoutImage : ['text', ...withoutImage]), 'image']
}

export function companyGatewayModelInputs(namespaces: unknown): ReadonlyMap<string, readonly string[]> {
  const models = gatewayModels(namespaces)
  return new Map(models?.map(model => [model.id, inputOf(model)]) ?? [])
}

export function companyGatewayModelAcceptsImage(inputs: readonly string[] | undefined): boolean {
  return inputs?.includes('image') ?? false
}

/**
 * Write only one saved company model's `input` field. Other row/profile fields
 * remain untouched, and clearing image preserves every remaining string value.
 */
export async function setCompanyGatewayModelImageInput(
  api: GatewayApi,
  modelId: string,
  enabled: boolean,
): Promise<{ input?: readonly string[]; error?: string }> {
  try {
    const described = await api.settings.describe({})
    if (!described.result.ok) return { error: described.result.error.message }
    const models = gatewayModels(described.result.value.namespaces)
    const index = models?.findIndex(model => model.id === modelId) ?? -1
    if (index < 0 || models === undefined) return { error: '未找到公司网关模型配置。' }
    const input = companyGatewayModelInputAfterImageToggle(inputOf(models[index]), enabled)
    // Settings paths cannot traverse arrays. Replacing the complete models list
    // retains the target row's unknown fields and every other saved model.
    const nextModels = models.map((model, rowIndex) => {
      if (rowIndex !== index) return model
      const nextModel = { ...model }
      if (input.length === 0) delete nextModel.input
      else nextModel.input = input
      return nextModel
    })
    const mutated = await api.settings.mutate({
      ns: SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: ['providers', COMPANY_GATEWAY_PROVIDER, 'models'], value: nextModels }],
    })
    return mutated.result.ok ? { input } : { error: mutated.result.error.message }
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
