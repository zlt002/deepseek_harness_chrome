import { computeReferenceEvidenceFingerprint, validateReferenceEvidence, type ReferenceEvidenceV1 } from '../../../packages/harness-ui-prototype-studio/src/prototype-document'

export const PROTOTYPE_REFERENCE_STORAGE_KEY = 'harnessPrototypeReferencesV1'

export interface CapturedStyleSample {
  tag: string
  role?: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  color: string
  backgroundColor: string
  borderColor: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  borderRadius: string
  borderWidth: string
  borderStyle: string
  padding: string
  margin: string
  gap: string
  boxShadow: string
  backgroundImage: string
  opacity: string
  transitionDuration: string
  transitionTimingFunction: string
  display?: string
  position?: string
  gridTemplateColumns?: string
  flexDirection?: string
  outlineColor?: string
  outlineWidth?: string
  outlineStyle?: string
  outlineOffset?: string
  state?: string
}

export interface CapturedDesignReferencePage {
  v: 1
  source: { url: string; title: string }
  viewport: { width: number; height: number; deviceScaleFactor: number }
  pageSize: { width: number; height: number; sampledBands: number }
  responsiveBreakpoints?: number[]
  declaredInteractionStates?: string[]
  declaredFocusStyles?: { width: string; style: string; color: string; offset: string }[]
  captureCoverage?: {
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
  samples: CapturedStyleSample[]
}

/** Runs in the selected page through chrome.scripting.executeScript. */
export function captureDesignReferencePage(): CapturedDesignReferencePage {
  const bounded = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max)
  const pageCssColor = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,60}\))$/
  const safeUrl = (): string => {
    try { return `${location.origin}${location.pathname}` } catch { return '' }
  }
  const relevant = new Set(['HTML', 'BODY', 'A', 'ARTICLE', 'ASIDE', 'BUTTON', 'DIALOG', 'FIGCAPTION', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'HEADER', 'IMG', 'INPUT', 'LABEL', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SELECT', 'SMALL', 'SVG', 'TABLE', 'TEXTAREA'])
  const samples: CapturedStyleSample[] = []
  const pageWidth = Math.max(innerWidth, document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0)
  const pageHeight = Math.max(innerHeight, document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0)
  const sampledBands = Math.max(1, Math.min(8, Math.ceil(pageHeight / Math.max(1, innerHeight))))
  const bandQuota = Math.max(12, Math.floor(240 / sampledBands))
  const bandCounts = Array.from({ length: sampledBands }, () => 0)
  const kindCounts = new Map<string, number>()
  const responsiveBreakpoints = new Set<number>()
  const declaredInteractionStates = new Set<string>()
  const declaredFocusStyles: { width: string; style: string; color: string; offset: string }[] = []
  let accessibleStylesheets = 0
  let opaqueStylesheets = 0
  let inspectedCssRules = 0
  let cssRuleLimitReached = false
  const cssRuleLimit = 20_000
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const collectBreakpoints = (rules: CSSRuleList, depth = 0): void => {
    if (depth > 4 || inspectedCssRules >= cssRuleLimit) { if (inspectedCssRules >= cssRuleLimit) cssRuleLimitReached = true; return }
    for (let index = 0; index < rules.length; index += 1) {
      if (inspectedCssRules >= cssRuleLimit) { cssRuleLimitReached = true; return }
      const rule = rules[index]
      if (rule === undefined) continue
      inspectedCssRules += 1
      const mediaText = 'media' in rule && rule.media instanceof MediaList ? rule.media.mediaText : ''
      for (const match of mediaText.matchAll(/(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)/gi)) {
        const value = Math.round(Number(match[1]) * (match[2]?.toLowerCase() === 'px' ? 1 : rootFontSize))
        if (responsiveBreakpoints.size < 12 && value >= 240 && value <= 7_680) responsiveBreakpoints.add(value)
      }
      if ('selectorText' in rule && typeof rule.selectorText === 'string') {
        for (const match of rule.selectorText.matchAll(/:(hover|active|focus-visible|focus|disabled|checked|selected)\b/gi)) declaredInteractionStates.add(match[1]!.toLowerCase())
        if (/:focus(?:-visible)?\b/i.test(rule.selectorText) && 'style' in rule) {
          const style = rule.style as CSSStyleDeclaration
          const shorthand = style.outline.match(/^([^\s]+)\s+(solid|dashed|dotted)\s+(.+)$/i)
          const width = style.outlineWidth || shorthand?.[1] || ''
          const outlineStyle = style.outlineStyle || shorthand?.[2] || ''
          const color = style.outlineColor || shorthand?.[3] || ''
          const offset = style.outlineOffset || '0px'
          if (declaredFocusStyles.length < 8 && /^\d+(?:\.\d+)?px$/.test(width) && ['solid', 'dashed', 'dotted'].includes(outlineStyle) && pageCssColor.test(color) && /^-?\d+(?:\.\d+)?px$/.test(offset)) declaredFocusStyles.push({ width, style: outlineStyle, color, offset })
        }
      }
      if ('cssRules' in rule) {
        try { collectBreakpoints(rule.cssRules as CSSRuleList, depth + 1) } catch { /* Cross-origin and disabled sheets stay opaque. */ }
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets).slice(0, 200)) {
    try { accessibleStylesheets += 1; collectBreakpoints(sheet.cssRules) } catch { accessibleStylesheets -= 1; opaqueStylesheets += 1 }
  }
  let inspected = 0
  const priority = (element: Element): number => {
    if (element === document.documentElement || element === document.body) return 120
    if (element.matches(':disabled,:checked,:focus') || element.hasAttribute('aria-selected') || element.hasAttribute('aria-expanded') || element.hasAttribute('aria-current')) return 110
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG'].includes(element.tagName) || ['button', 'checkbox', 'combobox', 'dialog', 'radio', 'searchbox', 'switch', 'tab', 'textbox'].includes(element.getAttribute('role') ?? '')) return 100
    if (/^H[1-4]$/.test(element.tagName)) return 90
    if (['MAIN', 'NAV', 'HEADER', 'FOOTER', 'FORM', 'TABLE'].includes(element.tagName) || ['navigation', 'menu', 'table'].includes(element.getAttribute('role') ?? '')) return 80
    if (relevant.has(element.tagName) || element.getAttribute('role') !== null) return 60
    return 0
  }
  const prioritized: Array<{ element: Element; order: number; priority: number }> = []
  const ordinary: Array<{ element: Element; order: number; priority: number }> = []
  // Large SPA pages can contain tens of thousands of nodes. Walk only a bounded
  // prefix instead of materializing the entire DOM into one huge array.
  const roots: Array<Element | null> = [document.documentElement, document.body]
  const candidates: Element[] = roots.filter((element): element is Element => element !== null)
  const candidateLimit = 12_000
  let candidateLimitReached = false
  if (document.body !== null) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    while (candidates.length < candidateLimit) {
      const next = walker.nextNode()
      if (!(next instanceof Element)) break
      candidates.push(next)
    }
    candidateLimitReached = walker.nextNode() !== null
  }
  for (let order = 0; order < candidates.length; order += 1) {
    const element = candidates[order]!; const score = priority(element); const bucket = score > 0 ? prioritized : ordinary
    if (bucket.length < 3_000) bucket.push({ element, order, priority: score })
  }
  const elements = [...prioritized, ...ordinary].sort((left, right) => right.priority - left.priority || left.order - right.order)
  for (const element of elements) {
    if (samples.length >= 240 || inspected >= 6_000) break
    inspected += 1
    const node = element.element
    const rect = node.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2 || rect.right <= 0 || rect.left >= innerWidth) continue
    const documentY = Math.max(0, Math.min(pageHeight - 1, rect.top + scrollY + rect.height / 2))
    const band = Math.min(sampledBands - 1, Math.floor(documentY / Math.max(1, pageHeight / sampledBands)))
    if (bandCounts[band]! >= bandQuota) continue
    const style = getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    const role = node.getAttribute('role') ?? undefined
    const states = [
      node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
      node.matches(':checked') || node.getAttribute('aria-checked') === 'true' ? 'checked' : '',
      node.getAttribute('aria-selected') === 'true' || node.hasAttribute('aria-current') ? 'selected' : '',
      node.getAttribute('aria-expanded') === 'true' ? 'expanded' : node.getAttribute('aria-expanded') === 'false' ? 'collapsed' : '',
      node === document.activeElement ? 'focus' : '',
    ].filter(Boolean).join(',')
    const text = bounded((node instanceof HTMLElement ? node.innerText : node.textContent) ?? node.getAttribute('aria-label') ?? '', 240)
    const hasVisualSurface = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none' || style.borderRadius !== '0px'
    if (!relevant.has(node.tagName) && role === undefined && text === '' && !hasVisualSurface) continue
    const kind = `${band}:${role ?? node.tagName}`
    if ((kindCounts.get(kind) ?? 0) >= 10 && !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) continue
    samples.push({
      tag: node.tagName.toLowerCase(),
      ...(role === undefined ? {} : { role: bounded(role, 48) }),
      ...(text === '' ? {} : { text }),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      fontFamily: bounded(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      borderStyle: style.borderStyle,
      padding: style.padding,
      margin: style.margin,
      gap: style.gap,
      boxShadow: bounded(style.boxShadow, 240),
      backgroundImage: /gradient\(/i.test(style.backgroundImage) ? bounded(style.backgroundImage, 320) : 'none',
      opacity: style.opacity,
      transitionDuration: bounded(style.transitionDuration, 80),
      transitionTimingFunction: bounded(style.transitionTimingFunction, 120),
      display: bounded(style.display, 40),
      position: bounded(style.position, 40),
      gridTemplateColumns: bounded(style.gridTemplateColumns, 240),
      flexDirection: bounded(style.flexDirection, 40),
      outlineColor: bounded(style.outlineColor, 80),
      outlineWidth: bounded(style.outlineWidth, 40),
      outlineStyle: bounded(style.outlineStyle, 40),
      outlineOffset: bounded(style.outlineOffset, 40),
      ...(states === '' ? {} : { state: states }),
    })
    bandCounts[band] = bandCounts[band]! + 1
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
  }
  const iframeElements = document.querySelectorAll('iframe').length
  const unloadedImages = Array.from(document.images).filter(image => !image.complete || image.naturalWidth === 0).length
  const horizontalOverflow = pageWidth > innerWidth + 1
  const limitations = [
    `仅在当前 ${Math.max(1, Math.round(innerWidth))}px 宽度实测；响应式断点来自可读取的 CSS 声明，未切换多尺寸重采。`,
    'hover、active 等交互状态只读取当前 DOM 状态和可访问样式表声明，没有逐个主动触发。',
    ...(opaqueStylesheets > 0 ? [`${opaqueStylesheets} 个跨域或受限样式表无法读取规则。`] : []),
    ...(iframeElements > 0 ? [`${iframeElements} 个 iframe 的内部页面没有采集。`] : []),
    ...(unloadedImages > 0 ? [`${unloadedImages} 张未完成加载或不可用的图片没有形成可靠证据。`] : []),
    ...(horizontalOverflow ? ['页面存在横向滚动；只采集了与当前横向视口相交的元素。'] : []),
    ...(cssRuleLimitReached ? [`CSS 规则超过 ${cssRuleLimit} 条，只检查前 ${cssRuleLimit} 条，后续状态或断点可能未覆盖。`] : []),
    ...(candidateLimitReached ? [`页面元素超过 ${candidateLimit} 个，只枚举前 ${candidateLimit} 个候选元素，后续区域可能未覆盖。`] : []),
    ...(candidates.length > inspected ? [`候选元素 ${candidates.length} 个，按业务优先级检查 ${inspected} 个并限量采样，低优先级元素可能未覆盖。`] : []),
    '截图只包含当前可见区域；纵向其他区域只采集计算样式，不保存完整截图。',
  ].slice(0, 12)
  return {
    v: 1,
    source: { url: safeUrl(), title: bounded(document.title, 240) },
    viewport: { width: Math.max(1, Math.round(innerWidth)), height: Math.max(1, Math.round(innerHeight)), deviceScaleFactor: Math.max(0.25, Math.min(8, devicePixelRatio || 1)) },
    pageSize: { width: Math.max(1, Math.round(pageWidth)), height: Math.max(1, Math.round(pageHeight)), sampledBands },
    responsiveBreakpoints: [...responsiveBreakpoints].sort((left, right) => left - right), declaredInteractionStates: [...declaredInteractionStates].slice(0, 16), declaredFocusStyles,
    captureCoverage: { candidateElements: candidates.length, inspectedElements: inspected, sampledElements: samples.length, accessibleStylesheets, opaqueStylesheets, iframeElements, unloadedImages, horizontalOverflow, limitations },
    samples,
  }
}

const cssColor = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,60}\))$/
const pixels = /^\d+(?:\.\d+)?px$/

