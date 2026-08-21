import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  companyGatewayBaseUrl,
  companyGatewayApiKeyFailure,
  companyGatewayModelDraftFailure,
  companyGatewayProtocolFromNamespaces,
  COMPANY_GATEWAY_CREDENTIAL_REF,
  COMPANY_GATEWAY_KEY_PORTAL_URL,
  saveCompanyGateway,
} from './company-gateway.ts'
import type { CompanyGatewayProtocol } from './company-gateway.ts'
import type { AccountAccessCommand, AccountAccessSnapshot, CompanyGatewayMetadata, CompanyGatewayModel, CompanyGatewayProbeSnapshot } from './types.ts'
import css from './AccountAccessSection.module.css'

export interface AccountAccessInjected {
  hooks: {
    accountAccess: SnapshotStore<AccountAccessSnapshot | undefined>
    companyGatewayProbe?: SnapshotStore<CompanyGatewayProbeSnapshot | undefined>
  }
  command: (command: AccountAccessCommand) => void
  probeGateway?: (apiKey: string) => string
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

function cloneModels(models: readonly CompanyGatewayModel[]): CompanyGatewayModel[] {
  return models.map(model => ({ ...model, ...(Array.isArray(model.input) ? { input: [...model.input] } : {}) }))
}

/** A refreshed catalog remains authoritative, while fields edited by this form survive for matching ids. */
function mergeProbedModels(current: readonly CompanyGatewayModel[], probed: readonly CompanyGatewayModel[]): CompanyGatewayModel[] {
  const draftedById = new Map(current.map(model => [model.id, model]))
  return probed.map(model => ({ ...model, ...draftedById.get(model.id), id: model.id }))
}

function acceptsImage(model: CompanyGatewayModel): boolean {
  return Array.isArray(model.input) && model.input.includes('image')
}

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}>
    <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

