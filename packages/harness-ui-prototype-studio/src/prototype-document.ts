/** The only model-to-preview contract: bounded data, never executable code. */
export const PROTOTYPE_DOCUMENT_VERSION = 1 as const
export const MAX_REFERENCE_EVIDENCE = 12
export const MAX_SCREENS = 12
export const MAX_NODES = 240
export const MAX_TEXT_LENGTH = 2_000
export const MAX_URL_LENGTH = 2_048
export const MAX_DOCUMENT_JSON_BYTES = 200_000
export const MAX_DOCUMENT_TEXT_BYTES = 24_000
export const MAX_STATE_VARIABLES = 24
export const MAX_STATE_ALLOWED_VALUES = 40

export type PrototypeActionType = 'navigate' | 'open-modal' | 'close-modal' | 'set-value' | 'set-state' | 'toggle' | 'set-tab' | 'submit-success' | 'sequence'
export type PrototypeNodeType = 'text' | 'icon' | 'button' | 'input' | 'card' | 'group' | 'metric' | 'badge' | 'alert' | 'progress' | 'chart' | 'table' | 'tabs' | 'list' | 'breadcrumb' | 'empty-state' | 'pagination' | 'modal'
export const PROTOTYPE_ACTION_TYPES = ['navigate', 'open-modal', 'close-modal', 'set-value', 'set-state', 'toggle', 'set-tab', 'submit-success', 'sequence'] as const satisfies readonly PrototypeActionType[]
export const PROTOTYPE_NODE_TYPES = ['text', 'icon', 'button', 'input', 'card', 'group', 'metric', 'badge', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'breadcrumb', 'empty-state', 'pagination', 'modal'] as const satisfies readonly PrototypeNodeType[]
/** A deliberately small, closed icon vocabulary. Model output may name one, never supply artwork. */
export const PROTOTYPE_ICON_NAMES = ['home', 'dashboard', 'search', 'add', 'user', 'users', 'settings', 'calendar', 'filter', 'check', 'info', 'warning', 'error', 'close', 'chevron-left', 'chevron-right', 'chevron-up', 'chevron-down', 'arrow-left', 'arrow-right', 'menu', 'bell', 'edit', 'trash'] as const
export type PrototypeIconName = typeof PROTOTYPE_ICON_NAMES[number]
/** Trusted renderer artwork. This table is never part of the model-facing document interface. */
export const PROTOTYPE_ICON_PATHS: Readonly<Record<PrototypeIconName, string>> = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  dashboard: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  search: 'm21 21-4.35-4.35M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z',
  add: 'M12 5v14M5 12h14',
  user: 'M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.2 2.2-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56v.1h-3.12v-.1A1.7 1.7 0 0 0 10.5 18.74a1.7 1.7 0 0 0-1.88.34l-.06.06-2.2-2.2.06-.06A1.7 1.7 0 0 0 6.76 15a1.7 1.7 0 0 0-1.56-1.03h-.1v-3.12h.1a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.2-2.2.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.1h3.12v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.2 2.2-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.1v3.12h-.1A1.7 1.7 0 0 0 19.4 15z',
  calendar: 'M6 2v4M18 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  filter: 'M4 5h16M7 12h10M10 19h4',
  check: 'm5 12 4 4L19 6',
  info: 'M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  warning: 'M10.3 3.6 2.5 17.1A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.9L13.7 3.6a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  error: 'M12 9v4M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  close: 'M6 6l12 12M18 6 6 18',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'arrow-right': 'M5 12h14M12 5l7 7-7 7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 14h10l1-14',
}
export interface ReferenceDesignTokensV1 {
  colors: string[]; fonts: string[]; radius: string[]; spacing: string[]
  textColors?: string[]; backgroundColors?: string[]; pageBackgroundColors?: string[]; elevatedBackgroundColors?: string[]; borderColors?: string[]; accentColors?: string[]
  accentBackgroundColors?: string[]; accentTextColors?: string[]
  fontSizes?: string[]; fontWeights?: string[]; lineHeights?: string[]; letterSpacings?: string[]
  textStyles?: { kind: 'heading' | 'body' | 'caption'; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string }[]
  borderWidths?: string[]; borderStyles?: string[]; shadows?: string[]; gradients?: string[]; opacities?: string[]
  controlHeights?: string[]; motionDurations?: string[]; motionEasings?: string[]
  buttonHeights?: string[]; inputHeights?: string[]; contentWidths?: string[]; iconSizes?: string[]
  componentKinds?: string[]; componentStates?: string[]
  componentSamples?: { kind: string; count: number; exampleText?: string; states: string[]; width: number; height: number; color: string; backgroundColor: string; backgroundImage?: string; borderColor: string; borderRadius: string; borderWidth: string; boxShadow: string; disabledOpacity?: string; transitionDuration?: string; transitionTimingFunction?: string }[]
  layoutPatterns?: Array<'block' | 'flex-row' | 'flex-column' | 'grid' | 'sticky'>
  responsiveBreakpoints?: number[]
  focusStyles?: { width: string; style: 'solid' | 'dashed' | 'dotted'; color: string; offset: string }[]
}
export interface ReferenceCaptureCoverageV1 {
  candidateElements: number
  inspectedElements: number
  sampledElements: number
  accessibleStylesheets: number
  opaqueStylesheets: number
  iframeElements: number
  unloadedImages: number
  horizontalOverflow: boolean
  limitations: string[]
}
export interface ReferenceEvidenceV1 { v: 1; id: string; source: { url: string; title: string; capturedAt: string }; viewport: { width: number; height: number; deviceScaleFactor: number }; pageSize?: { width: number; height: number; sampledBands: number }; captureCoverage?: ReferenceCaptureCoverageV1; observations: string[]; designTokens: ReferenceDesignTokensV1; fingerprint: string; screenshotFingerprint?: string; screenshotDataUrl?: string }
export interface DesignSpecV1 {
  v: 1; id: string; name: string; basedOnEvidenceIds: string[]; summary: string
  colors: { name: string; value: string; usage: string }[]
  typography: { fontFamily: string; headingWeight: number; bodyWeight?: number; bodySize: number; headingSize?: number; captionSize?: number; fontSizeScale?: number[]; fontWeightScale?: number[]; lineHeightScale?: number[]; bodyLineHeight?: number; headingLineHeight?: number; letterSpacing?: number }
  spacing: { base: number; cardRadius: number; scale?: number[]; sectionGap?: number; contentWidth?: number }
  surfaces?: { page: string; surface: string; elevated: string; text: string; textMuted: string; border: string }
  borders?: { width: number; style: 'solid' | 'dashed' | 'dotted'; radiusScale: number[] }
  /** Raw lists remain complete for review. Semantic roles are the only effects a trusted preview may apply. */
  effects?: { shadows: string[]; gradients: string[]; opacities: number[]; semantic?: { primaryControlGradient?: string; surfaceShadow?: string; elevatedShadow?: string; disabledControlOpacity?: number } }
  controls?: { height: number; buttonHeight?: number; inputHeight: number; iconSize?: number; radius: number }
  motion?: { durations: string[]; easings: string[]; semantic?: { controlDuration?: string; controlEasing?: string } }
  focus?: { width: number; style: 'solid' | 'dashed' | 'dotted'; color: string; offset: number }
  responsive?: { breakpoints: number[]; layoutPatterns: Array<'block' | 'flex-row' | 'flex-column' | 'grid' | 'sticky'> }
  principles: string[]
}
export interface PrototypeActionV1 { type: PrototypeActionType; targetId?: string; targetScreenId?: string; value?: string; actions?: PrototypeActionV1[] }
/** A finite product state. It makes a demo feel real without adding model code. */
export interface PrototypeStateVariableV1 { id: string; initialValue: string; allowedValues: string[] }
export interface PrototypeVisibleWhenV1 { stateId: string; equals: string }
interface PrototypeNodeBase { id: string; type: PrototypeNodeType; label?: string; visibleWhen?: PrototypeVisibleWhenV1 }
export interface PrototypeTextNodeV1 extends PrototypeNodeBase { type: 'text'; text: string; tone?: 'heading' | 'body' | 'caption' }
export interface PrototypeIconNodeV1 extends PrototypeNodeBase { type: 'icon'; name: PrototypeIconName; label?: string }
export interface PrototypeButtonNodeV1 extends PrototypeNodeBase { type: 'button'; label: string; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; action?: PrototypeActionV1 }
export interface PrototypeInputOptionV1 { label: string; value: string }
export interface PrototypeInputNodeV1 extends PrototypeNodeBase { type: 'input'; label: string; placeholder?: string; value?: string; inputType?: 'text' | 'email' | 'password' | 'checkbox' | 'search' | 'number' | 'date' | 'textarea' | 'select'; options?: PrototypeInputOptionV1[]; bindStateId?: string; required?: boolean; errorText?: string }
export interface PrototypeCardNodeV1 extends PrototypeNodeBase { type: 'card'; children: PrototypeNodeV1[] }
export interface PrototypeGroupNodeV1 extends PrototypeNodeBase { type: 'group'; layout: 'row' | 'column' | 'grid-2' | 'grid-3'; children: PrototypeNodeV1[] }
export interface PrototypeMetricNodeV1 extends PrototypeNodeBase { type: 'metric'; label: string; value: string; detail?: string; tone?: 'neutral' | 'positive' | 'warning' | 'danger' }
export interface PrototypeBadgeNodeV1 extends PrototypeNodeBase { type: 'badge'; text: string; tone?: 'neutral' | 'primary' | 'positive' | 'warning' | 'danger' }
export interface PrototypeAlertNodeV1 extends PrototypeNodeBase { type: 'alert'; title: string; detail?: string; tone?: 'info' | 'positive' | 'warning' | 'danger' }
export interface PrototypeProgressNodeV1 extends PrototypeNodeBase { type: 'progress'; label: string; value: number; detail?: string; tone?: 'primary' | 'positive' | 'warning' | 'danger' }
export interface PrototypeChartBarV1 { label: string; value: number }
export interface PrototypeChartNodeV1 extends PrototypeNodeBase { type: 'chart'; label: string; bars: PrototypeChartBarV1[] }
export interface PrototypeTableColumnV1 { key: string; label: string }
export interface PrototypeTableRowV1 { id: string; values: string[]; action?: PrototypeActionV1 }
export interface PrototypeTableNodeV1 extends PrototypeNodeBase { type: 'table'; label?: string; columns: PrototypeTableColumnV1[]; rows: PrototypeTableRowV1[] }
export interface PrototypeListItemV1 { id: string; title: string; detail?: string; action?: PrototypeActionV1 }
export interface PrototypeListNodeV1 extends PrototypeNodeBase { type: 'list'; items: PrototypeListItemV1[] }
export interface PrototypeTabV1 { id: string; label: string; children: PrototypeNodeV1[]; action?: PrototypeActionV1 }
export interface PrototypeTabsNodeV1 extends PrototypeNodeBase { type: 'tabs'; tabs: PrototypeTabV1[] }
export interface PrototypeBreadcrumbItemV1 { id: string; label: string; targetScreenId?: string }
export interface PrototypeBreadcrumbNodeV1 extends PrototypeNodeBase { type: 'breadcrumb'; items: PrototypeBreadcrumbItemV1[] }
export interface PrototypeEmptyStateNodeV1 extends PrototypeNodeBase { type: 'empty-state'; title: string; detail?: string; actionLabel?: string; action?: PrototypeActionV1 }
export interface PrototypePaginationNodeV1 extends PrototypeNodeBase { type: 'pagination'; label?: string; pageCount: number; bindStateId: string }
export interface PrototypeModalNodeV1 extends PrototypeNodeBase { type: 'modal'; title: string; placement?: 'dialog' | 'drawer-left' | 'drawer-right'; children: PrototypeNodeV1[] }
export type PrototypeNodeV1 = PrototypeTextNodeV1 | PrototypeIconNodeV1 | PrototypeButtonNodeV1 | PrototypeInputNodeV1 | PrototypeCardNodeV1 | PrototypeGroupNodeV1 | PrototypeMetricNodeV1 | PrototypeBadgeNodeV1 | PrototypeAlertNodeV1 | PrototypeProgressNodeV1 | PrototypeChartNodeV1 | PrototypeTableNodeV1 | PrototypeListNodeV1 | PrototypeTabsNodeV1 | PrototypeBreadcrumbNodeV1 | PrototypeEmptyStateNodeV1 | PrototypePaginationNodeV1 | PrototypeModalNodeV1
export interface PrototypeScreenV1 { id: string; title: string; nodes: PrototypeNodeV1[] }
export interface PrototypeShellItemV1 { id: string; label: string; targetScreenId: string }
export interface PrototypeShellV1 { productName: string; placement: 'top' | 'sidebar'; items: PrototypeShellItemV1[] }
export interface PrototypeDocumentV1 { v: 1; id: string; title: string; designSpecId: string; initialScreenId: string; stateVariables?: PrototypeStateVariableV1[]; shell?: PrototypeShellV1; screens: PrototypeScreenV1[] }
export interface PrototypeBundleV1 { evidence: ReferenceEvidenceV1[]; designSpec: DesignSpecV1; document: PrototypeDocumentV1 }
export interface PrototypeRevisionV1 { v: 1; id: string; prototypeId: string; parentRevisionId?: string; createdAt: string; author: 'agent' | 'user'; document: PrototypeDocumentV1; documentFingerprint: string; referenceEvidenceFingerprints: string[]; designSpecFingerprint: string; changeSummary: string }
export interface ValidationSuccess<T> { ok: true; value: T }
export interface ValidationFailure { ok: false; errors: string[] }
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

