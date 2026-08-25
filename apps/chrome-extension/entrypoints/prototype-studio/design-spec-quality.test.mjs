import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from '../../../../test/helpers/bundle-typescript.mjs'

async function moduleUnderTest() {
  const sourceUrl = new URL('./design-spec-quality.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const compiled = await bundleTypescript(source, sourceUrl)
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}-${Math.random()}`)
}

function spec(primary = '#2563eb', onPrimary = '#ffffff') {
  return { v: 1, id: 'design-one', name: '规范', basedOnEvidenceIds: ['ref-one'], summary: '规范', colors: [{ name: '主要操作色', value: primary, usage: '按钮' }, { name: '按钮文字', value: onPrimary, usage: '按钮文字' }, { name: '页面背景', value: '#ffffff', usage: '页面' }, { name: '主要文字', value: '#111827', usage: '正文' }, { name: '次要文字', value: '#64748b', usage: '说明' }, { name: '信息色', value: '#2563eb', usage: '信息' }, { name: '成功色', value: '#16805c', usage: '成功' }, { name: '警告色', value: '#8a5b08', usage: '警告' }, { name: '危险色', value: '#a33c35', usage: '危险' }], typography: { fontFamily: 'Inter', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, surfaces: { page: '#ffffff', surface: '#ffffff', elevated: '#ffffff', text: '#111827', textMuted: '#64748b', border: '#e2e8f0' }, controls: { height: 38, buttonHeight: 38, inputHeight: 38, iconSize: 16, radius: 8 }, principles: ['清晰'] }
}

test('reports actionable readability warnings instead of silently confirming', async () => {
  const { designSpecQualityWarnings } = await moduleUnderTest()
  const poor = spec('#fff7cc', '#ffffff'); poor.typography.bodySize = 10; poor.controls.buttonHeight = 28
  const warnings = designSpecQualityWarnings(poor)
  assert.equal(warnings.some(item => /主要按钮文字对比度/.test(item)), true)
  assert.equal(warnings.some(item => /正文字号只有 10px/.test(item)), true)
  assert.equal(warnings.some(item => /按钮高度只有 28px/.test(item)), true)
  assert.deepEqual(designSpecQualityWarnings(spec()), [])
})

test('checks content surfaces, focus visibility, semantic controls, and body rhythm', async () => {
  const { designSpecQualityWarnings } = await moduleUnderTest()
  const poor = spec()
  poor.surfaces.surface = '#111827'
  poor.surfaces.elevated = '#1f2937'
  poor.surfaces.text = '#111827'
  poor.surfaces.textMuted = '#1f2937'
  poor.focus = { width: 2, style: 'solid', color: '#ffffff', offset: 2 }
  poor.typography.bodyLineHeight = 1.05
  const warnings = designSpecQualityWarnings(poor)
  assert.equal(warnings.some(item => /正文在内容表面上对比度/.test(item)), true)
  assert.equal(warnings.some(item => /辅助文字在浮层表面上对比度/.test(item)), true)
  assert.equal(warnings.some(item => /键盘焦点环在页面背景上对比度/.test(item)), true)
  assert.equal(warnings.some(item => /正文行高只有 1\.05 倍/.test(item)), true)
})

test('composites translucent foregrounds and requires confirmation for unknown backdrops', async () => {
  const { designSpecQualityWarnings } = await moduleUnderTest()
  const translucent = spec(); translucent.surfaces.text = 'rgba(0, 0, 0, 0.4)'
  assert.equal(designSpecQualityWarnings(translucent).some(item => /正文在页面背景上对比度 2\.8:1/.test(item)), true)
  const uncertain = spec(); uncertain.surfaces.page = 'rgba(255, 255, 255, 0.8)'
  assert.equal(designSpecQualityWarnings(uncertain).some(item => /正文在页面背景上包含无法可靠合成/.test(item)), true)
})

test('checks every semantic status and suspicious component values', async () => {
  const { designSpecQualityWarnings } = await moduleUnderTest()
  const poor = spec()
  poor.colors = poor.colors.map(item => ['信息色', '成功色', '警告色'].includes(item.name) ? { ...item, value: '#f8fafc' } : item)
  poor.controls.iconSize = 64
  poor.focus = { width: 0, style: 'solid', color: '#2563eb', offset: 2 }
  poor.effects = { shadows: [], gradients: ['linear-gradient(90deg,#2563eb,#ffffff)'], opacities: [.2], semantic: { disabledControlOpacity: .2, primaryControlGradient: 'linear-gradient(90deg,#2563eb,#ffffff)' } }
  const warnings = designSpecQualityWarnings(poor)
  for (const label of ['信息状态', '成功状态', '警告状态']) assert.equal(warnings.some(item => item.includes(label)), true)
  assert.equal(warnings.some(item => /头像或插图误当成图标/.test(item)), true)
  assert.equal(warnings.some(item => /焦点描边为 0px/.test(item)), true)
  assert.equal(warnings.some(item => /禁用控件透明度只有 0\.2/.test(item)), true)
  assert.equal(warnings.some(item => /主按钮使用渐变/.test(item)), true)
  const crowded = spec(); crowded.spacing = { ...crowded.spacing, scale: [8, 40, 80, 160], contentWidth: 240 }
  assert.equal(designSpecQualityWarnings(crowded).some(item => /页面内容可能被挤压/.test(item)), true)
})

test('checks visual hierarchy, density, borders, and motion before confirmation', async () => {
  const { designSpecQualityWarnings } = await moduleUnderTest()
  const poor = spec()
  poor.typography = { ...poor.typography, headingSize: 12, captionSize: 18, headingLineHeight: .9 }
  poor.spacing = { ...poor.spacing, base: 0, contentWidth: 360 }
  poor.borders = { width: 6, style: 'solid', radiusScale: [8] }
  poor.motion = { durations: ['1600ms'], easings: ['ease'], semantic: { controlDuration: '1600ms', controlEasing: 'ease' } }
  const warnings = designSpecQualityWarnings(poor)
  for (const expected of ['信息层级可能颠倒', '辅助字号 18px', '多行标题可能重叠', '边框宽度达到 6px', '基础间距为 0px', '桌面页面可能过窄', '频繁操作时可能显得迟缓']) {
    assert.equal(warnings.some(item => item.includes(expected)), true, expected)
  }
})
