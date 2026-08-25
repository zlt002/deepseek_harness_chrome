import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleUnderTest() {
  const source = await readFile(new URL('./design-spec-tweaks.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}

const spec = () => ({
  v: 1, id: 'design-ref-one', name: '参考规范', basedOnEvidenceIds: ['ref-one'], summary: '参考网页设计规范',
  colors: [{ name: '主要操作色', value: '#3977e8', usage: '按钮' }, { name: '按钮文字', value: '#ffffff', usage: '按钮文字' }, { name: '页面背景', value: '#f5f6f8', usage: '页面' }, { name: '内容表面', value: '#ffffff', usage: '卡片' }, { name: '主要文字', value: '#283347', usage: '正文' }, { name: '次要文字', value: '#697386', usage: '说明' }, { name: '边框颜色', value: '#e2e5eb', usage: '边框' }],
  typography: { fontFamily: 'Inter', headingWeight: 700, bodyWeight: 400, bodySize: 14, headingSize: 28, captionSize: 12, fontSizeScale: [12, 14, 28], fontWeightScale: [400, 700], bodyLineHeight: 1.5, headingLineHeight: 1.15, letterSpacing: 0 },
  spacing: { base: 8, cardRadius: 8, scale: [4, 8, 16, 24], sectionGap: 32, contentWidth: 1080 },
  surfaces: { page: '#f5f6f8', surface: '#ffffff', elevated: '#ffffff', text: '#283347', textMuted: '#697386', border: '#e2e5eb' },
  borders: { width: 1, style: 'solid', radiusScale: [4, 8, 12] }, effects: { shadows: [], gradients: [], opacities: [] }, controls: { height: 36, buttonHeight: 36, inputHeight: 40, iconSize: 16, radius: 8 }, motion: { durations: ['160ms'], easings: ['ease-out'] }, principles: ['保持一致'],
})

test('applies bounded visual tweaks without changing evidence identity', async () => {
  const { applyDesignSpecTweak, designSpecTweakCount } = await moduleUnderTest()
  const original = spec()
  let draft = applyDesignSpecTweak(original, { key: 'primary', value: '#0057d9' })
  draft = applyDesignSpecTweak(draft, { key: 'bodySize', value: 16 })
  draft = applyDesignSpecTweak(draft, { key: 'spacingBase', value: 10 })
  draft = applyDesignSpecTweak(draft, { key: 'cardRadius', value: 12 })
  draft = applyDesignSpecTweak(draft, { key: 'controlRadius', value: 6 })
  assert.equal(draft.id, original.id)
  assert.deepEqual(draft.basedOnEvidenceIds, original.basedOnEvidenceIds)
  assert.equal(draft.colors[0].value, '#0057d9')
  assert.equal(draft.typography.bodySize, 16)
  assert.deepEqual(draft.spacing.scale, [5, 10, 20, 30])
  assert.deepEqual(draft.borders.radiusScale, [6, 12, 18])
  assert.equal(draft.controls.radius, 6)
  assert.equal(designSpecTweakCount(original, draft), 5)
})

test('counts user-facing categories and reports exactly which categories changed', async () => {
  const { applyDesignSpecTweak, designSpecChangedGroups, designSpecTweakCount } = await moduleUnderTest()
  const original = spec()
  const changedPage = applyDesignSpecTweak(original, { key: 'page', value: '#f0f2f5' })
  assert.equal(designSpecTweakCount(original, changedPage), 1)
  assert.deepEqual([...designSpecChangedGroups(original, changedPage)], ['colors'])
  const changedRadius = applyDesignSpecTweak(changedPage, { key: 'cardRadius', value: 12 })
  assert.deepEqual([...designSpecChangedGroups(original, changedRadius)], ['colors', 'layout', 'borders'])
})

test('clamps unsafe numeric values and ignores executable color input', async () => {
  const { applyDesignSpecTweak, colorInputValue } = await moduleUnderTest()
  const original = spec()
  assert.equal(applyDesignSpecTweak(original, { key: 'primary', value: 'red; background:url(x)' }), original)
  assert.equal(applyDesignSpecTweak(original, { key: 'contentWidth', value: 9_999 }).spacing.contentWidth, 3_840)
  assert.equal(applyDesignSpecTweak(original, { key: 'bodyLineHeight', value: 9 }).typography.bodyLineHeight, 3)
  assert.equal(colorInputValue('rgb(31, 35, 40)'), '#1f2328')
})

test('toggles bounded effects and motion values only', async () => {
  const { applyDesignSpecTweak, motionDurationMilliseconds } = await moduleUnderTest()
  let draft = applyDesignSpecTweak(spec(), { key: 'shadowEnabled', value: true })
  draft = applyDesignSpecTweak(draft, { key: 'elevatedShadowEnabled', value: true })
  draft = applyDesignSpecTweak(draft, { key: 'gradientEnabled', value: true })
  draft = applyDesignSpecTweak(draft, { key: 'effectOpacity', value: 0.65 })
  draft = applyDesignSpecTweak(draft, { key: 'motionDuration', value: 240 })
  draft = applyDesignSpecTweak(draft, { key: 'motionEasing', value: 'ease-in-out' })
  assert.match(draft.effects.shadows[0], /0 8px 24px/)
  assert.equal(draft.effects.semantic.elevatedShadow, draft.effects.shadows[0])
  assert.match(draft.effects.gradients[0], /^linear-gradient/)
  assert.deepEqual(draft.effects.opacities, [0.65])
  assert.equal(draft.effects.semantic.disabledControlOpacity, 0.65)
  assert.deepEqual(draft.motion.durations, ['160ms', '240ms'])
  assert.deepEqual(draft.motion.easings, ['ease-out', 'ease-in-out'])
  assert.deepEqual(draft.motion.semantic, { controlDuration: '240ms', controlEasing: 'ease-in-out' })
  assert.equal(motionDurationMilliseconds('0.2s'), 200)
  assert.equal(motionDurationMilliseconds('240ms'), 240)
  assert.equal(motionDurationMilliseconds('invalid'), 160)
  draft = applyDesignSpecTweak(draft, { key: 'elevatedShadowEnabled', value: false })
  assert.equal(draft.effects.semantic.elevatedShadow, undefined)
})

test('adjusts elevated surfaces and bounded responsive breakpoints', async () => {
  const { applyDesignSpecTweak, designSpecColor } = await moduleUnderTest()
  let draft = applyDesignSpecTweak(spec(), { key: 'elevated', value: '#fefefe' })
  draft = { ...draft, responsive: { breakpoints: [640, 768, 1_024], layoutPatterns: ['grid'] } }
  draft = applyDesignSpecTweak(draft, { key: 'mobileBreakpoint', value: 720 })
  draft = applyDesignSpecTweak(draft, { key: 'desktopBreakpoint', value: 1_280 })
  draft = applyDesignSpecTweak(draft, { key: 'focusStyle', value: 'dashed' })
  assert.equal(designSpecColor(draft, 'elevated'), '#fefefe')
  assert.deepEqual(draft.responsive.breakpoints, [720, 768, 1_280])
  assert.equal(draft.focus.style, 'dashed')
})

test('rejects reversed responsive breakpoints instead of silently swapping their meaning', async () => {
  const { applyDesignSpecTweak } = await moduleUnderTest()
  const original = { ...spec(), responsive: { breakpoints: [720, 768, 1_024], layoutPatterns: ['grid'] } }
  assert.equal(applyDesignSpecTweak(original, { key: 'desktopBreakpoint', value: 700 }), original)
  assert.equal(applyDesignSpecTweak(original, { key: 'mobileBreakpoint', value: 1_100 }), original)
  assert.deepEqual(applyDesignSpecTweak(original, { key: 'desktopBreakpoint', value: 1_280 }).responsive.breakpoints, [720, 768, 1_280])
})