const ids = /^[a-z][a-z0-9_-]{0,79}$/
const hash = /^[0-9a-f]{64}$/
const color = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,60}\))$/
const cssSize = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/
const cssDuration = /^\d+(?:\.\d+)?m?s$/
const safeCssText = (value: unknown, max = 320): value is string => typeof value === 'string' && value.length <= max && !/[;{}<>]/.test(value) && !/url\s*\(/i.test(value)
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && ids.test(value)
const text = (value: unknown, max = MAX_TEXT_LENGTH): value is string => typeof value === 'string' && value.length <= max
const array = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const strings = (value: unknown, max: number, each = MAX_TEXT_LENGTH): value is string[] => array(value, max) && value.every(item => text(item, each))
const numberIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const integerIn = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const fail = <T>(...errors: string[]): ValidationResult<T> => ({ ok: false, errors })

function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength }
function stringBytes(value: unknown): number { if (typeof value === 'string') return new TextEncoder().encode(value).byteLength; if (Array.isArray(value)) return value.reduce<number>((total, item) => total + stringBytes(item), 0); if (object(value)) return Object.values(value).reduce<number>((total, item) => total + stringBytes(item), 0); return 0 }
function withinDocumentBudget(value: unknown): boolean { return byteLength(value) <= MAX_DOCUMENT_JSON_BYTES && stringBytes(value) <= MAX_DOCUMENT_TEXT_BYTES }