function frequent(values: string[], maximum: number, accept: (value: string) => boolean = value => value !== ''): string[] {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const value = raw.trim()
    if (!accept(value)) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, maximum).map(([value]) => value)
}

function hasVisibleBorder(sample: CapturedStyleSample): boolean {
  const widths = (sample.borderWidth ?? '').split(/\s+/).map(value => Number.parseFloat(value)).filter(Number.isFinite)
  const styles = (sample.borderStyle ?? '').split(/\s+/)
  return widths.some(value => value > 0) && styles.some(value => !['none', 'hidden'].includes(value))
}

function hasVisibleBackground(sample: CapturedStyleSample): boolean {
  return cssColor.test(sample.backgroundColor) && sample.backgroundColor !== 'rgba(0, 0, 0, 0)'
}

function isElevatedSurface(sample: CapturedStyleSample): boolean {
  if (!hasVisibleBackground(sample)) return false
  const surfaceTag = ['article', 'aside', 'dialog', 'footer', 'form', 'header', 'main', 'nav', 'section', 'table'].includes(sample.tag)
  return sample.tag === 'dialog'
    || ['dialog', 'menu'].includes(sample.role ?? '')
    || (surfaceTag && ['fixed', 'sticky'].includes(sample.position ?? ''))
    || (surfaceTag && sample.boxShadow !== '' && sample.boxShadow !== 'none')
}

