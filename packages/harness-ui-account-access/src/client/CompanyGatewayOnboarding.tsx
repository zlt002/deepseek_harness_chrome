import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  COMPANY_GATEWAY_CREDENTIAL_REF,
  companyGatewayApiKeyFailure,
  companyGatewayProtocolFromNamespaces,
  saveCompanyGateway,
} from './company-gateway.ts'
import { hasUsableModelProvider, type OnboardingNamespace, type OnboardingProvider } from './onboarding.ts'
import type { CompanyGatewayMetadata, CompanyGatewayModel, CompanyGatewayProbeSnapshot, CompanyGatewayProtocol } from './types.ts'
import css from './AccountAccessSection.module.css'

export interface CompanyGatewayOnboardingInjected {
  hooks: { companyGatewayProbe: SnapshotStore<CompanyGatewayProbeSnapshot | undefined> }
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  probeGateway: (apiKey: string, protocol: CompanyGatewayProtocol, requestedModelId?: string) => string
  selectInitialModel: (models: readonly CompanyGatewayModel[]) => Promise<string | undefined>
}

type Props = PropsRuntime<'settings.onboarding'> & InjectFace<CompanyGatewayOnboardingInjected>
type Readiness = 'loading' | 'needed' | 'ready' | 'unavailable'

const useMissingGatewayProbe = <T,>(selector: (snapshot: CompanyGatewayProbeSnapshot | undefined) => T): T => selector(undefined)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function firstModel(models: readonly CompanyGatewayModel[], selected: string | undefined): CompanyGatewayModel[] {
  if (selected === undefined) return [...models]
  const first = models.find(model => model.id === selected)
  return first === undefined ? [...models] : [first, ...models.filter(model => model !== first)]
}

/**
 * Product-owned first-run step. It uses the same active-provider/credential
 * facts as official onboarding and exits as soon as any provider is usable.
 */
