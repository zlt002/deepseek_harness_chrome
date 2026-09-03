import { useEffect, useState, useSyncExternalStore } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  COMPANY_GATEWAY_PROVIDER, companyGatewayModelAcceptsImage, companyGatewayModelInputAfterImageToggle, companyGatewayModelInputs,
  setCompanyGatewayModelImageInput,
} from './company-gateway-multimodal.ts'
import css from './CompanyGatewayMultimodalToggle.module.css'

type GatewayApi = Pick<IApiClient, 'settings'>

interface GatewayInputsStore {
  readonly listeners: Set<() => void>
  inputs: ReadonlyMap<string, readonly string[]>
  loading: Promise<void> | undefined
}

const stores = new WeakMap<GatewayApi, GatewayInputsStore>()

function storeFor(api: GatewayApi): GatewayInputsStore {
  const existing = stores.get(api)
  if (existing !== undefined) return existing
  const store: GatewayInputsStore = { listeners: new Set(), inputs: new Map(), loading: undefined }
  stores.set(api, store)
  return store
}

function publish(store: GatewayInputsStore): void {
  for (const listener of store.listeners) listener()
}

function refresh(api: GatewayApi): Promise<void> {
  const store = storeFor(api)
  if (store.loading !== undefined) return store.loading
  store.loading = api.settings.describe({}).then(response => {
    if (response.result.ok) {
      store.inputs = companyGatewayModelInputs(response.result.value.namespaces)
      publish(store)
    }
  }).finally(() => { store.loading = undefined })
  return store.loading
}

export function CompanyGatewayMultimodalToggle(
  { providerId, modelId, api }: PropsRuntime<'model-selection.option.trailing'> & { api: GatewayApi },
) {
  const store = storeFor(api)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const inputs = useSyncExternalStore(
    listener => {
      store.listeners.add(listener)
      return () => { store.listeners.delete(listener) }
    },
    () => store.inputs,
  )
  const enabled = companyGatewayModelAcceptsImage(inputs.get(modelId))

  useEffect(() => { void refresh(api) }, [api])

  if (providerId !== COMPANY_GATEWAY_PROVIDER) return null

  const stop = (event: { stopPropagation(): void }): void => { event.stopPropagation() }
  const toggle = async (): Promise<void> => {
    const previous = inputs.get(modelId) ?? []
    const requested = companyGatewayModelInputAfterImageToggle(previous, !enabled)
    store.inputs = new Map(store.inputs).set(modelId, requested)
    publish(store)
    setSaving(true)
    setFailure(undefined)
    const result = await setCompanyGatewayModelImageInput(api, modelId, !enabled)
    if (result.input !== undefined) {
      store.inputs = new Map(store.inputs).set(modelId, result.input)
      publish(store)
    } else {
      store.inputs = new Map(store.inputs).set(modelId, previous)
      publish(store)
      setFailure(result.error ?? '更新多模态配置失败。')
    }
    setSaving(false)
  }

  return <label className={css.root} onClick={stop} onMouseDown={stop} title="启用多模态图片">
    <input
      type="checkbox"
      className={css.input}
      checked={enabled}
      disabled={saving}
      aria-label={`启用 ${modelId} 多模态图片`}
      onClick={stop}
      onChange={() => { void toggle() }}
    />
    <span>多模态</span>
    {failure !== undefined && <span className={css.error} role="alert">{failure}</span>}
  </label>
}
