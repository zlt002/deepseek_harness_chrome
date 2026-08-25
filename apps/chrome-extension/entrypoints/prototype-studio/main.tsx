import '@vitejs/plugin-react/preamble'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { PrototypeSelection } from '../../../../packages/harness-ui-prototype-studio/src/client/TrustedPrototypeRuntime'
import {
  canonicalJson,
  collectPrototypeElementIds,
  prototypeDesignTokens,
  sha256Fingerprint,
  validateDesignSpec,
  validatePrototypeBundle,
  validateReferenceEvidence,
  verifyReferenceEvidenceFingerprint,
  type DesignSpecV1,
  type PrototypeDocumentV1,
  type ReferenceEvidenceV1,
} from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { PROTOTYPE_REFERENCE_STORAGE_KEY } from '../../src/design-reference-capture'
import { createDesignSpecFromEvidence, designEvidenceConflicts, designEvidenceCoverage, type DesignMergeStrategy } from './design-system'
import { clearDesignSpecDraft, loadDesignSpecDraft, saveDesignSpecDraft } from './design-spec-draft'
import { DesignSpecTweakPanel } from './DesignSpecTweakPanel'
import { designSpecQualityWarnings } from './design-spec-quality'
import { designSpecChangedGroups, designSpecColor, designSpecTweakCount, type DesignSpecChangeGroup } from './design-spec-tweaks'
import { extensionRequest } from './extension-request'
import { generationOutcome, hasStoppedGeneration, type StudioAttempt, type StudioGenerationAttempt } from './generation-status'
import { clearProductBriefDraft, loadProductBriefDraft, saveProductBriefDraft } from './product-brief-draft'
import { clearPrototypeRequestDraft, loadPrototypeRequestDraft, savePrototypeRequestDraft } from './prototype-request-draft'
import { createPrototypeExportArtifacts, downloadPrototypeArtifact } from './prototype-export'
import { isSandboxPreviewAuditMessage, isSandboxSelectionClearMessage, isSandboxSelectionMessage, sandboxPreviewSrcDoc, type SandboxPreviewMode } from './sandbox-preview'
import { summarizeAllPreviewAudits, summarizePreviewAudit, type PreviewAudit } from './preview-audit'
import { PREVIEW_VIEWPORT_WIDTHS, previewStageLayout, type PreviewViewport } from './preview-stage'
import { parseRevisionPreview, visualRevisionDiff, type RevisionPreview } from './revision-preview'
import { nextExampleTab, type ExampleTab } from './example-tab-navigation'
import { productBrief, productBriefFromFields, productBriefPrompt, type ProductBriefV1 } from '../../../../packages/harness-ui-prototype-studio/src/product-brief.mjs'
import { productRequirementCoverage, productRequirementCoverageValue, type ProductRequirementCoverageMatchV1, type ProductRequirementCoverageV1 } from '../../../../packages/harness-ui-prototype-studio/src/requirement-coverage.mjs'
import './style.css'

type DesignExampleViewport = 'desktop' | 'tablet' | 'mobile'

const PROTOTYPE_STUDIO_BUILD_ID = 'prototype-studio-2026-08-25-r4'
const PROTOTYPE_SELECTABLE_TYPES = new Set<PrototypeSelection['type']>(['text', 'icon', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal', 'table-row', 'list-item', 'tab', 'navigation-item', 'breadcrumb-item'])

/**
 * Early V1 Hosts returned only the fingerprint for their one reference. It is
 * safe to fill that shape from the verified local record, but never for a
 * multi-page project: every auxiliary page must still be complete Host
 * evidence, or the user must re-capture it.
 */
function legacySingleReferenceFingerprint(value: unknown, referenceId: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const fields = Object.keys(record)
  if (!fields.includes('fingerprint') || !fields.every(field => field === 'id' || field === 'fingerprint') || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(record.fingerprint)) return undefined
  if (record.id !== undefined && record.id !== referenceId) return undefined
  return record.fingerprint
}

function startupReason(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause)
  const compact = value.replace(/\s+/g, ' ').trim()
  return (compact || '未知启动错误。').slice(0, 600)
}

function notifyStartupFailure(message: string): void {
  window.dispatchEvent(new CustomEvent('prototype-studio-startup-failure', { detail: { message } }))
}

function nativeStartupFailure(message: string): void {
  const root = document.getElementById('root')
  if (root === null || root.querySelector('[data-prototype-startup-guard="failed"]') !== null) return
  const shell = document.createElement('main')
  shell.dataset.prototypeStartupGuard = 'failed'
  shell.setAttribute('role', 'alert')
  shell.setAttribute('aria-live', 'assertive')
  Object.assign(shell.style, { boxSizing: 'border-box', width: 'min(560px, calc(100% - 48px))', margin: '96px auto', padding: '24px', border: '1px solid #e5e7eb', borderRadius: '12px', color: '#172033', background: '#ffffff', boxShadow: '0 12px 32px rgba(15, 23, 42, 0.08)', font: '14px/1.6 system-ui, sans-serif' })
  const title = document.createElement('strong')
  title.textContent = 'AI 原型工具启动失败'
  Object.assign(title.style, { display: 'block', marginBottom: '8px', fontSize: '18px' })
  const detail = document.createElement('p')
  detail.textContent = `${message} 你的参考网页和已保存版本没有丢失。`
  Object.assign(detail.style, { margin: '0 0 12px', color: '#5b6474' })
  const build = document.createElement('small')
  build.textContent = `构建版本：${PROTOTYPE_STUDIO_BUILD_ID}`
  Object.assign(build.style, { display: 'block', marginBottom: '12px', color: '#7b8494', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' })
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = '重新加载页面'
  Object.assign(retry.style, { padding: '8px 14px', border: '1px solid #2563eb', borderRadius: '8px', color: '#ffffff', background: '#2563eb', cursor: 'pointer' })
  retry.addEventListener('click', () => location.reload())
  shell.append(title, detail, build, retry)
  root.replaceChildren(shell)
}

interface PrototypeStartupBoundaryState { error?: string }

class PrototypeStartupBoundary extends React.Component<React.PropsWithChildren, PrototypeStartupBoundaryState> {
  state: PrototypeStartupBoundaryState = {}

  componentDidMount(): void {
    const root = document.getElementById('root')
    if (root === null) {
      const message = '找不到原型工具的页面容器。'
      this.setState({ error: message })
      notifyStartupFailure(message)
      return
    }
    root.dataset.prototypeStudioMounted = 'true'
    root.dataset.prototypeStudioBuild = PROTOTYPE_STUDIO_BUILD_ID
  }

  componentDidCatch(error: Error): void {
    const message = `React 渲染失败：${startupReason(error)}`
    this.setState({ error: message })
    notifyStartupFailure(message)
  }

  render(): React.ReactNode {
    return this.state.error === undefined ? this.props.children : <StartupFailureView message={this.state.error} />
  }
}

function StartupFailureView({ message }: { message: string }): React.JSX.Element {
  return <main role="alert" aria-live="assertive" className="studio-startup-failure" style={{ boxSizing: 'border-box', width: 'min(560px, calc(100% - 48px))', margin: '96px auto', padding: 24, border: '1px solid #e5e7eb', borderRadius: 12, color: '#172033', background: '#fff', boxShadow: '0 12px 32px rgba(15, 23, 42, .08)', font: '14px/1.6 system-ui, sans-serif' }}><strong style={{ display: 'block', marginBottom: 8, fontSize: 18 }}>AI 原型工具启动失败</strong><p style={{ margin: '0 0 12px', color: '#5b6474' }}>{message} 你的参考网页和已保存版本没有丢失。</p><small style={{ display: 'block', marginBottom: 12, color: '#7b8494', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>构建版本：{PROTOTYPE_STUDIO_BUILD_ID}</small><button type="button" onClick={() => location.reload()}>重新加载页面</button></main>
}

interface StoredPrototypeReferences { v: 1; references: Record<string, unknown> }
interface StudioRevisionSummary { id: string; parentRevisionId?: string; createdAt: string; changeSummary: string; current: boolean }
interface BriefSuggestionAttempt { status: 'pending' | 'saved'; requestId: string; expiresAt: number }
interface StudioBundle { projectId: string; evidence: ReferenceEvidenceV1[]; designSpec: DesignSpecV1; document: PrototypeDocumentV1; revisions: StudioRevisionSummary[]; designConfirmed: boolean; screenshotUnavailable: boolean; productBrief?: ProductBriefV1; requirementCoverage?: ProductRequirementCoverageV1; currentRevisionId?: string; generationAttempt?: StudioGenerationAttempt; briefSuggestionAttempt?: BriefSuggestionAttempt; suggestedProductBrief?: ProductBriefV1; lastAttempt?: StudioAttempt }
interface SnapshotResponse { ok: boolean; snapshot?: { projectId?: unknown; sessionId?: unknown; evidence?: unknown; confirmedDesignSpec?: unknown; designConfirmed?: unknown; productBrief?: unknown; suggestedProductBrief?: unknown; briefSuggestionAttempt?: unknown; requirementCoverage?: unknown; designSpec?: unknown; document?: unknown; revisions?: unknown; currentRevisionId?: unknown; generationAttempt?: unknown; lastAttempt?: unknown }; code?: string; recoveryAvailable?: boolean; error?: string }
type LoadStage = 'reading-reference' | 'verifying-reference' | 'connecting-service' | 'preparing-studio'

class RecoverablePrototypeAuthorizationError extends Error {}

const LOAD_STAGE_COPY: Record<LoadStage, { title: string; detail: string }> = {
  'reading-reference': { title: '正在读取参考网页…', detail: '读取刚才保存的网页样式和截图。' },
  'verifying-reference': { title: '正在验证参考证据…', detail: '检查网页样式和截图是否完整，通常不到 1 秒。' },
  'connecting-service': { title: '正在连接原型服务…', detail: '读取这个原型项目和历史版本。' },
  'preparing-studio': { title: '正在准备原型编辑器…', detail: '生成初始设计规范和可交互页面。' },
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = window.setTimeout(() => { if (!settled) { settled = true; reject(new Error(message)) } }, timeoutMs)
    void promise.then(value => { if (!settled) { settled = true; window.clearTimeout(timeout); resolve(value) } }, cause => { if (!settled) { settled = true; window.clearTimeout(timeout); reject(cause) } })
  })
}

function studioAttempt(value: unknown): StudioAttempt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.status !== 'error' || typeof item.message !== 'string' || item.message.length === 0 || item.message.length > 600 || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || (item.requestId !== undefined && (typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(item.requestId)))) return undefined
  return { status: 'error', message: item.message, at: item.at, ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}) }
}

function studioGenerationAttempt(value: unknown): StudioGenerationAttempt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const allowed = item.status === 'pending' ? ['status', 'requestId', 'expectedRevisionId', 'prompt', 'localEditScope', 'productBrief', 'allowRevisionEviction', 'at'] : ['status', 'requestId', 'expectedRevisionId', 'prompt', 'localEditScope', 'productBrief', 'allowRevisionEviction', 'message', 'at']
  if (!Object.keys(item).every(key => allowed.includes(key)) || (item.status !== 'pending' && item.status !== 'error') || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(item.requestId) || (item.expectedRevisionId !== undefined && (typeof item.expectedRevisionId !== 'string' || !/^rev-[a-z0-9-]{1,156}$/i.test(item.expectedRevisionId))) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) return undefined
  if (item.localEditScope !== undefined) {
    const scope = item.localEditScope
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length !== 2) return undefined
    const selection = (scope as Record<string, unknown>).selection; const fingerprint = (scope as Record<string, unknown>).baselineDocumentFingerprint
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).length !== 3 || typeof (selection as Record<string, unknown>).elementId !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test((selection as Record<string, unknown>).elementId as string) || typeof (selection as Record<string, unknown>).type !== 'string' || typeof (selection as Record<string, unknown>).label !== 'string' || ((selection as Record<string, unknown>).label as string).length > 2_000 || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) return undefined
  }
  if (item.prompt !== undefined && (typeof item.prompt !== 'string' || item.prompt.trim().length === 0 || item.prompt.length > 6_000)) return undefined
  if (item.productBrief !== undefined && productBrief(item.productBrief) === undefined) return undefined
  if (item.allowRevisionEviction !== undefined && item.allowRevisionEviction !== true) return undefined
  if (item.status === 'error' && (typeof item.message !== 'string' || item.message.length === 0 || item.message.length > 600)) return undefined
  return item as unknown as StudioGenerationAttempt
}

function briefSuggestionAttempt(value: unknown): BriefSuggestionAttempt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || (item.status !== 'pending' && item.status !== 'saved') || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(item.requestId) || !Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) <= Date.now()) return undefined
  return item as unknown as BriefSuggestionAttempt
}

function studioRevisions(value: unknown, currentRevisionId: unknown): StudioRevisionSummary[] | undefined {
  if (!Array.isArray(value) || value.length > 20 || (currentRevisionId !== undefined && (typeof currentRevisionId !== 'string' || !/^rev-[a-z0-9-]{1,156}$/i.test(currentRevisionId)))) return undefined
  const revisions: StudioRevisionSummary[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const item = raw as Record<string, unknown>; const keys = Object.keys(item)
    if (!keys.every(key => ['id', 'parentRevisionId', 'createdAt', 'changeSummary', 'current'].includes(key)) || typeof item.id !== 'string' || !/^rev-[a-z0-9-]{1,156}$/i.test(item.id) || (item.parentRevisionId !== undefined && (typeof item.parentRevisionId !== 'string' || !/^rev-[a-z0-9-]{1,156}$/i.test(item.parentRevisionId))) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.changeSummary !== 'string' || item.changeSummary.length > 600 || typeof item.current !== 'boolean') return undefined
    revisions.push(item as unknown as StudioRevisionSummary)
  }
  if (new Set(revisions.map(item => item.id)).size !== revisions.length || revisions.filter(item => item.current).length > 1) return undefined
  const current = revisions.find(item => item.current)
  if ((current?.id ?? undefined) !== (currentRevisionId ?? undefined)) return undefined
  return revisions
}

function selectionTypeLabel(type: PrototypeSelection['type']): string {
  return ({ text: '文字', icon: '图标', button: '按钮', input: '输入框', card: '卡片', group: '布局组', metric: '指标', badge: '状态标签', alert: '提示', progress: '进度', chart: '图表', table: '表格', tabs: '标签页组', list: '列表', breadcrumb: '面包屑', 'empty-state': '空状态', pagination: '分页', modal: '弹窗或抽屉', 'table-row': '表格行', 'list-item': '列表项', tab: '标签页', 'navigation-item': '产品导航项', 'breadcrumb-item': '面包屑项' } satisfies Record<PrototypeSelection['type'], string>)[type]
}

function revisionTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) : ''
}

function coverageKind(kind: 'page' | 'module' | 'flow'): string { return ({ page: '页面', module: '模块', flow: '流程' })[kind] }
function missingCoverageReason(kind: 'page' | 'module' | 'flow'): string { return ({ page: '没有找到同名或明确对应的页面。', module: '没有找到可见的对应模块、字段或内容。', flow: '没有找到能产生对应页面、弹窗或业务状态结果的固定动作。' })[kind] }

function RequirementCoveragePanel({ coverage, historical, onFocus }: { coverage: ProductRequirementCoverageV1; historical: boolean; onFocus?: (match: ProductRequirementCoverageMatchV1) => void }): React.JSX.Element {
  const missing = coverage.items.filter(item => item.status === 'missing').length
  return <article className={`requirement-coverage ${historical ? 'historical' : ''}`} aria-label="需求验收">
    <header><div><h3>需求验收</h3><small>{historical ? '这是该历史版本当时的验收结果。' : '页面和模块核对真实结构；流程由可信运行器逐步骤回放，不采用 AI 自评。'}</small></div><b className={missing === 0 ? 'complete' : 'incomplete'}>{missing === 0 ? `✓ ${coverage.items.length} 项已通过` : `${missing} 项待补`}</b></header>
    <ol>{coverage.items.map(item => {
      const match = item.matches[0]
      return <li key={item.id} className={item.status}><span aria-hidden="true">{item.status === 'satisfied' ? '✓' : '○'}</span><div><b>{coverageKind(item.kind)} · {item.requirement}</b>{match === undefined ? <small>{missingCoverageReason(item.kind)}</small> : <><small>{item.kind === 'flow' ? '可信运行器回放通过' : '已匹配'}：{match.label}{match.screenId === undefined ? '' : ` · 页面 ${match.screenId}`}{match.nodeId === undefined ? '' : ` · 控件 ${match.nodeId}`}</small>{match.verification !== undefined && <small className="coverage-replay"><b>实际步骤：</b>{match.verification.steps.join(' → ')}<i>最后看到：{match.verification.final}</i></small>}</>}</div>{match !== undefined && !historical && onFocus !== undefined && <button type="button" className="secondary" onClick={() => onFocus(match)}>{match.nodeId === undefined ? '定位页面' : '定位控件'}</button>}</li>
    })}</ol>
  </article>
}