export function CompanyGatewayOnboarding(props: Props): ReactNode {
  const { complete, api, probeGateway, selectInitialModel, useCompanyGatewayProbe } = props
  const useGatewayProbe = useCompanyGatewayProbe ?? useMissingGatewayProbe
  const probe = useGatewayProbe(snapshot => snapshot)
  const [readiness, setReadiness] = useState<Readiness>('loading')
  const [keyDraft, setKeyDraft] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [request, setRequest] = useState<{ id: string; key: string; protocol: CompanyGatewayProtocol; requestedModelId?: string }>()
  const [gateway, setGateway] = useState<CompanyGatewayMetadata>()
  const [loadedKey, setLoadedKey] = useState<string>()
  const [protocol, setProtocol] = useState<CompanyGatewayProtocol>('anthropic-messages')
  const [selectedModel, setSelectedModel] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [providersResponse, settingsResponse] = await Promise.all([api.llm.providers({}), api.settings.describe({})])
        if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
        if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
        const namespaces = settingsResponse.result.value.namespaces as OnboardingNamespace[]
        const providers = providersResponse.result.value.providers as OnboardingProvider[]
        const refs = new Set<string>([COMPANY_GATEWAY_CREDENTIAL_REF])
        for (const provider of providers) {
          const namespace = namespaces.find(candidate => candidate.ns === provider.settingsNs)
          let profile: unknown = namespace?.value
          for (const key of provider.settingsPath) {
            if (profile === null || typeof profile !== 'object') { profile = undefined; break }
            profile = (profile as Record<string, unknown>)[key]
          }
          const ref = profile !== null && typeof profile === 'object' ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv : undefined
          if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
        }
        const credentialsResponse = await api.credentials.describe({ refs: [...refs] })
        if (!credentialsResponse.result.ok) throw new Error(credentialsResponse.result.error.message)
        if (!active) return
        setProtocol(companyGatewayProtocolFromNamespaces(namespaces) ?? 'anthropic-messages')
        setReadiness(hasUsableModelProvider(providers, namespaces, credentialsResponse.result.value.credentials) ? 'ready' : 'needed')
      } catch {
        if (active) setReadiness('unavailable')
      }
    })()
    return () => { active = false }
  }, [api.credentials, api.llm, api.settings])

  useEffect(() => {
    if (readiness === 'ready' || readiness === 'unavailable') complete()
  }, [complete, readiness])

  useEffect(() => {
    if (readiness !== 'needed') return
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const previous = appRoot.inert
    appRoot.inert = true
    return () => { appRoot.inert = previous }
  }, [readiness])

  const probing = request !== undefined
  useEffect(() => {
    if (probe?.status === 'ready' && probe.requestId === request?.id) {
      setGateway(probe.gateway)
      setLoadedKey(request.key)
      setRequest(undefined)
      setSelectedModel(current => current !== undefined && probe.gateway.models.some(model => model.id === current) ? current : probe.gateway.models[0]?.id)
    }
  }, [probe, request])
  useEffect(() => {
    if (probe?.status === 'error' && probe.requestId === request?.id) {
      setFailure(probe.error)
      setRequest(undefined)
    }
  }, [probe, request?.id])

  if (readiness !== 'needed') return null

  const loadCatalog = (): void => {
    const key = keyDraft.trim()
    const invalid = companyGatewayApiKeyFailure(key)
    if (invalid !== undefined) { setFailure(invalid); return }
    setFailure(undefined)
    setGateway(undefined); setLoadedKey(undefined)
    setRequest({ id: probeGateway(key, protocol), key, protocol })
  }
  const verifySelectedModel = (): void => {
    const key = keyDraft.trim()
    if (gateway === undefined || loadedKey !== key || selectedModel === undefined) { setFailure('请先加载模型目录并选择模型。'); return }
    setFailure(undefined)
    setRequest({ id: probeGateway(key, protocol, selectedModel), key, protocol, requestedModelId: selectedModel })
  }
  const save = async (): Promise<void> => {
    if (gateway === undefined || loadedKey !== keyDraft.trim()) {
      setFailure('请先验证 API Key。')
      return
    }
    const models = firstModel(gateway.models, selectedModel)
    const capability = gateway.capability
    if (capability === undefined || capability.tools !== true || capability.protocol !== protocol || capability.modelId !== selectedModel) {
      setFailure('请先验证所选模型是否支持 Agent 工具调用。')
      return
    }
    setSaving(true); setFailure(undefined)
    try {
      const error = await saveCompanyGateway(api, models, keyDraft.trim(), protocol)
      if (error !== undefined) { setFailure(error); return }
      const selectionFailure = await selectInitialModel(models)
      if (selectionFailure !== undefined) {
        setFailure(`公司网关已保存，但初始模型未选中：${selectionFailure}`)
        return
      }
      complete()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSaving(false)
    }
  }

  return <Modal open title="配置公司网关" onClose={() => undefined} headless className={css.onboardingModal as string}>
    <div className={css.onboardingContent}>
      <h2 className={css.onboardingTitle}>配置公司网关</h2>
      <p className={css.notice}>验证 API Key 后加载公司模型目录；Key 仅写入 Harness 凭据存储。</p>
      <label className={css.gatewayField}>
        <span>API Key</span>
        <span className={css.keyRow}>
          <input autoFocus type={showKey ? 'text' : 'password'} value={keyDraft} placeholder="请输入公司网关 API Key" disabled={saving} onChange={event => { setKeyDraft(event.target.value); setGateway(undefined); setLoadedKey(undefined); setRequest(undefined); setFailure(undefined) }} />
          <button type="button" onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button>
        </span>
      </label>
      <label className={css.gatewayField}><span>API 协议</span><select value={protocol} disabled={saving} onChange={event => { setProtocol(event.target.value as CompanyGatewayProtocol); setGateway(undefined); setLoadedKey(undefined); setRequest(undefined); setFailure(undefined) }}><option value="anthropic-messages">Anthropic URL</option><option value="openai-completions">OpenAI URL</option></select></label>
      <div className={css.gatewayUtilityActions}>
        <button type="button" className={css.gatewaySecondaryButton} disabled={probing || saving} onClick={loadCatalog}>{probing ? '验证中…' : '验证 Key 并加载模型'}</button>
      </div>
      {gateway === undefined ? null : <>
        <label className={css.gatewayField}>
          <span>初始模型（已探测到 {gateway.models.length} 个模型）</span>
          <select value={selectedModel} disabled={saving} onChange={event => { setSelectedModel(event.target.value); setFailure(undefined) }}>
            {gateway.models.map(model => <option key={model.id} value={model.id}>{typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id}</option>)}
          </select>
        </label>
        <div className={css.gatewayUtilityActions}><button type="button" className={css.gatewaySecondaryButton} disabled={probing || saving || selectedModel === undefined} onClick={verifySelectedModel}>{probing ? '验证中…' : '验证所选模型的 Agent 工具能力'}</button></div>
        <p className={css.notice}>保存后通过 Harness 的模型选择服务设为当前会话和后续会话的初始模型。</p>
      </>}
      {failure === undefined ? null : <p className={css.error} role="alert">{failure}</p>}
      <div className={css.gatewayEditorActions}>
        <button type="button" className={css.gatewayCancelButton} disabled={saving} onClick={complete}>稍后配置</button>
        <button type="button" className={css.gatewaySaveButton} disabled={saving || gateway === undefined} onClick={() => { void save() }}>{saving ? '保存中…' : '保存并开始使用'}</button>
      </div>
    </div>
  </Modal>
}
