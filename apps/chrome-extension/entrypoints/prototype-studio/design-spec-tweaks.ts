import type { DesignSpecV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'

export type DesignSpecColorKey = 'primary' | 'onPrimary' | 'page' | 'surface' | 'elevated' | 'text' | 'textMuted' | 'border' | 'info' | 'positive' | 'warning' | 'danger' | 'focus'
export type DesignSpecChangeGroup = 'colors' | 'typography' | 'layout' | 'borders' | 'effects' | 'controls' | 'focus' | 'responsive' | 'motion'
export type DesignSpecTweak =
  | { key: DesignSpecColorKey; value: string }
  | { key: 'fontFamily'; value: string }
  | { key: 'bodySize' | 'headingSize' | 'captionSize'; value: number }
  | { key: 'bodyWeight' | 'headingWeight'; value: number }
  | { key: 'bodyLineHeight' | 'headingLineHeight' | 'letterSpacing'; value: number }
  | { key: 'spacingBase' | 'sectionGap' | 'contentWidth' | 'cardRadius' | 'controlRadius'; value: number }
  | { key: 'borderWidth'; value: number }
  | { key: 'borderStyle'; value: 'solid' | 'dashed' | 'dotted' }
  | { key: 'controlHeight' | 'inputHeight' | 'iconSize'; value: number }
  | { key: 'focusWidth' | 'focusOffset'; value: number }
  | { key: 'focusStyle'; value: 'solid' | 'dashed' | 'dotted' }
  | { key: 'shadowEnabled' | 'elevatedShadowEnabled' | 'gradientEnabled'; value: boolean }
  | { key: 'effectOpacity'; value: number }
  | { key: 'motionDuration'; value: number }
  | { key: 'motionEasing'; value: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' }
  | { key: 'mobileBreakpoint' | 'desktopBreakpoint'; value: number }
  | { key: 'rawColor'; index: number; value: string }
  | { key: 'fontSizeScale' | 'fontWeightScale' | 'lineHeightScale' | 'spacingScale' | 'radiusScale' | 'opacityScale'; value: number[] }
  | { key: 'surfaceShadow' | 'elevatedShadow' | 'primaryGradient'; value: string | undefined }
  | { key: 'layoutPatterns'; value: Array<'block' | 'flex-row' | 'flex-column' | 'grid' | 'sticky'> }

const colorPattern = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,60}\))$/

function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum
}

function color(spec: DesignSpecV1, name: string, fallback: string): string {
  return spec.colors.find(item => item.name === name)?.value ?? fallback
}

function replaceColor(spec: DesignSpecV1, name: string, value: string): DesignSpecV1['colors'] {
  return spec.colors.map(item => item.name === name ? { ...item, value } : item)
}

function scaleWith(values: readonly number[] | undefined, value: number, maximum: number): number[] {
  return [...new Set([...(values ?? []), value].map(item => bounded(item, 0, maximum)))].sort((left, right) => left - right).slice(0, 20)
}

function numericScale(values: unknown, minimum: number, maximum: number, count: number): number[] | undefined {
  if (!Array.isArray(values) || values.length === 0 || values.length > count || !values.every(item => typeof item === 'number' && Number.isFinite(item))) return undefined
  return [...new Set(values.map(item => bounded(item, minimum, maximum)))].sort((left, right) => left - right)
}

function semanticEffect(spec: DesignSpecV1, role: 'surfaceShadow' | 'elevatedShadow' | 'primaryControlGradient', value: string | undefined): DesignSpecV1 {
  const effects = spec.effects ?? { shadows: [], gradients: [], opacities: [] }
  const allowed = role === 'primaryControlGradient' ? effects.gradients : effects.shadows
  if (value !== undefined && !allowed.includes(value)) return spec
  const semantic = { ...effects.semantic, [role]: value }
  return { ...spec, effects: { ...effects, ...(Object.values(semantic).some(item => item !== undefined) ? { semantic } : {}) } }
}

export function motionDurationMilliseconds(value: string | undefined, fallback = 160): number {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (match === undefined || match === null) return fallback
  const milliseconds = Number(match[1]) * (match[2] === 's' ? 1_000 : 1)
  return Number.isFinite(milliseconds) ? bounded(milliseconds, 0, 10_000) : fallback
}

