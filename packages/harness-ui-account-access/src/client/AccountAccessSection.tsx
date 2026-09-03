import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  companyGatewayBaseUrl,
  companyGatewayApiKeyFailure,
  discoverCompanyGatewayModels,
  companyGatewayMetadataForEditing,
  companyGatewayModelsFromNamespaces,
  companyGatewayModelsForSelection,
  companyGatewayProtocolFromNamespaces,
  mergeCompanyGatewayModels,
  COMPANY_GATEWAY_CREDENTIAL_REF,
  COMPANY_GATEWAY_KEY_PORTAL_URL,
  saveCompanyGateway,
} from './company-gateway.ts'
import type { AccountAccessCommand, AccountAccessSnapshot, CompanyGatewayMetadata, CompanyGatewayModel, CompanyGatewayProbeSnapshot, CompanyGatewayProtocol } from './types.ts'
import { CompanyGatewayModelCatalog } from './CompanyGatewayModelCatalog.tsx'
import css from './AccountAccessSection.module.css'

export interface AccountAccessInjected {
  hooks: {
    accountAccess: SnapshotStore<AccountAccessSnapshot | undefined>
    companyGatewayProbe?: SnapshotStore<CompanyGatewayProbeSnapshot | undefined>
  }
  command: (command: AccountAccessCommand) => void
  probeGateway?: (apiKey: string, protocol: CompanyGatewayProtocol) => string
  selectInitialModel?: (models: readonly CompanyGatewayModel[]) => Promise<string | undefined>
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
}

type Props = PropsRuntime<'settings.section'> & InjectFace<AccountAccessInjected>

const useMissingGatewayProbe = <T,>(selector: (snapshot: CompanyGatewayProbeSnapshot | undefined) => T): T => selector(undefined)

function cycleLabel(value: CompanyGatewayMetadata['quota']['resetCycle']): string {
  if (value === 'daily') return '1 天'
  if (value === 'weekly') return '1 周'
  if (value === 'monthly') return '1 个月'
  return '不限额'
}

function resetTime(value: string | null): string | undefined {
  if (value === null) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('zh-CN', { hour12: false })
}