export function AccountAccessSection({ useAccountAccess, useCompanyGatewayProbe, command, probeGateway, selectInitialModel, api }: Props) {
  const account = useAccountAccess(snapshot => snapshot)
  const useGatewayProbe = useCompanyGatewayProbe ?? useMissingGatewayProbe
  const probe = useGatewayProbe(snapshot => snapshot)
  const [keyDraft, setKeyDraft] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [request, setRequest] = useState<{ id: string; key: string }>()
  const [modelDrafts, setModelDrafts] = useState<CompanyGatewayModel[]>([])
  const [expandedModels, setExpandedModels] = useState<ReadonlySet<number>>(new Set())
  const [editingGateway, setEditingGateway] = useState(false)
  const [gatewayBeforeEdit, setGatewayBeforeEdit] = useState<{ models: CompanyGatewayModel[]; protocol: CompanyGatewayProtocol; key: string; showKey: boolean }>()
  const [protocol, setProtocol] = useState<CompanyGatewayProtocol>('anthropic-messages')
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [credentialWritable, setCredentialWritable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()

  const probedGateway = probe?.status === 'ready' && probe.requestId === request?.id ? probe.gateway : undefined
  const gateway = probedGateway ?? account?.gateway
  const verifiedDraft = probedGateway !== undefined && request?.key === keyDraft.trim()
  const probing = request !== undefined && probe?.requestId !== request.id

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
    setFailure(undefined)
    if (editingGateway) setModelDrafts(current => mergeProbedModels(current, probe.gateway.models))
  }, [editingGateway, probe, request?.id])

  useEffect(() => {
    if (gateway === undefined || editingGateway) return
    setModelDrafts(cloneModels(gateway.models))
  }, [editingGateway, gateway])

  const keyHint = credentialConfigured ? '已配置；输入新 Key 可验证并替换' : '请输入公司网关 API Key'
  const quotaPercent = gateway?.quota.usagePercent
  const visibleModels = useMemo(() => modelDrafts, [modelDrafts])

  if (account === undefined) return <p className={css.status}>正在检查账号状态…</p>
  const authenticated = account.status === 'authenticated'
  const probeKey = (): void => {
    const key = keyDraft.trim()
    const invalid = companyGatewayApiKeyFailure(key)
    if (invalid !== undefined) { setFailure(invalid); return }
    if (probeGateway === undefined) { setFailure('公司网关连接正在刷新，请关闭并重新打开个人中心。'); return }
    setFailure(undefined); setNotice(undefined)
    setRequest({ id: probeGateway(key), key })
  }
  const save = async (): Promise<boolean> => {
    if (gateway === undefined) return false
    const modelFailure = companyGatewayModelDraftFailure(modelDrafts)
    if (modelFailure !== undefined) { setFailure(modelFailure); return false }
    const key = keyDraft.trim()
    if (!credentialConfigured && !verifiedDraft) { setFailure('请先验证 API Key。'); return false }
    if (key.length > 0 && !verifiedDraft) { setFailure('Key 已变化，请重新验证后再保存。'); return false }
    setSaving(true); setFailure(undefined); setNotice(undefined)
    try {
      const error = await saveCompanyGateway(api, modelDrafts, key.length === 0 ? undefined : key, protocol)
      if (error !== undefined) { setFailure(error); return false }
      const selectionFailure = await selectInitialModel?.(modelDrafts)
      setCredentialConfigured(true); setKeyDraft(''); setRequest(undefined)
      if (selectionFailure !== undefined) {
        setFailure(`公司网关已保存，但初始模型未选中：${selectionFailure}`)
        return false
      }
      setNotice(`公司网关已保存，新的会话使用 ${modelDrafts[0].id.trim()}。`)
      return true
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }
  const openGatewayEditor = (): void => {
    const models = cloneModels(gateway?.models ?? modelDrafts)
    setModelDrafts(models)
    setExpandedModels(new Set())
    setGatewayBeforeEdit({ models, protocol, key: keyDraft, showKey })
    setFailure(undefined); setNotice(undefined); setEditingGateway(true)
  }
  const cancelGatewayEditor = (): void => {
    if (gatewayBeforeEdit !== undefined) {
      setModelDrafts(cloneModels(gatewayBeforeEdit.models))
      setProtocol(gatewayBeforeEdit.protocol)
      setKeyDraft(gatewayBeforeEdit.key)
      setShowKey(gatewayBeforeEdit.showKey)
    }
    setExpandedModels(new Set())
    setRequest(undefined); setFailure(undefined); setNotice(undefined); setEditingGateway(false)
  }
  const patchModel = (index: number, patch: Partial<CompanyGatewayModel>): void => {
    setModelDrafts(current => {
      const before = current[index]
      if (before === undefined) return current
      const after: CompanyGatewayModel = { ...before, ...patch }
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete after[key]
      return current.map((model, at) => at === index ? after : model)
    })
    setFailure(undefined); setNotice(undefined)
  }
  const toggleModelDetails = (index: number): void => {
    setExpandedModels(current => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  return <section className={css.section}>
    <div className={css.heading}>
      <div><h2>个人中心</h2><p>账号、公司网关模型和用量统一在这里管理。</p></div>
      <span className={authenticated ? css.signedIn : css.guest}>{authenticated ? '已登录' : account.status === 'guest' ? '游客' : '检测失败'}</span>
    </div>
    <div className={css.card}>
      <strong>{authenticated ? account.displayName ?? '公司账号' : '游客模式'}</strong>
      <dl>
        <div><dt>知识库</dt><dd>{account.knowledgeAccess ? '可使用' : '登录后可用'}</dd></div>
        <div><dt>代码库</dt><dd>{account.codeAccess ? '可使用' : '登录后可用'}</dd></div>
        <div><dt>模型来源</dt><dd>验证 Key 后启用公司网关</dd></div>
      </dl>
      {account.status === 'unavailable' ? <p className={css.error} role="alert">账号状态暂时无法验证，请检查网络后重试。</p> : null}
      <div className={css.actions}>
        {!authenticated ? <button type="button" className={css.primary} onClick={() => command('login')}>登录公司账号</button> : null}
        <button type="button" onClick={() => command('refresh')}>重新检测</button>
        {authenticated ? <button type="button" className={css.danger} onClick={() => command('logout')}>退出公司账号</button> : null}
      </div>
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
        <label className={css.gatewayField}><span>API Key</span><span className={css.keyRow}><input type={showKey ? 'text' : 'password'} value={keyDraft} placeholder={keyHint} disabled={!credentialWritable} onChange={event => { setKeyDraft(event.target.value); setFailure(undefined); setNotice(undefined) }} /><button type="button" onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button></span></label>
        <details className={css.customized}>
          <summary>自定义设置</summary>
          <div className={css.customizedBody}>
            <label className={css.gatewayField}><span>API 协议</span><select value={protocol} onChange={event => setProtocol(event.target.value as CompanyGatewayProtocol)}><option value="anthropic-messages">Anthropic URL</option><option value="openai-completions">OpenAI URL</option></select></label>
            <label className={css.gatewayField}><span>API 地址</span><input readOnly value={companyGatewayBaseUrl(protocol)} /></label>
          </div>
        </details>
        <div className={css.gatewayUtilityActions}>
          <button type="button" className={css.gatewaySecondaryButton} disabled={probing || !credentialWritable || probeGateway === undefined} onClick={probeKey}>{probing ? '验证中…' : '验证 Key 并加载'}</button>
          <button type="button" className={css.gatewaySecondaryButton} onClick={() => window.open(COMPANY_GATEWAY_KEY_PORTAL_URL, '_blank', 'noreferrer')}>打开密钥门户</button>
        </div>
        {gateway !== undefined ? <>
          <div className={css.quota}>
            <div className={css.quotaHead}><strong>用量信息</strong><span>{quotaPercent === null ? '不限额' : `${quotaPercent.toFixed(1)}%`}</span></div>
            {quotaPercent !== null ? <div className={css.progress} aria-label={`已使用 ${quotaPercent.toFixed(1)}%`}><span style={{ width: `${quotaPercent}%` }} /></div> : null}
            <p>重置周期：{cycleLabel(gateway.quota.resetCycle)}{resetTime(gateway.quota.nextResetTime) === undefined ? '' : `　下次重置：${resetTime(gateway.quota.nextResetTime)}`}</p>
          </div>
          <div className={css.modelCatalogHeading}><strong>模型目录</strong><span>已探测到 {visibleModels.length} 个模型</span></div>
          <div className={css.modelCatalog} aria-label="公司网关模型目录">
            {visibleModels.map((model, index) => <div key={index} className={css.modelCatalogEntry}>
              <div className={css.modelCatalogRow}>
                <input className={css.modelInput} type="text" value={model.id} placeholder="模型 ID" aria-label={`模型 ID ${index + 1}`} disabled={saving} onChange={event => patchModel(index, { id: event.target.value })} />
                <input className={css.modelInput} type="text" value={typeof model.name === 'string' ? model.name : ''} placeholder="显示名称（留空使用模型 ID）" aria-label={`显示名称 ${index + 1}`} disabled={saving} onChange={event => patchModel(index, { name: event.target.value.trim() === '' ? undefined : event.target.value })} />
                <button type="button" className={css.modelDetailsButton} aria-label={`模型详情 ${index + 1}`} aria-expanded={expandedModels.has(index)} title="模型详情" disabled={saving} onClick={() => toggleModelDetails(index)}><Chevron open={expandedModels.has(index)} /></button>
              </div>
              {expandedModels.has(index) ? <div className={css.modelAdvanced}>
                <label className={css.modelCheck}><input type="checkbox" checked={acceptsImage(model)} aria-label={`支持图片输入 ${index + 1}`} disabled={saving} onChange={event => patchModel(index, { input: event.target.checked ? ['text', 'image'] : undefined })} /><span>支持图片输入</span></label>
              </div> : null}
            </div>)}
          </div>
        </> : <p className={css.notice}>输入 Key 后加载公司模型目录和用量；Key 仅写入 Harness 凭据存储，不写入设置文件或日志。</p>}
        <div className={css.gatewayEditorActions}>
          <button type="button" className={css.gatewayCancelButton} disabled={saving} onClick={cancelGatewayEditor}>取消</button>
          <button type="button" className={css.gatewaySaveButton} disabled={saving || visibleModels.length === 0 || (!credentialConfigured && !verifiedDraft)} onClick={() => { void save().then(saved => { if (saved) setEditingGateway(false) }) }}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div> : null}
      {notice ? <p className={css.success} role="status">{notice}</p> : null}
      {failure ? <p className={css.error} role="alert">{failure}</p> : null}
    </div>
  </section>
}
