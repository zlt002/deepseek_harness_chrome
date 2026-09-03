import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

const PROVIDER = 'annto-company-gateway'
const SETTINGS_NS = 'llm-pi-ai'

type GatewayApi = Pick<IApiClient, 'settings' | 'llm'>
type ModelRow = { id: string; [key: string]: unknown }

interface DirectoryLike {
  load(): Promise<unknown>
  store: {
    update(updater: (state: { failures: readonly { id: string; name: string; message: string }[] }) => void): void
  }
}
function profileFromNamespaces(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  const namespace = value.find(item => item !== null && typeof item === 'object' && (item as { ns?: unknown }).ns === SETTINGS_NS) as { value?: unknown } | undefined
  const root = namespace?.value
  if (root === null || typeof root !== 'object') return undefined
  const providers = (root as { providers?: unknown }).providers
  if (providers === null || typeof providers !== 'object') return undefined
  const profile = (providers as Record<string, unknown>)[PROVIDER]
  return profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? profile as Record<string, unknown> : undefined
}

function modelRows(value: unknown): ModelRow[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows = value.flatMap((entry): ModelRow[] => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as { id?: unknown }).id === 'string' && (entry as { id: string }).id.trim().length > 0
    ? [{ ...(entry as ModelRow) }]
    : [])
  return rows.length === value.length ? rows : undefined
}

function mergeSavedFields(saved: readonly ModelRow[], latest: readonly ModelRow[]): ModelRow[] {
  const savedById = new Map(saved.map(model => [model.id.trim(), model]))
  return latest.map(model => {
    const previous = savedById.get(model.id.trim())
    return previous === undefined ? { ...model } : { ...model, ...previous, id: model.id }
  })
}

/** Refresh only the company route; a failure leaves every saved provider untouched. */
export async function refreshCompanyGatewayCatalog(api: GatewayApi): Promise<string | undefined> {
  const settings = await api.settings.describe({})
  if (!settings.result.ok) return settings.result.error.message
  const profile = profileFromNamespaces(settings.result.value.namespaces)
  if (profile === undefined) return undefined
  const apiProtocol = profile.api
  const baseURL = profile.baseURL
  const saved = modelRows(profile.models)
  if (apiProtocol !== 'openai-completions' || typeof baseURL !== 'string' || baseURL.length === 0 || saved === undefined) return undefined
  const discovered = await api.llm.discoverModels({
    settingsNs: SETTINGS_NS,
    provider: PROVIDER,
    baseURL,
    api: apiProtocol,
  })
  if (!discovered.result.ok) return discovered.result.error.message
  const latest = modelRows(discovered.result.value.models)
  if (latest === undefined || latest.length === 0) return '公司网关没有返回可用模型。'
  const merged = mergeSavedFields(saved, latest)
  if (JSON.stringify(merged) === JSON.stringify(saved)) return undefined
  const mutation = await api.settings.mutate({
    ns: SETTINGS_NS,
    ops: [{ op: 'set', path: ['providers', PROVIDER, 'models'], value: merged }],
  })
  return mutation.result.ok ? undefined : mutation.result.error.message
}

/**
 * The stock picker calls directory.load on mount and on every open. Wrap that
 * public operation so the company catalog is synchronized first, then load
 * the complete Host directory. A sync failure is provider-local: cached model
 * groups still open and the picker shows a retryable warning.
 */
export function installCompanyGatewayRefresh(directory: DirectoryLike, refresh: () => Promise<string | undefined>): () => void {
  const original = directory.load.bind(directory)
  let refreshing: Promise<string | undefined> | undefined
  const installed = async (): Promise<unknown> => {
    refreshing ??= refresh().finally(() => { refreshing = undefined })
    const failure = await refreshing.catch(error => error instanceof Error ? error.message : String(error))
    const result = await original()
    if (failure !== undefined) {
      directory.store.update(state => {
        state.failures = [
          ...state.failures.filter(item => item.id !== PROVIDER),
          { id: PROVIDER, name: '公司网关', message: `远程模型同步失败：${failure}` },
        ]
      })
    }
    return result
  }
  directory.load = installed
  return () => { if (directory.load === installed) directory.load = original }
}
