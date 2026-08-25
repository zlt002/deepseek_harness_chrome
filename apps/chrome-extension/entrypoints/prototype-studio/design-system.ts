import type { DesignSpecV1, ReferenceEvidenceV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'

export type DesignCoverageStatus = 'observed' | 'inferred' | 'default'
export interface DesignCoverageItem { id: string; label: string; status: DesignCoverageStatus; detail: string }

function numericToken(values: readonly string[], fallback: number): number {
  for (const value of values) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function numericScale(values: readonly string[], fallback: number[], minimum = 0, maximum = 240): number[] {
  const parsed = values.map(value => Number.parseFloat(value)).filter(value => Number.isFinite(value) && value >= minimum && value <= maximum)
  const unique = [...new Set(parsed)].sort((left, right) => left - right)
  return unique.length > 0 ? unique.slice(0, 12) : fallback
}

function ratioToken(value: string | undefined, fontSize: number, fallback: number): number {
  if (value === undefined || value === 'normal') return fallback
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(.8, Math.min(3, /px$/.test(value) ? parsed / fontSize : parsed))
}

function colorfulness(value: string): number {
  const rgb = value.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i)
  if (rgb !== null) { const channels = rgb.slice(1, 4).map(Number); return Math.max(...channels) - Math.min(...channels) }
  const hex = value.match(/^#([0-9a-f]{6})/i)?.[1]
  if (hex !== undefined) { const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(item => Number.parseInt(item, 16)); return Math.max(...channels) - Math.min(...channels) }
  const hsl = value.match(/hsla?\([^,]+,\s*(\d+(?:\.\d+)?)%/i)
  return hsl === null ? 0 : Number(hsl[1]) * 2.55
}

function strongestAccent(values: readonly string[] | undefined, fallback: string): string {
  return [...(values ?? [])].sort((left, right) => colorfulness(right) - colorfulness(left))[0] ?? fallback
}

function colorChannels(value: string): number[] | undefined {
  const rgb = value.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i)
  const channels = rgb !== null ? rgb.slice(1, 4).map(Number) : value.match(/^#([0-9a-f]{6})/i)?.[1]?.match(/.{2}/g)?.map(item => Number.parseInt(item, 16))
  return channels === undefined || channels.length !== 3 || channels.some(item => !Number.isFinite(item)) ? undefined : channels
}

function colorLightness(value: string): number | undefined {
  const channels = colorChannels(value)
  return channels === undefined ? undefined : (channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722) / 255
}

function colorDistance(left: string, right: string): number {
  const a = colorChannels(left); const b = colorChannels(right)
  return a === undefined || b === undefined ? 0 : Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]!) ** 2, 0))
}