function nonZeroDuration(value: string): boolean {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(m?s)$/)
  return match !== null && Number(match[1]) > 0
}

function splitCssList(value: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') depth = Math.max(0, depth - 1)
    else if (value[index] === ',' && depth === 0) { items.push(value.slice(start, index).trim()); start = index + 1 }
  }
  items.push(value.slice(start).trim())
  return items.filter(Boolean)
}

function activeMotionEasings(samples: CapturedStyleSample[]): string[] {
  const values: string[] = []
  for (const sample of samples) {
    const durations = (sample.transitionDuration ?? '').split(',').map(value => value.trim())
    const easings = splitCssList(sample.transitionTimingFunction ?? '')
    if (easings.length === 0) continue
    for (let index = 0; index < durations.length; index += 1) {
      if (nonZeroDuration(durations[index] ?? '')) values.push(easings[index % easings.length]!)
    }
  }
  return values
}

function isIconSample(sample: CapturedStyleSample): boolean {
  const small = sample.rect.width > 0 && sample.rect.height > 0 && sample.rect.width <= 48 && sample.rect.height <= 48
  return small && (sample.tag === 'svg' || (sample.role === 'img' && sample.tag !== 'img'))
}

function componentKind(sample: CapturedStyleSample): string | undefined {
  const role = sample.role?.toLowerCase()
  if (role !== undefined && ['button', 'checkbox', 'combobox', 'dialog', 'link', 'list', 'menu', 'navigation', 'radio', 'searchbox', 'switch', 'tab', 'table', 'textbox'].includes(role)) return role
  if (['button', 'input', 'select', 'textarea', 'table', 'nav', 'form'].includes(sample.tag)) return sample.tag
  if (sample.tag === 'a') return 'link'
  if (isIconSample(sample)) return 'icon'
  if (sample.tag === 'img' || sample.tag === 'svg' || role === 'img') return 'image'
  if (['article', 'aside', 'section'].includes(sample.tag) && sample.backgroundColor !== 'rgba(0, 0, 0, 0)') return 'surface'
  return undefined
}

