import '@vitejs/plugin-react/preamble'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { TrustedPrototypeRuntime, type PrototypeSelection } from '../../../../packages/harness-ui-prototype-studio/src/client/TrustedPrototypeRuntime'
import {
  collectPrototypeElementIds,
  validatePrototypeBundle,
  validateReferenceEvidence,
  verifyReferenceEvidenceFingerprint,
  type DesignSpecV1,
  type PrototypeDocumentV1,
  type ReferenceEvidenceV1,
} from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { PROTOTYPE_REFERENCE_STORAGE_KEY } from '../../src/design-reference-capture'
import { isSandboxSelectionMessage, sandboxPreviewSrcDoc } from './sandbox-preview'
import './style.css'

interface StoredPrototypeReferences { v: 1; references: Record<string, unknown> }
interface StudioRevisionSummary { id: string; parentRevisionId?: string; createdAt: string; changeSummary: string; current: boolean }
interface StudioBundle { projectId: string; evidence: ReferenceEvidenceV1[]; designSpec: DesignSpecV1; document: PrototypeDocumentV1; revisions: StudioRevisionSummary[]; currentRevisionId?: string }
interface SnapshotResponse { ok: boolean; snapshot?: { projectId?: unknown; evidence?: unknown; designSpec?: unknown; document?: unknown; revisions?: unknown; currentRevisionId?: unknown }; error?: string }

function numericToken(values: readonly string[], fallback: number): number {
  for (const value of values) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function designSpecFromEvidence(evidence: ReferenceEvidenceV1): DesignSpecV1 {
  const colors = evidence.designTokens.colors.length > 0 ? evidence.designTokens.colors : ['#2563eb', '#ffffff']
  return {
    v: 1,
    id: `design-${evidence.id}`.slice(0, 80),
    name: `${evidence.source.title || '参考网页'}设计规范`,
    basedOnEvidenceIds: [evidence.id],
    summary: evidence.observations.join(' '),
    colors: colors.slice(0, 8).map((value, index) => ({ name: index === 0 ? '主要颜色' : `辅助颜色 ${index}`, value, usage: index === 0 ? '主要操作与强调信息' : '页面背景、文字或边框' })),
    typography: { fontFamily: evidence.designTokens.fonts[0] ?? 'system-ui', headingWeight: 700, bodySize: 14 },
    spacing: { base: numericToken(evidence.designTokens.spacing, 8), cardRadius: numericToken(evidence.designTokens.radius, 10) },
    principles: ['沿用参考网页的视觉层级', '使用真实业务文案', '交互结果必须可以演示'],
  }
}

function starterDocument(designSpecId: string, title: string): PrototypeDocumentV1 {
  return {
    v: 1,
    id: 'product-prototype',
    title: `${title || '产品'}原型`,
    designSpecId,
    initialScreenId: 'overview',
    screens: [
      {
        id: 'overview', title: '产品首页', nodes: [
          { id: 'hero', type: 'text', tone: 'heading', text: '告诉 AI，你想做一个什么产品' },
          { id: 'intro', type: 'text', text: '当前原型已经继承参考网页的配色、字体、间距和圆角。' },
          { id: 'start', type: 'button', label: '查看交互示例', action: { type: 'navigate', targetScreenId: 'form' } },
        ],
      },
      {
        id: 'form', title: '交互示例', nodes: [
          { id: 'form-card', type: 'card', label: '真实可操作组件', children: [
            { id: 'name', type: 'input', label: '项目名称', placeholder: '请输入项目名称' },
            { id: 'details', type: 'button', label: '查看说明', variant: 'secondary', action: { type: 'open-modal', targetId: 'details-modal' } },
            { id: 'finish', type: 'button', label: '完成', action: { type: 'submit-success', targetScreenId: 'done' } },
            { id: 'details-modal', type: 'modal', title: '交互说明', children: [{ id: 'details-copy', type: 'text', text: '这些交互由受信运行器执行，不会运行 AI 生成的 JavaScript。' }] },
          ] },
        ],
      },
      { id: 'done', title: '完成', nodes: [{ id: 'done-title', type: 'text', tone: 'heading', text: '演示完成' }, { id: 'back', type: 'button', label: '返回首页', action: { type: 'navigate', targetScreenId: 'overview' } }] },
    ],
  }
}

function extensionRequest<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response: T | undefined) => {
    const error = chrome.runtime.lastError
    if (error !== undefined) reject(new Error(error.message)); else if (response === undefined) reject(new Error('扩展后台没有响应。')); else resolve(response)
  }))
}