export function AccountAccessSection({ useAccountAccess, useCompanyGatewayProbe, command, probeGateway, selectInitialModel, api }: Props) {
  const account = useAccountAccess(snapshot => snapshot)
  const useGatewayProbe = useCompanyGatewayProbe ?? useMissingGatewayProbe
  const probe = useGatewayProbe(snapshot => snapshot)
  const [keyDraft, setKeyDraft] = useState('')
  const [request, setRequest] = useState<{ id: string; key: string; protocol: CompanyGatewayProtocol }>()
  const [probedGateway, setProbedGateway] = useState<CompanyGatewayMetadata>()
  const [restoredGateway, setRestoredGateway] = useState<CompanyGatewayMetadata>()
  const [probedKey, setProbedKey] = useState<string>()
  const [savedGatewayModels, setSavedGatewayModels] = useState<CompanyGatewayModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string>()
  const [editingGateway, setEditingGateway] = useState(false)
  const [gatewayBeforeEdit, setGatewayBeforeEdit] = useState<{ protocol: CompanyGatewayProtocol; key: string }>()
  const [protocol, setProtocol] = useState<CompanyGatewayProtocol>('openai-completions')
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [credentialWritable, setCredentialWritable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const probing = request !== undefined
  const gateway = probing ? undefined : (probedGateway ?? restoredGateway)
  const storedCredentialDraft = gateway !== undefined && probedGateway === undefined && credentialConfigured && keyDraft.trim().length === 0
  const verifiedDraft = (probedGateway !== undefined && probedKey === keyDraft.trim()) || storedCredentialDraft

  useEffect(() => {
    let active = true
    void api.credentials.describe({ refs: [COMPANY_GATEWAY_CREDENTIAL_REF] }).then(response => {
      if (!active || !response.result.ok) return
      const state = response.result.value.credentials[COMPANY_GATEWAY_CREDENTIAL_REF]
      setCredentialConfigured(state?.configured === true)
      setCredentialWritable(state?.writable !== false)
    }, () => undefined)
    return () => { active = false }
  }, [api.credentials])

  useEffect(() => {
    let active = true
    void api.settings.describe({}).then(response => {
      if (!active || !response.result.ok) return
      const namespaces = response.result.value.namespaces
      const saved = companyGatewayProtocolFromNamespaces(namespaces)
      if (saved !== undefined) setProtocol(saved)
      const models = companyGatewayModelsFromNamespaces(namespaces) ?? []
      setSavedGatewayModels(models)
      const restored = companyGatewayMetadataForEditing(models, account?.gateway)
      setRestoredGateway(restored)
      setSelectedModel(current => current !== undefined && restored?.models.some(model => model.id === current) ? current : restored?.models[0]?.id)
    }, () => undefined)
    return () => { active = false }
  // Load the saved profile once for this panel. Do not re-run this effect when
  // the account snapshot refreshes, or an in-progress restored-catalog draft
  // could be replaced underneath the editor.
  }, [api.settings])

  useEffect(() => {
    if (probe === undefined || probe.requestId !== request?.id) return
    if (probe.status === 'error') { setFailure(probe.error); setRequest(undefined); return }
    const models = mergeCompanyGatewayModels(savedGatewayModels, probe.gateway.models)
    setProbedGateway({ ...probe.gateway, models }); setProbedKey(request.key); setRequest(undefined)
    setSelectedModel(current => current !== undefined && models.some(model => model.id === current) ? current : models[0]?.id)
    setFailure(undefined)
  }, [probe, request, savedGatewayModels])

  const keyHint = credentialConfigured ? '已安全保存；无需重新输入，仅替换时填写' : '请输入公司网关 API Key'
  const quotaPercent = gateway?.quota.usagePercent

  const probeKey = (): void => {
    const key = keyDraft.trim()
    const invalid = companyGatewayApiKeyFailure(key)
    if (invalid !== undefined) { setFailure(invalid); return }
    if (probeGateway === undefined) { setFailure('公司网关连接正在刷新，请关闭并重新打开个人中心。'); return }
    setFailure(undefined); setNotice(undefined)
    setProbedGateway(undefined); setRestoredGateway(undefined); setProbedKey(undefined); setSelectedModel(undefined)
    setRequest({ id: probeGateway(key, protocol), key, protocol })
  }
  const refreshCatalog = async (): Promise<void> => {
    const key = keyDraft.trim()
    if (key.length === 0 && !credentialConfigured) { setFailure('请先输入 API Key。'); return }
    if (key.length > 0) {
      const invalid = companyGatewayApiKeyFailure(key)
      if (invalid !== undefined) { setFailure(invalid); return }
    }
    setDiscovering(true); setFailure(undefined); setNotice(undefined)
    try {
      const currentModels = gateway?.models ?? savedGatewayModels
      const result = await discoverCompanyGatewayModels(api, currentModels, protocol, key.length === 0 ? undefined : key)
      if (result.error !== undefined || result.models === undefined) { setFailure(result.error ?? '刷新模型目录失败。'); return }
      const base = gateway ?? companyGatewayMetadataForEditing(result.models, account?.gateway)
      if (base === undefined) { setFailure('刷新模型目录失败。'); return }
      const refreshed = { ...base, models: result.models, checkedAt: new Date().toISOString() }
      if (probedGateway !== undefined) setProbedGateway(refreshed)
      else setRestoredGateway(refreshed)
      setSelectedModel(current => current !== undefined && result.models?.some(model => model.id === current) ? current : result.models?.[0]?.id)
      setNotice(`已同步远程最新的 ${String(result.models.length)} 个模型；保存后对话列表生效。`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setDiscovering(false)
    }
  }
  const save = async (): Promise<boolean> => {
    if (gateway === undefined) return false
    if (!verifiedDraft || selectedModel === undefined) { setFailure('请先加载模型目录并选择模型。'); return false }
    const key = keyDraft.trim()
    if (key.length === 0 && !credentialConfigured) { setFailure('请输入 API Key 后加载最新模型目录。'); return false }
    const models = companyGatewayModelsForSelection(gateway.models, selectedModel)
    setSaving(true); setFailure(undefined); setNotice(undefined)
    try {
      const error = await saveCompanyGateway(api, models, key.length === 0 ? undefined : key, protocol)
      if (error !== undefined) { setFailure(error); return false }
      const selectionFailure = await selectInitialModel?.(models)
      setCredentialConfigured(true); setKeyDraft(''); setRequest(undefined)
      if (selectionFailure !== undefined) {
        setFailure(`公司网关已保存，但初始模型未选中：${selectionFailure}`)
        return false
      }
      setNotice(`公司网关已保存，新的会话使用 ${selectedModel}。`)
      return true
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }
  const openGatewayEditor = (): void => {
    setGatewayBeforeEdit({ protocol, key: keyDraft })
    setFailure(undefined); setNotice(undefined); setEditingGateway(true)
  }
  const cancelGatewayEditor = (): void => {
    if (gatewayBeforeEdit !== undefined) {
      setProtocol(gatewayBeforeEdit.protocol)
      setKeyDraft(gatewayBeforeEdit.key)
    }
    setRequest(undefined); setFailure(undefined); setNotice(undefined); setEditingGateway(false)
  }

  useEffect(() => {
    if (!editingGateway || !credentialConfigured || keyDraft.trim().length > 0) return
    void refreshCatalog()
  // Opening the editor is the explicit refresh gesture. Do not repeat after
  // the refreshed draft itself changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingGateway, credentialConfigured])

  if (account === undefined) return <p className={css.status}>正在检查账号状态…</p>
  const authenticated = account.status === 'authenticated'

  return <section className={css.section}>
    <div className={css.heading}>
      <div className={css.headingCopy}>
        <div className={css.titleRow}>
          <h2>个人中心</h2>
          <span className={authenticated ? css.signedIn : css.guest}>{authenticated ? '已登录' : account.status === 'guest' ? '游客' : '检测失败'}</span>
        </div>
        <p>账号、网关与模型统一管理。</p>
      </div>
      <div className={css.headingActions}>
        {!authenticated ? <button type="button" className={css.primary} onClick={() => command('login')}>登录</button> : null}
        <button type="button" onClick={() => command('refresh')}>检测</button>
        {authenticated ? <button type="button" className={css.danger} onClick={() => command('logout')}>退出</button> : null}
      </div>
    </div>
    <div className={css.card}>
      {authenticated ? <strong className={css.accountName}>{account.displayName ?? '公司账号'}</strong> : null}
      <dl>
        <div><dt>知识库</dt><dd>{account.knowledgeAccess ? '可使用' : '登录后可用'}</dd></div>
        <div><dt>代码库</dt><dd>{account.codeAccess ? '可使用' : '登录后可用'}</dd></div>
        <div><dt>模型来源</dt><dd>验证 Key 后启用公司网关</dd></div>
      </dl>
      {account.status === 'unavailable' ? <p className={css.error} role="alert">{account.message ?? '账号状态暂时无法验证，请检查网络后重试。'}</p> : null}
      {authenticated ? <p className={css.hint}>退出会清除 wb-uat.annto.com 与公司 API 的登录状态。</p> : null}
    </div>

    <div className={css.gatewayProvider} data-testid="company-gateway-card">
      <div className={css.gatewayProviderHead}>
        <span className={css.gatewayProviderIdentity}>
          <span className={css.gatewayProviderName}>公司网关</span>
          <span className={`${css.credentialDot} ${credentialConfigured ? css.credentialDotConfigured : css.credentialDotMissing}`} role="img" aria-label={credentialConfigured ? 'Key 已配置' : 'Key 待配置'} title={credentialConfigured ? 'Key 已配置' : 'Key 待配置'} />
        </span>
        <button type="button" className={css.gatewayEditButton} aria-label="编辑公司网关" onClick={() => editingGateway ? cancelGatewayEditor() : openGatewayEditor()}>{editingGateway ? '取消' : '编辑'}</button>
      </div>
      {editingGateway ? <div className={css.gatewayEditor}>
        <p className={css.notice}>填写方式与自定义提供方一致；公司地址固定，模型目录以密钥门户的最新结果为准。</p>
        <label className={css.gatewayField}><span>API 协议</span><select value={protocol} onChange={event => { setProtocol(event.target.value as CompanyGatewayProtocol); setProbedGateway(undefined); setRestoredGateway(undefined); setProbedKey(undefined); setRequest(undefined); setSelectedModel(undefined); setFailure(undefined) }}><option value="openai-completions">OpenAI URL</option><option value="anthropic-messages">Anthropic URL</option></select></label>
        <label className={css.gatewayField}><span>API 地址</span><input readOnly value={companyGatewayBaseUrl(protocol)} /></label>
        <label className={css.gatewayField}><span>API Key</span><span className={css.keyRow}><input type="password" value={keyDraft} placeholder={keyHint} disabled={!credentialWritable} onChange={event => { setKeyDraft(event.target.value); setProbedGateway(undefined); setRestoredGateway(undefined); setProbedKey(undefined); setRequest(undefined); setSelectedModel(undefined); setFailure(undefined); setNotice(undefined) }} /></span></label>
        <div className={css.gatewayUtilityActions}>
          <button type="button" className={css.gatewaySecondaryButton} disabled={probing || discovering || (!credentialConfigured && keyDraft.trim().length === 0)} onClick={() => { void refreshCatalog() }}>{discovering ? '同步中…' : '刷新远程模型'}</button>
          {keyDraft.trim().length === 0 ? null : <button type="button" className={css.gatewaySecondaryButton} disabled={probing || discovering || !credentialWritable || probeGateway === undefined} onClick={probeKey}>{probing ? '验证中…' : '验证并加载用量'}</button>}
          <button type="button" className={css.gatewaySecondaryButton} onClick={() => window.open(COMPANY_GATEWAY_KEY_PORTAL_URL, '_blank', 'noreferrer')}>打开密钥门户</button>
        </div>
        {gateway !== undefined ? <>
          <div className={css.quota}>
            <div className={css.quotaHead}><strong>用量信息</strong><span>{quotaPercent === null ? '不限额' : `${quotaPercent.toFixed(1)}%`}</span></div>
            {quotaPercent !== null ? <div className={css.progress} aria-label={`已使用 ${quotaPercent.toFixed(1)}%`}><span style={{ width: `${quotaPercent}%` }} /></div> : null}
            <p>重置周期：{cycleLabel(gateway.quota.resetCycle)}{resetTime(gateway.quota.nextResetTime) === undefined ? '' : `　下次重置：${resetTime(gateway.quota.nextResetTime)}`}</p>
          </div>
          <CompanyGatewayModelCatalog
            models={gateway.models}
            selectedModel={selectedModel}
            disabled={saving}
            onSelectedModelChange={model => { setSelectedModel(model); setFailure(undefined); setNotice(undefined) }}
            onChange={models => {
              if (probedGateway !== undefined) setProbedGateway(current => current === undefined ? current : { ...current, models })
              else setRestoredGateway(current => current === undefined ? current : { ...current, models })
              setSelectedModel(current => current !== undefined && models.some(model => model.id === current) ? current : models[0]?.id)
              setFailure(undefined); setNotice(undefined)
            }}
          />
        </> : <p className={css.notice}>输入 Key 后加载最新模型目录和用量；未出现在目录中的旧模型不会被验证或保存。</p>}
        <div className={css.gatewayEditorActions}>
          <button type="button" className={css.gatewayCancelButton} disabled={saving} onClick={cancelGatewayEditor}>取消</button>
          <button type="button" className={css.gatewaySaveButton} disabled={saving || !verifiedDraft || selectedModel === undefined} onClick={() => { void save().then(saved => { if (saved) setEditingGateway(false) }) }}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div> : null}
      {notice ? <p className={css.success} role="status">{notice}</p> : null}
      {failure ? <p className={css.error} role="alert">{failure}</p> : null}
    </div>
  </section>
}