export function designSpecColor(spec: DesignSpecV1, key: DesignSpecColorKey): string {
  const surfaces = spec.surfaces
  if (key === 'primary') return color(spec, '主要操作色', spec.colors[0]?.value ?? '#3977e8')
  if (key === 'onPrimary') return color(spec, '按钮文字', '#ffffff')
  if (key === 'page') return surfaces?.page ?? color(spec, '页面背景', '#f5f6f8')
  if (key === 'surface') return surfaces?.surface ?? color(spec, '内容表面', '#ffffff')
  if (key === 'elevated') return surfaces?.elevated ?? designSpecColor(spec, 'surface')
  if (key === 'text') return surfaces?.text ?? color(spec, '主要文字', '#283347')
  if (key === 'textMuted') return surfaces?.textMuted ?? color(spec, '次要文字', '#697386')
  if (key === 'border') return surfaces?.border ?? color(spec, '边框颜色', '#e2e5eb')
  if (key === 'info') return color(spec, '信息色', designSpecColor(spec, 'primary'))
  if (key === 'positive') return color(spec, '成功色', '#16805c')
  if (key === 'warning') return color(spec, '警告色', '#8a5b08')
  if (key === 'focus') return spec.focus?.color ?? designSpecColor(spec, 'primary')
  return color(spec, '危险色', '#c2413b')
}