function relativeLuminance(value: string): number | undefined {
  const channels = colorChannels(value)
  if (channels === undefined) return undefined
  const linear = channels.map(channel => { const normalized = channel / 255; return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
}

function contrast(left: string, right: string): number {
  const a = relativeLuminance(left); const b = relativeLuminance(right)
  if (a === undefined || b === undefined) return 0
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

/**
 * Raw effect lists are for inspection. Only a value seen on the same component
 * kind is eligible for a trusted preview role.
 */
function observedComponentEffect(samples: NonNullable<ReferenceEvidenceV1['designTokens']['componentSamples']>, kinds: readonly string[], field: 'backgroundImage' | 'boxShadow', allowed: readonly string[]): string | undefined {
  return samples.find(sample => kinds.includes(sample.kind)
    && sample[field] !== undefined
    && sample[field] !== 'none'
    && allowed.includes(sample[field]!))?.[field]
}

const controlKinds = ['button', 'input', 'select', 'textarea', 'checkbox', 'combobox', 'searchbox', 'switch', 'tab', 'textbox'] as const

function observedDisabledControlOpacity(samples: NonNullable<ReferenceEvidenceV1['designTokens']['componentSamples']>, allowed: readonly number[]): number | undefined {
  const value = samples.find(sample => controlKinds.includes(sample.kind as typeof controlKinds[number])
    && sample.disabledOpacity !== undefined
    && allowed.includes(Number(sample.disabledOpacity)))?.disabledOpacity
  return value === undefined ? undefined : Number(value)
}

function splitCssList(value: string): string[] {
  const result: string[] = []
  let depth = 0; let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') depth = Math.max(0, depth - 1)
    else if (value[index] === ',' && depth === 0) { result.push(value.slice(start, index).trim()); start = index + 1 }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function observedControlMotion(samples: NonNullable<ReferenceEvidenceV1['designTokens']['componentSamples']>, durations: readonly string[], easings: readonly string[]): { controlDuration?: string; controlEasing?: string } {
  for (const sample of samples) {
    if (!controlKinds.includes(sample.kind as typeof controlKinds[number]) || sample.transitionDuration === undefined) continue
    const values = sample.transitionDuration.split(',').map(value => value.trim())
    const index = values.findIndex(value => /^\d+(?:\.\d+)?m?s$/.test(value) && Number.parseFloat(value) > 0)
    if (index < 0) continue
    const controlDuration = durations.includes(values[index]!) ? values[index] : undefined
    const timingValues = splitCssList(sample.transitionTimingFunction ?? '')
    const timing = timingValues.length === 0 ? undefined : timingValues[index % timingValues.length]
    const controlEasing = timing !== undefined && easings.includes(timing) ? timing : undefined
    if (controlDuration !== undefined || controlEasing !== undefined) return { ...(controlDuration === undefined ? {} : { controlDuration }), ...(controlEasing === undefined ? {} : { controlEasing }) }
  }
  return {}
}

function observedComponentRadius(samples: NonNullable<ReferenceEvidenceV1['designTokens']['componentSamples']>, kinds: readonly string[]): number | undefined {
  for (const sample of samples) {
    if (!kinds.includes(sample.kind)) continue
    const value = Number.parseFloat(sample.borderRadius.split(/\s+/)[0] ?? '')
    if (Number.isFinite(value)) return Math.min(80, Math.max(0, value))
  }
  return undefined
}

export function createDesignSpecFromEvidence(evidence: ReferenceEvidenceV1): DesignSpecV1 {
  const tokens = evidence.designTokens
  const page = tokens.pageBackgroundColors?.[0] ?? tokens.backgroundColors?.[0] ?? '#f5f6f8'
  const surface = tokens.backgroundColors?.find(value => value !== page) ?? '#ffffff'
  const elevated = tokens.elevatedBackgroundColors?.[0] ?? surface
  // Prefer a foreground/background pair captured from the same real control.
  // Independent frequency lists can otherwise combine the text of one button
  // with the background of another and invent a pairing that never existed.
  const observedPrimaryPair = [...(tokens.componentSamples ?? [])]
    .filter(sample => ['button', 'tab'].includes(sample.kind)
      && colorDistance(sample.backgroundColor, page) >= 40
      && colorDistance(sample.backgroundColor, surface) >= 40
      && contrast(sample.color, sample.backgroundColor) >= 4.5)
    .sort((left, right) => colorfulness(right.backgroundColor) - colorfulness(left.backgroundColor) || right.count - left.count)[0]
  const primary = observedPrimaryPair?.backgroundColor
    ?? tokens.accentBackgroundColors?.find(value => colorDistance(value, page) >= 40 && colorDistance(value, surface) >= 40)
    ?? strongestAccent(tokens.accentColors, strongestAccent(tokens.colors, '#3977e8'))
  const onPrimary = observedPrimaryPair?.color
    ?? tokens.accentTextColors?.find(value => contrast(value, primary) >= 4.5)
    ?? (contrast('#111111', primary) >= contrast('#ffffff', primary) ? '#111111' : '#ffffff')
  const text = tokens.textColors?.[0] ?? '#283347'
  const textContrast = contrast(text, page)
  const textMuted = (tokens.textColors ?? []).filter(value => value !== text && contrast(value, page) >= 2.5 && contrast(value, page) < textContrast).sort((left, right) => colorfulness(left) - colorfulness(right))[0]
    ?? tokens.textColors?.find(value => value !== text)
    ?? '#697386'
  const border = tokens.borderColors?.[0] ?? '#e2e5eb'
  const semanticColors: DesignSpecV1['colors'] = [
    { name: '主要操作色', value: primary, usage: '主要按钮、链接和选中状态' },
    { name: '按钮文字', value: onPrimary, usage: '主要操作上的文字和图标' },
    { name: '页面背景', value: page, usage: '页面最底层背景' },
    { name: '内容表面', value: surface, usage: '卡片、弹窗和输入区域' },
    { name: '主要文字', value: text, usage: '标题和正文' },
    { name: '次要文字', value: textMuted, usage: '说明、占位和辅助信息' },
    { name: '边框颜色', value: border, usage: '分割线、描边和输入框' },
    { name: '信息色', value: primary, usage: '一般提示和信息状态' },
    { name: '成功色', value: '#16805c', usage: '完成、通过和正向变化' },
    { name: '警告色', value: '#8a5b08', usage: '提醒、待处理和风险预警' },
    { name: '危险色', value: '#c2413b', usage: '错误、驳回和危险操作' },
  ]
  const semanticValues = new Set(semanticColors.map(item => item.value))
  const extraColors = tokens.colors.filter(value => !semanticValues.has(value)).slice(0, 16 - semanticColors.length).map((value, index) => ({ name: `扩展色 ${index + 1}`, value, usage: '参考页面中的补充颜色' }))
  const fontSizes = numericScale(tokens.fontSizes ?? [], [12, 14, 28])
  const bodyStyle = tokens.textStyles?.find(item => item.kind === 'body')
  const headingStyle = tokens.textStyles?.find(item => item.kind === 'heading')
  const captionStyle = tokens.textStyles?.find(item => item.kind === 'caption')
  const bodySize = numericToken(bodyStyle === undefined ? tokens.fontSizes ?? [] : [bodyStyle.fontSize], 14)
  const headingSize = numericToken(headingStyle === undefined ? [] : [headingStyle.fontSize], fontSizes.at(-1) ?? Math.round(bodySize * 2))
  const captionSize = numericToken(captionStyle === undefined ? [] : [captionStyle.fontSize], fontSizes[0] ?? Math.max(10, bodySize - 2))
  const weights = numericScale(tokens.fontWeights ?? [], [400, 700], 100, 1_000)
  const lineHeightScale = numericScale((tokens.lineHeights ?? []).filter(value => value !== 'normal'), [])
  const spacingScale = numericScale(tokens.spacing, [4, 8, 12, 16, 24, 32])
  const componentSamples = tokens.componentSamples ?? []
  const radiusScale = numericScale(tokens.radius, [4, 8, 12], 0, 80)
  const spacingBase = numericToken(tokens.spacing, 8)
  const cardRadius = observedComponentRadius(componentSamples, ['surface', 'table', 'form']) ?? 8
  const controlRadius = observedComponentRadius(componentSamples, ['button', 'input', 'select', 'tab', 'combobox', 'searchbox', 'textbox']) ?? 8
  const controlHeight = numericToken(tokens.buttonHeights ?? [], 38)
  const buttonHeight = numericToken(tokens.buttonHeights ?? [], controlHeight)
  const inputHeight = numericToken(tokens.inputHeights ?? [], controlHeight)
  const iconSize = numericToken(tokens.iconSizes ?? [], 16)
  const borderStyle = tokens.borderStyles?.find((value): value is 'solid' | 'dashed' | 'dotted' => ['solid', 'dashed', 'dotted'].includes(value)) ?? 'solid'
  const focusStyle = tokens.focusStyles?.[0]
  const responsiveBreakpoints = [...new Set(tokens.responsiveBreakpoints ?? [768, 1_024])].sort((left, right) => left - right).slice(0, 12)
  const layoutPatterns: NonNullable<DesignSpecV1['responsive']>['layoutPatterns'] = tokens.layoutPatterns?.length ? tokens.layoutPatterns : ['block']
  const theme = (colorLightness(page) ?? .9) < .45 ? '深色' : '浅色'
  const density = controlHeight <= 34 || spacingBase <= 6 ? '紧凑' : controlHeight >= 46 || spacingBase >= 12 ? '舒展' : '适中密度'
  const geometry = cardRadius <= 4 ? '利落小圆角' : cardRadius >= 14 ? '柔和大圆角' : `${cardRadius}px 中等圆角`
  const elevation = (tokens.shadows?.length ?? 0) === 0 ? '扁平弱层级' : (tokens.shadows?.length ?? 0) <= 2 ? '轻投影分层' : '多层投影'
  const summary = `${theme}、${density}、${geometry}、${elevation}的产品界面，以 ${primary} 作为主要强调色。`
  const semanticEffects = {
    primaryControlGradient: observedComponentEffect(componentSamples, ['button'], 'backgroundImage', tokens.gradients ?? []),
    surfaceShadow: observedComponentEffect(componentSamples, ['surface', 'table', 'form'], 'boxShadow', tokens.shadows ?? []),
    elevatedShadow: observedComponentEffect(componentSamples, ['dialog', 'menu'], 'boxShadow', tokens.shadows ?? []),
    disabledControlOpacity: observedDisabledControlOpacity(componentSamples, (tokens.opacities ?? []).map(Number).filter(value => Number.isFinite(value) && value >= 0 && value <= 1)),
  }
  const semantic = Object.fromEntries(Object.entries(semanticEffects).filter(([, value]) => value !== undefined))
  const controlMotion = observedControlMotion(componentSamples, tokens.motionDurations ?? [], tokens.motionEasings ?? [])
  return {
    v: 1,
    id: `design-${evidence.id}`.slice(0, 80),
    name: `${evidence.source.title || '参考网页'}设计规范`,
    basedOnEvidenceIds: [evidence.id],
    summary,
    colors: [...semanticColors, ...extraColors],
    typography: { fontFamily: tokens.fonts[0] ?? 'system-ui', headingWeight: numericToken(headingStyle === undefined ? [] : [headingStyle.fontWeight], weights.at(-1) ?? 700), bodyWeight: numericToken(bodyStyle === undefined ? tokens.fontWeights ?? [] : [bodyStyle.fontWeight], 400), bodySize, headingSize, captionSize, fontSizeScale: fontSizes, fontWeightScale: weights, lineHeightScale, bodyLineHeight: ratioToken(bodyStyle?.lineHeight ?? tokens.lineHeights?.[0], bodySize, 1.5), headingLineHeight: ratioToken(headingStyle?.lineHeight, headingSize, 1.15), letterSpacing: numericToken((bodyStyle === undefined ? tokens.letterSpacings ?? [] : [bodyStyle.letterSpacing]).filter(value => value !== 'normal'), 0) },
    spacing: { base: spacingBase, cardRadius, scale: spacingScale, sectionGap: spacingScale.at(-1) ?? 32, contentWidth: Math.min(1_440, Math.max(480, numericToken(tokens.contentWidths ?? [], evidence.viewport.width - 80))) },
    surfaces: { page, surface, elevated, text, textMuted, border },
    borders: { width: numericToken(tokens.borderWidths ?? [], 1), style: borderStyle, radiusScale },
    effects: { shadows: tokens.shadows ?? [], gradients: tokens.gradients ?? [], opacities: (tokens.opacities ?? []).map(Number).filter(value => Number.isFinite(value) && value >= 0 && value <= 1), ...(Object.keys(semantic).length === 0 ? {} : { semantic }) },
    controls: { height: controlHeight, buttonHeight, inputHeight, iconSize, radius: controlRadius },
    motion: { durations: tokens.motionDurations?.length ? tokens.motionDurations : ['160ms'], easings: tokens.motionEasings?.length ? tokens.motionEasings : ['ease-out'], ...(Object.keys(controlMotion).length === 0 ? {} : { semantic: controlMotion }) },
    focus: { width: numericToken(focusStyle === undefined ? [] : [focusStyle.width], 2), style: focusStyle?.style ?? 'solid', color: focusStyle?.color ?? primary, offset: numericToken(focusStyle === undefined ? [] : [focusStyle.offset], 2) },
    responsive: { breakpoints: responsiveBreakpoints, layoutPatterns },
    principles: [`保持${theme}主题和${density}节奏`, `沿用${geometry}与${elevation}`, '颜色、间距、排版和控件尺寸必须来自本规范', '使用真实业务文案，并提供清晰可演示的交互状态'],
  }
}

export function designEvidenceCoverage(evidence: ReferenceEvidenceV1): DesignCoverageItem[] {
  const token = evidence.designTokens
  const captured = (value: readonly unknown[] | undefined): DesignCoverageStatus => value === undefined ? 'default' : 'observed'
  const hasValues = (value: readonly unknown[] | undefined): boolean => (value?.length ?? 0) > 0
  const colors: DesignCoverageStatus = !hasValues(token.textColors) || !hasValues(token.backgroundColors) ? 'default' : !hasValues(token.pageBackgroundColors) ? 'inferred' : 'observed'
  const controlValues = [...(token.buttonHeights ?? []), ...(token.inputHeights ?? []), ...(token.iconSizes ?? [])]
  const controls = token.controlHeights === undefined && controlValues.length === 0 ? 'default' : (token.controlHeights?.length ?? 0) + controlValues.length > 0 ? 'observed' : 'inferred'
  return [
    { id: 'colors', label: '颜色', status: colors, detail: `${token.colors.length} 个颜色值，${token.pageBackgroundColors?.length ?? 0} 个页面底色，${token.elevatedBackgroundColors?.length ?? 0} 个浮层表面色` },
    { id: 'surfaces', label: '页面与浮层表面', status: !hasValues(token.backgroundColors) ? 'default' : !hasValues(token.elevatedBackgroundColors) ? 'inferred' : 'observed', detail: token.elevatedBackgroundColors?.length ? `已实测页面、内容和 ${token.elevatedBackgroundColors.length} 个浮层表面色` : !hasValues(token.backgroundColors) ? '页面、内容和浮层表面色使用安全默认值' : '页面与内容表面已实测；网页未出现可稳定采集的浮层，示例沿用内容表面色' },
    { id: 'feedback-colors', label: '状态反馈色', status: 'default', detail: '成功、警告、危险和信息状态无法从静态页面可靠判断，可在确认前调整' },
    { id: 'typography', label: '排版', status: !hasValues(token.fontSizes) || !hasValues(token.lineHeights) ? 'default' : !hasValues(token.textStyles) ? 'inferred' : 'observed', detail: `${token.fontSizes?.length ?? 0} 个字号，${token.fontWeights?.length ?? 0} 个字重，${token.textStyles?.length ?? 0} 组真实文字样式` },
    { id: 'font-assets', label: '字体资源', status: hasValues(token.fonts) ? 'inferred' : 'default', detail: hasValues(token.fonts) ? `识别到 ${token.fonts.slice(0, 4).join('、')}；只记录字体名称，不复制网页字体文件，预览不可用时会回退系统字体` : '未识别字体名称，预览使用系统字体' },
    { id: 'spacing', label: '间距', status: token.spacing.length > 0 ? 'observed' : 'default', detail: `${token.spacing.length} 个间距档位` },
    { id: 'layout', label: '页面布局', status: hasValues(token.layoutPatterns) || hasValues(token.contentWidths) ? 'observed' : 'inferred', detail: `${token.contentWidths?.length ?? 0} 个内容宽度；${token.layoutPatterns?.join('、') || '未识别稳定布局模式'}` },
    { id: 'responsive', label: '响应式断点', status: token.responsiveBreakpoints === undefined || token.responsiveBreakpoints.length === 0 ? 'default' : 'inferred', detail: token.responsiveBreakpoints?.length ? `${token.responsiveBreakpoints.join(' / ')} px · 来自 CSS 声明，尚未多尺寸实测` : `当前只实测 ${evidence.viewport.width}px 视口，使用安全默认断点` },
    { id: 'borders', label: '边框圆角', status: token.radius.length > 0 || hasValues(token.borderWidths) ? 'observed' : 'default', detail: `${token.radius.length} 个圆角，${token.borderWidths?.length ?? 0} 个边框宽度` },
    { id: 'effects', label: '投影渐变', status: captured(token.shadows), detail: `${token.shadows?.length ?? 0} 种投影，${token.gradients?.length ?? 0} 种渐变` },
    { id: 'controls', label: '组件尺寸', status: controls, detail: controlValues.length > 0 ? `${token.buttonHeights?.length ?? 0} 个按钮高度，${token.inputHeights?.length ?? 0} 个普通输入高度（不含文本域），${token.iconSizes?.length ?? 0} 个图标尺寸` : token.controlHeights?.length ? `${token.controlHeights.length} 个控件高度；未采到普通输入或图标尺寸` : '依据排版与间距推导' },
    { id: 'components', label: '组件与状态', status: hasValues(token.componentKinds) ? 'observed' : 'default', detail: `${token.componentKinds?.length ?? 0} 类组件，${token.componentStates?.length ?? 0} 种显式状态` },
    { id: 'visual-assets', label: '图标与图片素材', status: hasValues(token.componentKinds) ? 'inferred' : 'default', detail: token.componentKinds?.includes('image') ? `网页中识别到图片元素；不会复制原网页图片文件或 Logo，原型仅继承其布局位置并使用安全占位` : token.componentKinds?.includes('icon') ? `识别到图标及 ${token.iconSizes?.length ?? 0} 个图标尺寸；原型使用内置安全图标，不复制网页图标文件` : '未识别稳定的图片或图标样式；原型使用内置安全图标' },
    { id: 'focus', label: '键盘焦点', status: hasValues(token.focusStyles) ? 'inferred' : 'default', detail: token.focusStyles?.length ? `${token.focusStyles.length} 组焦点描边，来自当前焦点或可读取 CSS 声明，未逐个主动触发` : '使用主要操作色和 2px 安全焦点环' },
    { id: 'motion', label: '动效', status: hasValues(token.motionDurations) && hasValues(token.motionEasings) ? 'observed' : 'default', detail: `${token.motionDurations?.length ?? 0} 个时长，${token.motionEasings?.length ?? 0} 个缓动` },
  ]
}
