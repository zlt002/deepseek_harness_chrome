import { validateReferenceEvidence, type ReferenceEvidenceV1 } from '../../../packages/harness-ui-prototype-studio/src/prototype-document'

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
  borderRadius: string
  padding: string
  margin: string
  gap: string
  boxShadow: string
}

export interface CapturedDesignReferencePage {
  v: 1
  source: { url: string; title: string }
  viewport: { width: number; height: number; deviceScaleFactor: number }
  samples: CapturedStyleSample[]
}

/** Runs in the selected page through chrome.scripting.executeScript. */
export function captureDesignReferencePage(): CapturedDesignReferencePage {
  const bounded = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max)
  const safeUrl = (): string => {
    try { return `${location.origin}${location.pathname}` } catch { return '' }
  }
  const relevant = new Set(['A', 'ARTICLE', 'ASIDE', 'BUTTON', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'HEADER', 'INPUT', 'LABEL', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'SELECT', 'TEXTAREA'])
  const samples: CapturedStyleSample[] = []
  for (const element of Array.from(document.body?.querySelectorAll<HTMLElement>('*') ?? [])) {
    if (samples.length >= 240) break
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
    const role = element.getAttribute('role') ?? undefined
    const text = bounded(element.innerText ?? element.getAttribute('aria-label') ?? '', 240)
    const hasVisualSurface = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none' || style.borderRadius !== '0px'
    if (!relevant.has(element.tagName) && role === undefined && text === '' && !hasVisualSurface) continue
    samples.push({
      tag: element.tagName.toLowerCase(),
      ...(role === undefined ? {} : { role: bounded(role, 48) }),
      ...(text === '' ? {} : { text }),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      fontFamily: bounded(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      borderRadius: style.borderRadius,
      padding: style.padding,
      margin: style.margin,
      gap: style.gap,
      boxShadow: bounded(style.boxShadow, 240),
    })
  }
  return {
    v: 1,
    source: { url: safeUrl(), title: bounded(document.title, 240) },
    viewport: { width: Math.max(1, Math.round(innerWidth)), height: Math.max(1, Math.round(innerHeight)), deviceScaleFactor: Math.max(0.25, Math.min(8, devicePixelRatio || 1)) },
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

function isCapturedPage(value: unknown): value is CapturedDesignReferencePage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const capture = value as Partial<CapturedDesignReferencePage>
  return capture.v === 1 && typeof capture.source?.url === 'string' && /^https?:\/\//.test(capture.source.url)
    && typeof capture.source.title === 'string' && typeof capture.viewport?.width === 'number' && typeof capture.viewport.height === 'number'
    && typeof capture.viewport.deviceScaleFactor === 'number' && Array.isArray(capture.samples) && capture.samples.length <= 240
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Converts raw page observations into the only bounded evidence shown to the model. */
export async function buildReferenceEvidence(raw: unknown, screenshotDataUrl: string, capturedAt = new Date()): Promise<ReferenceEvidenceV1> {
  if (!isCapturedPage(raw) || raw.samples.length === 0) throw new Error('The selected page exposed no bounded visual evidence.')
  if (!/^data:image\/(png|jpeg);base64,/.test(screenshotDataUrl) || screenshotDataUrl.length > 2_000_000) throw new Error('The visible-page screenshot is missing or too large.')
  const colors = frequent(raw.samples.flatMap(sample => [sample.color, sample.backgroundColor, sample.borderColor]), 16, value => cssColor.test(value) && value !== 'rgba(0, 0, 0, 0)')
  const fonts = frequent(raw.samples.map(sample => sample.fontFamily.split(',')[0]?.replace(/["']/g, '') ?? ''), 8)
  const radius = frequent(raw.samples.flatMap(sample => sample.borderRadius.split(/\s+/)), 8, value => pixels.test(value) && value !== '0px')
  const spacing = frequent(raw.samples.flatMap(sample => `${sample.padding} ${sample.margin} ${sample.gap}`.split(/\s+/)), 10, value => pixels.test(value) && value !== '0px')
  const surfaceCount = raw.samples.filter(sample => sample.backgroundColor !== 'rgba(0, 0, 0, 0)').length
  const observations = [
    `当前视口为 ${raw.viewport.width}×${raw.viewport.height}，共采集 ${raw.samples.length} 个可见设计元素。`,
    `页面主要使用 ${colors.slice(0, 5).join('、') || '未识别到稳定色板'}。`,
    `页面主要字体为 ${fonts.slice(0, 3).join('、') || '未识别到稳定字体'}。`,
    `检测到 ${surfaceCount} 个具有可见背景的区域；常用圆角为 ${radius.slice(0, 4).join('、') || '0px'}。`,
  ]
  const screenshotFingerprint = await sha256(screenshotDataUrl)
  const content = { v: 1 as const, source: raw.source, viewport: raw.viewport, observations, designTokens: { colors, fonts, radius, spacing }, screenshotFingerprint }
  const evidence: ReferenceEvidenceV1 = {
    ...content,
    id: `ref-${crypto.randomUUID()}`,
    source: { ...raw.source, capturedAt: capturedAt.toISOString() },
    fingerprint: await sha256(JSON.stringify(content)),
    screenshotDataUrl,
  }
  const checked = validateReferenceEvidence(evidence)
  if (!checked.ok) throw new Error(checked.errors[0])
  return checked.value
}