export function colorInputValue(value: string, fallback = '#3977e8'): string {
  const hex = value.match(/^#([0-9a-f]{6})/i)?.[1]
  if (hex !== undefined) return `#${hex.toLowerCase()}`
  const rgb = value.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i)
  if (rgb === null) return fallback
  return `#${rgb.slice(1, 4).map(item => Math.round(bounded(Number(item), 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

export function applyDesignSpecTweak(spec: DesignSpecV1, tweak: DesignSpecTweak): DesignSpecV1 {
  if (['primary', 'onPrimary', 'page', 'surface', 'elevated', 'text', 'textMuted', 'border', 'info', 'positive', 'warning', 'danger', 'focus'].includes(tweak.key)) {
    if (typeof tweak.value !== 'string' || !colorPattern.test(tweak.value)) return spec
    const colorValue = tweak.value
    const key = tweak.key as DesignSpecColorKey
    if (key === 'focus') return { ...spec, focus: { width: spec.focus?.width ?? 2, style: spec.focus?.style ?? 'solid', color: colorValue, offset: spec.focus?.offset ?? 2 } }
    const semanticName = { primary: '主要操作色', onPrimary: '按钮文字', page: '页面背景', surface: '内容表面', elevated: '浮层表面', text: '主要文字', textMuted: '次要文字', border: '边框颜色', info: '信息色', positive: '成功色', warning: '警告色', danger: '危险色' }[key]
    const surfaces = spec.surfaces ?? { page: designSpecColor(spec, 'page'), surface: designSpecColor(spec, 'surface'), elevated: designSpecColor(spec, 'surface'), text: designSpecColor(spec, 'text'), textMuted: designSpecColor(spec, 'textMuted'), border: designSpecColor(spec, 'border') }
    const surfaceKey = ['onPrimary', 'primary', 'info', 'positive', 'warning', 'danger'].includes(key) ? undefined : key as 'page' | 'surface' | 'elevated' | 'text' | 'textMuted' | 'border'
    const colors = semanticName === '浮层表面' && !spec.colors.some(item => item.name === semanticName)
      ? spec.colors
      : key === 'primary' && !spec.colors.some(item => item.name === semanticName)
        ? spec.colors.map((item, index) => index === 0 ? { ...item, value: colorValue } : item)
        : replaceColor(spec, semanticName, colorValue)
    return { ...spec, colors, surfaces: surfaceKey === undefined ? surfaces : { ...surfaces, [surfaceKey]: colorValue } }
  }
  if (tweak.key === 'rawColor') {
    if (!Number.isInteger(tweak.index) || tweak.index < 0 || tweak.index >= spec.colors.length || typeof tweak.value !== 'string' || !colorPattern.test(tweak.value)) return spec
    return { ...spec, colors: spec.colors.map((item, index) => index === tweak.index ? { ...item, value: tweak.value } : item) }
  }
  if (tweak.key === 'fontFamily') return tweak.value.length > 0 && tweak.value.length <= 160 && !/[;{}<>]/.test(tweak.value) ? { ...spec, typography: { ...spec.typography, fontFamily: tweak.value } } : spec
  if (tweak.key === 'bodySize') { const value = bounded(tweak.value, 8, 96); return { ...spec, typography: { ...spec.typography, bodySize: value, fontSizeScale: scaleWith(spec.typography.fontSizeScale, value, 160) } } }
  if (tweak.key === 'headingSize') { const value = bounded(tweak.value, 10, 160); return { ...spec, typography: { ...spec.typography, headingSize: value, fontSizeScale: scaleWith(spec.typography.fontSizeScale, value, 160) } } }
  if (tweak.key === 'captionSize') { const value = bounded(tweak.value, 8, 48); return { ...spec, typography: { ...spec.typography, captionSize: value, fontSizeScale: scaleWith(spec.typography.fontSizeScale, value, 160) } } }
  if (tweak.key === 'bodyWeight') { const value = bounded(tweak.value, 100, 1_000); return { ...spec, typography: { ...spec.typography, bodyWeight: value, fontWeightScale: scaleWith(spec.typography.fontWeightScale, value, 1_000) } } }
  if (tweak.key === 'headingWeight') { const value = bounded(tweak.value, 100, 1_000); return { ...spec, typography: { ...spec.typography, headingWeight: value, fontWeightScale: scaleWith(spec.typography.fontWeightScale, value, 1_000) } } }
  if (tweak.key === 'bodyLineHeight') return { ...spec, typography: { ...spec.typography, bodyLineHeight: bounded(tweak.value, .8, 3) } }
  if (tweak.key === 'headingLineHeight') return { ...spec, typography: { ...spec.typography, headingLineHeight: bounded(tweak.value, .8, 3) } }
  if (tweak.key === 'letterSpacing') return { ...spec, typography: { ...spec.typography, letterSpacing: bounded(tweak.value, -5, 20) } }
  if (tweak.key === 'fontSizeScale') { const values = numericScale(tweak.value, 8, 160, 20); return values === undefined ? spec : { ...spec, typography: { ...spec.typography, fontSizeScale: values } } }
  if (tweak.key === 'fontWeightScale') { const values = numericScale(tweak.value, 100, 1_000, 12); return values === undefined ? spec : { ...spec, typography: { ...spec.typography, fontWeightScale: values } } }
  if (tweak.key === 'lineHeightScale') { const values = numericScale(tweak.value, 8, 240, 20); return values === undefined ? spec : { ...spec, typography: { ...spec.typography, lineHeightScale: values } } }
  if (tweak.key === 'spacingBase') { const value = bounded(tweak.value, 0, 64); return { ...spec, spacing: { ...spec.spacing, base: value, scale: [value / 2, value, value * 2, value * 3].map(item => bounded(item, 0, 160)) } } }
  if (tweak.key === 'spacingScale') { const values = numericScale(tweak.value, 0, 160, 16); return values === undefined ? spec : { ...spec, spacing: { ...spec.spacing, scale: values } } }
  if (tweak.key === 'sectionGap') return { ...spec, spacing: { ...spec.spacing, sectionGap: bounded(tweak.value, 0, 240) } }
  if (tweak.key === 'contentWidth') return { ...spec, spacing: { ...spec.spacing, contentWidth: bounded(tweak.value, 240, 3_840) } }
  if (tweak.key === 'cardRadius') { const value = bounded(tweak.value, 0, 80); return { ...spec, spacing: { ...spec.spacing, cardRadius: value }, borders: { width: spec.borders?.width ?? 1, style: spec.borders?.style ?? 'solid', radiusScale: [value / 2, value, Math.min(80, value * 1.5)] } } }
  if (tweak.key === 'radiusScale') { const values = numericScale(tweak.value, 0, 160, 12); return values === undefined ? spec : { ...spec, borders: { width: spec.borders?.width ?? 1, style: spec.borders?.style ?? 'solid', radiusScale: values } } }
  if (tweak.key === 'controlRadius') { const value = bounded(tweak.value, 0, 80); return { ...spec, controls: { height: spec.controls?.height ?? 38, buttonHeight: spec.controls?.buttonHeight, inputHeight: spec.controls?.inputHeight ?? 38, iconSize: spec.controls?.iconSize ?? 16, radius: value } } }
  if (tweak.key === 'borderWidth') return { ...spec, borders: { width: bounded(tweak.value, 0, 16), style: spec.borders?.style ?? 'solid', radiusScale: spec.borders?.radiusScale ?? [spec.spacing.cardRadius] } }
  if (tweak.key === 'borderStyle') return { ...spec, borders: { width: spec.borders?.width ?? 1, style: tweak.value, radiusScale: spec.borders?.radiusScale ?? [spec.spacing.cardRadius] } }
  if (tweak.key === 'controlHeight') { const value = bounded(tweak.value, 20, 120); return { ...spec, controls: { height: value, buttonHeight: value, inputHeight: spec.controls?.inputHeight ?? value, iconSize: spec.controls?.iconSize ?? 16, radius: spec.controls?.radius ?? spec.spacing.cardRadius } } }
  if (tweak.key === 'inputHeight') { const value = bounded(tweak.value, 20, 240); return { ...spec, controls: { height: spec.controls?.height ?? 38, buttonHeight: spec.controls?.buttonHeight, inputHeight: value, iconSize: spec.controls?.iconSize ?? 16, radius: spec.controls?.radius ?? spec.spacing.cardRadius } } }
  if (tweak.key === 'iconSize') { const value = bounded(tweak.value, 4, 160); return { ...spec, controls: { height: spec.controls?.height ?? 38, buttonHeight: spec.controls?.buttonHeight, inputHeight: spec.controls?.inputHeight ?? 38, iconSize: value, radius: spec.controls?.radius ?? spec.spacing.cardRadius } } }
  if (tweak.key === 'focusWidth') return { ...spec, focus: { width: bounded(tweak.value, 0, 12), style: spec.focus?.style ?? 'solid', color: spec.focus?.color ?? designSpecColor(spec, 'primary'), offset: spec.focus?.offset ?? 2 } }
  if (tweak.key === 'focusOffset') return { ...spec, focus: { width: spec.focus?.width ?? 2, style: spec.focus?.style ?? 'solid', color: spec.focus?.color ?? designSpecColor(spec, 'primary'), offset: bounded(tweak.value, -8, 16) } }
  if (tweak.key === 'focusStyle') return { ...spec, focus: { width: spec.focus?.width ?? 2, style: tweak.value, color: spec.focus?.color ?? designSpecColor(spec, 'primary'), offset: spec.focus?.offset ?? 2 } }
  if (tweak.key === 'shadowEnabled') {
    const effects = spec.effects ?? { shadows: [], gradients: [], opacities: [] }
    const shadows = tweak.value ? effects.shadows.length > 0 ? effects.shadows : ['0 8px 24px rgba(15, 23, 42, 0.12)'] : effects.shadows
    const semantic = { ...effects.semantic, ...(tweak.value ? { surfaceShadow: shadows[0]! } : { surfaceShadow: undefined }) }
    return { ...spec, effects: { ...effects, shadows, ...(Object.values(semantic).some(value => value !== undefined) ? { semantic } : {}) } }
  }
  if (tweak.key === 'elevatedShadowEnabled') {
    const effects = spec.effects ?? { shadows: [], gradients: [], opacities: [] }
    const shadows = tweak.value ? effects.shadows.length > 0 ? effects.shadows : ['0 18px 48px rgba(15, 23, 42, 0.22)'] : effects.shadows
    const selected = shadows[1] ?? shadows[0]
    const semantic = { ...effects.semantic, ...(tweak.value ? { elevatedShadow: selected } : { elevatedShadow: undefined }) }
    return { ...spec, effects: { ...effects, shadows, ...(Object.values(semantic).some(value => value !== undefined) ? { semantic } : {}) } }
  }
  if (tweak.key === 'gradientEnabled') {
    const effects = spec.effects ?? { shadows: [], gradients: [], opacities: [] }
    const gradients = tweak.value ? effects.gradients.length > 0 ? effects.gradients : [`linear-gradient(135deg, ${designSpecColor(spec, 'page')}, ${designSpecColor(spec, 'surface')})`] : effects.gradients
    const semantic = { ...effects.semantic, ...(tweak.value ? { primaryControlGradient: gradients[0]! } : { primaryControlGradient: undefined }) }
    return { ...spec, effects: { ...effects, gradients, ...(Object.values(semantic).some(value => value !== undefined) ? { semantic } : {}) } }
  }
  if (tweak.key === 'effectOpacity') {
    const effects = spec.effects ?? { shadows: [], gradients: [], opacities: [] }
    const disabledControlOpacity = bounded(tweak.value, 0, 1)
    const opacities = effects.opacities.includes(disabledControlOpacity) ? effects.opacities : [...effects.opacities, disabledControlOpacity].slice(0, 12)
    return { ...spec, effects: { ...effects, opacities, semantic: { ...effects.semantic, disabledControlOpacity } } }
  }
  if (tweak.key === 'opacityScale') { const values = numericScale(tweak.value, 0, 1, 12); return values === undefined ? spec : { ...spec, effects: { ...(spec.effects ?? { shadows: [], gradients: [], opacities: [] }), opacities: values } } }
  if (tweak.key === 'surfaceShadow') return semanticEffect(spec, 'surfaceShadow', tweak.value)
  if (tweak.key === 'elevatedShadow') return semanticEffect(spec, 'elevatedShadow', tweak.value)
  if (tweak.key === 'primaryGradient') return semanticEffect(spec, 'primaryControlGradient', tweak.value)
  if (tweak.key === 'motionDuration') {
    const controlDuration = `${Math.round(bounded(tweak.value, 0, 10_000))}ms`
    const motion = spec.motion ?? { durations: [], easings: [] }
    const durations = motion.durations.includes(controlDuration) ? motion.durations : [...motion.durations, controlDuration].slice(0, 12)
    return { ...spec, motion: { ...motion, durations, semantic: { ...motion.semantic, controlDuration } } }
  }
  if (tweak.key === 'motionEasing') {
    const motion = spec.motion ?? { durations: [], easings: [] }
    const easings = motion.easings.includes(tweak.value) ? motion.easings : [...motion.easings, tweak.value].slice(0, 12)
    return { ...spec, motion: { ...motion, easings, semantic: { ...motion.semantic, controlEasing: tweak.value } } }
  }
  if (tweak.key === 'layoutPatterns') {
    const allowed = ['block', 'flex-row', 'flex-column', 'grid', 'sticky'] as const
    if (!Array.isArray(tweak.value) || tweak.value.length === 0 || tweak.value.length > allowed.length || !tweak.value.every(item => allowed.includes(item))) return spec
    return { ...spec, responsive: { breakpoints: spec.responsive?.breakpoints ?? [768, 1_024], layoutPatterns: [...new Set(tweak.value)] } }
  }
  if (tweak.key === 'mobileBreakpoint' || tweak.key === 'desktopBreakpoint') {
    const existing = spec.responsive?.breakpoints ?? [768, 1_024]
    const oldMobile = existing[0] ?? 768
    const oldDesktop = existing.length > 1 ? existing.at(-1)! : Math.max(oldMobile + 1, 1_024)
    const mobile = tweak.key === 'mobileBreakpoint' ? bounded(tweak.value, 320, 1_200) : oldMobile
    const desktop = tweak.key === 'desktopBreakpoint' ? bounded(tweak.value, 640, 3_840) : oldDesktop
    if (mobile >= desktop) return spec
    const intermediate = existing.slice(1, -1).filter(value => value > mobile && value < desktop)
    return { ...spec, responsive: { breakpoints: [...new Set([mobile, ...intermediate, desktop])], layoutPatterns: spec.responsive?.layoutPatterns ?? ['block'] } }
  }
  return spec
}

export function designSpecTweakCount(original: DesignSpecV1, draft: DesignSpecV1): number {
  return designSpecChangedGroups(original, draft).size
}

export function designSpecChangedGroups(original: DesignSpecV1, draft: DesignSpecV1): ReadonlySet<DesignSpecChangeGroup> {
  const changed = new Set<DesignSpecChangeGroup>()
  const different = (...keys: Array<keyof DesignSpecV1>): boolean => keys.some(key => JSON.stringify(original[key]) !== JSON.stringify(draft[key]))
  if (different('colors', 'surfaces')) changed.add('colors')
  if (different('typography')) changed.add('typography')
  if (different('spacing')) changed.add('layout')
  if (different('borders')) changed.add('borders')
  if (different('effects')) changed.add('effects')
  if (different('controls')) changed.add('controls')
  if (different('focus')) changed.add('focus')
  if (different('responsive')) changed.add('responsive')
  if (different('motion')) changed.add('motion')
  return changed
}