function starterDocument(designSpecId: string, title: string): PrototypeDocumentV1 {
  return {
    v: 1,
    id: 'product-prototype',
    title: `${title || '产品'}原型`,
    designSpecId,
    initialScreenId: 'overview',
    shell: { productName: title || '产品原型', placement: 'sidebar', items: [{ id: 'nav-overview', label: '产品首页', targetScreenId: 'overview' }, { id: 'nav-form', label: '交互示例', targetScreenId: 'form' }, { id: 'nav-done', label: '完成状态', targetScreenId: 'done' }] },
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

function reviewVariables(spec: DesignSpecV1): React.CSSProperties {
  const token = prototypeDesignTokens(spec)
  return {
    '--review-primary': token.primary, '--review-on-primary': token.onPrimary, '--review-info': token.info, '--review-positive': token.positive, '--review-warning': token.warning, '--review-danger': token.danger, '--review-page': token.page, '--review-surface': token.surface, '--review-elevated': token.elevated,
    '--review-text': token.text, '--review-muted': token.textMuted, '--review-border': token.border, '--review-border-width': token.borderWidth, '--review-radius': token.radius,
    '--review-radius-small': token.radiusSmall, '--review-radius-large': token.radiusLarge, '--review-font': token.font, '--review-body': token.bodySize, '--review-body-weight': token.bodyWeight, '--review-body-line': token.bodyLineHeight,
    '--review-heading': token.headingSize, '--review-heading-line': token.headingLineHeight, '--review-heading-weight': token.headingWeight, '--review-caption': token.captionSize,
    '--review-letter': token.letterSpacing, '--review-space-small': token.spaceSmall, '--review-space-medium': token.spaceMedium, '--review-space-large': token.spaceLarge,
    '--review-section-gap': token.sectionGap, '--review-content-width': token.contentWidth, '--review-shadow': token.shadow, '--review-surface-shadow': token.surfaceShadow, '--review-elevated-shadow': token.elevatedShadow, '--review-gradient': token.gradient, '--review-control': token.controlHeight, '--review-control-radius': token.controlRadius, '--review-input': token.inputHeight, '--review-icon-size': token.iconSize, '--review-disabled-opacity': token.disabledOpacity,
    '--review-duration': token.motionDuration, '--review-easing': token.motionEasing, '--review-focus-width': token.focusWidth, '--review-focus-style': token.focusStyle, '--review-focus-color': token.focusColor, '--review-focus-offset': token.focusOffset,
  } as React.CSSProperties
}

function DesignSystemReview({ bundle, confirming, confirmError, reopening, reopenError, creatingVariant, createVariantError, onConfirm, onReopen, onCreateVariant }: { bundle: StudioBundle; confirming: boolean; confirmError?: string; reopening: boolean; reopenError?: string; creatingVariant: boolean; createVariantError?: string; onConfirm: (designSpec: DesignSpecV1) => void; onReopen: () => void; onCreateVariant: () => void }): React.JSX.Element {
  const { evidence } = bundle
  const evidenceIds = useMemo(() => evidence.map(item => item.id), [evidence])
  const [draftSpec, setDraftSpec] = useState(() => loadDesignSpecDraft(window.sessionStorage, bundle.projectId, evidenceIds, validateDesignSpec) ?? bundle.designSpec)
  const [showTweaks, setShowTweaks] = useState(false)
  const [previewTab, setPreviewTab] = useState<ExampleTab>('overview')
  const [exampleViewport, setExampleViewport] = useState<DesignExampleViewport>('desktop')
  const [showExampleModal, setShowExampleModal] = useState(false)
  const [exampleSection, setExampleSection] = useState<'workspace' | 'projects'>('workspace')
  const [exampleFilter, setExampleFilter] = useState<'all' | 'active'>('all')
  const [exampleProfileOpen, setExampleProfileOpen] = useState(false)
  const [exampleProjectName, setExampleProjectName] = useState('')
  const [exampleFeedback, setExampleFeedback] = useState<string>()
  const [defaultAcknowledged, setDefaultAcknowledged] = useState(false)
  const exampleTriggerRef = useRef<HTMLButtonElement>(null)
  const exampleModalRef = useRef<HTMLElement>(null)
  const exampleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const restored = loadDesignSpecDraft(window.sessionStorage, bundle.projectId, evidenceIds, validateDesignSpec)
    setDraftSpec(restored ?? bundle.designSpec)
    setShowTweaks(restored !== undefined)
  }, [bundle.designSpec, bundle.projectId, evidenceIds])
  const closeExampleModal = (): void => {
    setShowExampleModal(false)
    window.requestAnimationFrame(() => exampleTriggerRef.current?.focus())
  }
  const showExampleFeedback = (message: string): void => {
    setExampleFeedback(message)
    window.setTimeout(() => setExampleFeedback(current => current === message ? undefined : current), 2_400)
  }
  const createExampleProject = (): void => {
    const name = exampleProjectName.trim()
    if (name.length === 0) { showExampleFeedback('请先填写项目名称'); exampleInputRef.current?.focus(); return }
    closeExampleModal()
    setExampleProjectName('')
    showExampleFeedback(`已创建“${name}”示例项目`)
  }
  useEffect(() => {
    if (!showExampleModal) return
    window.requestAnimationFrame(() => exampleInputRef.current?.focus())
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeExampleModal(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(exampleModalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (focusable.length === 0) { event.preventDefault(); return }
      const first = focusable[0]!; const last = focusable.at(-1)!
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keepFocusInside)
    return () => window.removeEventListener('keydown', keepFocusInside)
  }, [showExampleModal])
  useEffect(() => {
    const tabList = window.document.querySelector<HTMLElement>('.example-tabs[role="tablist"]')
    if (tabList === null) return
    const tabs = [...tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    tabs.forEach((tab, index) => { tab.tabIndex = index === (previewTab === 'overview' ? 0 : 1) ? 0 : -1 })
    const navigateTabs = (event: KeyboardEvent): void => {
      if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
      const next = nextExampleTab(previewTab, event.key)
      if (next === undefined) return
      event.preventDefault()
      setPreviewTab(next)
      window.requestAnimationFrame(() => tabs[next === 'overview' ? 0 : 1]?.focus())
    }
    tabList.addEventListener('keydown', navigateTabs)
    return () => tabList.removeEventListener('keydown', navigateTabs)
  }, [previewTab])
  const updateDraftSpec = (next: DesignSpecV1): void => {
    setDraftSpec(next)
    saveDesignSpecDraft(window.sessionStorage, bundle.projectId, evidenceIds, next, bundle.designSpec)
    setDefaultAcknowledged(false)
  }
  const legacyCapture = evidence.some(item => item.designTokens.fontSizes === undefined || item.designTokens.textStyles === undefined || item.designTokens.accentBackgroundColors === undefined)
  const designSpec = bundle.designConfirmed ? bundle.designSpec : draftSpec
  const evidenceConflicts = designEvidenceConflicts(evidence)
  const designBreakpoints = designSpec.responsive?.breakpoints ?? [768, 1_024]
  const compactBreakpoint = designBreakpoints[0] ?? 768
  const wideBreakpoint = designBreakpoints.at(-1) ?? 1_024
  const exampleViewportWidths: Record<DesignExampleViewport, number> = {
    mobile: Math.max(320, Math.min(480, compactBreakpoint - 1)),
    tablet: Math.max(compactBreakpoint, Math.min(wideBreakpoint - 1, Math.round((compactBreakpoint + wideBreakpoint) / 2))),
    desktop: Math.min(1_920, Math.max(1_080, wideBreakpoint + 1)),
  }
  const changedGroups = designSpecTweakCount(bundle.designSpec, designSpec)
  const changedGroupIds = designSpecChangedGroups(bundle.designSpec, designSpec)
  const spacing = designSpec.spacing.scale ?? [designSpec.spacing.base, designSpec.spacing.base * 2, designSpec.spacing.base * 3]
  const radii = designSpec.borders?.radiusScale ?? [designSpec.spacing.cardRadius]
  const coverageGroup = (id: string): DesignSpecChangeGroup | undefined => ({ colors: 'colors', surfaces: 'colors', 'feedback-colors': 'colors', typography: 'typography', 'font-assets': 'typography', spacing: 'layout', layout: 'layout', responsive: 'responsive', borders: 'borders', effects: 'effects', controls: 'controls', components: 'controls', 'visual-assets': 'controls', focus: 'focus', motion: 'motion' } as Record<string, DesignSpecChangeGroup | undefined>)[id]
  const referencePageKeys = evidence.map(item => { try { const url = new URL(item.source.url); return `${url.origin}${url.pathname}` } catch { return item.source.url } })
  const responsiveVariantWidths = new Set(referencePageKeys).size === 1 ? [...new Set(evidence.map(item => item.viewport.width))].sort((left, right) => right - left) : []
  const coverage = designEvidenceCoverage(evidence[0]!).map(item => item.id === 'responsive' && responsiveVariantWidths.length > 1 ? { ...item, status: 'observed' as const, detail: `同一网页已分别实测 ${responsiveVariantWidths.join(' / ')}px，布局和组件 token 均来自各自真实视口`, adjusted: coverageGroup(item.id) !== undefined && changedGroupIds.has(coverageGroup(item.id)!) } : { ...item, adjusted: coverageGroup(item.id) !== undefined && changedGroupIds.has(coverageGroup(item.id)!) })
  const coverageById = new Map(coverage.map(item => [item.id, item]))
  // The generated spec always has safe fallback values so the preview can render.
  // Never present those fallbacks as if the reference page supplied them.
  const measuredValue = (coverageId: string, value: React.ReactNode): React.ReactNode => {
    const item = coverageById.get(coverageId)
    return item?.status === 'default' && !item.adjusted ? '未识别' : value
  }
  const defaultCoverage = coverage.filter(item => item.status === 'default')
  const defaultCoverageCount = defaultCoverage.length
  const requiresDefaultAcknowledgement = !bundle.designConfirmed && !legacyCapture && defaultCoverageCount >= 2
  const qualityWarnings = designSpecQualityWarnings(designSpec)
  const observedComponents = [...new Set(evidence.flatMap(item => item.designTokens.componentKinds ?? []))]
  const observedStates = [...new Set(evidence.flatMap(item => item.designTokens.componentStates ?? []))]
  const componentSamples = evidence[0]!.designTokens.componentSamples ?? []
  const captureCoverage = evidence[0]!.captureCoverage
  const responsiveCoverage = captureCoverage?.responsive
  const stateCoverage = captureCoverage?.states
  const cssStateRuleTokens = stateCoverage?.cssRuleTokens ?? []
  const responsiveSource = responsiveVariantWidths.length > 1 ? `同一网页实测 ${responsiveVariantWidths.join(' / ')}px` : responsiveCoverage !== undefined && responsiveCoverage.observedViewportWidths.length > 1 ? `实测 ${responsiveCoverage.observedViewportWidths.join(' / ')}px` : responsiveCoverage !== undefined && responsiveCoverage.cssBreakpoints.length > 0 ? `从 CSS 规则提取 ${responsiveCoverage.cssBreakpoints.join(' / ')}px` : captureCoverage !== undefined && captureCoverage.opaqueStylesheets > 0 ? '不可访问/默认（部分样式表受限）' : '不可访问/默认'
  const interactionStateSource = stateCoverage !== undefined && stateCoverage.observedTokens.length > 0 ? `实测 ${stateCoverage.observedTokens.join('、')}` : cssStateRuleTokens.length > 0 ? `从 CSS 规则提取 ${cssStateRuleTokens.length} 条安全 token` : captureCoverage !== undefined && captureCoverage.opaqueStylesheets > 0 ? '不可访问/默认（部分样式表受限）' : '不可访问/默认'
  const cssStateStyle = (component: string, state: string): React.CSSProperties | undefined => {
    const token = cssStateRuleTokens.find(item => item.component === component && item.state === state)
    return token === undefined ? undefined : { color: token.color, backgroundColor: token.backgroundColor, borderColor: token.borderColor, boxShadow: token.boxShadow, transitionDuration: token.transitionDuration, transitionTimingFunction: token.transitionTimingFunction }
  }
  const captureCoverageWarnings = captureCoverage === undefined ? ['这条旧参考没有记录采集覆盖范围，请重新提取以查看 iframe、跨域样式、懒加载图片和元素丢弃情况。'] : captureCoverage.opaqueStylesheets > 0 || captureCoverage.iframeElements > 0 || captureCoverage.unloadedImages > 0 || captureCoverage.horizontalOverflow || captureCoverage.candidateElements > captureCoverage.inspectedElements ? captureCoverage.limitations : []
  const requiresReviewAcknowledgement = requiresDefaultAcknowledgement || qualityWarnings.length > 0 || captureCoverageWarnings.length > 0
  const reviewTokens = prototypeDesignTokens(designSpec)
  const semanticColors = [
    { name: '页面背景', value: reviewTokens.page }, { name: '内容表面', value: reviewTokens.surface }, { name: '浮层表面', value: reviewTokens.elevated },
    { name: '主要文字', value: reviewTokens.text }, { name: '辅助文字', value: reviewTokens.textMuted }, { name: '分隔边框', value: reviewTokens.border },
  ]
  return <main className="review-shell" style={reviewVariables(designSpec)}>
    <header className="review-header"><div><span className="step-badge">AI 原型工具</span><h1>{bundle.designConfirmed ? '查看已确认的设计规范' : '确认网页设计规范'}</h1><p>左侧检查全部规范，右侧直接操作示例页面；确认后才会交给 AI 生成原型。</p></div><ol className="review-steps"><li className="done"><i>1</i><span>提取规范</span></li><li className={bundle.designConfirmed ? 'done' : 'current'}><i>2</i><span>确认规范</span></li><li className={bundle.designConfirmed ? 'current' : ''}><i>3</i><span>生成原型</span></li></ol></header>
    {bundle.screenshotUnavailable && <section className="evidence-retention-note" role="status"><b>参考截图已清理</b><span>为了控制浏览器存储空间，旧截图已移除；完整设计规范、已确认需求和原型历史仍由可信服务保留，可以继续使用。</span></section>}
    {!bundle.designConfirmed && requiresReviewAcknowledgement && <section id="review-warnings" className="review-warnings" aria-labelledby="review-warnings-title"><header><div><span>确认前请核对</span><b id="review-warnings-title">采集结果存在需要你判断的项目</b></div><small>这些内容不会被偷偷当成参考网页证据</small></header><div className="review-warning-groups">{captureCoverageWarnings.length > 0 && <section><b>采集覆盖提醒</b><ul>{captureCoverageWarnings.map(item => <li key={item}>{item}</li>)}</ul></section>}{requiresDefaultAcknowledgement && <section><b>网页未识别，示例使用安全默认值</b><p>{defaultCoverage.map(item => item.label).join('、')}。</p></section>}{qualityWarnings.length > 0 && <section><b>可读性与操作提醒</b><ul>{qualityWarnings.map(item => <li key={item}>{item}</li>)}</ul></section>}</div><label className="review-acknowledgement"><input type="checkbox" checked={defaultAcknowledged} onChange={event => setDefaultAcknowledged(event.target.checked)} /><span><b>我已经看过右侧示例页面</b><small>示例效果符合预期，可以把当前规范交给 AI。</small></span></label></section>}
    <div className="review-layout">
      <aside className="review-source">{evidence[0]!.screenshotDataUrl !== undefined && <figure><img src={evidence[0]!.screenshotDataUrl} alt="参考网页当前可见区域截图" /><figcaption>截图只展示当前可见区域</figcaption></figure>}<div className="source-copy"><span className="source-label">参考网页</span><h2>{evidence[0]!.source.title}</h2><small>{evidence[0]!.source.url}</small><a className="source-open" href={evidence[0]!.source.url} target="_blank" rel="noreferrer">打开原网页核对</a><p>{designSpec.summary}</p><details className="capture-details"><summary>采集范围与未覆盖内容</summary><p>设计规范来自整页多个纵向区域的样式采样，不是只看截图；{responsiveVariantWidths.length > 1 ? `并且同一网页已在 ${responsiveVariantWidths.join(' / ')}px 分别实测。` : '当前只在一个浏览器宽度实测。'}</p><b>已经采集</b><ul>{evidence[0]!.observations.map((observation, index) => <li key={`${index}-${observation}`}>{observation}</li>)}</ul>{captureCoverage !== undefined && <><b>未覆盖或仅作推导</b><ul className="capture-limitations">{captureCoverage.limitations.filter(limitation => responsiveVariantWidths.length < 2 || !limitation.startsWith('仅在当前')).map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul></>}</details></div><div className="source-facts"><span><b>{responsiveVariantWidths.length > 1 ? responsiveVariantWidths.length : captureCoverage === undefined ? evidence[0]!.pageSize === undefined ? `${evidence[0]!.viewport.width} × ${evidence[0]!.viewport.height}` : `${evidence[0]!.pageSize!.sampledBands} 个区域` : `${captureCoverage.sampledElements} / ${captureCoverage.inspectedElements}`}</b>{responsiveVariantWidths.length > 1 ? '真实采集尺寸' : captureCoverage === undefined ? evidence[0]!.pageSize === undefined ? '采集视口' : '整页样式采样区域' : '采入 / 检查元素'}</span><span><b>{captureCoverage === undefined ? designSpec.colors.length : captureCoverage.accessibleStylesheets}</b>{captureCoverage === undefined ? '规范颜色' : '可读取样式表'}</span><span><b>{captureCoverage === undefined ? spacing.length : captureCoverage.opaqueStylesheets}</b>{captureCoverage === undefined ? '间距档位' : '受限样式表'}</span></div></aside>
      <section className="review-spec">{legacyCapture && <div className="upgrade-notice"><b>这条参考是旧版采集结果</b><span>缺少文字样式组合或按钮前景/背景配对，直接确认可能出现主色、字号或按钮文字判断不准。请回到侧栏找到该网页，点击“提取设计规范”。</span></div>}<div className="section-heading"><div><span>完整设计规范</span><h2>{designSpec.name}</h2></div><div className="section-actions">{changedGroups > 0 && <strong>已调整 {changedGroups} 类</strong>}<small>每类标明数据来源</small>{!bundle.designConfirmed && <button type="button" className="secondary" onClick={() => setShowTweaks(value => !value)}>{showTweaks ? '收起调整' : '调整规范'}</button>}</div></div>{evidence.length > 1 && <section className="multi-reference-review" aria-label="多页面参考"><b>多页面参考：{evidence.length} 页</b><p>主参考是“{evidence[0]!.source.title}”；其余页面作为辅助参考。不会把不同页面的值偷偷取平均。</p><ul>{evidence.map((item, index) => <li key={item.id}><strong>{index === 0 ? '主参考' : '辅助参考'}</strong><span>{item.source.title || item.source.url}</span>{item.screenshotDataUrl === undefined && <small>无截图，已使用可信服务中的设计证据</small>}</li>)}</ul>{evidenceConflicts.length > 0 && <div className="multi-reference-conflicts"><b>多页面差异</b><span>{evidenceConflicts.map(item => item.label).join('、')}在页面间不同。请选择合并规则后再确认。</span>{!bundle.designConfirmed && <div><button type="button" className={designSpec.merge?.strategy !== 'common' ? 'active' : ''} onClick={() => updateDraftSpec(createDesignSpecFromEvidence(evidence, 'primary' satisfies DesignMergeStrategy))}>主参考优先</button><button type="button" className={designSpec.merge?.strategy === 'common' ? 'active' : ''} onClick={() => updateDraftSpec(createDesignSpecFromEvidence(evidence, 'common' satisfies DesignMergeStrategy))}>常见值优先</button></div>}</div>}</section>}{showTweaks && !bundle.designConfirmed && <DesignSpecTweakPanel original={bundle.designSpec} draft={designSpec} onChange={updateDraftSpec} onClose={() => setShowTweaks(false)} />}<div className="coverage-grid">{coverage.map(item => <div key={item.id}><span className={`coverage-status ${item.adjusted ? 'adjusted' : item.status}`}>{item.adjusted ? '用户已调整' : item.status === 'observed' ? '网页实测' : item.status === 'inferred' ? '根据实测推导' : '网页未识别（安全默认）'}</span><b>{item.label}</b><small>{item.adjusted ? `${item.detail}；当前值以你的调整为准` : item.detail}</small></div>)}</div><nav className="spec-index" aria-label="设计规范快速目录"><b>快速查看</b><a href="#spec-colors">颜色</a><a href="#spec-type">排版</a><a href="#spec-layout">间距与响应式</a><a href="#spec-effects">圆角与效果</a><a href="#spec-components">组件状态</a><a href="#spec-principles">设计原则</a>{defaultCoverageCount > 0 && <span>{defaultCoverageCount} 类未实测</span>}</nav>
        <article id="spec-colors" className="spec-block"><h3>颜色系统</h3><h4>网页提取色板</h4><div className="color-grid">{designSpec.colors.map(item => <div className="color-token" key={`${item.name}-${item.value}`}><i style={{ background: item.value }} /><span><b>{item.name}</b><code>{item.value}</code><small>{item.usage}</small></span></div>)}</div><h4>页面语义颜色</h4><div className="semantic-color-grid">{semanticColors.map(item => <div key={item.name}><i style={{ background: item.value }} /><span><b>{item.name}</b><code>{item.value}</code></span></div>)}</div></article>
        <article id="spec-type" className="spec-block"><h3>排版系统</h3><div className="type-specimen"><div className="type-heading">页面标题 Typography</div><div className="type-body">正文用于承载主要产品信息，保持清晰、稳定的阅读节奏。</div><div className="type-caption">辅助说明与状态信息 Caption</div></div><div className="token-lines"><span><b>字号梯度</b>{measuredValue('typography', `${(designSpec.typography.fontSizeScale ?? [designSpec.typography.captionSize ?? 12, designSpec.typography.bodySize, designSpec.typography.headingSize ?? 28]).join(' / ')} px`)}</span><span><b>字重梯度</b>{measuredValue('typography', (designSpec.typography.fontWeightScale ?? [designSpec.typography.bodyWeight ?? 400, designSpec.typography.headingWeight]).join(' / '))}</span><span><b>行高梯度</b>{measuredValue('typography', designSpec.typography.lineHeightScale?.length ? `${designSpec.typography.lineHeightScale.join(' / ')} px` : '未识别')}</span></div><dl className="property-grid"><div><dt>字体</dt><dd>{measuredValue('typography', designSpec.typography.fontFamily)}</dd></div><div><dt>字体文件</dt><dd>{coverageById.get('font-assets')?.detail}</dd></div><div><dt>标题</dt><dd>{measuredValue('typography', `${designSpec.typography.headingSize ?? Math.round(designSpec.typography.bodySize * 2)}px / ${designSpec.typography.headingWeight}`)}</dd></div><div><dt>正文</dt><dd>{measuredValue('typography', `${designSpec.typography.bodySize}px / ${designSpec.typography.bodyWeight ?? 400} / ${designSpec.typography.bodyLineHeight ?? 1.5}`)}</dd></div><div><dt>辅助文字</dt><dd>{measuredValue('typography', `${designSpec.typography.captionSize ?? Math.max(10, designSpec.typography.bodySize - 2)}px`)}</dd></div><div><dt>字距</dt><dd>{measuredValue('typography', `${designSpec.typography.letterSpacing ?? 0}px`)}</dd></div></dl></article>
        <article id="spec-layout" className="spec-block"><h3>间距、布局与响应式</h3><div className="spacing-scale">{spacing.map(value => <span key={value}><i style={{ width: `${Math.max(4, value * 2)}px` }} />{value}px</span>)}</div><dl className="property-grid"><div><dt>基础间距</dt><dd>{measuredValue('spacing', `${designSpec.spacing.base}px`)}</dd></div><div><dt>区块间距</dt><dd>{measuredValue('spacing', `${designSpec.spacing.sectionGap ?? spacing.at(-1)}px`)}</dd></div><div><dt>内容宽度</dt><dd>{measuredValue('layout', `${designSpec.spacing.contentWidth ?? 680}px`)}</dd></div><div><dt>响应式断点</dt><dd>{measuredValue('responsive', designSpec.responsive?.breakpoints.length ? `${designSpec.responsive.breakpoints.join(' / ')}px` : '未识别')}</dd></div><div><dt>页面布局</dt><dd>{measuredValue('layout', designSpec.responsive?.layoutPatterns.length ? designSpec.responsive.layoutPatterns.join('、') : '未识别')}</dd></div></dl><p className="evidence-provenance"><b>响应式：</b>{responsiveSource}<small>{responsiveVariantWidths.length > 1 ? '每个尺寸都读取了当时真实 DOM 和计算样式；CSS 断点仍单独标为规则提取。' : '没有自动缩放或切换浏览器尺寸；CSS 规则提取不等于实测。'}</small></p></article>
        <article id="spec-effects" className="spec-block"><h3>边框、圆角与视觉效果</h3><div className="effect-grid"><div><b>圆角梯度</b><div className="radius-list">{radii.map(value => <i key={value} style={{ borderRadius: `${value}px` }}>{measuredValue('borders', `${value}px`)}</i>)}</div></div><div><b>投影</b><div className="shadow-list">{coverageById.get('effects')?.status === 'default' && !coverageById.get('effects')?.adjusted ? <i>未识别</i> : (designSpec.effects?.shadows.length ? designSpec.effects.shadows : ['none']).map((value, index) => <i key={`${value}-${index}`} style={{ boxShadow: value }}>{value === 'none' ? '无投影' : `层级 ${index + 1}`}</i>)}</div></div><div><b>渐变</b><div className="gradient-list">{coverageById.get('effects')?.status === 'default' && !coverageById.get('effects')?.adjusted ? <i>未识别</i> : (designSpec.effects?.gradients.length ? designSpec.effects.gradients : ['none']).map((value, index) => <i key={`${value}-${index}`} style={{ backgroundImage: value }}>{value === 'none' ? '未使用渐变' : `渐变 ${index + 1}`}</i>)}</div></div></div><dl className="property-grid"><div><dt>边框</dt><dd>{measuredValue('borders', `${designSpec.borders?.width ?? 1}px ${designSpec.borders?.style ?? 'solid'}`)}</dd></div><div><dt>卡片圆角</dt><dd>{measuredValue('borders', `${designSpec.spacing.cardRadius}px`)}</dd></div><div><dt>控件圆角</dt><dd>{measuredValue('controls', `${designSpec.controls?.radius ?? designSpec.spacing.cardRadius}px`)}</dd></div><div><dt>普通表面投影</dt><dd>{measuredValue('effects', designSpec.effects?.semantic?.surfaceShadow ?? '不使用')}</dd></div><div><dt>弹窗与菜单投影</dt><dd>{measuredValue('effects', designSpec.effects?.semantic?.elevatedShadow ?? '不使用')}</dd></div><div><dt>主按钮渐变</dt><dd>{measuredValue('effects', designSpec.effects?.semantic?.primaryControlGradient ?? '不使用')}</dd></div><div><dt>禁用控件透明度</dt><dd>{measuredValue('effects', designSpec.effects?.semantic?.disabledControlOpacity ?? '未识别')}</dd></div><div><dt>全部透明度</dt><dd>{measuredValue('effects', designSpec.effects?.opacities.length ? designSpec.effects.opacities.join(' / ') : '未识别')}</dd></div><div><dt>动效时长</dt><dd>{measuredValue('motion', designSpec.motion?.durations.length ? designSpec.motion.durations.join(' / ') : '未识别')}</dd></div><div><dt>动效曲线</dt><dd>{measuredValue('motion', designSpec.motion?.easings.length ? designSpec.motion.easings.join(' / ') : '未识别')}</dd></div></dl></article>
        <article id="spec-components" className="spec-block"><h3>组件与交互状态</h3><p className="component-observation"><b>网页实际发现：</b>{observedComponents.length > 0 ? observedComponents.join('、') : '未识别到稳定组件'}<br /><b>显式状态：</b>{observedStates.length > 0 ? observedStates.join('、') : '未发现 disabled、selected、checked 等显式状态'}</p><p className="evidence-provenance"><b>交互状态：</b>{interactionStateSource}<small>“从 CSS 规则提取”只展示已校验的颜色、边框、投影和动效 token，不会标成网页实测。</small></p>{componentSamples.length > 0 ? <div className="component-evidence-grid">{componentSamples.map(sample => <div key={sample.kind}><span style={{ color: sample.color, background: sample.backgroundColor, borderColor: sample.borderColor, borderRadius: sample.borderRadius, boxShadow: sample.boxShadow }}>{sample.exampleText?.slice(0, 20) || sample.kind}</span><b>{sample.kind} · 实采 {sample.count} 个</b><small>{sample.width}×{sample.height}px · 圆角 {sample.borderRadius} · 边框 {sample.borderWidth}{sample.states.length > 0 ? ` · ${sample.states.join(' / ')}` : ''}</small></div>)}</div> : <p className="component-missing">未采到可稳定复现的组件样本，不代表网页不存在这些组件。</p>}<div className="component-rules"><div><b>按钮</b><span>{measuredValue('controls', `${designSpec.controls?.buttonHeight ?? designSpec.controls?.height ?? 38}px 高 · ${designSpec.controls?.radius ?? 8}px 圆角`)}</span><small>主要、次要、危险、禁用</small></div><div><b>输入框</b><span>{measuredValue('controls', `${designSpec.controls?.inputHeight ?? 38}px 高 · ${designSpec.borders?.width ?? 1}px 边框`)}</span><small>默认、聚焦、错误、禁用</small></div><div><b>图标</b><span>{measuredValue('controls', `${designSpec.controls?.iconSize ?? 16}px`)}</span><small>仅使用产品内置安全图标</small></div><div><b>图片 / Logo</b><span>{observedComponents.includes('image') ? '发现图片元素，不复制网页文件' : '未识别稳定图片素材'}</span><small>原型只继承布局位置；需要真实素材时由用户另行添加</small></div><div><b>卡片</b><span>{measuredValue('borders', `${designSpec.spacing.cardRadius}px 圆角 · 表面色`)}</span><small>边框、投影、内边距</small></div><div><b>表格 / 列表</b><span>{measuredValue('components', '行间距、分隔线和选中态')}</span><small>默认、悬停、空状态</small></div><div><b>弹窗 / 抽屉</b><span>{measuredValue('components', '遮罩、层级、标题和操作区')}</span><small>打开、关闭、确认、取消</small></div><div><b>标签 / 提示</b><span>{measuredValue('feedback-colors', '信息、成功、警告、危险')}</span><small>若未识别，右侧只展示安全默认</small></div><div><b>键盘焦点</b><span>{measuredValue('focus', `${designSpec.focus?.width ?? 2}px ${designSpec.focus?.style ?? 'solid'} · 外移 ${designSpec.focus?.offset ?? 2}px`)}</span><small>{measuredValue('focus', designSpec.focus?.color ?? designSpecColor(designSpec, 'primary'))}</small></div><div><b>导航与标签页</b><span>{measuredValue('components', '默认、悬停、选中')}</span><small>未识别时不把示例选中态当作网页证据</small></div></div><div className="state-legend"><b>{coverageById.get('components')?.status === 'default' ? '下列状态用于示例交互，网页未识别' : '示例状态'}</b><span>Default 默认</span><span>Hover 悬停</span><span>Focus 聚焦</span><span>Disabled 禁用</span><span>Selected 选中</span></div>{cssStateRuleTokens.length > 0 && <div className="css-state-samples"><b>右侧示例使用的 CSS 规则 token</b>{cssStateRuleTokens.slice(0, 8).map(token => <button type="button" key={`${token.component}-${token.state}-${token.color ?? ''}-${token.backgroundColor ?? ''}`} style={cssStateStyle(token.component, token.state)} onClick={() => showExampleFeedback(`已展示 ${token.component}:${token.state} 的 CSS 规则提取样式`)}>{token.component} · {token.state}<small>CSS 规则提取</small></button>)}</div>}</article>
        <p className="component-observation"><small>CSS 声明的 hover、focus、active 等状态未被主动触发；未测视觉值不计入网页实测。</small></p>
        <article id="spec-principles" className="spec-block"><h3>交给 AI 的设计原则</h3><p className="principles-intro">下列原则会与上面的具体数值一起锁定并发送给 AI，不包含隐藏规则。</p><ol className="principles-list">{designSpec.principles.map((principle, index) => <li key={`${index}-${principle}`}><i>{index + 1}</i><span>{principle}</span></li>)}</ol></article>
      </section>
      <section className="review-example"><div className="section-heading"><div><span>组合效果预览</span><h2>这些规范组成的示例页面</h2></div><div className="example-heading-actions"><div className="example-viewport-switch" aria-label="示例页面尺寸">{(['desktop', 'tablet', 'mobile'] as const).map(value => <button type="button" key={value} className={exampleViewport === value ? 'active' : ''} aria-pressed={exampleViewport === value} onClick={() => setExampleViewport(value)}>{value === 'desktop' ? '桌面' : value === 'tablet' ? '平板' : '手机'}</button>)}</div><small>{exampleViewportWidths[exampleViewport]}px 布局示意 · 按钮均可操作</small></div></div><div className={`example-page example-${exampleViewport}`} data-example-viewport={exampleViewport}><nav><b><i />Product Workspace</b><div><button type="button" aria-pressed={exampleSection === 'workspace'} className={`nav-item ${exampleSection === 'workspace' ? 'active' : ''}`} onClick={() => { setExampleSection('workspace'); showExampleFeedback('已切换到工作台') }}>工作台</button><button type="button" aria-pressed={exampleSection === 'projects'} className={`nav-item ${exampleSection === 'projects' ? 'active' : ''}`} onClick={() => { setExampleSection('projects'); showExampleFeedback('已切换到项目') }}>项目</button><button type="button" className="avatar" aria-expanded={exampleProfileOpen} aria-label="打开用户菜单" onClick={() => setExampleProfileOpen(value => !value)}>Z</button></div></nav>{exampleProfileOpen && <div className="example-profile" role="status"><b>张产品</b><span>产品经理 · 示例账号</span></div>}<section className="example-hero"><div><small>{exampleSection === 'workspace' ? 'PROJECT OVERVIEW' : 'ALL PROJECTS'}</small><h3>{exampleSection === 'workspace' ? '让产品工作更清晰' : '集中管理全部项目'}</h3><p>标题、正文、颜色、间距、圆角、边框、投影和动效都来自左侧这套规范。</p>{defaultCoverageCount > 0 && <small className="example-provenance">其中 {defaultCoverageCount} 类网页未识别；示例只使用安全默认值展示，不把它当作网页证据。</small>}</div><button ref={exampleTriggerRef} type="button" onClick={() => setShowExampleModal(true)}>新建项目</button></section><div className="example-tabs" role="tablist"><button type="button" role="tab" aria-selected={previewTab === 'overview'} className={previewTab === 'overview' ? 'active' : ''} onClick={() => setPreviewTab('overview')}>业务页面</button><button type="button" role="tab" aria-selected={previewTab === 'components'} className={previewTab === 'components' ? 'active' : ''} onClick={() => setPreviewTab('components')}>组件状态</button></div>{previewTab === 'overview' ? <><section className="example-grid"><article><small>进行中的项目</small><strong>24</strong><span className="positive">↑ 12% 较上周</span></article><article><small>待处理事项</small><strong>08</strong><span>3 项需要今天完成</span></article><article><small>团队成员</small><strong>16</strong><span>本周新增 2 人</span></article></section><section className="example-insights"><div className="mini-chart"><b>近 5 周完成趋势</b><div>{[46, 68, 58, 82, 74].map((value, index) => <i key={value + index} style={{ height: `${value}%` }} />)}</div></div><div><p className="mini-alert"><b>2 个项目需要关注</b><span>风险、提醒和进度均沿用当前规范。</span></p><label className="mini-progress"><span>季度目标　74%</span><i><b /></i></label></div></section><section className="example-list"><header><div><b>最近项目</b><span>{exampleFilter === 'all' ? '显示全部状态' : '仅显示进行中'}</span></div><button type="button" className="example-secondary" aria-pressed={exampleFilter === 'active'} onClick={() => setExampleFilter(value => value === 'all' ? 'active' : 'all')}>{exampleFilter === 'all' ? '筛选进行中' : '清除筛选'}</button></header><button type="button" className="example-project-row" onClick={() => showExampleFeedback('已打开“供应商准入平台”详情')}><span className="project-icon">A</span><p><b>供应商准入平台</b><small>产品设计 · 更新于 10 分钟前</small></p><em>进行中</em></button>{exampleFilter === 'all' && <button type="button" className="example-project-row" onClick={() => showExampleFeedback('已打开“数据运营看板”详情')}><span className="project-icon muted">D</span><p><b>数据运营看板</b><small>数据产品 · 更新于昨天</small></p><em className="neutral">待评审</em></button>}</section></> : <section className="component-preview"><div><small>按钮状态</small><p><button type="button" onClick={() => showExampleFeedback('主要操作已执行')}>主要操作</button><button type="button" className="example-secondary" onClick={() => showExampleFeedback('次要操作已执行')}>次要操作</button><button type="button" className="danger-demo" onClick={() => showExampleFeedback('危险操作示例：实际产品应再次确认')}>危险操作</button><button type="button" disabled>禁用状态</button></p></div><div><small>输入框状态</small><label>默认状态<input placeholder="请输入项目名称" /></label><label>聚焦状态<input className="focus-demo" value="供应商准入平台" readOnly /></label><label>错误状态<input className="error-demo" value="名称已存在" readOnly /></label><label>禁用状态<input value="不可编辑" disabled readOnly /></label></div><div><small>信息与业务状态</small><p><em className="info-tag">信息</em><em>成功</em><em className="warning-tag">警告</em><em className="danger-tag">危险</em><em className="neutral">待评审</em></p></div></section>}{showExampleModal && <div className="example-backdrop" role="presentation" onClick={closeExampleModal}><section ref={exampleModalRef} className="example-modal" role="dialog" aria-modal="true" aria-label="新建项目" onClick={event => event.stopPropagation()}><header><div><b>新建项目</b><small>示例弹窗使用同一套规范</small></div><button type="button" className="modal-close" aria-label="关闭" onClick={closeExampleModal}>×</button></header><label>项目名称<input ref={exampleInputRef} value={exampleProjectName} onChange={event => setExampleProjectName(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') createExampleProject() }} placeholder="请输入项目名称" /></label><footer><button type="button" className="example-secondary" onClick={closeExampleModal}>取消</button><button type="button" onClick={createExampleProject}>创建项目</button></footer></section></div>}{exampleFeedback !== undefined && <div className="example-feedback" role="status">{exampleFeedback}</div>}</div></section>
    </div>
    <footer className="review-footer"><div><b>{bundle.designConfirmed && bundle.revisions.length > 0 ? '这套规范已用于已保存的原型版本' : bundle.designConfirmed ? '这套规范已经安全锁定' : legacyCapture ? '这条参考需要重新采集' : requiresReviewAcknowledgement && !defaultAcknowledged ? '请先查看并勾选上方的核对项' : changedGroups > 0 ? `你调整了 ${changedGroups} 类规范，确认后 AI 将使用调整结果` : defaultCoverageCount > 0 ? `有 ${defaultCoverageCount} 类网页未识别；示例中的安全默认值不是网页证据` : '确认后，AI 会收到你眼前看到的完整规范'}</b><span>{bundle.designConfirmed && bundle.revisions.length > 0 ? '旧原型和历史版本会完整保留；新方案会复用同一份已验证参考证据，并重新进入规范调整。' : bundle.designConfirmed ? '尚未生成原型时，可以重新调整规范；重新确认后才允许生成。' : legacyCapture ? '重新提取后会补齐排版、边框、效果和动效信息。' : requiresReviewAcknowledgement && !defaultAcknowledged ? <a href="#review-warnings">查看需要核对的项目</a> : '系统会先安全保存并回读确认；成功后才进入 AI 生成。'}</span>{confirmError !== undefined && <strong className="confirm-error">没有确认成功：{confirmError}</strong>}{reopenError !== undefined && <strong className="confirm-error">暂时不能重新调整：{reopenError}</strong>}{createVariantError !== undefined && <strong className="confirm-error">新方案没有创建成功：{createVariantError}</strong>}</div><div className="review-footer-actions">{bundle.designConfirmed && bundle.revisions.length === 0 && <button type="button" className="secondary" disabled={reopening || creatingVariant} onClick={onReopen}>{reopening ? '正在返回调整…' : '重新调整规范'}</button>}{bundle.designConfirmed && bundle.revisions.length > 0 && <button type="button" className="secondary" disabled={creatingVariant || reopening} onClick={onCreateVariant}>{creatingVariant ? '正在创建新方案…' : '基于同一参考创建新方案'}</button>}<button type="button" disabled={(!bundle.designConfirmed && legacyCapture) || confirming || reopening || creatingVariant || (!bundle.designConfirmed && requiresReviewAcknowledgement && !defaultAcknowledged)} onClick={() => onConfirm(designSpec)}>{bundle.designConfirmed ? '返回原型编辑器' : legacyCapture ? '请先重新提取' : confirming ? '正在保存并核对…' : '确认并交给 AI'}</button></div></footer>
  </main>
}

async function loadCapturedReference(onStage: (stage: LoadStage) => void = () => {}): Promise<StudioBundle> {
  const query = new URLSearchParams(location.search); const referenceId = query.get('referenceId'); const projectId = query.get('projectId')
  if (referenceId === null || !/^ref-[a-z0-9-]{1,75}$/i.test(referenceId) || projectId === null || !/^prototype-[a-z0-9-]{8,72}$/.test(projectId)) throw new Error('请先在侧栏的 Browser Target 中找到网页，然后点击“提取设计规范”。')
  onStage('connecting-service')
  const response = await extensionRequest<SnapshotResponse>({ type: 'prototype-studio-snapshot/v1', projectId })
  if (!response.ok || response.snapshot === undefined) {
    if (response.code === 'prototype_authorization_expired' && response.recoveryAvailable === true) throw new RecoverablePrototypeAuthorizationError(response.error ?? '当前授权已过期，但原型仍安全保留。')
    throw new Error(response.error ?? '无法读取原型项目。')
  }
  const snapshot = response.snapshot
  const rawHostEvidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : []
  if (rawHostEvidence.length < 1 || rawHostEvidence.length > 3) throw new Error('原型项目的参考网页集合无效，请重新采集。')
  const legacyFingerprint = rawHostEvidence.length === 1 ? legacySingleReferenceFingerprint(rawHostEvidence[0], referenceId) : undefined
  if (legacyFingerprint === undefined && (rawHostEvidence[0] as { id?: unknown } | undefined)?.id !== referenceId) throw new Error('原型项目的参考网页集合无效，请重新采集。')
  onStage('reading-reference')
  const storedResult = await bounded(chrome.storage.local.get(PROTOTYPE_REFERENCE_STORAGE_KEY), 5_000, '读取参考网页超时，请点击重试。')
  const stored = storedResult[PROTOTYPE_REFERENCE_STORAGE_KEY] as StoredPrototypeReferences | undefined
  onStage('verifying-reference')
  const legacyLocal = legacyFingerprint === undefined ? undefined : validateReferenceEvidence(stored?.v === 1 ? stored.references?.[referenceId] : undefined)
  if (legacyFingerprint !== undefined && (!legacyLocal?.ok || legacyLocal.value.fingerprint !== legacyFingerprint || !(await bounded(verifyReferenceEvidenceFingerprint(legacyLocal.value), 5_000, '验证本地参考证据超时，请点击重试。')))) throw new Error('原型服务中的参考网页证据不存在或校验失败，请重新采集。')
  const hostEvidence: unknown[] = legacyLocal?.ok ? [legacyLocal.value] : rawHostEvidence
  // Local screenshots may be evicted independently. Validate and fall back
  // page-by-page so a three-page project never silently drops auxiliaries.
  const evidence: ReferenceEvidenceV1[] = []
  for (const rawHost of hostEvidence) {
    const hostChecked = validateReferenceEvidence(rawHost)
    if (!hostChecked.ok || !(await bounded(verifyReferenceEvidenceFingerprint(hostChecked.value), 5_000, '验证原型服务中的参考证据超时，请点击重试。'))) throw new Error('原型服务中的参考网页证据不存在或校验失败，请重新采集。')
    const local = validateReferenceEvidence(stored?.v === 1 ? stored.references?.[hostChecked.value.id] : undefined)
    const localUsable = local.ok && local.value.fingerprint === hostChecked.value.fingerprint && await bounded(verifyReferenceEvidenceFingerprint(local.value), 5_000, '验证本地参考证据超时，请点击重试。')
    evidence.push(localUsable ? local.value : hostChecked.value)
  }
  onStage('preparing-studio')
  const revisions = studioRevisions(snapshot.revisions, snapshot.currentRevisionId)
  if (snapshot.projectId !== projectId || revisions === undefined) throw new Error('原型项目与当前参考网页或版本历史不匹配。')
  const lastAttempt = studioAttempt(snapshot.lastAttempt)
  const generationAttempt = studioGenerationAttempt(snapshot.generationAttempt)
  const suggestionAttempt = briefSuggestionAttempt(snapshot.briefSuggestionAttempt)
  const suggestedProductBrief = productBrief(snapshot.suggestedProductBrief)
  const savedBrief = snapshot.productBrief === undefined ? generationAttempt?.productBrief : productBrief(snapshot.productBrief)
  if (snapshot.generationAttempt !== undefined && generationAttempt === undefined) throw new Error('原型生成状态格式无效，请刷新后重试。')
  if (snapshot.briefSuggestionAttempt !== undefined && suggestionAttempt === undefined) throw new Error('AI 产品需求草稿状态无效，请刷新后重试。')
  if (snapshot.suggestedProductBrief !== undefined && suggestedProductBrief === undefined) throw new Error('AI 整理的产品需求草稿格式无效。')
  if ((suggestionAttempt?.status === 'saved') !== (suggestedProductBrief !== undefined) || (suggestionAttempt?.status === 'pending' && suggestedProductBrief !== undefined)) throw new Error('AI 产品需求草稿与请求状态不一致，请重新整理。')
  if (snapshot.productBrief !== undefined && savedBrief === undefined) throw new Error('产品需求验收清单格式无效。')
  if (snapshot.designSpec !== undefined || snapshot.document !== undefined) {
    const bundle = validatePrototypeBundle({ evidence, designSpec: snapshot.designSpec, document: snapshot.document })
    if (!bundle.ok || typeof snapshot.currentRevisionId !== 'string') throw new Error('AI 保存的原型版本未通过安全校验。')
    const expectedCoverage = savedBrief === undefined ? undefined : productRequirementCoverage(bundle.value.document, savedBrief)
    const savedCoverage = snapshot.requirementCoverage === undefined ? expectedCoverage : productRequirementCoverageValue(snapshot.requirementCoverage)
    if ((expectedCoverage === undefined) !== (savedCoverage === undefined) || (savedCoverage !== undefined && JSON.stringify(savedCoverage) !== JSON.stringify(expectedCoverage))) throw new Error('当前版本的需求验收结果未通过确定性校验。')
    return { projectId, ...bundle.value, revisions, designConfirmed: snapshot.designConfirmed === true, screenshotUnavailable: evidence.some(item => item.screenshotDataUrl === undefined), productBrief: savedBrief, ...(savedCoverage === undefined ? {} : { requirementCoverage: savedCoverage }), currentRevisionId: snapshot.currentRevisionId, ...(generationAttempt === undefined ? {} : { generationAttempt }), ...(suggestionAttempt === undefined ? {} : { briefSuggestionAttempt: suggestionAttempt }), ...(suggestedProductBrief === undefined ? {} : { suggestedProductBrief }), ...(lastAttempt === undefined ? {} : { lastAttempt }) }
  }
  let designSpec = createDesignSpecFromEvidence(evidence)
  let designConfirmed = false
  if (snapshot.designConfirmed === true && snapshot.confirmedDesignSpec !== undefined) {
    const confirmed = validateDesignSpec(snapshot.confirmedDesignSpec, evidence.map(item => item.id))
    if (!confirmed.ok) throw new Error('已确认的设计规范未通过安全校验，请重新采集。')
    designSpec = confirmed.value
    designConfirmed = true
  }
  return { projectId, evidence, designSpec, document: starterDocument(designSpec.id, evidence[0]!.source.title), revisions, designConfirmed, screenshotUnavailable: evidence.some(item => item.screenshotDataUrl === undefined), productBrief: savedBrief, ...(generationAttempt === undefined ? {} : { generationAttempt }), ...(suggestionAttempt === undefined ? {} : { briefSuggestionAttempt: suggestionAttempt }), ...(suggestedProductBrief === undefined ? {} : { suggestedProductBrief }), ...(lastAttempt === undefined ? {} : { lastAttempt }) }
}

function App(): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const historyFrameRef = useRef<HTMLIFrameElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const [bundle, setBundle] = useState<StudioBundle>()
  const [error, setError] = useState<string>()
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveringProject, setRecoveringProject] = useState(false)
  const [loadStage, setLoadStage] = useState<LoadStage>('reading-reference')
  const [retryKey, setRetryKey] = useState(0)
  const [designConfirmed, setDesignConfirmed] = useState(false)
  const [confirmingDesign, setConfirmingDesign] = useState(false)
  const [confirmDesignError, setConfirmDesignError] = useState<string>()
  const [reopeningDesign, setReopeningDesign] = useState(false)
  const [reopenDesignError, setReopenDesignError] = useState<string>()
  const [creatingVariant, setCreatingVariant] = useState(false)
  const [createVariantError, setCreateVariantError] = useState<string>()
  const [createVariantSuccess, setCreateVariantSuccess] = useState<string>()
  const [selection, setSelection] = useState<PrototypeSelection>()
  const [previewMode, setPreviewMode] = useState<SandboxPreviewMode>('interact')
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>('desktop')
  const [previewAudits, setPreviewAudits] = useState<Partial<Record<PreviewViewport, PreviewAudit>>>({})
  const [checkingAllViewports, setCheckingAllViewports] = useState(false)
  const [previewStageSize, setPreviewStageSize] = useState({ width: 1_440, height: 720 })
  const [request, setRequest] = useState('')
  const [requestDraftReadyProject, setRequestDraftReadyProject] = useState<string>()
  const [briefAudience, setBriefAudience] = useState('')
  const [briefTask, setBriefTask] = useState('')
  const [briefPages, setBriefPages] = useState('')
  const [briefModules, setBriefModules] = useState('')
  const [briefFlows, setBriefFlows] = useState('')
  const [briefNotes, setBriefNotes] = useState('')
  const [editingRequirements, setEditingRequirements] = useState(false)
  const [requestStatus, setRequestStatus] = useState<string>()
  const [requestTone, setRequestTone] = useState<'info' | 'success' | 'error'>('info')
  const [confirmingBrief, setConfirmingBrief] = useState(false)
  const [suggestingBrief, setSuggestingBrief] = useState(false)
  const [exporting, setExporting] = useState<'html' | 'json'>()
  const [briefDraftReadyProject, setBriefDraftReadyProject] = useState<string>()
  const [sending, setSending] = useState(false)
  const [waitingForRevision, setWaitingForRevision] = useState(false)
  const [generationTimedOut, setGenerationTimedOut] = useState(false)
  const [refreshingGeneration, setRefreshingGeneration] = useState(false)
  const [confirmingGenerationCancel, setConfirmingGenerationCancel] = useState(false)
  const [cancellingGeneration, setCancellingGeneration] = useState(false)
  const [confirmingRevisionId, setConfirmingRevisionId] = useState<string>()
  const [restoringRevisionId, setRestoringRevisionId] = useState<string>()
  const [historyPreview, setHistoryPreview] = useState<RevisionPreview>()
  const [loadingHistoryRevisionId, setLoadingHistoryRevisionId] = useState<string>()
  const [historyPreviewError, setHistoryPreviewError] = useState<string>()
  const [confirmingRevisionEviction, setConfirmingRevisionEviction] = useState(false)
  const pendingRevisionBaseline = useRef<string | undefined>(undefined)
  const generationRequestId = useRef<string | undefined>(undefined)
  const initializedBriefProject = useRef<string | undefined>(undefined)
  const appliedBriefSuggestionRequest = useRef<string | undefined>(undefined)
  const requirementsUpdateProject = useRef<string | undefined>(undefined)
  const previewViewportRef = useRef<PreviewViewport>('desktop')
  const previewAuditQueueRef = useRef<PreviewViewport[]>([])
  const previewAuditReturnViewportRef = useRef<PreviewViewport | undefined>(undefined)
  const pendingPreviewAuditRef = useRef<{ viewport: PreviewViewport; requestId: string } | undefined>(undefined)
  const nonce = useMemo(() => crypto.randomUUID(), [])
  const historyNonce = useMemo(() => crypto.randomUUID(), [])
  const populateBriefFields = (brief: ProductBriefV1): void => {
    setBriefAudience(brief.audience)
    setBriefTask(brief.coreTask)
    setBriefPages(brief.requiredPages.join('\n'))
    setBriefModules(brief.requiredModules?.join('\n') ?? '')
    setBriefFlows(brief.requiredFlows.join('\n'))
    setBriefNotes(brief.notes ?? '')
  }
  useEffect(() => {
    let disposed = false
    setError(undefined)
    setRecoveryAvailable(false)
    void loadCapturedReference(stage => { if (!disposed) setLoadStage(stage) })
      .then(next => { if (!disposed) { setBundle(next); setDesignConfirmed(next.designConfirmed) } })
      .catch((cause: unknown) => { if (!disposed) { setRecoveryAvailable(cause instanceof RecoverablePrototypeAuthorizationError); setError(cause instanceof Error ? cause.message : String(cause)) } })
    return () => { disposed = true }
  }, [retryKey])
  useEffect(() => {
    if (bundle === undefined || initializedBriefProject.current === bundle.projectId) return
    initializedBriefProject.current = bundle.projectId
    const pendingBrief = bundle.generationAttempt?.productBrief
    const savedBrief = bundle.productBrief
    const draft = loadProductBriefDraft(window.sessionStorage, bundle.projectId)
    if (pendingBrief !== undefined) {
      populateBriefFields(pendingBrief)
      setRequest('')
      const pendingRequirementsUpdate = savedBrief !== undefined && canonicalJson(pendingBrief) !== canonicalJson(savedBrief)
      requirementsUpdateProject.current = pendingRequirementsUpdate ? bundle.projectId : undefined
      setEditingRequirements(pendingRequirementsUpdate)
      clearProductBriefDraft(window.sessionStorage, bundle.projectId)
    } else if (bundle.currentRevisionId !== undefined && savedBrief !== undefined && draft !== undefined) {
      // An existing prototype only has a brief draft when the user explicitly
      // started changing requirements. Keep it across an accidental refresh.
      setBriefAudience(draft.audience)
      setBriefTask(draft.coreTask)
      setBriefPages(draft.pages)
      setBriefModules(draft.modules)
      setBriefFlows(draft.flows)
      setBriefNotes(draft.notes)
      setRequest('')
      requirementsUpdateProject.current = bundle.projectId
      setEditingRequirements(true)
    } else if (savedBrief !== undefined) {
      populateBriefFields(savedBrief)
      setRequest('')
      if (requirementsUpdateProject.current !== bundle.projectId) setEditingRequirements(false)
      clearProductBriefDraft(window.sessionStorage, bundle.projectId)
    } else {
      if (draft !== undefined) { setBriefAudience(draft.audience); setBriefTask(draft.coreTask); setBriefPages(draft.pages); setBriefModules(draft.modules); setBriefFlows(draft.flows); setBriefNotes(draft.notes) }
    }
    setBriefDraftReadyProject(bundle.projectId)
  }, [bundle?.generationAttempt?.productBrief, bundle?.productBrief, bundle?.projectId])
  useEffect(() => {
    if (bundle?.currentRevisionId === undefined || bundle.generationAttempt !== undefined || requestDraftReadyProject === bundle.projectId) return
    const draft = loadPrototypeRequestDraft(window.sessionStorage, bundle.projectId, bundle.currentRevisionId)
    if (draft !== undefined) {
      const ids = collectPrototypeElementIds(bundle.document)
      if (draft.selection === undefined || ids.has(draft.selection.elementId)) {
        setRequest(draft.request)
        if (draft.selection !== undefined) { setSelection(draft.selection as PrototypeSelection); setPreviewMode('select') }
        setRequestTone('info')
        setRequestStatus('已恢复上次未发送的修改要求。')
      } else clearPrototypeRequestDraft(window.sessionStorage, bundle.projectId)
    }
    setRequestDraftReadyProject(bundle.projectId)
  }, [bundle?.currentRevisionId, bundle?.generationAttempt?.requestId, bundle?.projectId, requestDraftReadyProject])
  useEffect(() => {
    if (bundle?.currentRevisionId === undefined || requestDraftReadyProject !== bundle.projectId || waitingForRevision) return
    savePrototypeRequestDraft(window.sessionStorage, bundle.projectId, bundle.currentRevisionId, { request, ...(selection === undefined ? {} : { selection }) })
  }, [bundle?.currentRevisionId, bundle?.projectId, request, requestDraftReadyProject, selection, waitingForRevision])
  useEffect(() => {
    const attempt = bundle?.briefSuggestionAttempt
    if (bundle === undefined || attempt === undefined) return
    if (attempt.status === 'saved' && bundle.suggestedProductBrief !== undefined) {
      if (appliedBriefSuggestionRequest.current !== attempt.requestId) {
        appliedBriefSuggestionRequest.current = attempt.requestId
        populateBriefFields(bundle.suggestedProductBrief)
        if (bundle.currentRevisionId !== undefined) { requirementsUpdateProject.current = bundle.projectId; setEditingRequirements(true) }
        setRequestTone('success'); setRequestStatus('AI 已根据当前对话整理成需求草稿。请检查和修改，确认后才会用于原型。')
      }
      setSuggestingBrief(false)
      return
    }
    setSuggestingBrief(true)
    let disposed = false; let inFlight = false
    const refresh = (): void => {
      if (disposed || inFlight) return
      inFlight = true
      void loadCapturedReference().then(next => {
        if (disposed) return
        setBundle(next)
        if (next.briefSuggestionAttempt === undefined && Date.now() >= attempt.expiresAt) { setSuggestingBrief(false); setRequestTone('error'); setRequestStatus('AI 整理需求超时，没有改动当前草稿。可以重新整理。') }
      }).catch((cause: unknown) => { if (!disposed) { setRequestTone('info'); setRequestStatus(`暂时无法读取需求草稿，系统会继续检查：${cause instanceof Error ? cause.message : String(cause)}`) } }).finally(() => { inFlight = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [bundle?.briefSuggestionAttempt?.requestId, bundle?.briefSuggestionAttempt?.status, bundle?.projectId, bundle?.suggestedProductBrief])
  useEffect(() => {
    const shouldKeepDraft = bundle !== undefined && briefDraftReadyProject === bundle.projectId && ((bundle.currentRevisionId === undefined && bundle.productBrief === undefined) || editingRequirements || requirementsUpdateProject.current === bundle.projectId)
    if (!shouldKeepDraft || bundle === undefined) return
    saveProductBriefDraft(window.sessionStorage, bundle.projectId, { audience: briefAudience, coreTask: briefTask, pages: briefPages, modules: briefModules, flows: briefFlows, notes: briefNotes })
  }, [briefAudience, briefDraftReadyProject, briefFlows, briefModules, briefNotes, briefPages, briefTask, bundle?.currentRevisionId, bundle?.productBrief, bundle?.projectId, editingRequirements])
  useEffect(() => {
    const attempt = bundle?.generationAttempt
    if (attempt === undefined) return
    if (generationRequestId.current !== undefined && generationRequestId.current !== attempt.requestId) return
    generationRequestId.current = attempt.requestId
    pendingRevisionBaseline.current = attempt.expectedRevisionId
    const requirementsChanged = attempt.productBrief !== undefined && bundle?.productBrief !== undefined && canonicalJson(attempt.productBrief) !== canonicalJson(bundle.productBrief)
    if (requirementsChanged) { requirementsUpdateProject.current = bundle?.projectId; setEditingRequirements(true) }
    else if (attempt.expectedRevisionId !== undefined && attempt.prompt !== undefined) setRequest(attempt.prompt)
    setWaitingForRevision(true)
    const age = Date.now() - Date.parse(attempt.at)
    if (attempt.status === 'error') {
      const message = attempt.message ?? '原型保存未通过安全校验。'
      setGenerationTimedOut(true)
      setRequestTone('error')
      setRequestStatus(age < 90_000 ? `已恢复一条需要 AI 修正的生成请求：${message}` : `上次生成未能保存：${message} 请停止本次生成后再修改要求。`)
      return
    }
    if (age >= 180_000) {
      setGenerationTimedOut(true)
      setRequestTone('info')
      setRequestStatus('已恢复一条仍在处理的生成请求，但尚未收到保存结果。')
    } else {
      setRequestTone('info')
      setRequestStatus('已恢复正在处理的生成请求，保存完成后会自动刷新。')
    }
  }, [bundle?.generationAttempt?.at, bundle?.generationAttempt?.requestId, bundle?.generationAttempt?.status])
  useEffect(() => {
    if (bundle === undefined) return
    let disposed = false; let inFlight = false
    const refresh = () => {
      if (inFlight) return
      inFlight = true
      void loadCapturedReference()
        .then(next => {
          if (disposed) return
          setBundle(next)
          if (generationRequestId.current === undefined && !waitingForRevision) return
          const outcome = generationOutcome(generationRequestId.current, pendingRevisionBaseline.current, next.currentRevisionId, next.generationAttempt, next.lastAttempt)
          if (outcome.status === 'repairing') {
            setRequestTone('info'); setRequestStatus(`AI 第一次保存没有通过，正在等待它根据具体错误修正：${outcome.message}`); return
          }
          if (outcome.status === 'failed') {
            setGenerationTimedOut(true); setRequestTone('error'); setRequestStatus(`AI 多次保存仍未通过：${outcome.message} 请停止本次生成后再修改要求。`); return
          }
          if (outcome.status === 'stopped') {
            generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setRequestTone('info'); setRequestStatus(`本次生成已在另一窗口安全停止：${outcome.message} 你的要求已保留，可以直接重新发送。`); return
          }
          if (outcome.status === 'saved') {
            generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; requirementsUpdateProject.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setConfirmingRevisionEviction(false); setEditingRequirements(false); clearProductBriefDraft(window.sessionStorage, bundle.projectId); setSelection(undefined); setPreviewMode('interact'); setRequest(''); setRequestTone('success'); setRequestStatus('新原型已经生成、校验并保存，可以直接在中间操作。')
          }
        })
        .catch((cause: unknown) => { if (!disposed && waitingForRevision) { setRequestTone('info'); setRequestStatus(`暂时无法读取生成进度，系统会继续重试：${cause instanceof Error ? cause.message : String(cause)}`) } })
        .finally(() => { inFlight = false })
    }
    if (waitingForRevision) {
      refresh()
      const timer = window.setInterval(refresh, 2_000)
      return () => { disposed = true; window.clearInterval(timer) }
    }
    const refreshWhenVisible = () => { if (window.document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refreshWhenVisible)
    window.document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { disposed = true; window.removeEventListener('focus', refreshWhenVisible); window.document.removeEventListener('visibilitychange', refreshWhenVisible) }
  }, [bundle?.projectId, waitingForRevision])
  useEffect(() => {
    if (!waitingForRevision) return
    const timer = window.setTimeout(() => { setGenerationTimedOut(true); setRequestTone('info'); setRequestStatus('尚未收到保存结果。原请求仍在等待处理，为避免晚到结果和新请求冲突，暂时不能再次发送。') }, 180_000)
    return () => window.clearTimeout(timer)
  }, [waitingForRevision])
  const displayedDocument = bundle?.document
  const displayedDesignSpec = bundle?.designSpec
  const knownElementIds = useMemo(() => bundle === undefined || historyPreview !== undefined ? new Set<string>() : collectPrototypeElementIds(bundle.document), [bundle, historyPreview])
  const srcDoc = useMemo(() => bundle === undefined || displayedDocument === undefined || displayedDesignSpec === undefined ? '' : sandboxPreviewSrcDoc(displayedDocument, displayedDesignSpec, bundle.evidence, nonce, historyPreview === undefined ? 'interact' : 'select'), [bundle, displayedDesignSpec, displayedDocument, historyPreview, nonce])
  const historySrcDoc = useMemo(() => bundle === undefined || historyPreview === undefined ? '' : sandboxPreviewSrcDoc(historyPreview.document, historyPreview.designSpec, bundle.evidence, historyNonce, 'select'), [bundle, historyNonce, historyPreview])
  useEffect(() => {
    const stage = previewStageRef.current
    if (stage === null) return
    const measure = (): void => setPreviewStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [bundle?.currentRevisionId])
  useEffect(() => { previewAuditQueueRef.current = []; previewAuditReturnViewportRef.current = undefined; pendingPreviewAuditRef.current = undefined; setCheckingAllViewports(false); setPreviewAudits({}) }, [bundle?.currentRevisionId])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (isSandboxSelectionClearMessage(event.data, nonce)) { setSelection(undefined); return }
      if (isSandboxPreviewAuditMessage(event.data, nonce)) {
        const pending = pendingPreviewAuditRef.current
        if (event.data.requestId === null && previewAuditQueueRef.current.length > 0) return
        if (event.data.requestId !== null && (pending === undefined || event.data.requestId !== pending.requestId || pending.viewport !== previewViewportRef.current)) return
        const viewport = event.data.requestId === null ? previewViewportRef.current : pending!.viewport
        const expectedWidth = PREVIEW_VIEWPORT_WIDTHS[viewport]
        const frameWidth = Math.round(frameRef.current?.clientWidth ?? 0)
        if (Math.abs(frameWidth - expectedWidth) > 2 || Math.abs(event.data.audit.viewportWidth - expectedWidth) > 2) return
        if (event.data.requestId !== null) pendingPreviewAuditRef.current = undefined
        setPreviewAudits(current => ({ ...current, [viewport]: event.data.audit }))
        if (previewAuditQueueRef.current[0] === viewport) {
          previewAuditQueueRef.current.shift()
          const next = previewAuditQueueRef.current[0]
          if (next === undefined) {
            setCheckingAllViewports(false)
            const returnViewport = previewAuditReturnViewportRef.current
            previewAuditReturnViewportRef.current = undefined
            if (returnViewport !== undefined && returnViewport !== viewport) { previewViewportRef.current = returnViewport; setPreviewViewport(returnViewport) }
          }
          else window.setTimeout(() => {
            previewViewportRef.current = next; setPreviewViewport(next)
            const requestId = crypto.randomUUID(); pendingPreviewAuditRef.current = { viewport: next, requestId }
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => frameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-preview-audit-request/v1', schema: 'prototype-document/v1', nonce, requestId }, '*')))
          }, 60)
        }
        return
      }
      if (!isSandboxSelectionMessage(event.data, nonce)) return
      if (historyPreview !== undefined) return
      const item = event.data.selection
      if (!knownElementIds.has(item.elementId)) return
      setSelection({ elementId: item.elementId, type: item.type as PrototypeSelection['type'], label: item.label })
      setPreviewMode('select')
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [historyPreview, knownElementIds, nonce])
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-selection-sync/v1', schema: 'prototype-document/v1', nonce, elementId: selection?.elementId ?? null }, '*')
  }, [nonce, selection])
  useEffect(() => {
    const mode = historyPreview === undefined ? previewMode : 'select'
    frameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-preview-mode/v1', schema: 'prototype-document/v1', nonce, mode }, '*')
    if (historyPreview !== undefined) historyFrameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-preview-mode/v1', schema: 'prototype-document/v1', nonce: historyNonce, mode: 'select' }, '*')
  }, [historyNonce, historyPreview, nonce, previewMode])

  const syncPreviewState = (): void => {
    const target = frameRef.current?.contentWindow
    if (target === undefined || target === null) return
    target.postMessage({ v: 1, type: 'prototype-selection-sync/v1', schema: 'prototype-document/v1', nonce, elementId: selection?.elementId ?? null }, '*')
    target.postMessage({ v: 1, type: 'prototype-preview-mode/v1', schema: 'prototype-document/v1', nonce, mode: historyPreview === undefined ? previewMode : 'select' }, '*')
  }

  const syncHistoryPreviewState = (): void => {
    historyFrameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-selection-sync/v1', schema: 'prototype-document/v1', nonce: historyNonce, elementId: null }, '*')
    historyFrameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-preview-mode/v1', schema: 'prototype-document/v1', nonce: historyNonce, mode: 'select' }, '*')
  }

  const choosePreviewMode = (mode: SandboxPreviewMode): void => {
    if (historyPreview !== undefined && mode === 'select') return
    setPreviewMode(mode)
    if (mode === 'interact') setSelection(undefined)
  }

  const focusCoverageMatch = (match: ProductRequirementCoverageMatchV1): void => {
    if (historyPreview !== undefined) return
    const elementId = match.nodeId !== undefined && knownElementIds.has(match.nodeId) ? match.nodeId : undefined
    setPreviewMode('select')
    if (elementId !== undefined && match.nodeType !== undefined && PROTOTYPE_SELECTABLE_TYPES.has(match.nodeType as PrototypeSelection['type'])) setSelection({ elementId, type: match.nodeType as PrototypeSelection['type'], label: match.label })
    else setSelection(undefined)
    frameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-coverage-focus/v1', schema: 'prototype-document/v1', nonce, screenId: match.screenId ?? null, elementId: elementId ?? null }, '*')
  }

  const choosePreviewViewport = (viewport: PreviewViewport): void => {
    previewAuditQueueRef.current = []
    previewAuditReturnViewportRef.current = undefined
    pendingPreviewAuditRef.current = undefined
    setCheckingAllViewports(false)
    previewViewportRef.current = viewport
    setPreviewViewport(viewport)
    setPreviewAudits(current => {
      const next = { ...current }
      delete next[viewport]
      return next
    })
  }

  const checkAllViewports = (): void => {
    previewAuditReturnViewportRef.current = previewViewportRef.current
    previewAuditQueueRef.current = ['desktop', 'tablet', 'mobile']
    setPreviewAudits({})
    setCheckingAllViewports(true)
    previewViewportRef.current = 'desktop'
    setPreviewViewport('desktop')
    const requestId = crypto.randomUUID(); pendingPreviewAuditRef.current = { viewport: 'desktop', requestId }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => frameRef.current?.contentWindow?.postMessage({ v: 1, type: 'prototype-preview-audit-request/v1', schema: 'prototype-document/v1', nonce, requestId }, '*')))
  }

  const refreshGenerationStatus = async (): Promise<void> => {
    if (bundle === undefined || !waitingForRevision || refreshingGeneration) return
    setRefreshingGeneration(true)
    try {
      const next = await loadCapturedReference()
      setBundle(next)
      const outcome = generationOutcome(generationRequestId.current, pendingRevisionBaseline.current, next.currentRevisionId, next.generationAttempt, next.lastAttempt)
      if (outcome.status === 'saved') {
        generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; requirementsUpdateProject.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setConfirmingRevisionEviction(false); setEditingRequirements(false); clearProductBriefDraft(window.sessionStorage, bundle.projectId); setSelection(undefined); setPreviewMode('interact'); setRequest(''); setRequestTone('success'); setRequestStatus('新原型已经生成、校验并保存，可以直接在中间操作。')
      } else if (outcome.status === 'failed') {
        setGenerationTimedOut(true); setRequestTone('error'); setRequestStatus(`AI 多次保存仍未通过：${outcome.message} 请停止本次生成后再修改要求。`)
      } else if (outcome.status === 'repairing') {
        setGenerationTimedOut(false); setRequestTone('info'); setRequestStatus(`AI 第一次保存没有通过，正在等待它根据具体错误修正：${outcome.message}`)
      } else if (outcome.status === 'stopped') {
        generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setRequestTone('info'); setRequestStatus(`本次生成已在另一窗口安全停止：${outcome.message} 你的要求已保留，可以直接重新发送。`)
      } else {
        setRequestTone('info'); setRequestStatus('尚未收到保存结果。原请求仍在等待处理，系统会继续轮询。')
      }
    } catch (cause) {
      setRequestTone('info'); setRequestStatus(`暂时无法读取生成状态，原请求仍会继续等待：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally { setRefreshingGeneration(false) }
  }

  const askAi = async (): Promise<void> => {
    if (bundle === undefined) return
    if (historyPreview !== undefined) { setRequestTone('info'); setRequestStatus('当前是只读历史预览，请先返回当前版本，或恢复该版本后再修改。'); return }
    const firstGeneration = bundle.currentRevisionId === undefined
    const updatingRequirements = !firstGeneration && (editingRequirements || requirementsUpdateProject.current === bundle.projectId)
    const brief = firstGeneration || updatingRequirements ? productBriefFromFields({ audience: briefAudience, coreTask: briefTask, pages: briefPages, modules: briefModules, flows: briefFlows, notes: briefNotes }) : undefined
    if ((firstGeneration || updatingRequirements) && brief === undefined) { setRequestTone('error'); setRequestStatus('请先补全使用者、核心任务、必须页面，以及必须演示的流程。'); return }
    if (firstGeneration && canonicalJson(brief) !== canonicalJson(bundle.productBrief)) { setRequestTone('error'); setRequestStatus('需求清单有变化，请先保存并确认，再开始生成。'); return }
    if (updatingRequirements && bundle.productBrief === undefined) { setRequestTone('error'); setRequestStatus('当前版本缺少已确认的产品需求，无法安全更新。'); return }
    if (updatingRequirements && canonicalJson(brief) === canonicalJson(bundle.productBrief)) { setRequestTone('info'); setRequestStatus('产品需求没有变化，请修改后再生成新版本。'); return }
    if (!firstGeneration && !updatingRequirements && request.trim() === '') return
    const requiresRevisionEviction = bundle.currentRevisionId !== undefined && bundle.revisions.length >= 20
    if (requiresRevisionEviction && !confirmingRevisionEviction) { setConfirmingRevisionEviction(true); setRequestTone('info'); setRequestStatus('历史版本已满。请确认本次保存会替换最旧的一个版本；当前版本不会被替换。'); return }
    const outgoingPrompt = brief === undefined ? request.trim() : productBriefPrompt(brief)!
    const localEdit = updatingRequirements ? undefined : selection
    if (updatingRequirements) { setSelection(undefined); setPreviewMode('interact') }
    setSending(true); setGenerationTimedOut(false); setRequestStatus(undefined)
    pendingRevisionBaseline.current = bundle.currentRevisionId
    const requestId = crypto.randomUUID()
    generationRequestId.current = requestId
    let responseReceived = false
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-prompt/v1', projectId: bundle.projectId, requestId, prompt: outgoingPrompt, ...(localEdit === undefined ? {} : { selection: localEdit }), ...(brief === undefined ? {} : { brief }), ...(requiresRevisionEviction ? { allowRevisionEviction: true } : {}) })
      responseReceived = true
      if (!response.ok) throw new Error(response.error ?? 'Harness 没有接受这次原型请求。')
      setWaitingForRevision(true); setRequestTone('info'); setRequestStatus('AI 正在生成并校验原型，保存完成后会自动刷新。你的要求会保留，失败后可直接重试。')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (responseReceived) {
        generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setRequestTone('error'); setRequestStatus(message)
        return
      }
      try {
        const refreshed = await loadCapturedReference()
        setBundle(refreshed)
        const outcome = generationOutcome(requestId, pendingRevisionBaseline.current, refreshed.currentRevisionId, refreshed.generationAttempt, refreshed.lastAttempt)
        if (outcome.status === 'saved') {
          generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; requirementsUpdateProject.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setEditingRequirements(false); clearProductBriefDraft(window.sessionStorage, bundle.projectId); setSelection(undefined); setPreviewMode('interact'); setRequest(''); setRequestTone('success'); setRequestStatus('虽然发送回包中断，但已回读确认新原型完成保存，可以直接操作。')
        } else if (refreshed.generationAttempt?.requestId === requestId) {
          setWaitingForRevision(true); setRequestTone(outcome.status === 'failed' ? 'error' : 'info'); setGenerationTimedOut(outcome.status === 'failed')
          setRequestStatus(outcome.status === 'repairing' ? `发送回包中断，但已回读确认 AI 正在根据保存错误修正：${outcome.message}` : outcome.status === 'failed' ? `已回读确认 AI 多次保存仍未通过：${outcome.message}` : '发送回包中断，但已回读确认 AI 已接收请求，系统会继续等待保存结果。')
        } else {
          generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setRequestTone('error'); setRequestStatus(message)
        }
      } catch {
        setWaitingForRevision(true); setGenerationTimedOut(true); setRequestTone('info'); setRequestStatus(`发送回包中断，并且暂时无法回读是否已接收。为避免重复生成，系统会保留这次请求并继续检查。原始错误：${message}`)
      }
    } finally { setSending(false) }
  }

  const startRequirementsUpdate = (): void => {
    if (bundle === undefined || bundle.currentRevisionId === undefined || bundle.productBrief === undefined || sending || waitingForRevision || historyPreview !== undefined) return
    populateBriefFields(bundle.productBrief)
    setRequest('')
    setSelection(undefined)
    setPreviewMode('interact')
    requirementsUpdateProject.current = bundle.projectId
    setEditingRequirements(true)
    setRequestTone('info')
    setRequestStatus('正在准备新需求。当前版本仍使用旧需求；新版本通过校验并保存后才会更新。')
  }

  const cancelRequirementsUpdate = (): void => {
    if (bundle === undefined || bundle.productBrief === undefined || sending || waitingForRevision) return
    populateBriefFields(bundle.productBrief)
    clearProductBriefDraft(window.sessionStorage, bundle.projectId)
    setRequest('')
    setSelection(undefined)
    setPreviewMode('interact')
    requirementsUpdateProject.current = undefined
    setEditingRequirements(false)
    setRequestTone('info')
    setRequestStatus('已取消本次需求更新，当前版本继续使用已确认的旧需求。')
  }

  const confirmBrief = async (brief: ProductBriefV1): Promise<void> => {
    if (bundle === undefined || confirmingBrief || sending || waitingForRevision) return
    setConfirmingBrief(true); setRequestStatus(undefined)
    let expectedFingerprint: string | undefined
    try {
      expectedFingerprint = await sha256Fingerprint(brief)
      const response = await extensionRequest<{ ok: boolean; result?: { productBriefFingerprint?: unknown }; error?: string }>({ type: 'prototype-studio-confirm-brief/v1', projectId: bundle.projectId, brief })
      if (!response.ok) throw new Error(response.error ?? '产品需求清单没有安全保存。')
      if (response.result?.productBriefFingerprint !== expectedFingerprint) throw new Error('可信服务保存的产品需求指纹与刚才确认的内容不一致。')
      const refreshed = await loadCapturedReference()
      if (refreshed.productBrief === undefined || await sha256Fingerprint(refreshed.productBrief) !== expectedFingerprint) throw new Error('产品需求清单保存后未能完成同内容回读。')
      clearProductBriefDraft(window.sessionStorage, bundle.projectId)
      setBundle(refreshed); setRequestTone('success'); setRequestStatus('产品需求清单已保存并确认。请再看一眼左侧确认结果，然后开始生成原型。')
    } catch (cause) {
      try {
        const refreshed = await loadCapturedReference()
        if (expectedFingerprint === undefined || refreshed.productBrief === undefined || await sha256Fingerprint(refreshed.productBrief) !== expectedFingerprint) throw cause
        clearProductBriefDraft(window.sessionStorage, bundle.projectId)
        setBundle(refreshed); setRequestTone('success'); setRequestStatus('确认回包中断，但已回读确认产品需求清单保存成功。可以继续生成原型。')
      } catch { setRequestTone('error'); setRequestStatus(cause instanceof Error ? cause.message : String(cause)) }
    } finally { setConfirmingBrief(false) }
  }

  const cancelGeneration = async (): Promise<void> => {
    const requestId = generationRequestId.current
    if (bundle === undefined || requestId === undefined || cancellingGeneration) return
    setCancellingGeneration(true)
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-cancel-generation/v1', projectId: bundle.projectId, requestId, expectedRevisionId: pendingRevisionBaseline.current ?? null })
      if (!response.ok) throw new Error(response.error ?? '无法停止本次原型生成。')
      const refreshed = await loadCapturedReference()
      if (!hasStoppedGeneration(requestId, refreshed.generationAttempt)) throw new Error('停止状态尚未确认，请刷新生成状态后重试。')
      setBundle(refreshed); generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setRequestTone('info'); setRequestStatus('本次生成已安全停止，晚到结果不会写入。你的要求仍保留，可以修改后重新发送。')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      try {
        const refreshed = await loadCapturedReference()
        setBundle(refreshed)
        const outcome = generationOutcome(requestId, pendingRevisionBaseline.current, refreshed.currentRevisionId, refreshed.generationAttempt, refreshed.lastAttempt)
        if (outcome.status === 'saved') {
          generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; requirementsUpdateProject.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setEditingRequirements(false); clearProductBriefDraft(window.sessionStorage, bundle.projectId); setSelection(undefined); setPreviewMode('interact'); setRequest(''); setRequestTone('success'); setRequestStatus('停止回包中断，但已回读确认原型已经完成保存，可以直接操作。')
        } else if (refreshed.generationAttempt === undefined) {
          generationRequestId.current = undefined; pendingRevisionBaseline.current = undefined; setWaitingForRevision(false); setGenerationTimedOut(false); setConfirmingGenerationCancel(false); setRequestTone('info'); setRequestStatus('停止回包中断，但已回读确认服务端没有活跃生成。你的要求仍保留，可以重新发送。')
        } else {
          setRequestTone('error'); setRequestStatus(message)
        }
      } catch { setRequestTone('error'); setRequestStatus(message) }
    } finally { setCancellingGeneration(false) }
  }

  const confirmDesign = async (designSpec: DesignSpecV1): Promise<void> => {
    if (bundle === undefined || confirmingDesign) return
    setConfirmingDesign(true); setConfirmDesignError(undefined)
    let expectedFingerprint: string | undefined
    try {
      const checked = validateDesignSpec(designSpec, bundle.evidence.map(item => item.id))
      if (!checked.ok) throw new Error(checked.errors[0] ?? '调整后的设计规范格式无效。')
      expectedFingerprint = await sha256Fingerprint(checked.value)
      const response = await extensionRequest<{ ok: boolean; result?: { designSpecFingerprint?: unknown }; error?: string }>({ type: 'prototype-studio-confirm-design/v1', projectId: bundle.projectId, designSpec: checked.value })
      if (!response.ok) throw new Error(response.error ?? '设计规范没有安全保存。')
      if (response.result?.designSpecFingerprint !== expectedFingerprint) throw new Error('可信服务保存的设计规范指纹与刚才确认的内容不一致，请勿继续生成。')
      const refreshed = await loadCapturedReference()
      if (!refreshed.designConfirmed) throw new Error('设计规范保存后未能回读确认。')
      if (await sha256Fingerprint(refreshed.designSpec) !== expectedFingerprint) throw new Error('保存后回读的设计规范与刚才确认的内容不一致，请勿继续生成。')
      clearDesignSpecDraft(window.sessionStorage, bundle.projectId)
      setBundle(refreshed); setDesignConfirmed(true)
    } catch (cause) {
      try {
        const refreshed = await loadCapturedReference()
        if (expectedFingerprint === undefined || !refreshed.designConfirmed || await sha256Fingerprint(refreshed.designSpec) !== expectedFingerprint) throw cause
        clearDesignSpecDraft(window.sessionStorage, bundle.projectId)
        setBundle(refreshed); setDesignConfirmed(true)
      } catch { setConfirmDesignError(cause instanceof Error ? cause.message : String(cause)) }
    } finally { setConfirmingDesign(false) }
  }

  const reopenDesign = async (): Promise<void> => {
    if (bundle === undefined || !bundle.designConfirmed || bundle.revisions.length !== 0 || reopeningDesign) return
    setReopeningDesign(true); setReopenDesignError(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-reopen-design/v1', projectId: bundle.projectId })
      if (!response.ok) throw new Error(response.error ?? '设计规范暂时无法重新调整。')
      const refreshed = await loadCapturedReference()
      if (refreshed.designConfirmed || refreshed.currentRevisionId !== undefined || refreshed.revisions.length !== 0) throw new Error('重新调整后回读的原型状态不正确，请勿继续生成。')
      const original = createDesignSpecFromEvidence(bundle.evidence[0]!)
      saveDesignSpecDraft(window.sessionStorage, bundle.projectId, bundle.evidence.map(item => item.id), bundle.designSpec, original)
      setBundle(refreshed); setDesignConfirmed(false)
    } catch (cause) { setReopenDesignError(cause instanceof Error ? cause.message : String(cause)) } finally { setReopeningDesign(false) }
  }

  const createVariant = async (): Promise<void> => {
    if (bundle === undefined || bundle.revisions.length === 0 || creatingVariant) return
    setCreatingVariant(true); setCreateVariantError(undefined); setCreateVariantSuccess(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; projectId?: string; referenceId?: string; error?: string }>({ type: 'prototype-studio-create-variant/v1', projectId: bundle.projectId })
      if (!response.ok || typeof response.projectId !== 'string' || typeof response.referenceId !== 'string') throw new Error(response.error ?? '没有收到新设计方案的安全回读。')
      setCreateVariantSuccess('新方案已在新标签页打开。')
    } catch (cause) { setCreateVariantError(cause instanceof Error ? cause.message : String(cause)) } finally { setCreatingVariant(false) }
  }

  const restoreRevision = async (targetRevisionId: string): Promise<void> => {
    if (bundle === undefined || bundle.currentRevisionId === undefined || targetRevisionId === bundle.currentRevisionId) return
    if (historyPreview?.revisionId !== targetRevisionId) { setRequestTone('error'); setRequestStatus('恢复前必须先读取并核对该版本与当前版本的差异。'); return }
    setRestoringRevisionId(targetRevisionId); setRequestStatus(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-restore/v1', projectId: bundle.projectId, targetRevisionId, expectedCurrentRevisionId: bundle.currentRevisionId })
      if (!response.ok) throw new Error(response.error ?? '无法恢复该历史版本。')
      const refreshed = await loadCapturedReference()
      setBundle(refreshed); setHistoryPreview(undefined); setSelection(undefined); setPreviewMode('interact'); setRequestTone('success'); setRequestStatus('已安全恢复该历史版本，并完成写入回读验证。')
    } catch (cause) { setRequestTone('error'); setRequestStatus(cause instanceof Error ? cause.message : String(cause)) } finally { setRestoringRevisionId(undefined) }
  }

  const previewRevision = async (targetRevisionId: string): Promise<RevisionPreview | undefined> => {
    if (bundle === undefined || loadingHistoryRevisionId !== undefined) return undefined
    setLoadingHistoryRevisionId(targetRevisionId); setHistoryPreviewError(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; preview?: unknown; error?: string }>({ type: 'prototype-studio-revision-preview/v1', projectId: bundle.projectId, targetRevisionId })
      if (!response.ok) throw new Error(response.error ?? '无法读取该历史版本。')
      const checked = parseRevisionPreview(response.preview, { projectId: bundle.projectId, targetRevisionId, currentRevisionId: bundle.currentRevisionId!, evidence: bundle.evidence })
      if (!checked.ok) throw new Error(checked.error)
      setHistoryPreview(checked.value)
      setSelection(undefined); setPreviewMode('interact')
      return checked.value
    } catch (cause) { setHistoryPreviewError(cause instanceof Error ? cause.message : String(cause)); return undefined } finally { setLoadingHistoryRevisionId(undefined) }
  }

  const prepareRestore = async (targetRevisionId: string): Promise<void> => {
    const preview = historyPreview?.revisionId === targetRevisionId ? historyPreview : await previewRevision(targetRevisionId)
    if (preview !== undefined) setConfirmingRevisionId(targetRevisionId)
  }

  const recoverProject = async (): Promise<void> => {
    if (recoveringProject) return
    const query = new URLSearchParams(location.search); const projectId = query.get('projectId'); const referenceId = query.get('referenceId')
    if (projectId === null || referenceId === null) { setError('当前页面缺少项目身份，请回到原型入口重新打开。'); setRecoveryAvailable(false); return }
    setRecoveringProject(true); setError(undefined)
    try {
      const response = await extensionRequest<{ ok: boolean; snapshot?: unknown; error?: string }>({ type: 'prototype-studio-recover/v1', projectId, referenceId })
      if (!response.ok || response.snapshot === undefined) throw new Error(response.error ?? '没有收到恢复后的项目回读。')
      setRetryKey(value => value + 1)
    } catch (cause) {
      setRecoveryAvailable(true)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setRecoveringProject(false) }
  }

  if (bundle === undefined) {
    const copy = LOAD_STAGE_COPY[loadStage]
    return <main className="studio-loading" role={error === undefined ? 'status' : 'alert'} aria-live="polite"><strong>{error === undefined ? copy.title : recoveryAvailable ? '原型仍在，只需恢复访问' : '暂时无法打开原型编辑器'}</strong><p>{error ?? copy.detail}</p>{error !== undefined && <><div className="studio-loading-actions">{recoveryAvailable && <button type="button" disabled={recoveringProject} onClick={() => { void recoverProject() }}>{recoveringProject ? '正在安全恢复…' : '恢复已有项目'}</button>}<button className={recoveryAvailable ? 'secondary' : undefined} type="button" disabled={recoveringProject} onClick={() => setRetryKey(value => value + 1)}>重新检查</button></div><small>{recoveryAvailable ? '恢复会重新签发一次短期访问授权，不会重建项目，也不会删除任何历史版本。' : '不需要重新加载扩展。只有提示参考证据不存在或校验失败时，才需要重新采集网页。'}</small></>}</main>
  }
  if (!designConfirmed) return <><DesignSystemReview bundle={bundle} confirming={confirmingDesign} confirmError={confirmDesignError} reopening={reopeningDesign} reopenError={reopenDesignError} creatingVariant={creatingVariant} createVariantError={createVariantError} onConfirm={designSpec => { if (bundle.designConfirmed) setDesignConfirmed(true); else void confirmDesign(designSpec) }} onReopen={() => { void reopenDesign() }} onCreateVariant={() => { void createVariant() }} />{createVariantSuccess !== undefined && <div className="variant-success" role="status">{createVariantSuccess}</div>}</>
  const { evidence, designSpec, document, revisions, currentRevisionId } = bundle
  const auditSummary = summarizePreviewAudit(previewAudits[previewViewport])
  const allAuditSummary = summarizeAllPreviewAudits(previewAudits)
  const viewportLabel: Record<PreviewViewport, string> = { desktop: '桌面', tablet: '平板', mobile: '手机' }
  const stageLayout = previewStageLayout(previewStageSize.width, previewStageSize.height, previewViewport)
  const compareStageLayout = previewStageLayout(previewStageSize.width >= 900 ? Math.max(240, (previewStageSize.width - 12) / 2) : previewStageSize.width, previewStageSize.height, previewViewport)
  const requirementsUpdateActive = currentRevisionId !== undefined && (editingRequirements || requirementsUpdateProject.current === bundle.projectId)
  const isBriefEditor = currentRevisionId === undefined || requirementsUpdateActive
  const draftBrief = isBriefEditor ? productBriefFromFields({ audience: briefAudience, coreTask: briefTask, pages: briefPages, modules: briefModules, flows: briefFlows, notes: briefNotes }) : undefined
  const briefConfirmed = currentRevisionId === undefined && draftBrief !== undefined && canonicalJson(draftBrief) === canonicalJson(bundle.productBrief)
  const requirementsChanged = draftBrief !== undefined && bundle.productBrief !== undefined && canonicalJson(draftBrief) !== canonicalJson(bundle.productBrief)
  const requestReady = currentRevisionId === undefined ? draftBrief !== undefined : editingRequirements ? draftBrief !== undefined && requirementsChanged : request.trim() !== ''
  const historyPreviewReadOnly = historyPreview !== undefined
  const displayedCoverage = bundle.requirementCoverage
  const visualHistoryDiff = historyPreview === undefined ? undefined : visualRevisionDiff(document, historyPreview.document, bundle.requirementCoverage, historyPreview.requirementCoverage)
  const applyBriefExample = (kind: 'supplier' | 'project'): void => {
    if (kind === 'supplier') { setBriefAudience('采购经理、供应商管理员'); setBriefTask('筛选供应商并完成准入审批'); setBriefPages('工作台\n供应商列表\n审批详情'); setBriefModules('关键指标\n组合筛选\n供应商表格\n资质与风险\n审批记录'); setBriefFlows('组合条件筛选供应商\n打开供应商详情\n通过或驳回准入申请'); setBriefNotes('详情中展示负责人、风险、资质和审批记录。') }
    else { setBriefAudience('项目经理、团队负责人'); setBriefTask('查看项目进度并及时处理风险'); setBriefPages('项目总览\n项目列表\n风险详情'); setBriefModules('关键指标\n完成趋势\n项目筛选\n风险清单\n最近动态'); setBriefFlows('按负责人和状态筛选项目\n打开项目风险详情\n更新风险处理状态'); setBriefNotes('展示关键指标、完成趋势、负责人和最近动态。') }
  }
  const suggestBriefFromConversation = async (): Promise<void> => {
    if (suggestingBrief || sending || waitingForRevision || historyPreview !== undefined) return
    const requestId = `brief-${crypto.randomUUID()}`
    setSuggestingBrief(true); setRequestTone('info'); setRequestStatus('正在让 AI 从当前对话整理产品需求草稿…')
    try {
      const response = await extensionRequest<{ ok: boolean; error?: string }>({ type: 'prototype-studio-suggest-brief/v1', projectId: bundle.projectId, requestId })
      if (!response.ok) throw new Error(response.error ?? 'Harness 对话没有接受需求整理请求。')
      const refreshed = await loadCapturedReference()
      setBundle(refreshed)
      if (refreshed.briefSuggestionAttempt?.requestId !== requestId) throw new Error('需求整理请求登记后未能完成同请求回读。')
      setRequestStatus('AI 正在结合当前对话整理需求；完成后会自动填入下面的草稿。')
    } catch (cause) {
      setSuggestingBrief(false); setRequestTone('error'); setRequestStatus(`没有开始整理：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const exportCurrentPrototype = async (kind: 'html' | 'json'): Promise<void> => {
    if (currentRevisionId === undefined || exporting !== undefined) return
    setExporting(kind)
    try {
      const artifact = await createPrototypeExportArtifacts({ projectId: bundle.projectId, revisionId: currentRevisionId, document, designSpec, evidence })
      if (kind === 'html') downloadPrototypeArtifact(`${artifact.baseName}.html`, artifact.html, 'text/html')
      else downloadPrototypeArtifact(`${artifact.baseName}.json`, artifact.json, 'application/json')
      setRequestTone('success'); setRequestStatus(kind === 'html' ? `离线交互原型已导出（版本指纹 ${artifact.documentFingerprint.slice(0, 12)}…）。` : `原型与设计规范数据已导出（版本指纹 ${artifact.documentFingerprint.slice(0, 12)}…）。`)
    } catch (cause) { setRequestTone('error'); setRequestStatus(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`) } finally { setExporting(undefined) }
  }
  const askForResponsiveRepair = (): void => {
    setSelection(undefined)
    setPreviewMode('interact')
    setRequest(`请修复${viewportLabel[previewViewport]}尺寸的布局问题：${auditSummary.detail} 保持已确认的设计规范和现有业务流程不变，并重新检查所有操作区和弹窗。`)
  }
  const previewSurface = currentRevisionId === undefined ? <div className="prototype-empty"><span>{briefConfirmed ? '设计规范和产品需求均已确认' : '设计规范已确认'}</span><h2>{briefConfirmed ? '需求已准备好，可以开始生成' : '你想做一个什么产品原型？'}</h2><p>{briefConfirmed ? '左侧已经显示确认后的需求清单。点击右侧“开始生成原型”，AI 才会收到这些内容。' : '说明使用者、核心任务和必须演示的流程。AI 会沿用刚才确认的完整设计规范。'}</p><div>{!briefConfirmed && <><button type="button" className="secondary" onClick={() => applyBriefExample('supplier')}>填入供应商管理示例</button><button type="button" className="secondary" onClick={() => applyBriefExample('project')}>填入项目看板示例</button></>}</div></div> : historyPreview === undefined ? <div ref={previewStageRef} className={`prototype-viewport ${previewViewport}`}><div className="prototype-scale-stage" style={{ width: stageLayout.displayWidth, height: stageLayout.displayHeight }}><iframe ref={frameRef} title="安全交互原型" className="prototype-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={syncPreviewState} style={{ width: stageLayout.viewportWidth, height: stageLayout.viewportHeight, transform: `scale(${stageLayout.scale})` }} /></div></div> : <div ref={previewStageRef} className="history-compare" aria-label="当前版本与历史版本对比"><section className="history-compare-column"><header><b>当前版本</b><small>只读对比，不会改变当前版本</small></header><div className={`prototype-viewport ${previewViewport}`}><div className="prototype-scale-stage" style={{ width: compareStageLayout.displayWidth, height: compareStageLayout.displayHeight }}><iframe ref={frameRef} title="当前版本安全预览" className="prototype-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={syncPreviewState} style={{ width: compareStageLayout.viewportWidth, height: compareStageLayout.viewportHeight, transform: `scale(${compareStageLayout.scale})` }} /></div></div></section><section className="history-compare-column"><header><b>历史版本</b><small>只读对比，不会改变历史版本</small></header><div className={`prototype-viewport ${previewViewport}`}><div className="prototype-scale-stage" style={{ width: compareStageLayout.displayWidth, height: compareStageLayout.displayHeight }}><iframe ref={historyFrameRef} title="历史版本安全预览" className="prototype-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={historySrcDoc} onLoad={syncHistoryPreviewState} style={{ width: compareStageLayout.viewportWidth, height: compareStageLayout.viewportHeight, transform: `scale(${compareStageLayout.scale})` }} /></div></div></section></div>
  return <main className={`studio-shell ${currentRevisionId === undefined ? 'before-first-generation' : 'has-revision'}`}>
    <header className="studio-header"><div><strong>AI 原型工具 · 生成与调整</strong><span><b className="confirmed-dot" />设计规范已确认　→　描述产品或选中元素　→　AI 生成安全交互原型</span></div><div className="studio-header-actions">{currentRevisionId !== undefined && <><button className="secondary" type="button" disabled={exporting !== undefined} onClick={() => { void exportCurrentPrototype('html') }}>{exporting === 'html' ? '正在导出…' : '导出离线原型'}</button><button className="secondary" type="button" disabled={exporting !== undefined} onClick={() => { void exportCurrentPrototype('json') }}>{exporting === 'json' ? '正在导出…' : '导出规范数据'}</button></>}<button className="secondary" type="button" onClick={() => setDesignConfirmed(false)}>查看完整规范</button></div></header>
    <section className="studio-grid">
      <aside className="studio-panel evidence-panel"><h2>设计依据</h2>{bundle.screenshotUnavailable && <p className="evidence-retention-inline" role="status">截图已清理；设计规范和历史仍保留。</p>}<article>{evidence[0]!.screenshotDataUrl !== undefined && <img className="reference-shot" src={evidence[0]!.screenshotDataUrl} alt="参考网页截图" />}<b>{evidence[0]!.source.title}</b><small>{evidence[0]!.source.url}</small><div className="evidence-summary"><span>{evidence[0]!.pageSize?.sampledBands ?? 1} 个页面区域</span><span>{designSpec.colors.length} 个规范颜色</span><span>{designSpec.spacing.scale?.length ?? 1} 个间距档位</span></div></article><article><h3>{designSpec.name}</h3><p>当前原型必须沿用已确认的颜色、排版、间距、圆角、边框、效果和动效。</p><div className="swatches">{designSpec.colors.slice(0, 7).map(item => <span key={`${item.name}-${item.value}`}><i style={{ background: item.value }} /><b>{item.name}</b><small>{item.value}</small></span>)}</div></article>{bundle.productBrief !== undefined && <article className="accepted-brief"><div className="accepted-brief-heading"><h3>已确认的产品需求</h3>{currentRevisionId !== undefined && historyPreview === undefined && !requirementsUpdateActive && <button type="button" className="secondary" disabled={sending || waitingForRevision} onClick={startRequirementsUpdate}>更新产品需求</button>}</div><dl><div><dt>谁来使用</dt><dd>{bundle.productBrief.audience}</dd></div><div><dt>核心任务</dt><dd>{bundle.productBrief.coreTask}</dd></div><div><dt>必须页面</dt><dd>{bundle.productBrief.requiredPages.join('、')}</dd></div>{bundle.productBrief.requiredModules !== undefined && <div><dt>页面内关键模块</dt><dd>{bundle.productBrief.requiredModules.join('、')}</dd></div>}<div><dt>必须演示流程</dt><dd>{bundle.productBrief.requiredFlows.join('；')}</dd></div>{bundle.productBrief.notes !== undefined && <div><dt>补充说明</dt><dd>{bundle.productBrief.notes}</dd></div>}</dl>{requirementsUpdateActive && <p className="requirements-update-note" role="status">正在准备新需求。当前版本仍使用旧需求；新版本通过校验并保存后才会更新。</p>}</article>}{displayedCoverage !== undefined && <RequirementCoveragePanel coverage={displayedCoverage} historical={historyPreview !== undefined} onFocus={historyPreview === undefined ? focusCoverageMatch : undefined} />}</aside>
      <section className="preview-panel"><div className="preview-heading"><div><h2>{currentRevisionId === undefined ? '准备生成产品原型' : displayedDocument?.title ?? document.title}</h2><p>{historyPreview !== undefined ? `只读预览 · ${revisionTime(historyPreview.createdAt)} · 不会改变当前版本` : currentRevisionId === undefined ? '在右侧描述产品、页面和关键流程。' : previewMode === 'interact' ? '操作原型：点击按钮、填写表单、切换页面。' : '选择修改：点击页面元素，再向 AI 说明要改什么。'}</p></div>{currentRevisionId === undefined ? <span>{briefConfirmed ? '需求已确认' : '等待需求'}</span> : <div className="preview-tools">{historyPreview === undefined && <div className="preview-mode-switch" aria-label="预览模式"><button type="button" className={previewMode === 'interact' ? 'active' : ''} aria-pressed={previewMode === 'interact'} onClick={() => choosePreviewMode('interact')}>操作原型</button><button type="button" className={previewMode === 'select' ? 'active' : ''} aria-pressed={previewMode === 'select'} onClick={() => choosePreviewMode('select')}>选择修改</button></div>}<div className="viewport-switch" aria-label="预览尺寸">{(['desktop', 'tablet', 'mobile'] as const).map(value => <button type="button" className={previewViewport === value ? 'active' : ''} aria-pressed={previewViewport === value} key={value} onClick={() => choosePreviewViewport(value)}>{viewportLabel[value]}</button>)}</div><span>{stageLayout.viewportWidth}px · {Math.round(stageLayout.scale * 100)}%</span></div>}</div>{historyPreview !== undefined && <div className="history-preview-banner"><div><b>正在对比：当前版本与“{historyPreview.changeSummary}”</b><span>两边都是隔离的只读预览；点击不会改变任何版本。</span><small className="history-brief-note">{historyPreview.productBriefKnown ? '恢复后产品需求也会回到该版本。' : '旧版未记录当时需求，恢复时会做兼容校验，可能被拒绝。'}</small>{visualHistoryDiff !== undefined && <div className="history-diff-summary"><section><strong>页面与组件差异</strong><ul>{visualHistoryDiff.structure.length === 0 ? <li>页面和组件标识未变化</li> : visualHistoryDiff.structure.map(detail => <li key={detail}>{detail}</li>)}</ul></section><section><strong>需求覆盖差异</strong><ul>{visualHistoryDiff.coverage.length === 0 ? <li>两个版本都没有已确认需求清单</li> : visualHistoryDiff.coverage.map(detail => <li key={detail}>{detail}</li>)}</ul></section></div>}</div><button type="button" className="secondary" onClick={() => setHistoryPreview(undefined)}>返回当前版本</button></div>}{currentRevisionId !== undefined && historyPreview === undefined && <div className={`preview-audit ${checkingAllViewports ? 'checking' : allAuditSummary.tone}`} role="status"><div className="audit-copy"><b>基础布局检查：{(['desktop', 'tablet', 'mobile'] as const).map(value => <span key={value} className={previewAudits[value] === undefined ? 'checking' : summarizePreviewAudit(previewAudits[value]).tone}>{viewportLabel[value]} {previewAudits[value] === undefined ? '待检查' : summarizePreviewAudit(previewAudits[value]).tone === 'pass' ? '✓' : '⚠'}</span>)}</b><small>{checkingAllViewports || Object.keys(previewAudits).length === 3 ? `${allAuditSummary.label} · ${allAuditSummary.detail}` : `${auditSummary.label} · ${auditSummary.detail}`}</small></div><div className="audit-actions"><button type="button" className="secondary" disabled={checkingAllViewports} onClick={checkAllViewports}>{checkingAllViewports ? '正在逐个检查…' : '检查全部尺寸'}</button>{auditSummary.tone === 'warning' && <button type="button" className="secondary" onClick={askForResponsiveRepair}>让 AI 修复当前尺寸</button>}</div></div>}{previewSurface}</section>
      <aside className="studio-panel ai-panel">
        <h2>AI 原型助手</h2>
        <p className="conversation-context-note"><b>会结合当前 AI 对话</b><span>下面确认的需求清单优先；对话里的业务背景、规则和已确认决定会一起提供给 AI，不需要重复粘贴。</span></p>
        <article className="request-card">
          {selection === undefined || requirementsUpdateActive ? <div className="request-heading"><b>{currentRevisionId === undefined ? '先确认产品需求清单' : requirementsUpdateActive ? '更新产品需求并生成新版本' : '继续完善整个原型'}</b><p>{currentRevisionId === undefined ? '四项写清楚后，AI 才开始生成，避免只做几张空卡片。' : requirementsUpdateActive ? '新需求只会在新版本通过校验并保存后正式生效；当前版本不会被改写。' : '也可以先点击中间的元素，再做局部修改。'}</p></div> : <div className="selected-target"><span>正在修改</span><b>{selection.label}</b><small>{selectionTypeLabel(selection.type)} · {selection.elementId}</small><button type="button" className="secondary" onClick={() => choosePreviewMode('interact')}>改为调整整个原型</button></div>}
          {isBriefEditor && <div className="brief-builder"><label>谁来使用<input maxLength={120} disabled={sending || waitingForRevision || confirmingBrief} value={briefAudience} onChange={event => setBriefAudience(event.target.value)} placeholder="例如：采购经理、供应商管理员" /></label><label>核心任务<input maxLength={300} disabled={sending || waitingForRevision || confirmingBrief} value={briefTask} onChange={event => setBriefTask(event.target.value)} placeholder="例如：筛选供应商并完成准入审批" /></label><label>必须包含的页面<textarea maxLength={700} disabled={sending || waitingForRevision || confirmingBrief} value={briefPages} onChange={event => setBriefPages(event.target.value)} placeholder={'每行一个真实页面，例如：\n工作台\n供应商列表\n审批详情'} /></label><label>页面内关键模块（可选）<textarea maxLength={1_000} disabled={sending || waitingForRevision || confirmingBrief} value={briefModules} onChange={event => setBriefModules(event.target.value)} placeholder={'每行一个，例如：\n关键指标\n组合筛选\n供应商表格\n风险记录'} /></label><label>必须演示的真实流程<textarea maxLength={1_300} disabled={sending || waitingForRevision || confirmingBrief} value={briefFlows} onChange={event => setBriefFlows(event.target.value)} placeholder={'每行一个，例如：\n筛选供应商\n打开详情\n通过或驳回申请'} /></label><div className="brief-status"><span className={briefAudience.trim().length >= 2 ? 'done' : ''}>使用者</span><span className={briefTask.trim().length >= 6 ? 'done' : ''}>核心任务</span><span className={productBriefFromFields({ audience: briefAudience || '临时', coreTask: briefTask || '临时核心任务', pages: briefPages, flows: '临时流程' }) !== undefined ? 'done' : ''}>页面</span><span className={productBriefFromFields({ audience: briefAudience || '临时', coreTask: briefTask || '临时核心任务', pages: '临时页面', flows: briefFlows }) !== undefined ? 'done' : ''}>流程</span></div></div>}
          {historyPreviewReadOnly && <p className="history-preview-readonly" role="status">当前是只读历史预览，请先返回当前版本，或恢复该版本后再修改。</p>}
          <textarea aria-label={isBriefEditor ? '产品补充说明' : '原型修改要求'} maxLength={isBriefEditor ? 1_200 : 4_000} disabled={sending || waitingForRevision || confirmingBrief || historyPreviewReadOnly} value={isBriefEditor ? briefNotes : request} onChange={event => isBriefEditor ? setBriefNotes(event.target.value) : setRequest(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && requestReady && !sending && !waitingForRevision && !confirmingBrief && !historyPreviewReadOnly) { event.preventDefault(); if (currentRevisionId === undefined && !briefConfirmed && draftBrief !== undefined) void confirmBrief(draftBrief); else void askAi() } }} placeholder={isBriefEditor ? '补充说明（可选）：业务字段、状态、规则或异常情况' : selection === undefined ? '例如：增加负责人筛选和项目风险抽屉' : '例如：点击这行后打开详情弹窗，显示负责人、风险和审批记录'} />
          <div className="request-meta"><span>{(isBriefEditor ? briefNotes : request).length} / {isBriefEditor ? 1200 : 4000}</span><span>{historyPreviewReadOnly ? '历史预览只读' : waitingForRevision ? '要求已保留' : isBriefEditor && !briefConfirmed ? '未确认草稿保存在当前标签页' : '⌘/Ctrl + Enter 发送'}</span></div>
          {isBriefEditor && <div className="prompt-examples"><button type="button" className="conversation-suggest" disabled={sending || waitingForRevision || confirmingBrief || suggestingBrief || historyPreviewReadOnly} onClick={() => { void suggestBriefFromConversation() }}>{suggestingBrief ? 'AI 正在整理对话…' : 'AI 从当前对话整理需求'}</button><button type="button" disabled={sending || waitingForRevision || confirmingBrief || suggestingBrief || historyPreviewReadOnly} onClick={() => applyBriefExample('supplier')}>填入供应商示例</button><button type="button" disabled={sending || waitingForRevision || confirmingBrief || suggestingBrief || historyPreviewReadOnly} onClick={() => applyBriefExample('project')}>填入项目看板示例</button>{requirementsUpdateActive && <button type="button" className="secondary" disabled={sending || waitingForRevision || suggestingBrief} onClick={cancelRequirementsUpdate}>取消更新</button>}</div>}
          {revisions.length >= 20 && confirmingRevisionEviction && <div className="revision-eviction-confirm"><b>将替换最旧的历史版本</b><span>这是保存第 21 个版本的必要操作；当前版本和其余 19 个版本会保留。</span><button type="button" className="secondary" onClick={() => { setConfirmingRevisionEviction(false); setRequestStatus(undefined) }}>暂不生成</button></div>}
          <button type="button" disabled={sending || waitingForRevision || confirmingBrief || historyPreviewReadOnly || !requestReady} onClick={() => { if (currentRevisionId === undefined && !briefConfirmed && draftBrief !== undefined) void confirmBrief(draftBrief); else void askAi() }}>{confirmingBrief ? '正在保存并回读需求…' : sending ? '正在发送…' : waitingForRevision ? 'AI 正在生成并校验…' : historyPreviewReadOnly ? '历史预览只读' : currentRevisionId === undefined && !briefConfirmed ? '保存并确认需求清单' : currentRevisionId === undefined ? '开始生成原型' : requirementsUpdateActive ? '确认需求变更并生成新版本' : revisions.length >= 20 && !confirmingRevisionEviction ? '继续并查看版本替换提醒' : revisions.length >= 20 ? '确认替换最旧版本并生成' : selection === undefined ? '完善整个原型' : '修改选中元素'}</button>
          {generationTimedOut && <div className="generation-timeout" role="status"><b>本次生成需要处理</b><span>可以继续等待；如果 AI 已停止工作，请安全结束本次生成后再重试。</span><div><button type="button" className="secondary" disabled={refreshingGeneration || cancellingGeneration} onClick={() => { void refreshGenerationStatus() }}>{refreshingGeneration ? '正在刷新…' : '刷新生成状态'}</button>{confirmingGenerationCancel ? <><button type="button" className="secondary" disabled={cancellingGeneration} onClick={() => setConfirmingGenerationCancel(false)}>继续等待</button><button type="button" className="danger-action" disabled={cancellingGeneration} onClick={() => { void cancelGeneration() }}>{cancellingGeneration ? '正在安全停止…' : '确认停止生成'}</button></> : <button type="button" className="secondary" onClick={() => setConfirmingGenerationCancel(true)}>停止本次生成</button>}</div>{confirmingGenerationCancel && <small>停止后，当前 AI 的晚到结果将被拒绝，但输入框里的要求会保留。</small>}</div>}
          {requestStatus !== undefined && <p className={`request-notice ${requestTone}`} role={requestTone === 'error' ? 'alert' : 'status'}>{requestStatus}</p>}
        </article>
        <div className="version-heading"><h3>历史版本</h3><small className={revisions.length >= 18 ? 'capacity-warning' : ''}>{revisions.length >= 20 ? '已满 20 个；替换前会再次确认' : revisions.length >= 18 ? `已保存 ${revisions.length}/20 个，即将达到上限` : `已保存 ${revisions.length}/20 个`}</small></div>
        {historyPreviewError !== undefined && <p className="history-error" role="alert">无法预览：{historyPreviewError}</p>}
        <ol className="revisions">{revisions.length === 0 ? <li className="current">尚无已保存版本<span>等待生成</span></li> : revisions.slice().reverse().map(revision => <li key={revision.id} className={revision.current ? 'current' : ''}>{revision.current ? <div className="version-copy"><b>{revision.changeSummary}</b><small>{revisionTime(revision.createdAt)}</small><span>当前</span></div> : confirmingRevisionId === revision.id && historyPreview?.revisionId === revision.id ? <div className="restore-confirm"><b>{revision.changeSummary}</b><small>{revisionTime(historyPreview.createdAt)} · 恢复后仍可切回其他版本</small><section className="restore-diff" aria-label="恢复版本差异"><span>{historyPreview.comparison.screenCountBefore} → {historyPreview.comparison.screenCountAfter} 个页面 · {historyPreview.comparison.componentCountBefore} → {historyPreview.comparison.componentCountAfter} 个组件</span><small className="history-brief-note">{historyPreview.productBriefKnown ? '恢复后产品需求也会回到该版本。' : '旧版未记录当时需求，恢复时会做兼容校验，可能被拒绝。'}</small><ul>{historyPreview.comparison.details.map(detail => <li key={detail}>{detail}</li>)}</ul></section><div><button type="button" className="secondary" onClick={() => setConfirmingRevisionId(undefined)}>取消</button><button type="button" disabled={restoringRevisionId !== undefined || waitingForRevision} onClick={() => { setConfirmingRevisionId(undefined); void restoreRevision(revision.id) }}>{restoringRevisionId === revision.id ? '正在恢复…' : '确认恢复这个差异版本'}</button></div></div> : <div className="version-row"><div className="version-copy"><b>{revision.changeSummary}</b><small>{revisionTime(revision.createdAt)}</small></div><div><button type="button" className="secondary" disabled={loadingHistoryRevisionId !== undefined} onClick={() => { void previewRevision(revision.id) }}>{loadingHistoryRevisionId === revision.id ? '读取中…' : historyPreview?.revisionId === revision.id ? '预览中' : '先预览'}</button><button type="button" className="secondary" disabled={restoringRevisionId !== undefined || waitingForRevision || loadingHistoryRevisionId !== undefined} onClick={() => { void prepareRestore(revision.id) }}>{loadingHistoryRevisionId === revision.id ? '读取差异…' : '恢复'}</button></div></div>}</li>)}</ol>
        <p className="verification-note">预览不会修改当前版本；保存和恢复都会校验版本指纹并完成同目标回读。</p>
      </aside>
    </section>
  </main>
}

function mountPrototypeStudio(): void {
  const root = document.getElementById('root')
  try {
    if (root === null) throw new Error('找不到原型工具的页面容器。')
    const pageBuildId = document.documentElement.dataset.prototypeStudioBuild
    if (pageBuildId !== undefined && pageBuildId !== PROTOTYPE_STUDIO_BUILD_ID) throw new Error(`页面与脚本版本不一致（页面 ${pageBuildId}，脚本 ${PROTOTYPE_STUDIO_BUILD_ID}）。`)
    ReactDOM.createRoot(root).render(<PrototypeStartupBoundary><App /></PrototypeStartupBoundary>)
  } catch (cause) {
    const message = `原型工具启动失败：${startupReason(cause)}`
    notifyStartupFailure(message)
    nativeStartupFailure(message)
  }
}

mountPrototypeStudio()