async function loadCapturedReference(): Promise<StudioBundle> {
  const query = new URLSearchParams(location.search); const referenceId = query.get('referenceId'); const projectId = query.get('projectId')
  if (referenceId === null || !/^ref-[a-z0-9-]{1,75}$/i.test(referenceId) || projectId === null || !/^prototype-[a-z0-9-]{8,72}$/.test(projectId)) throw new Error('请先在 Browser Target 中选择网页，然后点击“作为参考”。')
  const stored = (await chrome.storage.local.get(PROTOTYPE_REFERENCE_STORAGE_KEY))[PROTOTYPE_REFERENCE_STORAGE_KEY] as StoredPrototypeReferences | undefined
  const raw = stored?.v === 1 ? stored.references?.[referenceId] : undefined
  const checked = validateReferenceEvidence(raw)
  if (!checked.ok || !(await verifyReferenceEvidenceFingerprint(checked.value))) throw new Error('参考网页证据不存在或指纹校验失败，请重新采集。')
  const response = await extensionRequest<SnapshotResponse>({ type: 'prototype-studio-snapshot/v1', projectId })
  if (!response.ok || response.snapshot === undefined) throw new Error(response.error ?? '无法读取原型项目。')
  const snapshot = response.snapshot
  if (snapshot.projectId !== projectId || !Array.isArray(snapshot.evidence) || (snapshot.evidence[0] as { fingerprint?: unknown } | undefined)?.fingerprint !== checked.value.fingerprint || !Array.isArray(snapshot.revisions) || snapshot.revisions.length > 20) throw new Error('原型项目与当前参考网页不匹配。')
  const revisions = snapshot.revisions as StudioRevisionSummary[]
  if (snapshot.designSpec !== undefined || snapshot.document !== undefined) {
    const bundle = validatePrototypeBundle({ evidence: [checked.value], designSpec: snapshot.designSpec, document: snapshot.document })
    if (!bundle.ok || typeof snapshot.currentRevisionId !== 'string') throw new Error('AI 保存的原型版本未通过安全校验。')
    return { projectId, ...bundle.value, revisions, currentRevisionId: snapshot.currentRevisionId }
  }
  const designSpec = designSpecFromEvidence(checked.value)
  return { projectId, evidence: [checked.value], designSpec, document: starterDocument(designSpec.id, checked.value.source.title), revisions }
}

