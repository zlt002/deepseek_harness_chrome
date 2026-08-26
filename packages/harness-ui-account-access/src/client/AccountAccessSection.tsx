import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  companyGatewayBaseUrl,
  companyGatewayApiKeyFailure,
  companyGatewayModelsForSelection,
  companyGatewayProtocolFromNamespaces,
  COMPANY_GATEWAY_CREDENTIAL_REF,
  COMPANY_GATEWAY_KEY_PORTAL_URL,
  saveCompanyGateway,
} from './company-gateway.ts'
import type { AccountAccessCommand, AccountAccessSnapshot, CompanyGatewayMetadata, CompanyGatewayModel, CompanyGatewayProbeSnapshot, CompanyGatewayProtocol } from './types.ts'
import css from './AccountAccessSection.module.css'

export interface AccountAccessInjected {
  hooks: {
    accountAccess: SnapshotStore<AccountAccessSnapshot | undefined>
    companyGatewayProbe?: SnapshotStore<CompanyGatewayProbeSnapshot | undefined>
  }
  command: (command: AccountAccessCommand) => void
  probeGateway?: (apiKey: string, protocol: CompanyGatewayProtocol, requestedModelId?: string) => string
  selectInitialModel?: (models: readonly CompanyGatewayModel[]) => Promise<string | undefined>
  api: Pick<IApiClient, 'settings' | 'credentials'>
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
  const [showKey, setShowKey] = useState(false)
  const [request, setRequest] = useState<{ id: string; key: string; protocol: CompanyGatewayProtocol; requestedModelId?: string }>()
  const [probedGateway, setProbedGateway] = useState<CompanyGatewayMetadata>()
  const [probedKey, setProbedKey] = useState<string>()
  const [selectedModel, setSelectedModel] = useState<string>()
  const [editingGateway, setEditingGateway] = useState(false)
  const [gatewayBeforeEdit, setGatewayBeforeEdit] = useState<{ protocol: CompanyGatewayProtocol; key: string; showKey: boolean }>()
  const [protocol, setProtocol] = useState<CompanyGatewayProtocol>('openai-completions')
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [credentialWritable, setCredentialWritable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const gateway = probedGateway
  const verifiedDraft = probedGateway !== undefined && probedKey === keyDraft.trim()
  const probing = request !== undefined

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
      const saved = companyGatewayProtocolFromNamespaces(response.result.value.namespaces)
      if (saved !== undefined) setProtocol(saved)
    }, () => undefined)
    return () => { active = false }
  }, [api.settings])

  useEffect(() => {
    if (probe === undefined || probe.requestId !== request?.id) return
    if (probe.status === 'error') { setFailure(probe.error); setRequest(undefined); return }
    setProbedGateway(probe.gateway); setProbedKey(request.key); setRequest(undefined)
    setSelectedModel(current => current !== undefined && probe.gateway.models.some(model => model.id === current) ? current : probe.gateway.models[0]?.id)
    setFailure(undefined)
  }, [probe, request])

  const keyHint = credentialConfigured ? '已配置；输入新 Key 可验证并替换' : '请输入公司网关 API Key'
  const quotaPercent = gateway?.quota.usagePercent

  if (account === undefined) return <p className={css.status}>正在检查账号状态…</p>
  const authenticated = account.status === 'authenticated'
  const probeKey = (): void => {
    const key = keyDraft.trim()
    const invalid = companyGatewayApiKeyFailure(key)
    if (invalid !== undefined) { setFailure(invalid); return }
    if (probeGateway === undefined) { setFailure('公司网关连接正在刷新，请关闭并重新打开个人中心。'); return }
    setFailure(undefined); setNotice(undefined)
    setProbedGateway(undefined); setProbedKey(undefined); setSelectedModel(undefined)
    setRequest({ id: probeGateway(key, protocol), key, protocol })
  }
  const verifySelectedModel = (): void => {
    const key = keyDraft.trim()
    const modelId = selectedModel
    if (gateway === undefined || probedKey !== key || modelId === undefined) { setFailure('请先加载最新模型目录并选择模型。'); return }
    if (probeGateway === undefined) { setFailure('公司网关连接正在刷新，请关闭并重新打开个人中心。'); return }
    setFailure(undefined); setNotice(undefined)
    setRequest({ id: probeGateway(key, protocol, modelId), key, protocol, requestedModelId: modelId })
  }
  const save = async (): Promise<boolean> => {
    if (gateway === undefined) return false
    if (!verifiedDraft || selectedModel === undefined) { setFailure('请先用当前 Key 加载最新模型目录并选择模型。'); return false }
    const key = keyDraft.trim()
    if (key.length === 0) { setFailure('请输入 API Key 后加载最新模型目录。'); return false }
    const capability = gateway.capability
    if (capability === undefined || capability.tools !== true || capability.protocol !== protocol || capability.modelId !== selectedModel) {
      setFailure('请先验证所选模型是否支持 Agent 工具调用。')
      return false
    }
    const models = companyGatewayModelsForSelection(gateway.models, selectedModel)
    setSaving(true); setFailure(undefined); setNotice(undefined)
    try {
      const error = await saveCompanyGateway(api, models, key, protocol)
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
    setGatewayBeforeEdit({ protocol, key: keyDraft, showKey })
    setFailure(undefined); setNotice(undefined); setEditingGateway(true)
  }
  const cancelGatewayEditor = (): void => {
    if (gatewayBeforeEdit !== undefined) {
      setProtocol(gatewayBeforeEdit.protocol)
      setKeyDraft(gatewayBeforeEdit.key)
      setShowKey(gatewayBeforeEdit.showKey)
    }
    setRequest(undefined); setFailure(undefined); setNotice(undefined); setEditingGateway(false)
  }

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
        <label className={css.gatewayField}><span>API 协议</span><select value={protocol} onChange={event => { setProtocol(event.target.value as CompanyGatewayProtocol); setProbedGateway(undefined); setProbedKey(undefined); setRequest(undefined); setSelectedModel(undefined); setFailure(undefined) }}><option value="openai-completions">OpenAI URL</option><option value="anthropic-messages">Anthropic URL</option></select></label>
        <label className={css.gatewayField}><span>API 地址</span><input readOnly value={companyGatewayBaseUrl(protocol)} /></label>
        <label className={css.gatewayField}><span>API Key</span><span className={css.keyRow}><input type={showKey ? 'text' : 'password'} value={keyDraft} placeholder={keyHint} disabled={!credentialWritable} onChange={event => { setKeyDraft(event.target.value); setProbedGateway(undefined); setProbedKey(undefined); setRequest(undefined); setSelectedModel(undefined); setFailure(undefined); setNotice(undefined) }} /><button type="button" onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button></span></label>
        <div className={css.gatewayUtilityActions}>
          <button type="button" className={css.gatewaySecondaryButton} disabled={probing || !credentialWritable || probeGateway === undefined} onClick={probeKey}>{probing ? '加载中…' : '验证 Key 并加载模型'}</button>
          {gateway === undefined ? null : <button type="button" className={css.gatewaySecondaryButton} disabled={probing || keyDraft.trim().length === 0 || selectedModel === undefined || probeGateway === undefined} onClick={verifySelectedModel}>{probing ? '验证中…' : '验证所选模型的 Agent 工具能力'}</button>}
          <button type="button" className={css.gatewaySecondaryButton} onClick={() => window.open(COMPANY_GATEWAY_KEY_PORTAL_URL, '_blank', 'noreferrer')}>打开密钥门户</button>
        </div>
        {gateway !== undefined ? <>
          <div className={css.quota}>
            <div className={css.quotaHead}><strong>用量信息</strong><span>{quotaPercent === null ? '不限额' : `${quotaPercent.toFixed(1)}%`}</span></div>
            {quotaPercent !== null ? <div className={css.progress} aria-label={`已使用 ${quotaPercent.toFixed(1)}%`}><span style={{ width: `${quotaPercent}%` }} /></div> : null}
            <p>重置周期：{cycleLabel(gateway.quota.resetCycle)}{resetTime(gateway.quota.nextResetTime) === undefined ? '' : `　下次重置：${resetTime(gateway.quota.nextResetTime)}`}</p>
          </div>
          <label className={css.gatewayField}><span>模型目录（已加载 {gateway.models.length} 个模型）</span><select value={selectedModel} disabled={saving} onChange={event => { setSelectedModel(event.target.value); setFailure(undefined); setNotice(undefined) }}>{gateway.models.map(model => <option key={model.id} value={model.id}>{typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id}</option>)}</select></label>
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