function componentSampleScore(sample: CapturedStyleSample): number {
  const rgb = sample.backgroundColor.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i)
  const hex = sample.backgroundColor.match(/^#([0-9a-f]{6})/i)?.[1]
  const channels = rgb !== null ? rgb.slice(1, 4).map(Number) : hex?.match(/.{2}/g)?.map(value => Number.parseInt(value, 16))
  const colorfulness = channels === undefined ? 0 : Math.max(...channels) - Math.min(...channels)
  return colorfulness
    + (hasVisibleBackground(sample) ? 20 : 0)
    // Keep the actual gradient-bearing control when a component kind has both
    // plain and gradient variants. The later semantic projection must never
    // infer a button gradient from an unrelated hero section.
    + (/gradient\(/i.test(sample.backgroundImage) ? 30 : 0)
    + ((sample.text?.length ?? 0) > 0 ? 5 : 0)
    - (sample.state?.split(',').includes('disabled') ? 50 : 0)
}

function capturedComponentSamples(samples: CapturedStyleSample[]): NonNullable<ReferenceEvidenceV1['designTokens']['componentSamples']> {
  const groups = new Map<string, { count: number; sample: CapturedStyleSample; states: Set<string>; disabledOpacity?: string }>()
  for (const sample of samples) {
    const kind = componentKind(sample)
    if (kind === undefined) continue
    const current = groups.get(kind) ?? { count: 0, sample, states: new Set<string>() }
    current.count += 1
    for (const state of sample.state?.split(',') ?? []) if (state !== '') current.states.add(state)
    if (sample.state?.split(',').includes('disabled') === true && /^\d*(?:\.\d+)?$/.test(sample.opacity) && Number(sample.opacity) >= 0 && Number(sample.opacity) < 1) current.disabledOpacity ??= sample.opacity
    if (componentSampleScore(sample) > componentSampleScore(current.sample)) current.sample = sample
    groups.set(kind, current)
  }
  return [...groups].sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0])).slice(0, 20).map(([kind, item]) => ({
    kind, count: item.count, ...(item.sample.text === undefined ? {} : { exampleText: item.sample.text.slice(0, 120) }), states: [...item.states].slice(0, 8),
    width: Math.max(1, item.sample.rect.width), height: Math.max(1, item.sample.rect.height), color: item.sample.color || 'rgb(0, 0, 0)', backgroundColor: item.sample.backgroundColor || 'rgba(0, 0, 0, 0)',
    ...(item.sample.backgroundImage === undefined || item.sample.backgroundImage === 'none' ? {} : { backgroundImage: item.sample.backgroundImage }),
    borderColor: item.sample.borderColor || 'rgba(0, 0, 0, 0)', borderRadius: item.sample.borderRadius || '0px', borderWidth: item.sample.borderWidth || '0px', boxShadow: item.sample.boxShadow || 'none',
    ...(item.disabledOpacity === undefined ? {} : { disabledOpacity: item.disabledOpacity }),
    ...(item.sample.transitionDuration === undefined || !item.sample.transitionDuration.split(',').some(nonZeroDuration) ? {} : { transitionDuration: item.sample.transitionDuration, transitionTimingFunction: item.sample.transitionTimingFunction ?? 'ease-out' }),
  }))
}