function App(): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [bundle, setBundle] = useState<StudioBundle>()
  const [error, setError] = useState<string>()
  const [selection, setSelection] = useState<PrototypeSelection>()
  const [isolated, setIsolated] = useState(false)
  const [request, setRequest] = useState('')
  const [requestStatus, setRequestStatus] = useState<string>()
  const [sending, setSending] = useState(false)
  const [restoringRevisionId, setRestoringRevisionId] = useState<string>()
  const nonce = useMemo(() => crypto.randomUUID(), [])
  useEffect(() => {
    let disposed = false
    const refresh = () => { void loadCapturedReference().then(next => { if (!disposed) setBundle(previous => previous?.currentRevisionId === next.currentRevisionId ? previous : next) }).catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) }) }
    refresh(); const timer = window.setInterval(refresh, 2_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])
  const knownElementIds = useMemo(() => bundle === undefined ? new Set<string>() : collectPrototypeElementIds(bundle.document), [bundle])
  const srcDoc = useMemo(() => bundle === undefined ? '' : sandboxPreviewSrcDoc(bundle.document, bundle.designSpec, bundle.evidence, nonce), [bundle, nonce])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !isSandboxSelectionMessage(event.data, nonce)) return
      const item = event.data.selection
      if (!knownElementIds.has(item.elementId)) return
      setSelection({ elementId: item.elementId, type: item.type as PrototypeSelection['type'], label: item.label })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [knownElementIds, nonce])

  const askAi = async (): Promise<void> => {
    if (bundle === undefined || request.trim() === '') return
    setSending(true); setRequestStatus(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-prompt/v1', projectId: bundle.projectId, prompt: request.trim(), ...(selection === undefined ? {} : { selection }) })
      if (!response.ok) throw new Error(response.error ?? 'Harness 没有接受这次原型请求。')
      setRequest(''); setRequestStatus('已经交给 AI，生成完成后这里会自动出现新版本。')
    } catch (cause) { setRequestStatus(cause instanceof Error ? cause.message : String(cause)) } finally { setSending(false) }
  }

  const restoreRevision = async (targetRevisionId: string): Promise<void> => {
    if (bundle === undefined || bundle.currentRevisionId === undefined || targetRevisionId === bundle.currentRevisionId) return
    setRestoringRevisionId(targetRevisionId); setRequestStatus(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-restore/v1', projectId: bundle.projectId, targetRevisionId, expectedCurrentRevisionId: bundle.currentRevisionId })
      if (!response.ok) throw new Error(response.error ?? '无法恢复该历史版本。')
      const refreshed = await loadCapturedReference()
      setBundle(refreshed); setSelection(undefined); setRequestStatus('已安全恢复该历史版本，并完成写入回读验证。')
    } catch (cause) { setRequestStatus(cause instanceof Error ? cause.message : String(cause)) } finally { setRestoringRevisionId(undefined) }
  }

  if (bundle === undefined) return <main className="studio-loading"><strong>{error === undefined ? '正在读取参考网页…' : '还不能打开原型编辑器'}</strong><p>{error ?? '正在验证网页样式和截图指纹。'}</p></main>
  const { evidence, designSpec, document, revisions, currentRevisionId } = bundle
  return <main className="studio-shell">
    <header className="studio-header"><div><strong>AI 原型工具</strong><span>参考网页 → 设计规范 → 可交互原型</span></div><button type="button" onClick={() => setIsolated(value => !value)}>{isolated ? '使用应用预览' : '使用隔离预览'}</button></header>
    <section className="studio-grid">
      <aside className="studio-panel"><h2>参考与规范</h2><article>{evidence[0]!.screenshotDataUrl !== undefined && <img className="reference-shot" src={evidence[0]!.screenshotDataUrl} alt="参考网页截图" />}<b>{evidence[0]!.source.title}</b><small>{evidence[0]!.source.url}</small>{evidence[0]!.observations.map(item => <p key={item}>{item}</p>)}</article><article><h3>{designSpec.name}</h3><p>{designSpec.summary}</p><div className="swatches">{designSpec.colors.map(item => <span key={`${item.name}-${item.value}`}><i style={{ background: item.value }} />{item.name}</span>)}</div></article></aside>
      <section className="preview-panel"><div className="preview-heading"><div><h2>{document.title}</h2><p>点击原型中的任意区域，再向 AI 说明要修改什么。</p></div><span>{isolated ? '隔离沙箱' : '受信运行器'}</span></div>{isolated ? <iframe ref={frameRef} title="隔离交互原型" className="prototype-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} /> : <div className="prototype-runtime"><TrustedPrototypeRuntime document={document} designSpec={designSpec} evidence={evidence} revisionId={currentRevisionId ?? 'captured-reference'} onSelection={setSelection} /></div>}</section>
      <aside className="studio-panel"><h2>选中元素与版本</h2><article>{selection === undefined ? <p>描述你想生成的产品原型；也可以先点击中间某个元素再局部修改。</p> : <><b>{selection.label}</b><small>{selection.type} · {selection.elementId}</small></>}<textarea aria-label="原型修改要求" value={request} onChange={event => setRequest(event.target.value)} placeholder={selection === undefined ? '例如：做一个供应商准入管理后台，要有列表、筛选和审批弹窗' : '例如：把这个按钮改成主要操作，并在点击后打开确认弹窗'} /><button type="button" disabled={sending || request.trim() === ''} onClick={() => { void askAi() }}>{sending ? '正在发送…' : currentRevisionId === undefined ? '让 AI 生成原型' : '让 AI 修改原型'}</button>{requestStatus !== undefined && <p>{requestStatus}</p>}</article><h3>版本</h3><ol className="revisions">{revisions.length === 0 ? <li className="current">参考网页初始版<span>当前</span></li> : revisions.slice().reverse().map(revision => <li key={revision.id} className={revision.current ? 'current' : ''}>{revision.current ? <>{revision.changeSummary}<span>当前</span></> : <button type="button" disabled={restoringRevisionId !== undefined} onClick={() => { void restoreRevision(revision.id) }}>{restoringRevisionId === revision.id ? '正在恢复…' : `恢复：${revision.changeSummary}`}</button>}</li>)}</ol><p className="verification-note">每次保存或恢复都会绑定参考证据和设计规范指纹，并在写入后回读验证。</p></aside>
    </section>
  </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