type ActionOwner = { kind: 'button' | 'list-item' | 'table-row' | 'tab' | 'navigation-item' | 'breadcrumb-item' | 'empty-state'; id: string; tabParentId?: string }
interface Registry { ids: Set<string>; screens: Set<string>; inputs: Map<string, PrototypeInputNodeV1>; modals: Set<string>; tabs: Map<string, Set<string>>; stateVariables: Map<string, PrototypeStateVariableV1>; conditions: PrototypeVisibleWhenV1[]; bindings: PrototypeInputNodeV1[]; paginations: PrototypePaginationNodeV1[]; actions: Array<{ action: PrototypeActionV1; owner: ActionOwner }>; types: Set<string>; count: number; errors: string[] }
function addId(registry: Registry, value: unknown, label: string): value is string { if (!id(value) || registry.ids.has(value)) { registry.errors.push(`${label} id 无效或重复。`); return false }; registry.ids.add(value); return true }
function parseAction(value: unknown, owner: ActionOwner, registry: Registry, allowSequence = true): value is PrototypeActionV1 {
  const errorCount = registry.errors.length
  if (!object(value) || !text(value.type, 32) || !PROTOTYPE_ACTION_TYPES.includes(value.type as PrototypeActionType)) { registry.errors.push('动作必须是受支持的固定动作。'); return false }
  if (value.type === 'sequence') {
    if (!allowSequence || owner.kind === 'tab' || !keys(value, ['type', 'actions']) || !array(value.actions, 4) || value.actions.length === 0) { registry.errors.push('连续动作只能用于按钮、表格行或列表项，必须包含 1 到 4 个非嵌套固定动作。'); return false }
    for (const action of value.actions) parseAction(action, owner, registry, false)
    return registry.errors.length === errorCount
  }
  const allowed = value.type === 'navigate' || value.type === 'submit-success' ? ['type', 'targetScreenId'] : value.type === 'set-value' || value.type === 'set-state' || value.type === 'set-tab' ? ['type', 'targetId', 'value'] : ['type', 'targetId']
  if (!keys(value, allowed) || (value.targetId !== undefined && !id(value.targetId)) || (value.targetScreenId !== undefined && !id(value.targetScreenId)) || (value.value !== undefined && !text(value.value, 500))) { registry.errors.push('动作字段或目标 id 无效。'); return false }
  if ((value.type === 'navigate' || value.type === 'submit-success') && !id(value.targetScreenId)) registry.errors.push('页面动作必须指向真实页面。')
  if (!['navigate', 'submit-success'].includes(value.type) && !id(value.targetId)) registry.errors.push('组件动作必须指向真实组件。')
  if (['set-value', 'set-state', 'set-tab'].includes(value.type) && typeof value.value !== 'string') registry.errors.push('设值动作必须提供字符串 value。')
  if (owner.kind === 'tab' ? value.type !== 'set-tab' : value.type === 'set-tab') registry.errors.push('动作只能由对应的可点击控件执行。')
  registry.actions.push({ action: value as unknown as PrototypeActionV1, owner }); return registry.errors.length === errorCount
}
function parseVisibleWhen(value: unknown, registry: Registry): value is PrototypeVisibleWhenV1 {
  if (!object(value) || !keys(value, ['stateId', 'equals']) || !id(value.stateId) || !text(value.equals, 160)) { registry.errors.push('显示条件必须引用有效状态和值。'); return false }
  registry.conditions.push(value as unknown as PrototypeVisibleWhenV1)
  return true
}
function childNodes(children: unknown[], registry: Registry, depth: number): void { for (const child of children) if (!node(child, registry, depth + 1)) registry.errors.push('嵌套组件格式无效。') }
function node(value: unknown, registry: Registry, depth: number): value is PrototypeNodeV1 {
  registry.count += 1
  if (depth > 4 || registry.count > MAX_NODES || !object(value) || !addId(registry, value.id, '组件') || !text(value.type, 24)) { registry.errors.push('组件层级或数量超出限制。'); return false }
  const type = value.type
  if (!PROTOTYPE_NODE_TYPES.includes(type as PrototypeNodeType)) { registry.errors.push(`不支持的组件：${String(type)}`); return false }
  registry.types.add(type)
  const visibleWhenOk = value.visibleWhen === undefined || parseVisibleWhen(value.visibleWhen, registry)
  if (type === 'text') return visibleWhenOk && keys(value, ['id', 'type', 'text', 'tone', 'visibleWhen']) && text(value.text) && (value.tone === undefined || ['heading', 'body', 'caption'].includes(String(value.tone)))
  if (type === 'icon') return visibleWhenOk && keys(value, ['id', 'type', 'name', 'label', 'visibleWhen']) && typeof value.name === 'string' && PROTOTYPE_ICON_NAMES.includes(value.name as PrototypeIconName) && (value.label === undefined || text(value.label, 160))
  if (type === 'button') { const ok = visibleWhenOk && keys(value, ['id', 'type', 'label', 'variant', 'disabled', 'action', 'visibleWhen']) && text(value.label, 160) && (value.variant === undefined || ['primary', 'secondary', 'danger'].includes(String(value.variant))) && (value.disabled === undefined || typeof value.disabled === 'boolean'); if (value.action !== undefined) parseAction(value.action, { kind: 'button', id: value.id as string }, registry); return ok }
  if (type === 'input') { const inputType = value.inputType ?? 'text'; const options = value.options; const optionsOk = inputType === 'select' ? array(options, 40) && options.length > 0 && options.every(item => object(item) && keys(item, ['label', 'value']) && text(item.label, 120) && text(item.value, 160)) : options === undefined; const bindingOk = value.bindStateId === undefined || (id(value.bindStateId) && inputType !== 'checkbox'); const ok = visibleWhenOk && keys(value, ['id', 'type', 'label', 'placeholder', 'value', 'inputType', 'options', 'bindStateId', 'required', 'errorText', 'visibleWhen']) && text(value.label, 160) && (value.placeholder === undefined || text(value.placeholder, 240)) && (value.value === undefined || text(value.value, 500)) && (value.required === undefined || typeof value.required === 'boolean') && (value.errorText === undefined || text(value.errorText, 240)) && ['text', 'email', 'password', 'checkbox', 'search', 'number', 'date', 'textarea', 'select'].includes(String(inputType)) && optionsOk && bindingOk; if (ok) { const input = value as unknown as PrototypeInputNodeV1; registry.inputs.set(value.id as string, input); if (input.bindStateId !== undefined) registry.bindings.push(input) }; return ok }
  if (type === 'card' || type === 'modal') { const modal = type === 'modal'; const children = array(value.children, 40) ? value.children : undefined; const ok = visibleWhenOk && keys(value, modal ? ['id', 'type', 'title', 'placement', 'children', 'visibleWhen'] : ['id', 'type', 'label', 'children', 'visibleWhen']) && (modal ? text(value.title, 160) && (value.placement === undefined || ['dialog', 'drawer-left', 'drawer-right'].includes(String(value.placement))) : value.label === undefined || text(value.label, 160)) && children !== undefined; if (modal) registry.modals.add(value.id as string); if (ok && children !== undefined) childNodes(children, registry, depth); return ok }
  if (type === 'group') { const children = array(value.children, 40) ? value.children : undefined; const ok = visibleWhenOk && keys(value, ['id', 'type', 'label', 'layout', 'children', 'visibleWhen']) && (value.label === undefined || text(value.label, 160)) && ['row', 'column', 'grid-2', 'grid-3'].includes(String(value.layout)) && children !== undefined; if (ok && children !== undefined) childNodes(children, registry, depth); return ok }
  if (type === 'metric') return visibleWhenOk && keys(value, ['id', 'type', 'label', 'value', 'detail', 'tone', 'visibleWhen']) && text(value.label, 160) && text(value.value, 160) && (value.detail === undefined || text(value.detail, 300)) && (value.tone === undefined || ['neutral', 'positive', 'warning', 'danger'].includes(String(value.tone)))
  if (type === 'badge') return visibleWhenOk && keys(value, ['id', 'type', 'text', 'tone', 'visibleWhen']) && text(value.text, 120) && (value.tone === undefined || ['neutral', 'primary', 'positive', 'warning', 'danger'].includes(String(value.tone)))
  if (type === 'alert') return visibleWhenOk && keys(value, ['id', 'type', 'title', 'detail', 'tone', 'visibleWhen']) && text(value.title, 160) && (value.detail === undefined || text(value.detail, 600)) && (value.tone === undefined || ['info', 'positive', 'warning', 'danger'].includes(String(value.tone)))
  if (type === 'progress') return visibleWhenOk && keys(value, ['id', 'type', 'label', 'value', 'detail', 'tone', 'visibleWhen']) && text(value.label, 160) && numberIn(value.value, 0, 100) && (value.detail === undefined || text(value.detail, 300)) && (value.tone === undefined || ['primary', 'positive', 'warning', 'danger'].includes(String(value.tone)))
  if (type === 'chart') return visibleWhenOk && keys(value, ['id', 'type', 'label', 'bars', 'visibleWhen']) && text(value.label, 160) && array(value.bars, 16) && value.bars.length > 0 && value.bars.every(item => object(item) && keys(item, ['label', 'value']) && text(item.label, 120) && numberIn(item.value, 0, 1_000_000_000))
  if (type === 'table') { if (!visibleWhenOk || !keys(value, ['id', 'type', 'label', 'columns', 'rows', 'visibleWhen']) || (value.label !== undefined && !text(value.label, 160)) || !array(value.columns, 8) || value.columns.length === 0 || !array(value.rows, 40)) return false; const columnKeys = new Set<string>(); for (const column of value.columns) { if (!object(column) || !keys(column, ['key', 'label']) || !id(column.key) || columnKeys.has(column.key) || !text(column.label, 120)) { registry.errors.push('表格列无效或重复。'); continue }; columnKeys.add(column.key as string) }; for (const row of value.rows) { if (!object(row) || !keys(row, ['id', 'values', 'action']) || !addId(registry, row.id, '表格行') || !array(row.values, 8) || row.values.length !== value.columns.length || !row.values.every(item => text(item, 500))) { registry.errors.push('表格行无效或与列数不一致。'); continue }; if (row.action !== undefined) parseAction(row.action, { kind: 'table-row', id: row.id as string }, registry) }; return true }
  if (type === 'list') { if (!visibleWhenOk || !keys(value, ['id', 'type', 'label', 'items', 'visibleWhen']) || (value.label !== undefined && !text(value.label, 160)) || !array(value.items, 40)) return false; for (const item of value.items) { if (!object(item) || !keys(item, ['id', 'title', 'detail', 'action']) || !addId(registry, item.id, '列表项') || !text(item.title, 200) || (item.detail !== undefined && !text(item.detail, 600))) { registry.errors.push('列表项无效。'); continue }; if (item.action !== undefined) parseAction(item.action, { kind: 'list-item', id: item.id as string }, registry) }; return true }
  if (type === 'tabs') { if (!visibleWhenOk || !keys(value, ['id', 'type', 'label', 'tabs', 'visibleWhen']) || (value.label !== undefined && !text(value.label, 160)) || !array(value.tabs, 8) || value.tabs.length === 0) return false; const tabIds = new Set<string>(); registry.tabs.set(value.id as string, tabIds); for (const tab of value.tabs) { if (!object(tab) || !keys(tab, ['id', 'label', 'children', 'action']) || !addId(registry, tab.id, 'Tab') || !text(tab.label, 80) || !array(tab.children, 40)) { registry.errors.push('Tab 无效。'); continue }; tabIds.add(tab.id as string); if (tab.action !== undefined) parseAction(tab.action, { kind: 'tab', id: tab.id as string, tabParentId: value.id as string }, registry); childNodes(tab.children, registry, depth) }; return true }
  if (type === 'breadcrumb') { if (!visibleWhenOk || !keys(value, ['id', 'type', 'items', 'visibleWhen']) || !array(value.items, 8) || value.items.length === 0) return false; for (const item of value.items) { if (!object(item) || !keys(item, ['id', 'label', 'targetScreenId']) || !addId(registry, item.id, '面包屑项') || !text(item.label, 80) || (item.targetScreenId !== undefined && !id(item.targetScreenId))) { registry.errors.push('面包屑项无效。'); continue }; if (item.targetScreenId !== undefined) registry.actions.push({ action: { type: 'navigate', targetScreenId: item.targetScreenId as string }, owner: { kind: 'breadcrumb-item', id: item.id as string } }) }; return true }
  if (type === 'empty-state') { const pairedAction = (value.actionLabel === undefined) === (value.action === undefined); const ok = visibleWhenOk && keys(value, ['id', 'type', 'title', 'detail', 'actionLabel', 'action', 'visibleWhen']) && text(value.title, 160) && (value.detail === undefined || text(value.detail, 600)) && (value.actionLabel === undefined || text(value.actionLabel, 120)) && pairedAction; if (value.action !== undefined) parseAction(value.action, { kind: 'empty-state', id: value.id as string }, registry); return ok }
  if (type === 'pagination') { const ok = visibleWhenOk && keys(value, ['id', 'type', 'label', 'pageCount', 'bindStateId', 'visibleWhen']) && (value.label === undefined || text(value.label, 120)) && Number.isInteger(value.pageCount) && numberIn(value.pageCount, 2, 20) && id(value.bindStateId); if (ok) registry.paginations.push(value as unknown as PrototypePaginationNodeV1); return ok }
  return false
}
function validateReferences(registry: Registry): void { for (const condition of registry.conditions) { const variable = registry.stateVariables.get(condition.stateId); if (variable === undefined || !variable.allowedValues.includes(condition.equals)) registry.errors.push('显示条件必须引用已声明的状态和值。') }; for (const input of registry.bindings) { const variable = registry.stateVariables.get(input.bindStateId!); if (variable === undefined) { registry.errors.push('输入框绑定了不存在的状态。'); continue }; if (input.value !== undefined && !variable.allowedValues.includes(input.value)) registry.errors.push('输入框初始值必须属于绑定状态。'); if (input.inputType === 'select' && !input.options?.every(option => variable.allowedValues.includes(option.value))) registry.errors.push('下拉选项必须属于绑定状态。') }; for (const pagination of registry.paginations) { const variable = registry.stateVariables.get(pagination.bindStateId); const pages = Array.from({ length: pagination.pageCount }, (_, index) => String(index + 1)); if (variable === undefined || !pages.every(page => variable.allowedValues.includes(page))) registry.errors.push('分页必须绑定包含全部页码的有限业务状态。') }; for (const { action, owner } of registry.actions) { if ((action.type === 'navigate' || action.type === 'submit-success') && !registry.screens.has(action.targetScreenId!)) registry.errors.push('动作引用了不存在的页面。'); if ((action.type === 'open-modal' || action.type === 'close-modal') && !registry.modals.has(action.targetId!)) registry.errors.push('弹窗动作必须引用 modal。'); if (action.type === 'set-value') { const target = registry.inputs.get(action.targetId!); if (target === undefined || target.inputType === 'checkbox') registry.errors.push('set-value 必须引用非 checkbox input。') }; if (action.type === 'set-state') { const variable = registry.stateVariables.get(action.targetId!); if (variable === undefined || !variable.allowedValues.includes(action.value!)) registry.errors.push('set-state 必须引用已声明状态的允许值。') }; if (action.type === 'toggle') { const target = registry.inputs.get(action.targetId!); if (target?.inputType !== 'checkbox') registry.errors.push('toggle 必须引用 checkbox input。') }; if (action.type === 'set-tab') { const targets = registry.tabs.get(action.targetId!); if (targets === undefined || !targets.has(action.value!) || owner.tabParentId !== action.targetId || owner.id !== action.value) registry.errors.push('set-tab 必须由目标 tabs 内的对应 tab 执行。') } } }