function textStyleKind(sample: CapturedStyleSample): 'heading' | 'body' | 'caption' | undefined {
  if (/^h[1-4]$/.test(sample.tag) || sample.role === 'heading') return 'heading'
  if (sample.tag === 'small' || sample.tag === 'figcaption') return 'caption'
  if (['a', 'button', 'input', 'label', 'li', 'p', 'select', 'textarea'].includes(sample.tag) || ['button', 'link', 'tab', 'textbox'].includes(sample.role ?? '')) return 'body'
  return undefined
}

function frequentTextStyles(samples: CapturedStyleSample[], maximum: number): NonNullable<ReferenceEvidenceV1['designTokens']['textStyles']> {
  const counts = new Map<string, { value: NonNullable<ReferenceEvidenceV1['designTokens']['textStyles']>[number]; count: number }>()
  for (const sample of samples) {
    const kind = textStyleKind(sample)
    if (kind === undefined || !pixels.test(sample.fontSize) || !(sample.lineHeight === 'normal' || pixels.test(sample.lineHeight)) || !(sample.letterSpacing === 'normal' || /^-?\d+(?:\.\d+)?px$/.test(sample.letterSpacing))) continue
    const value = { kind, fontSize: sample.fontSize, fontWeight: sample.fontWeight, lineHeight: sample.lineHeight, letterSpacing: sample.letterSpacing }
    const key = JSON.stringify(value)
    const existing = counts.get(key)
    counts.set(key, { value, count: (existing?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.value.fontSize.localeCompare(right.value.fontSize)).slice(0, maximum).map(item => item.value)
}

function isCapturedPage(value: unknown): value is CapturedDesignReferencePage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const capture = value as Partial<CapturedDesignReferencePage>
  const coverage = capture.captureCoverage
  const coverageOk = coverage === undefined || (typeof coverage === 'object' && coverage !== null && Number.isSafeInteger(coverage.candidateElements) && Number.isSafeInteger(coverage.inspectedElements) && Number.isSafeInteger(coverage.sampledElements) && Number.isSafeInteger(coverage.accessibleStylesheets) && Number.isSafeInteger(coverage.opaqueStylesheets) && Number.isSafeInteger(coverage.iframeElements) && Number.isSafeInteger(coverage.unloadedImages) && typeof coverage.horizontalOverflow === 'boolean' && Array.isArray(coverage.limitations) && coverage.limitations.every(item => typeof item === 'string'))
  return capture.v === 1 && typeof capture.source?.url === 'string' && /^https?:\/\//.test(capture.source.url)
    && typeof capture.source.title === 'string' && typeof capture.viewport?.width === 'number' && typeof capture.viewport.height === 'number'
    && typeof capture.viewport.deviceScaleFactor === 'number' && typeof capture.pageSize?.width === 'number' && typeof capture.pageSize.height === 'number' && typeof capture.pageSize.sampledBands === 'number' && (capture.responsiveBreakpoints === undefined || Array.isArray(capture.responsiveBreakpoints)) && (capture.declaredInteractionStates === undefined || Array.isArray(capture.declaredInteractionStates)) && (capture.declaredFocusStyles === undefined || Array.isArray(capture.declaredFocusStyles)) && coverageOk && Array.isArray(capture.samples) && capture.samples.length <= 240
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Converts raw page observations into the only bounded evidence shown to the model. */
export async function buildReferenceEvidence(raw: unknown, screenshotDataUrl: string, capturedAt = new Date()): Promise<ReferenceEvidenceV1> {
  if (!isCapturedPage(raw) || raw.samples.length === 0) throw new Error('The selected page exposed no bounded visual evidence.')
  if (!/^data:image\/(png|jpeg);base64,/.test(screenshotDataUrl) || screenshotDataUrl.length > 2_000_000) throw new Error('The visible-page screenshot is missing or too large.')
  const colors = frequent(raw.samples.flatMap(sample => [sample.color, sample.backgroundColor, ...(hasVisibleBorder(sample) ? [sample.borderColor] : [])]), 16, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const textColors = frequent(raw.samples.map(sample => sample.color), 12, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const backgroundColors = frequent(raw.samples.map(sample => sample.backgroundColor), 12, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const pageBackgroundColors = frequent(raw.samples.filter(sample => ['html', 'body'].includes(sample.tag) || (sample.tag === 'main' && sample.rect.width >= raw.viewport.width * .75)).map(sample => sample.backgroundColor), 6, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const elevatedBackgroundColors = frequent(raw.samples.filter(isElevatedSurface).map(sample => sample.backgroundColor), 8, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const borderColors = frequent(raw.samples.filter(hasVisibleBorder).map(sample => sample.borderColor), 12, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const accentColors = frequent(raw.samples.filter(sample => ['a', 'button'].includes(sample.tag) || ['button', 'link', 'tab'].includes(sample.role ?? '')).flatMap(sample => [sample.color, sample.backgroundColor, ...(hasVisibleBorder(sample) ? [sample.borderColor] : [])]), 10, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const accentBackgroundColors = frequent(raw.samples.filter(sample => sample.tag === 'button' || ['button', 'tab'].includes(sample.role ?? '')).map(sample => sample.backgroundColor), 10, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const accentTextColors = frequent(raw.samples.filter(sample => sample.tag === 'button' || ['button', 'tab'].includes(sample.role ?? '')).map(sample => sample.color), 10, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const fonts = frequent(raw.samples.map(sample => sample.fontFamily.split(',')[0]?.replace(/["']/g, '') ?? ''), 8)
  const fontSizes = frequent(raw.samples.map(sample => sample.fontSize ?? ''), 12, value => pixels.test(value))
  const fontWeights = frequent(raw.samples.map(sample => sample.fontWeight ?? ''), 10, value => value !== '')
  const lineHeights = frequent(raw.samples.map(sample => sample.lineHeight ?? ''), 12, value => value === 'normal' || pixels.test(value))
  const letterSpacings = frequent(raw.samples.map(sample => sample.letterSpacing ?? ''), 10, value => value === 'normal' || /^-?\d+(?:\.\d+)?px$/.test(value))
  const textStyles = frequentTextStyles(raw.samples, 20)
  const radius = frequent(raw.samples.flatMap(sample => sample.borderRadius.split(/\s+/)), 8, value => pixels.test(value) && value !== '0px')
  const spacing = frequent(raw.samples.flatMap(sample => `${sample.padding} ${sample.margin} ${sample.gap}`.split(/\s+/)), 16, value => pixels.test(value) && value !== '0px')
  const borderedSamples = raw.samples.filter(hasVisibleBorder)
  const borderWidths = frequent(borderedSamples.flatMap(sample => (sample.borderWidth ?? '').split(/\s+/)), 8, value => pixels.test(value) && value !== '0px')
  const borderStyles = frequent(borderedSamples.flatMap(sample => (sample.borderStyle ?? '').split(/\s+/)), 8, value => ['solid', 'dashed', 'dotted', 'double'].includes(value))
  const shadows = frequent(raw.samples.map(sample => sample.boxShadow ?? ''), 8, value => value !== '' && value !== 'none')
  const gradients = frequent(raw.samples.map(sample => sample.backgroundImage ?? ''), 8, value => /gradient\(/i.test(value))
  const opacities = frequent(raw.samples.map(sample => sample.opacity ?? ''), 8, value => /^\d*(?:\.\d+)?$/.test(value) && value !== '1')
  const controlHeights = frequent(raw.samples.filter(sample => ['button', 'input', 'select', 'textarea'].includes(sample.tag) || ['button', 'textbox', 'combobox'].includes(sample.role ?? '')).map(sample => `${sample.rect.height}px`), 8, value => pixels.test(value))
  const buttonHeights = frequent(raw.samples.filter(sample => sample.tag === 'button' || sample.role === 'button').map(sample => `${sample.rect.height}px`), 8, value => pixels.test(value))
  // Textarea height is content-oriented and must not redefine the height of
  // ordinary single-line inputs in generated prototypes.
  const inputHeights = frequent(raw.samples.filter(sample => ['input', 'select'].includes(sample.tag) || ['textbox', 'combobox', 'searchbox'].includes(sample.role ?? '')).map(sample => `${sample.rect.height}px`), 8, value => pixels.test(value))
  const contentWidths = frequent(raw.samples.filter(sample => ['main', 'nav', 'header', 'footer', 'form'].includes(sample.tag) && sample.rect.width >= 240 && sample.rect.width <= raw.viewport.width).map(sample => `${sample.rect.width}px`), 8, value => pixels.test(value))
  // Bitmap avatars/thumbnails and large SVG illustrations are image evidence,
  // not icon evidence. Only small SVG or an explicit small icon role can tune
  // the trusted renderer's built-in icon size.
  const iconSizes = frequent(raw.samples.filter(isIconSample).map(sample => `${Math.round(Math.max(sample.rect.width, sample.rect.height))}px`), 8, value => pixels.test(value))
  const componentKinds = frequent(raw.samples.map(componentKind).filter((value): value is string => value !== undefined), 20)
  // A selector proves that a state is declared, not that its visual values were
  // observed. Keep only current-DOM states in trusted design tokens.
  const componentStates = frequent(raw.samples.flatMap(sample => sample.state === undefined ? [] : sample.state.split(',').map(state => `${componentKind(sample) ?? sample.tag}:${state}`)), 24)
  const componentSamples = capturedComponentSamples(raw.samples)
  const motionDurations = frequent(raw.samples.flatMap(sample => (sample.transitionDuration ?? '').split(',').map(value => value.trim())), 8, nonZeroDuration)
  const motionEasings = frequent(activeMotionEasings(raw.samples), 8)
  const layoutPatterns = frequent(raw.samples.flatMap(sample => {
    if (sample.position === 'sticky') return ['sticky']
    if (['grid', 'inline-grid'].includes(sample.display ?? '')) return ['grid']
    if (['flex', 'inline-flex'].includes(sample.display ?? '')) return [sample.flexDirection?.startsWith('column') ? 'flex-column' : 'flex-row']
    return sample.display === 'block' ? ['block'] : []
  }), 8, value => ['block', 'flex-row', 'flex-column', 'grid', 'sticky'].includes(value)) as NonNullable<ReferenceEvidenceV1['designTokens']['layoutPatterns']>
  const responsiveBreakpoints = [...new Set((raw.responsiveBreakpoints ?? []).filter(value => Number.isFinite(value) && value >= 240 && value <= 7_680).map(Math.round))].sort((left, right) => left - right).slice(0, 12)
  const focusStyleCounts = new Map<string, { value: NonNullable<ReferenceEvidenceV1['designTokens']['focusStyles']>[number]; count: number }>()
  for (const sample of [...raw.samples, ...(raw.declaredFocusStyles ?? []).map(style => ({ outlineWidth: style.width, outlineStyle: style.style, outlineColor: style.color, outlineOffset: style.offset } as CapturedStyleSample))]) {
    if (!pixels.test(sample.outlineWidth ?? '') || Number.parseFloat(sample.outlineWidth ?? '0') <= 0 || !['solid', 'dashed', 'dotted'].includes(sample.outlineStyle ?? '') || !cssColor.test(sample.outlineColor ?? '') || !/^-?\d+(?:\.\d+)?px$/.test(sample.outlineOffset ?? '')) continue
    const value = { width: sample.outlineWidth!, style: sample.outlineStyle as 'solid' | 'dashed' | 'dotted', color: sample.outlineColor!, offset: sample.outlineOffset! }
    const key = JSON.stringify(value); const existing = focusStyleCounts.get(key); focusStyleCounts.set(key, { value, count: (existing?.count ?? 0) + 1 })
  }
  const focusStyles = [...focusStyleCounts.values()].sort((left, right) => right.count - left.count).slice(0, 8).map(item => item.value)
  const surfaceCount = raw.samples.filter(sample => sample.backgroundColor !== 'rgba(0, 0, 0, 0)').length
  const captureCoverage = raw.captureCoverage ?? { candidateElements: raw.samples.length, inspectedElements: raw.samples.length, sampledElements: raw.samples.length, accessibleStylesheets: 0, opaqueStylesheets: 0, iframeElements: 0, unloadedImages: 0, horizontalOverflow: raw.pageSize.width > raw.viewport.width + 1, limitations: ['旧版采集没有记录样式表、iframe、图片加载和元素丢弃范围；请重新提取以获得完整覆盖说明。'] }
  const declaredStates = [...new Set((raw.declaredInteractionStates ?? []).filter(state => ['hover', 'active', 'focus-visible', 'focus', 'disabled', 'checked', 'selected'].includes(state)))].slice(0, 16)
  if (declaredStates.length > 0) captureCoverage.limitations = [...captureCoverage.limitations, `CSS 声明了 ${declaredStates.join('、')} 状态，但采集未触发这些状态，未记录其视觉值。`].slice(0, 12)
  const observations = [
    `当前视口为 ${raw.viewport.width}×${raw.viewport.height}，完整页面为 ${raw.pageSize.width}×${raw.pageSize.height}，已跨 ${raw.pageSize.sampledBands} 个纵向区域采集 ${raw.samples.length} 个设计元素。`,
    `候选元素 ${captureCoverage.candidateElements} 个，检查 ${captureCoverage.inspectedElements} 个；读取 ${captureCoverage.accessibleStylesheets} 个样式表，另有 ${captureCoverage.opaqueStylesheets} 个样式表无法读取。`,
    `页面主要使用 ${colors.slice(0, 5).join('、') || '未识别到稳定色板'}。`,
    `页面主要字体为 ${fonts.slice(0, 3).join('、') || '未识别到稳定字体'}。`,
    `常用字号为 ${fontSizes.slice(0, 6).join('、') || '未识别'}；字重为 ${fontWeights.slice(0, 5).join('、') || '未识别'}；行高为 ${lineHeights.slice(0, 5).join('、') || '未识别'}。`,
    `检测到 ${surfaceCount} 个具有可见背景的区域；常用圆角为 ${radius.slice(0, 4).join('、') || '0px'}。`,
    `常用间距为 ${spacing.slice(0, 8).join('、') || '未识别'}；边框宽度为 ${borderWidths.slice(0, 4).join('、') || '0px'}。`,
    `视觉效果包含 ${shadows.length} 种投影、${gradients.length} 种渐变和 ${motionDurations.length} 种动效时长。`,
    `布局中识别到 ${layoutPatterns.join('、') || '常规文档流'}；样式表暴露 ${responsiveBreakpoints.length} 个响应式断点；识别到 ${focusStyles.length} 组键盘焦点样式。`,
  ]
  const screenshotFingerprint = await sha256(screenshotDataUrl)
  const content = { v: 1 as const, source: { ...raw.source, capturedAt: capturedAt.toISOString() }, viewport: raw.viewport, pageSize: raw.pageSize, captureCoverage, observations, designTokens: { colors, fonts, radius, spacing, textColors, backgroundColors, pageBackgroundColors, elevatedBackgroundColors, borderColors, accentColors, accentBackgroundColors, accentTextColors, fontSizes, fontWeights, lineHeights, letterSpacings, textStyles, borderWidths, borderStyles, shadows, gradients, opacities, controlHeights, buttonHeights, inputHeights, contentWidths, iconSizes, componentKinds, componentStates, componentSamples, motionDurations, motionEasings, layoutPatterns, responsiveBreakpoints, focusStyles }, screenshotFingerprint }
  const evidence: ReferenceEvidenceV1 = {
    ...content,
    id: `ref-${crypto.randomUUID()}`,
    fingerprint: await computeReferenceEvidenceFingerprint(content),
    screenshotDataUrl,
  }
  const checked = validateReferenceEvidence(evidence)
  if (!checked.ok) throw new Error(checked.errors[0])
  return checked.value
}
