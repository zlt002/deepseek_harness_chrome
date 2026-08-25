import type { DesignSpecV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { designSpecColor, motionDurationMilliseconds } from './design-spec-tweaks'

interface Color { red: number; green: number; blue: number; alpha: number }

function color(value: string): Color | undefined {
  const hex = value.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1]
  if (hex !== undefined) {
    const expanded = hex.length <= 4 ? [...hex].map(item => item + item).join('') : hex
    return { red: Number.parseInt(expanded.slice(0, 2), 16), green: Number.parseInt(expanded.slice(2, 4), 16), blue: Number.parseInt(expanded.slice(4, 6), 16), alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1 }
  }
  const rgb = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?%?))?\s*\)$/i)
  if (rgb === null) return undefined
  const alphaValue = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4])
  if (![rgb[1], rgb[2], rgb[3]].every(item => Number.isFinite(Number(item))) || !Number.isFinite(alphaValue) || alphaValue < 0 || alphaValue > 1) return undefined
  return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]), alpha: alphaValue }
}

function luminance(value: Pick<Color, 'red' | 'green' | 'blue'>): number {
  const linear = [value.red, value.green, value.blue].map(channel => { const normalized = Math.min(255, Math.max(0, channel)) / 255; return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
}

function contrast(left: string, right: string): number | undefined {
  const foreground = color(left); const background = color(right)
  if (foreground === undefined || background === undefined || background.alpha !== 1) return undefined
  const composited = foreground.alpha === 1 ? foreground : { red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha), green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha), blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha) }
  const a = luminance(composited); const b = luminance(background)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

function contrastWarning(label: string, left: string, right: string, minimum: number): string | undefined {
  const ratio = contrast(left, right)
  return ratio === undefined ? `${label}包含无法可靠合成的半透明或未知颜色，请确认对比度。` : ratio >= minimum ? undefined : `${label}对比度 ${ratio.toFixed(1)}:1，建议至少 ${minimum}:1`
}

function contrastAgainst(label: string, foreground: string, backgrounds: Array<[string, string]>, minimum: number): string[] {
  return backgrounds
    .map(([backgroundLabel, background]) => contrastWarning(`${label}在${backgroundLabel}上`, foreground, background, minimum))
    .filter((item): item is string => item !== undefined)
}

export function designSpecQualityWarnings(spec: DesignSpecV1): string[] {
  const page = designSpecColor(spec, 'page')
  const surface = designSpecColor(spec, 'surface')
  const elevated = designSpecColor(spec, 'elevated')
  const contentBackgrounds: Array<[string, string]> = [['页面背景', page], ['内容表面', surface], ['浮层表面', elevated]]
  const warnings = [
    contrastWarning('主要按钮文字', designSpecColor(spec, 'onPrimary'), designSpecColor(spec, 'primary'), 4.5),
    ...contrastAgainst('正文', designSpecColor(spec, 'text'), contentBackgrounds, 4.5),
    ...contrastAgainst('辅助文字', designSpecColor(spec, 'textMuted'), contentBackgrounds, 3),
    ...contrastAgainst('主要操作色', designSpecColor(spec, 'primary'), contentBackgrounds, 3),
    ...contrastAgainst('键盘焦点环', designSpecColor(spec, 'focus'), contentBackgrounds, 3),
    ...contrastAgainst('信息状态', designSpecColor(spec, 'info'), [['内容表面', surface], ['浮层表面', elevated]], 3),
    ...contrastAgainst('成功状态', designSpecColor(spec, 'positive'), [['内容表面', surface], ['浮层表面', elevated]], 3),
    ...contrastAgainst('警告状态', designSpecColor(spec, 'warning'), [['内容表面', surface], ['浮层表面', elevated]], 3),
    ...contrastAgainst('危险状态', designSpecColor(spec, 'danger'), [['内容表面', surface], ['浮层表面', elevated]], 3),
  ].filter((item): item is string => item !== undefined)
  if (spec.typography.bodySize < 12) warnings.push(`正文字号只有 ${spec.typography.bodySize}px，长文本可能难以阅读`)
  const buttonHeight = spec.controls?.buttonHeight ?? spec.controls?.height
  if (buttonHeight !== undefined && buttonHeight < 32) warnings.push(`按钮高度只有 ${buttonHeight}px，可能难以点击`)
  const inputHeight = spec.controls?.inputHeight
  if (inputHeight !== undefined && inputHeight < 32) warnings.push(`输入框高度只有 ${inputHeight}px，可能难以操作`)
  const iconSize = spec.controls?.iconSize
  if (iconSize !== undefined && iconSize < 12) warnings.push(`图标尺寸只有 ${iconSize}px，可能难以识别`)
  if (iconSize !== undefined && iconSize > 48) warnings.push(`图标尺寸达到 ${iconSize}px，请确认没有把头像或插图误当成图标`)
  if (spec.focus !== undefined && spec.focus.width <= 0) warnings.push('键盘焦点描边为 0px，键盘用户可能看不到当前焦点')
  const disabledOpacity = spec.effects?.semantic?.disabledControlOpacity
  if (disabledOpacity !== undefined && disabledOpacity < .35) warnings.push(`禁用控件透明度只有 ${disabledOpacity}，文字和图标可能难以辨认`)
  if (spec.effects?.semantic?.primaryControlGradient !== undefined) warnings.push('主按钮使用渐变，单一主色的对比度不能代表整段渐变，请在右侧逐段检查按钮文字')
  const bodyLineHeight = spec.typography.bodyLineHeight
  if (bodyLineHeight !== undefined && bodyLineHeight < 1.2) warnings.push(`正文行高只有 ${bodyLineHeight} 倍，连续文字可能拥挤`)
  const headingSize = spec.typography.headingSize
  if (headingSize !== undefined && headingSize < spec.typography.bodySize) warnings.push(`标题字号 ${headingSize}px 小于正文字号 ${spec.typography.bodySize}px，信息层级可能颠倒`)
  const captionSize = spec.typography.captionSize
  if (captionSize !== undefined && captionSize > spec.typography.bodySize) warnings.push(`辅助字号 ${captionSize}px 大于正文字号 ${spec.typography.bodySize}px，请确认层级是否合理`)
  const headingLineHeight = spec.typography.headingLineHeight
  if (headingLineHeight !== undefined && headingLineHeight < 1) warnings.push(`标题行高只有 ${headingLineHeight} 倍，多行标题可能重叠`)
  const borderWidth = spec.borders?.width
  if (borderWidth !== undefined && borderWidth > 4) warnings.push(`边框宽度达到 ${borderWidth}px，普通卡片和输入框可能显得过重`)
  if (spec.spacing.base <= 0) warnings.push('基础间距为 0px，组件内容可能互相贴紧')
  const largeSpacing = spec.spacing.scale?.[3] ?? spec.spacing.base * 3
  const contentWidth = spec.spacing.contentWidth
  if (contentWidth !== undefined && contentWidth < 480) warnings.push(`内容宽度只有 ${contentWidth}px，桌面页面可能过窄`)
  if (contentWidth !== undefined && largeSpacing * 2 >= contentWidth) warnings.push(`大间距 ${largeSpacing}px 已接近或超过内容宽度 ${contentWidth}px 的一半，页面内容可能被挤压`)
  const controlDuration = spec.motion?.semantic?.controlDuration
  if (controlDuration !== undefined && motionDurationMilliseconds(controlDuration, 0) > 1_000) warnings.push(`控件动效时长为 ${controlDuration}，频繁操作时可能显得迟缓`)
  return [...new Set(warnings)]
}