function parseStateVariables(value: unknown, registry: Registry): void {
  if (value === undefined) return
  if (!array(value, MAX_STATE_VARIABLES) || value.length === 0) { registry.errors.push('业务状态必须是有限的非空列表。'); return }
  for (const item of value) {
    if (!object(item) || !keys(item, ['id', 'initialValue', 'allowedValues']) || !id(item.id) || registry.stateVariables.has(item.id) || !text(item.initialValue, 160) || !strings(item.allowedValues, MAX_STATE_ALLOWED_VALUES, 160) || item.allowedValues.length === 0 || new Set(item.allowedValues).size !== item.allowedValues.length || !item.allowedValues.includes(item.initialValue)) { registry.errors.push('业务状态无效、重复或初始值不在允许范围内。'); continue }
    registry.stateVariables.set(item.id, item as unknown as PrototypeStateVariableV1)
  }
}

/** Parse untrusted agent output and resolve every reference only after discovery. */
export function validatePrototypeDocument(value: unknown): ValidationResult<PrototypeDocumentV1> {
  if (!withinDocumentBudget(value)) return fail('原型文档总大小或总文本超过限制。')
  if (!object(value) || !keys(value, ['v', 'id', 'title', 'designSpecId', 'initialScreenId', 'stateVariables', 'shell', 'screens']) || value.v !== 1 || !id(value.id) || !text(value.title, 160) || !id(value.designSpecId) || !id(value.initialScreenId) || !array(value.screens, MAX_SCREENS) || value.screens.length === 0) return fail('原型文档不是受支持的 V1 格式。')
  const registry: Registry = { ids: new Set([value.id]), screens: new Set(), inputs: new Map(), modals: new Set(), tabs: new Map(), stateVariables: new Map(), conditions: [], bindings: [], paginations: [], actions: [], types: new Set(), count: 0, errors: [] }
  parseStateVariables(value.stateVariables, registry)
  for (const screen of value.screens) { if (!object(screen) || !keys(screen, ['id', 'title', 'nodes']) || !addId(registry, screen.id, '页面') || !text(screen.title, 160) || !array(screen.nodes, 80)) { registry.errors.push('页面格式无效。'); continue }; registry.screens.add(screen.id as string); for (const item of screen.nodes) if (!node(item, registry, 0)) registry.errors.push('页面包含不受支持组件或字段。') }
  if (value.shell !== undefined) {
    if (!object(value.shell) || !keys(value.shell, ['productName', 'placement', 'items']) || !text(value.shell.productName, 120) || !['top', 'sidebar'].includes(String(value.shell.placement)) || !array(value.shell.items, 12) || value.shell.items.length === 0) registry.errors.push('产品导航外壳格式无效。')
    else for (const item of value.shell.items) {
      if (!object(item) || !keys(item, ['id', 'label', 'targetScreenId']) || !addId(registry, item.id, '导航项') || !text(item.label, 80) || !id(item.targetScreenId)) { registry.errors.push('产品导航项格式无效。'); continue }
      registry.actions.push({ action: { type: 'navigate', targetScreenId: item.targetScreenId as string }, owner: { kind: 'navigation-item', id: item.id as string } })
    }
  }
  if (!registry.screens.has(value.initialScreenId)) registry.errors.push('初始页面不存在。'); validateReferences(registry)
  if (!registry.actions.some(item => item.action.type !== 'close-modal')) registry.errors.push('原型至少需要一条可演示交互流程，必须能改变页面、弹窗、表单、标签页或业务状态，不能只展示静态文字和图片。')
  if (registry.count < 6 || registry.types.size < 3 || ![...registry.types].some(type => ['card', 'group', 'input', 'metric', 'alert', 'progress', 'chart', 'table', 'tabs', 'list', 'empty-state', 'pagination'].includes(type))) registry.errors.push('原型页面过于简单：至少需要 6 个组件、3 种组件类型，并包含表单、卡片、列表、表格、指标、图表、空状态、分页或标签页等真实业务结构。')
  return registry.errors.length === 0 ? { ok: true, value: value as unknown as PrototypeDocumentV1 } : fail(...registry.errors)
}
export function isIsoDate(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
export function validateReferenceEvidence(value: unknown): ValidationResult<ReferenceEvidenceV1> {
  const tokenKeys = ['colors', 'fonts', 'radius', 'spacing', 'textColors', 'backgroundColors', 'pageBackgroundColors', 'elevatedBackgroundColors', 'borderColors', 'accentColors', 'accentBackgroundColors', 'accentTextColors', 'fontSizes', 'fontWeights', 'lineHeights', 'letterSpacings', 'textStyles', 'borderWidths', 'borderStyles', 'shadows', 'gradients', 'opacities', 'controlHeights', 'motionDurations', 'motionEasings', 'buttonHeights', 'inputHeights', 'contentWidths', 'iconSizes', 'componentKinds', 'componentStates', 'componentSamples', 'layoutPatterns', 'responsiveBreakpoints', 'focusStyles']
  if (!object(value) || !keys(value, ['v', 'id', 'source', 'viewport', 'pageSize', 'captureCoverage', 'observations', 'designTokens', 'fingerprint', 'screenshotFingerprint', 'screenshotDataUrl']) || value.v !== 1 || !id(value.id) || !object(value.source) || !keys(value.source, ['url', 'title', 'capturedAt']) || !text(value.source.url, MAX_URL_LENGTH) || !/^https?:\/\//.test(value.source.url) || !text(value.source.title, 240) || !isIsoDate(value.source.capturedAt) || !object(value.viewport) || !keys(value.viewport, ['width', 'height', 'deviceScaleFactor']) || !numberIn(value.viewport.width, 1, 20_000) || !numberIn(value.viewport.height, 1, 20_000) || !numberIn(value.viewport.deviceScaleFactor, .25, 8) || (value.pageSize !== undefined && (!object(value.pageSize) || !keys(value.pageSize, ['width', 'height', 'sampledBands']) || !numberIn(value.pageSize.width, 1, 100_000) || !numberIn(value.pageSize.height, 1, 1_000_000) || !numberIn(value.pageSize.sampledBands, 1, 12))) || !strings(value.observations, 40, 600) || !object(value.designTokens) || !keys(value.designTokens, tokenKeys) || !strings(value.designTokens.colors, 24, 80) || !value.designTokens.colors.every(item => color.test(item)) || !strings(value.designTokens.fonts, 12, 120) || !strings(value.designTokens.radius, 12, 80) || !strings(value.designTokens.spacing, 16, 80)) return fail('参考网页证据格式无效或超过大小限制。')
  if (value.captureCoverage !== undefined && (!object(value.captureCoverage) || !keys(value.captureCoverage, ['candidateElements', 'inspectedElements', 'sampledElements', 'accessibleStylesheets', 'opaqueStylesheets', 'iframeElements', 'unloadedImages', 'horizontalOverflow', 'limitations']) || !integerIn(value.captureCoverage.candidateElements, 1, 1_000_000) || !integerIn(value.captureCoverage.inspectedElements, 1, 6_000) || value.captureCoverage.inspectedElements > value.captureCoverage.candidateElements || !integerIn(value.captureCoverage.sampledElements, 1, 240) || value.captureCoverage.sampledElements > value.captureCoverage.inspectedElements || !integerIn(value.captureCoverage.accessibleStylesheets, 0, 200) || !integerIn(value.captureCoverage.opaqueStylesheets, 0, 200) || !integerIn(value.captureCoverage.iframeElements, 0, 10_000) || !integerIn(value.captureCoverage.unloadedImages, 0, 100_000) || typeof value.captureCoverage.horizontalOverflow !== 'boolean' || !strings(value.captureCoverage.limitations, 12, 240))) return fail('参考网页采集覆盖信息无效。')
  for (const key of ['textColors', 'backgroundColors', 'pageBackgroundColors', 'elevatedBackgroundColors', 'borderColors', 'accentColors', 'accentBackgroundColors', 'accentTextColors'] as const) { const list = value.designTokens[key]; if (list !== undefined && (!strings(list, 24, 80) || !list.every(item => color.test(item)))) return fail('参考网页颜色规范无效。') }
  for (const key of ['fontSizes', 'lineHeights', 'borderWidths', 'controlHeights', 'buttonHeights', 'inputHeights', 'contentWidths', 'iconSizes'] as const) { const list = value.designTokens[key]; if (list !== undefined && (!strings(list, 20, 80) || !list.every(item => item === 'normal' || cssSize.test(item)))) return fail('参考网页尺寸规范无效。') }
  if (value.designTokens.letterSpacings !== undefined && (!strings(value.designTokens.letterSpacings, 20, 80) || !value.designTokens.letterSpacings.every(item => item === 'normal' || /^-?\d+(?:\.\d+)?(?:px|rem|em)$/.test(item)))) return fail('参考网页字距规范无效。')
  if (value.designTokens.textStyles !== undefined && (!array(value.designTokens.textStyles, 20) || !value.designTokens.textStyles.every(item => object(item) && keys(item, ['kind', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']) && ['heading', 'body', 'caption'].includes(String(item.kind)) && cssSize.test(String(item.fontSize)) && text(item.fontWeight, 20) && (item.lineHeight === 'normal' || cssSize.test(String(item.lineHeight))) && (item.letterSpacing === 'normal' || /^-?\d+(?:\.\d+)?(?:px|rem|em)$/.test(String(item.letterSpacing)))))) return fail('参考网页排版组合无效。')
  for (const key of ['fontWeights', 'radius', 'spacing', 'opacities', 'motionDurations', 'motionEasings'] as const) { const list = value.designTokens[key]; if (list !== undefined && !strings(list, 20, 120)) return fail('参考网页设计 token 无效。') }
  if (value.designTokens.borderStyles !== undefined && (!strings(value.designTokens.borderStyles, 8, 20) || !value.designTokens.borderStyles.every(item => ['solid', 'dashed', 'dotted', 'double', 'none'].includes(item)))) return fail('参考网页边框样式无效。')
  for (const key of ['componentKinds', 'componentStates'] as const) { const list = value.designTokens[key]; if (list !== undefined && !strings(list, 32, 120)) return fail('参考网页组件规范无效。') }
  if (value.designTokens.componentSamples !== undefined && (!array(value.designTokens.componentSamples, 20) || !value.designTokens.componentSamples.every(item => object(item) && keys(item, ['kind', 'count', 'exampleText', 'states', 'width', 'height', 'color', 'backgroundColor', 'backgroundImage', 'borderColor', 'borderRadius', 'borderWidth', 'boxShadow', 'disabledOpacity', 'transitionDuration', 'transitionTimingFunction']) && text(item.kind, 60) && numberIn(item.count, 1, 240) && (item.exampleText === undefined || text(item.exampleText, 120)) && strings(item.states, 8, 40) && numberIn(item.width, 1, 20_000) && numberIn(item.height, 1, 20_000) && color.test(String(item.color)) && color.test(String(item.backgroundColor)) && (item.backgroundImage === undefined || safeCssText(String(item.backgroundImage))) && color.test(String(item.borderColor)) && safeCssText(String(item.borderRadius)) && safeCssText(String(item.borderWidth)) && safeCssText(String(item.boxShadow)) && (item.disabledOpacity === undefined || /^\d*(?:\.\d+)?$/.test(String(item.disabledOpacity))) && (item.transitionDuration === undefined || safeCssText(String(item.transitionDuration), 80)) && (item.transitionTimingFunction === undefined || safeCssText(String(item.transitionTimingFunction), 120))))) return fail('参考网页组件样本无效。')
  if (value.designTokens.layoutPatterns !== undefined && (!array(value.designTokens.layoutPatterns, 8) || !value.designTokens.layoutPatterns.every(item => ['block', 'flex-row', 'flex-column', 'grid', 'sticky'].includes(String(item))))) return fail('参考网页布局模式无效。')
  if (value.designTokens.responsiveBreakpoints !== undefined && (!array(value.designTokens.responsiveBreakpoints, 12) || !value.designTokens.responsiveBreakpoints.every(item => numberIn(item, 240, 7_680)))) return fail('参考网页响应式断点无效。')
  if (value.designTokens.focusStyles !== undefined && (!array(value.designTokens.focusStyles, 8) || !value.designTokens.focusStyles.every(item => object(item) && keys(item, ['width', 'style', 'color', 'offset']) && cssSize.test(String(item.width)) && ['solid', 'dashed', 'dotted'].includes(String(item.style)) && color.test(String(item.color)) && /^-?\d+(?:\.\d+)?px$/.test(String(item.offset))))) return fail('参考网页焦点样式无效。')
  for (const key of ['shadows', 'gradients'] as const) { const list = value.designTokens[key]; if (list !== undefined && (!strings(list, 12, 320) || !list.every(item => safeCssText(item)))) return fail('参考网页效果规范无效。') }
  if (!text(value.fingerprint, 64) || !hash.test(value.fingerprint) || (value.screenshotFingerprint !== undefined && (!text(value.screenshotFingerprint, 64) || !hash.test(value.screenshotFingerprint))) || (value.screenshotDataUrl !== undefined && (!text(value.screenshotDataUrl, 2_000_000) || !/^data:image\/(png|jpeg);base64,/.test(value.screenshotDataUrl)))) return fail('参考网页证据格式无效或超过大小限制。')
  return { ok: true, value: value as unknown as ReferenceEvidenceV1 }
}
function validDesignEffects(value: unknown): boolean {
  if (!object(value) || !keys(value, ['shadows', 'gradients', 'opacities', 'semantic']) || !strings(value.shadows, 12, 320) || !value.shadows.every(item => safeCssText(item)) || !strings(value.gradients, 12, 320) || !value.gradients.every(item => safeCssText(item)) || !array(value.opacities, 12) || !value.opacities.every(item => numberIn(item, 0, 1))) return false
  if (value.semantic === undefined) return true
  if (!object(value.semantic) || !keys(value.semantic, ['primaryControlGradient', 'surfaceShadow', 'elevatedShadow', 'disabledControlOpacity'])) return false
  const primaryControlGradient = value.semantic.primaryControlGradient
  const surfaceShadow = value.semantic.surfaceShadow
  const elevatedShadow = value.semantic.elevatedShadow
  const disabledControlOpacity = value.semantic.disabledControlOpacity
  return (primaryControlGradient === undefined || (typeof primaryControlGradient === 'string' && safeCssText(primaryControlGradient) && value.gradients.includes(primaryControlGradient)))
    && (surfaceShadow === undefined || (typeof surfaceShadow === 'string' && safeCssText(surfaceShadow) && value.shadows.includes(surfaceShadow)))
    && (elevatedShadow === undefined || (typeof elevatedShadow === 'string' && safeCssText(elevatedShadow) && value.shadows.includes(elevatedShadow)))
    && (disabledControlOpacity === undefined || (numberIn(disabledControlOpacity, 0, 1) && value.opacities.includes(disabledControlOpacity)))
}
function validDesignMotion(value: unknown): boolean {
  if (!object(value) || !keys(value, ['durations', 'easings', 'semantic']) || !strings(value.durations, 12, 40) || !value.durations.every(item => cssDuration.test(item)) || !strings(value.easings, 12, 120) || !value.easings.every(item => safeCssText(item))) return false
  if (value.semantic === undefined) return true
  if (!object(value.semantic) || !keys(value.semantic, ['controlDuration', 'controlEasing'])) return false
  const controlDuration = value.semantic.controlDuration
  const controlEasing = value.semantic.controlEasing
  return (controlDuration === undefined || (typeof controlDuration === 'string' && value.durations.includes(controlDuration)))
    && (controlEasing === undefined || (typeof controlEasing === 'string' && safeCssText(controlEasing) && value.easings.includes(controlEasing)))
}
export function validateDesignSpec(value: unknown, authorizedEvidenceIds: readonly string[]): ValidationResult<DesignSpecV1> {
  if (authorizedEvidenceIds.length === 0 || new Set(authorizedEvidenceIds).size !== authorizedEvidenceIds.length || !authorizedEvidenceIds.every(id)) return fail('设计规范必须有非空、去重的已授权参考证据。')
  if (!object(value) || !keys(value, ['v', 'id', 'name', 'basedOnEvidenceIds', 'summary', 'colors', 'typography', 'spacing', 'surfaces', 'borders', 'effects', 'controls', 'motion', 'focus', 'responsive', 'principles']) || value.v !== 1 || !id(value.id) || !text(value.name, 120) || !strings(value.basedOnEvidenceIds, MAX_REFERENCE_EVIDENCE, 80) || value.basedOnEvidenceIds.length === 0 || new Set(value.basedOnEvidenceIds).size !== value.basedOnEvidenceIds.length || !value.basedOnEvidenceIds.every(item => id(item) && authorizedEvidenceIds.includes(item)) || !text(value.summary, 1_200) || !array(value.colors, 16) || value.colors.length === 0 || !value.colors.every(item => object(item) && keys(item, ['name', 'value', 'usage']) && text(item.name, 80) && text(item.value, 80) && color.test(item.value) && text(item.usage, 240))) return fail('设计规范的来源或颜色无效。')
  if (!object(value.typography) || !keys(value.typography, ['fontFamily', 'headingWeight', 'bodyWeight', 'bodySize', 'headingSize', 'captionSize', 'fontSizeScale', 'fontWeightScale', 'lineHeightScale', 'bodyLineHeight', 'headingLineHeight', 'letterSpacing']) || !text(value.typography.fontFamily, 160) || !numberIn(value.typography.headingWeight, 100, 1_000) || (value.typography.bodyWeight !== undefined && !numberIn(value.typography.bodyWeight, 100, 1_000)) || !numberIn(value.typography.bodySize, 8, 96) || (value.typography.headingSize !== undefined && !numberIn(value.typography.headingSize, 10, 160)) || (value.typography.captionSize !== undefined && !numberIn(value.typography.captionSize, 8, 48)) || (value.typography.fontSizeScale !== undefined && (!array(value.typography.fontSizeScale, 20) || !value.typography.fontSizeScale.every(item => numberIn(item, 8, 160)))) || (value.typography.fontWeightScale !== undefined && (!array(value.typography.fontWeightScale, 12) || !value.typography.fontWeightScale.every(item => numberIn(item, 100, 1_000)))) || (value.typography.lineHeightScale !== undefined && (!array(value.typography.lineHeightScale, 20) || !value.typography.lineHeightScale.every(item => numberIn(item, 8, 240)))) || (value.typography.bodyLineHeight !== undefined && !numberIn(value.typography.bodyLineHeight, .8, 3)) || (value.typography.headingLineHeight !== undefined && !numberIn(value.typography.headingLineHeight, .8, 3)) || (value.typography.letterSpacing !== undefined && !numberIn(value.typography.letterSpacing, -5, 20))) return fail('设计规范的排版系统无效。')
  if (!object(value.spacing) || !keys(value.spacing, ['base', 'cardRadius', 'scale', 'sectionGap', 'contentWidth']) || !numberIn(value.spacing.base, 0, 64) || !numberIn(value.spacing.cardRadius, 0, 80) || (value.spacing.scale !== undefined && (!array(value.spacing.scale, 16) || !value.spacing.scale.every(item => numberIn(item, 0, 160)))) || (value.spacing.sectionGap !== undefined && !numberIn(value.spacing.sectionGap, 0, 240)) || (value.spacing.contentWidth !== undefined && !numberIn(value.spacing.contentWidth, 240, 3_840))) return fail('设计规范的间距系统无效。')
  if (value.surfaces !== undefined && (!object(value.surfaces) || !keys(value.surfaces, ['page', 'surface', 'elevated', 'text', 'textMuted', 'border']) || !Object.values(value.surfaces).every(item => typeof item === 'string' && color.test(item)))) return fail('设计规范的表面颜色无效。')
  if (value.borders !== undefined && (!object(value.borders) || !keys(value.borders, ['width', 'style', 'radiusScale']) || !numberIn(value.borders.width, 0, 16) || !['solid', 'dashed', 'dotted'].includes(String(value.borders.style)) || !array(value.borders.radiusScale, 12) || !value.borders.radiusScale.every(item => numberIn(item, 0, 160)))) return fail('设计规范的边框系统无效。')
  if (value.effects !== undefined && !validDesignEffects(value.effects)) return fail('设计规范的视觉效果无效。')
  if (value.controls !== undefined && (!object(value.controls) || !keys(value.controls, ['height', 'buttonHeight', 'inputHeight', 'iconSize', 'radius']) || !numberIn(value.controls.height, 20, 120) || (value.controls.buttonHeight !== undefined && !numberIn(value.controls.buttonHeight, 20, 120)) || !numberIn(value.controls.inputHeight, 20, 240) || (value.controls.iconSize !== undefined && !numberIn(value.controls.iconSize, 4, 160)) || !numberIn(value.controls.radius, 0, 80))) return fail('设计规范的控件尺寸无效。')
  if (value.motion !== undefined && !validDesignMotion(value.motion)) return fail('设计规范的动效系统无效。')
  if (value.focus !== undefined && (!object(value.focus) || !keys(value.focus, ['width', 'style', 'color', 'offset']) || !numberIn(value.focus.width, 0, 12) || !['solid', 'dashed', 'dotted'].includes(String(value.focus.style)) || typeof value.focus.color !== 'string' || !color.test(value.focus.color) || !numberIn(value.focus.offset, -8, 16))) return fail('设计规范的键盘焦点样式无效。')
  if (value.responsive !== undefined && (!object(value.responsive) || !keys(value.responsive, ['breakpoints', 'layoutPatterns']) || !array(value.responsive.breakpoints, 12) || !value.responsive.breakpoints.every(item => numberIn(item, 240, 7_680)) || !array(value.responsive.layoutPatterns, 8) || !value.responsive.layoutPatterns.every(item => ['block', 'flex-row', 'flex-column', 'grid', 'sticky'].includes(String(item))))) return fail('设计规范的响应式布局无效。')
  if (!strings(value.principles, 12, 240)) return fail('设计原则无效。')
  return { ok: true, value: value as unknown as DesignSpecV1 }
}
export function validatePrototypeBundle(value: unknown): ValidationResult<PrototypeBundleV1> { if (!object(value) || !keys(value, ['evidence', 'designSpec', 'document']) || !array(value.evidence, MAX_REFERENCE_EVIDENCE) || value.evidence.length === 0) return fail('原型必须带已授权参考证据和设计规范。'); const evidence: ReferenceEvidenceV1[] = []; for (const item of value.evidence) { const checked = validateReferenceEvidence(item); if (!checked.ok) return checked; evidence.push(checked.value) }; if (new Set(evidence.map(item => item.id)).size !== evidence.length) return fail('参考证据 id 重复。'); const designSpec = validateDesignSpec(value.designSpec, evidence.map(item => item.id)); if (!designSpec.ok) return designSpec; const document = validatePrototypeDocument(value.document); if (!document.ok) return document; if (document.value.designSpecId !== designSpec.value.id) return fail('原型 document.designSpecId 必须匹配当前设计规范。'); return { ok: true, value: { evidence, designSpec: designSpec.value, document: document.value } } }
export interface PrototypeDesignTokens { primary: string; onPrimary: string; info: string; onInfo: string; positive: string; onPositive: string; warning: string; onWarning: string; danger: string; onDanger: string; page: string; surface: string; elevated: string; text: string; textMuted: string; border: string; borderWidth: string; borderStyle: 'solid' | 'dashed' | 'dotted'; radius: string; radiusSmall: string; radiusLarge: string; controlRadius: string; font: string; bodySize: string; bodyWeight: number; bodyLineHeight: number; headingSize: string; headingLineHeight: number; headingWeight: number; captionSize: string; letterSpacing: string; spaceSmall: string; spaceMedium: string; spaceLarge: string; sectionGap: string; contentWidth: string; shadow: string; gradient: string; surfaceShadow: string; elevatedShadow: string; primaryControlGradient: string; disabledOpacity: number; controlHeight: string; inputHeight: string; iconSize: string; motionDuration: string; motionEasing: string; focusWidth: string; focusStyle: 'solid' | 'dashed' | 'dotted'; focusColor: string; focusOffset: string; compactBreakpoint: number }
function readableTextColor(background: string): '#111111' | '#ffffff' {
  const hex = background.match(/^#([0-9a-f]{6})/i)?.[1]
  const rgb = background.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i)
  const channels = hex === undefined ? rgb?.slice(1, 4).map(Number) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(item => Number.parseInt(item, 16))
  if (channels === undefined || channels.length !== 3 || channels.some(item => !Number.isFinite(item))) return '#ffffff'
  const linear = channels.map(channel => { const normalized = Math.min(255, Math.max(0, channel!)) / 255; return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  const luminance = linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#111111' : '#ffffff'
}
export function prototypeDesignTokens(spec: DesignSpecV1): PrototypeDesignTokens {
  const allowedFonts = new Set(['system-ui', 'ui-sans-serif', 'sans-serif', '-apple-system', 'BlinkMacSystemFont', 'Arial', 'Helvetica', 'Helvetica Neue', 'Inter', 'Mona Sans VF', 'Roboto', 'Segoe UI', 'Noto Sans', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Microsoft JhengHei'])
  const scale = spec.spacing.scale ?? [spec.spacing.base / 2, spec.spacing.base, spec.spacing.base * 2, spec.spacing.base * 3]
  const radiusScale = spec.borders?.radiusScale ?? [Math.max(0, spec.spacing.cardRadius / 2), spec.spacing.cardRadius, spec.spacing.cardRadius * 1.5]
  const primary = spec.colors[0]?.value ?? '#2563eb'
  const info = spec.colors.find(item => /信息色|info/i.test(item.name))?.value ?? primary
  const positive = spec.colors.find(item => /成功色|positive|success/i.test(item.name))?.value ?? '#16805c'
  const warning = spec.colors.find(item => /警告色|warning/i.test(item.name))?.value ?? '#8a5b08'
  const danger = spec.colors.find(item => /危险色|danger|error/i.test(item.name))?.value ?? '#c2413b'
  const disabledOpacity = spec.effects?.semantic?.disabledControlOpacity ?? .5
  const compactBreakpoint = spec.responsive?.breakpoints.find(value => value >= 480) ?? 760
  return {
    primary, onPrimary: spec.colors.find(item => /按钮文字|on.?primary/i.test(item.name))?.value ?? readableTextColor(primary), info, onInfo: readableTextColor(info), positive, onPositive: readableTextColor(positive), warning, onWarning: readableTextColor(warning), danger, onDanger: readableTextColor(danger),
    page: spec.surfaces?.page ?? '#f7f8fc', surface: spec.surfaces?.surface ?? spec.colors[1]?.value ?? '#ffffff', elevated: spec.surfaces?.elevated ?? spec.surfaces?.surface ?? '#ffffff', text: spec.surfaces?.text ?? '#172033', textMuted: spec.surfaces?.textMuted ?? '#64748b', border: spec.surfaces?.border ?? '#e2e8f0', borderWidth: `${spec.borders?.width ?? 1}px`, borderStyle: spec.borders?.style ?? 'solid',
    radius: `${spec.spacing.cardRadius}px`, radiusSmall: `${radiusScale[0] ?? spec.spacing.cardRadius}px`, radiusLarge: `${radiusScale.at(-1) ?? spec.spacing.cardRadius}px`, controlRadius: `${spec.controls?.radius ?? spec.spacing.cardRadius}px`, font: allowedFonts.has(spec.typography.fontFamily) ? spec.typography.fontFamily : 'system-ui', bodySize: `${spec.typography.bodySize}px`, bodyWeight: spec.typography.bodyWeight ?? 400, bodyLineHeight: spec.typography.bodyLineHeight ?? 1.5, headingSize: `${spec.typography.headingSize ?? spec.typography.fontSizeScale?.at(-1) ?? Math.round(spec.typography.bodySize * 2)}px`, headingLineHeight: spec.typography.headingLineHeight ?? 1.15, headingWeight: spec.typography.headingWeight, captionSize: `${spec.typography.captionSize ?? spec.typography.fontSizeScale?.[0] ?? Math.max(10, spec.typography.bodySize - 2)}px`, letterSpacing: `${spec.typography.letterSpacing ?? 0}px`,
    spaceSmall: `${scale[1] ?? spec.spacing.base}px`, spaceMedium: `${scale[2] ?? spec.spacing.base * 2}px`, spaceLarge: `${scale[3] ?? spec.spacing.base * 3}px`, sectionGap: `${spec.spacing.sectionGap ?? scale.at(-1) ?? spec.spacing.base * 3}px`, contentWidth: `${spec.spacing.contentWidth ?? 680}px`, shadow: spec.effects?.semantic?.surfaceShadow ?? (spec.effects === undefined ? '0 1px 2px rgba(15,23,42,.08)' : 'none'), gradient: spec.effects?.semantic?.primaryControlGradient ?? 'none', surfaceShadow: spec.effects?.semantic?.surfaceShadow ?? (spec.effects === undefined ? '0 1px 2px rgba(15,23,42,.08)' : 'none'), elevatedShadow: spec.effects?.semantic?.elevatedShadow ?? (spec.effects === undefined ? '0 22px 60px rgba(15,23,42,.25)' : 'none'), primaryControlGradient: spec.effects?.semantic?.primaryControlGradient ?? 'none', disabledOpacity, controlHeight: `${spec.controls?.buttonHeight ?? spec.controls?.height ?? 38}px`, inputHeight: `${spec.controls?.inputHeight ?? 38}px`, iconSize: `${spec.controls?.iconSize ?? 16}px`, motionDuration: spec.motion?.semantic?.controlDuration ?? '160ms', motionEasing: spec.motion?.semantic?.controlEasing ?? 'ease-out', focusWidth: `${spec.focus?.width ?? 2}px`, focusStyle: spec.focus?.style ?? 'solid', focusColor: spec.focus?.color ?? primary, focusOffset: `${spec.focus?.offset ?? 2}px`, compactBreakpoint,
  }
}
export function collectPrototypeElementIds(document: PrototypeDocumentV1): Set<string> { const result = new Set<string>(); const visit = (node: PrototypeNodeV1) => { result.add(node.id); if (node.type === 'card' || node.type === 'group' || node.type === 'modal') node.children.forEach(visit); if (node.type === 'list') node.items.forEach(item => result.add(item.id)); if (node.type === 'table') node.rows.forEach(row => result.add(row.id)); if (node.type === 'tabs') node.tabs.forEach(tab => { result.add(tab.id); tab.children.forEach(visit) }); if (node.type === 'breadcrumb') node.items.forEach(item => result.add(item.id)) }; document.shell?.items.forEach(item => result.add(item.id)); document.screens.forEach(screen => screen.nodes.forEach(visit)); return result }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value }
export function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)) }
export async function sha256Fingerprint(value: unknown): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
type ReferenceEvidenceFingerprintInput = Pick<ReferenceEvidenceV1, 'source' | 'viewport' | 'observations' | 'designTokens'> & Partial<Pick<ReferenceEvidenceV1, 'pageSize' | 'captureCoverage' | 'screenshotFingerprint'>>
/** Mirrors the trusted capture projection; agents cannot substitute this calculation. */
export async function computeReferenceEvidenceFingerprint(evidence: ReferenceEvidenceFingerprintInput): Promise<string> { const content = { v: 1, source: { url: evidence.source.url, title: evidence.source.title }, viewport: evidence.viewport, ...(evidence.pageSize === undefined ? {} : { pageSize: evidence.pageSize }), ...(evidence.captureCoverage === undefined ? {} : { captureCoverage: evidence.captureCoverage }), observations: evidence.observations, designTokens: evidence.designTokens, ...(evidence.screenshotFingerprint === undefined ? {} : { screenshotFingerprint: evidence.screenshotFingerprint }) }; return sha256Fingerprint(content) }
export async function verifyReferenceEvidenceFingerprint(evidence: ReferenceEvidenceV1): Promise<boolean> { return (await computeReferenceEvidenceFingerprint(evidence)) === evidence.fingerprint }
export interface CreateTrustedRevisionInput { id: string; parentRevisionId?: string; author: 'agent' | 'user'; document: unknown; designSpec: unknown; evidence: readonly unknown[]; changeSummary: string; createdAt?: string }
export async function createTrustedRevision(input: CreateTrustedRevisionInput): Promise<ValidationResult<PrototypeRevisionV1>> { const bundle = validatePrototypeBundle({ evidence: [...input.evidence], designSpec: input.designSpec, document: input.document }); if (!bundle.ok) return fail(...bundle.errors); if (!id(input.id) || (input.parentRevisionId !== undefined && !id(input.parentRevisionId)) || !['agent', 'user'].includes(input.author) || !text(input.changeSummary, 600)) return fail('版本 id、作者或变更摘要无效。'); if (!(await Promise.all(bundle.value.evidence.map(verifyReferenceEvidenceFingerprint))).every(Boolean)) return fail('参考证据指纹未通过可信计算。'); const createdAt = input.createdAt ?? new Date().toISOString(); if (!isIsoDate(createdAt)) return fail('版本创建时间必须是 ISO UTC 时间。'); return { ok: true, value: { v: 1, id: input.id, prototypeId: bundle.value.document.id, ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }), createdAt, author: input.author, document: bundle.value.document, documentFingerprint: await sha256Fingerprint(bundle.value.document), referenceEvidenceFingerprints: bundle.value.evidence.map(item => item.fingerprint), designSpecFingerprint: await sha256Fingerprint(bundle.value.designSpec), changeSummary: input.changeSummary } } }
export function validatePrototypeRevision(value: unknown): ValidationResult<PrototypeRevisionV1> { if (!object(value) || !keys(value, ['v', 'id', 'prototypeId', 'parentRevisionId', 'createdAt', 'author', 'document', 'documentFingerprint', 'referenceEvidenceFingerprints', 'designSpecFingerprint', 'changeSummary']) || value.v !== 1 || !id(value.id) || !id(value.prototypeId) || (value.parentRevisionId !== undefined && !id(value.parentRevisionId)) || !isIsoDate(value.createdAt) || !['agent', 'user'].includes(String(value.author)) || !text(value.documentFingerprint, 64) || !hash.test(value.documentFingerprint) || !strings(value.referenceEvidenceFingerprints, MAX_REFERENCE_EVIDENCE, 64) || value.referenceEvidenceFingerprints.length === 0 || !value.referenceEvidenceFingerprints.every(item => hash.test(item)) || !text(value.designSpecFingerprint, 64) || !hash.test(value.designSpecFingerprint) || !text(value.changeSummary, 600)) return fail('原型版本格式无效。'); const document = validatePrototypeDocument(value.document); if (!document.ok || document.value.id !== value.prototypeId) return fail('原型版本必须保存同一个已校验原型文档。'); return { ok: true, value: value as unknown as PrototypeRevisionV1 } }
export async function verifyTrustedRevision(revision: unknown, designSpec: unknown, evidence: readonly unknown[]): Promise<boolean> { const checked = validatePrototypeRevision(revision); if (!checked.ok) return false; const bundle = validatePrototypeBundle({ evidence: [...evidence], designSpec, document: checked.value.document }); if (!bundle.ok || !(await Promise.all(bundle.value.evidence.map(verifyReferenceEvidenceFingerprint))).every(Boolean)) return false; return checked.value.documentFingerprint === await sha256Fingerprint(bundle.value.document) && checked.value.designSpecFingerprint === await sha256Fingerprint(bundle.value.designSpec) && canonicalJson(checked.value.referenceEvidenceFingerprints) === canonicalJson(bundle.value.evidence.map(item => item.fingerprint)) }
