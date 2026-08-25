import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function designSystemModule() {
  const source = await readFile(new URL('./design-system.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(js)}#${Date.now()}-${Math.random()}`)
}

function evidence(designTokens) {
  return {
    v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考产品', capturedAt: '2026-08-24T00:00:00.000Z' },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, pageSize: { width: 1280, height: 2800, sampledBands: 4 }, observations: ['整页分区采集'], designTokens,
    fingerprint: 'a'.repeat(64),
  }
}

test('creates one deterministic complete design spec from captured evidence', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['rgb(40, 51, 71)', 'rgb(57, 119, 232)'], fonts: ['Inter'], radius: ['8px', '12px'], spacing: ['4px', '8px', '16px', '24px'],
    textColors: ['rgb(40, 51, 71)', 'rgb(105, 115, 134)'], backgroundColors: ['rgb(255, 255, 255)', 'rgb(245, 246, 248)'], pageBackgroundColors: ['rgb(245, 246, 248)'], elevatedBackgroundColors: ['rgb(252, 252, 253)'], borderColors: ['rgb(226, 229, 235)'], accentColors: ['rgb(57, 119, 232)'],
    accentBackgroundColors: ['rgb(57, 119, 232)'], accentTextColors: ['rgb(255, 255, 255)'],
    fontSizes: ['12px', '14px', '28px'], fontWeights: ['400', '650'], lineHeights: ['20px', '32px'], letterSpacings: ['0px'], textStyles: [{ kind: 'body', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '0px' }, { kind: 'heading', fontSize: '28px', fontWeight: '650', lineHeight: '32px', letterSpacing: '0px' }], borderWidths: ['1px'], borderStyles: ['solid'], shadows: [], gradients: [], opacities: [], controlHeights: ['40px'], buttonHeights: ['36px'], inputHeights: ['44px'], contentWidths: ['1080px'], iconSizes: ['20px'], componentKinds: ['button', 'table'], componentStates: ['button:disabled'], motionDurations: ['160ms'], motionEasings: ['ease-out'], layoutPatterns: ['flex-row', 'grid'], responsiveBreakpoints: [640, 768, 1024], focusStyles: [{ width: '2px', style: 'solid', color: 'rgb(57, 119, 232)', offset: '2px' }],
  }))
  assert.equal(result.basedOnEvidenceIds[0], 'ref-one')
  assert.equal(result.colors[0].value, 'rgb(57, 119, 232)')
  assert.equal(result.controls.height, 36)
  assert.equal(result.controls.inputHeight, 44)
  assert.equal(result.controls.iconSize, 20)
  assert.equal(result.typography.bodyLineHeight, 20 / 14)
  assert.equal(result.typography.headingLineHeight, 32 / 28)
  assert.deepEqual(result.typography.fontSizeScale, [12, 14, 28])
  assert.deepEqual(result.typography.fontWeightScale, [400, 650])
  assert.deepEqual(result.typography.lineHeightScale, [20, 32])
  assert.equal(result.spacing.contentWidth, 1080)
  assert.equal(result.spacing.cardRadius, 8)
  assert.deepEqual(result.responsive.breakpoints, [640, 768, 1024])
  assert.deepEqual(result.responsive.layoutPatterns, ['flex-row', 'grid'])
  assert.deepEqual(result.focus, { width: 2, style: 'solid', color: 'rgb(57, 119, 232)', offset: 2 })
  assert.equal(result.surfaces.page, 'rgb(245, 246, 248)')
  assert.equal(result.surfaces.surface, 'rgb(255, 255, 255)')
  assert.equal(result.surfaces.elevated, 'rgb(252, 252, 253)')
  assert.deepEqual(result.colors.slice(7, 11).map(item => item.name), ['信息色', '成功色', '警告色', '危险色'])
  assert.match(result.summary, /浅色、紧凑、8px 中等圆角、扁平弱层级/)
})

test('reports observed, inferred, and default provenance without pretending defaults were captured', async () => {
  const { designEvidenceCoverage } = await designSystemModule()
  const full = designEvidenceCoverage(evidence({ colors: ['#fff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'], textColors: ['#111'], backgroundColors: ['#fff'], pageBackgroundColors: ['#fff'], borderColors: ['#ddd'], fontSizes: ['14px'], fontWeights: ['400'], lineHeights: ['20px'], borderWidths: ['1px'], shadows: [], gradients: [], controlHeights: [], motionDurations: [], motionEasings: [] }))
  assert.equal(full.find(item => item.id === 'colors').status, 'observed')
  assert.equal(full.find(item => item.id === 'surfaces').status, 'inferred')
  assert.equal(full.find(item => item.id === 'feedback-colors').status, 'default')
  assert.equal(full.find(item => item.id === 'controls').status, 'inferred')
  assert.equal(full.find(item => item.id === 'responsive').status, 'default')
  assert.equal(full.find(item => item.id === 'focus').status, 'default')
  assert.equal(full.find(item => item.id === 'components').status, 'default')
  assert.equal(full.find(item => item.id === 'font-assets').status, 'inferred')
  assert.match(full.find(item => item.id === 'font-assets').detail, /不复制网页字体文件/)
  assert.equal(full.find(item => item.id === 'visual-assets').status, 'default')
  assert.equal(full.find(item => item.id === 'motion').status, 'default')
  const responsive = designEvidenceCoverage(evidence({ colors: ['#fff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'], responsiveBreakpoints: [640, 1024] }))
  assert.equal(responsive.find(item => item.id === 'responsive').status, 'inferred')
  assert.match(responsive.find(item => item.id === 'responsive').detail, /从 CSS 规则提取，尚未多尺寸实测/)
  const legacy = designEvidenceCoverage(evidence({ colors: ['#fff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'] }))
  assert.equal(legacy.find(item => item.id === 'surfaces').status, 'default')
  assert.equal(legacy.find(item => item.id === 'typography').status, 'default')
  assert.equal(legacy.find(item => item.id === 'effects').status, 'default')
})

test('does not label empty extracted token arrays or CSS-only focus rules as webpage measurements', async () => {
  const { designEvidenceCoverage } = await designSystemModule()
  const coverage = designEvidenceCoverage(evidence({
    colors: [], fonts: [], radius: [], spacing: [], textColors: [], backgroundColors: [], pageBackgroundColors: [], borderColors: [],
    fontSizes: [], fontWeights: [], lineHeights: [], textStyles: [], borderWidths: [], contentWidths: [], layoutPatterns: [],
    componentKinds: [], componentStates: [], motionDurations: [], motionEasings: [], focusStyles: [{ width: '2px', style: 'solid', color: '#3977e8', offset: '2px' }],
  }))
  for (const id of ['colors', 'surfaces', 'typography', 'borders', 'components', 'motion']) assert.equal(coverage.find(item => item.id === id).status, 'default', `${id} must not treat an empty list as observed evidence`)
  assert.equal(coverage.find(item => item.id === 'layout').status, 'inferred')
  assert.equal(coverage.find(item => item.id === 'focus').status, 'inferred')
  assert.match(coverage.find(item => item.id === 'focus').detail, /未逐个主动触发/)
})

test('keeps semantic color names stable when several roles share white', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#111111', '#ffffff', '#3977e8'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    textColors: ['#111111', '#666666'], backgroundColors: ['#f5f6f8', '#ffffff'], borderColors: ['#dddddd'], accentColors: ['#3977e8'],
  }))
  assert.deepEqual(result.colors.slice(0, 7).map(item => item.name), ['主要操作色', '按钮文字', '页面背景', '内容表面', '主要文字', '次要文字', '边框颜色'])
  assert.equal(result.colors.find(item => item.name === '内容表面').value, '#ffffff')
  assert.equal(result.colors.find(item => item.name === '主要文字').value, '#111111')
  assert.equal(result.colors.find(item => item.name === '成功色').value, '#16805c')
})

test('prefers frequently observed interactive backgrounds and keeps button text readable', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#ffffff', '#111111', '#ffe066', '#ef4444'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    textColors: ['#111111'], backgroundColors: ['#ffffff'], pageBackgroundColors: ['#ffffff'], borderColors: ['#dddddd'],
    // A rare red status can be more saturated, but the observed button background is the product accent.
    accentColors: ['#ffe066', '#ef4444'], accentBackgroundColors: ['#ffe066', '#ef4444'], accentTextColors: ['#111111', '#ffffff'],
  }))
  assert.equal(result.colors[0].value, '#ffe066')
  assert.equal(result.colors.find(item => item.name === '按钮文字').value, '#111111')
})

test('keeps the foreground and background captured from the same real primary control', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#ffffff', '#111111', '#1565c0', '#8b5cf6'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    textColors: ['#111111'], backgroundColors: ['#ffffff'], pageBackgroundColors: ['#ffffff'], borderColors: ['#dddddd'],
    // Independent lists contain a visually stronger unrelated accent first.
    accentColors: ['#8b5cf6', '#1565c0'], accentBackgroundColors: ['#8b5cf6', '#1565c0'], accentTextColors: ['#ffffff'],
    componentSamples: [{ kind: 'button', count: 6, exampleText: '保存', states: [], width: 88, height: 36, color: '#ffffff', backgroundColor: '#1565c0', borderColor: '#1565c0', borderRadius: '8px', borderWidth: '1px', boxShadow: 'none' }],
  }))
  assert.equal(result.colors.find(item => item.name === '主要操作色').value, '#1565c0')
  assert.equal(result.colors.find(item => item.name === '按钮文字').value, '#ffffff')
})

test('maps effects only from the matching control, surface, or dialog evidence', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const heroGradient = 'linear-gradient(135deg, #111827, #374151)'
  const buttonGradient = 'linear-gradient(90deg, #2563eb, #1d4ed8)'
  const surfaceShadow = '0 2px 8px rgba(15, 23, 42, .12)'
  const dialogShadow = '0 24px 64px rgba(15, 23, 42, .28)'
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#2563eb', '#ffffff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    gradients: [heroGradient, buttonGradient], shadows: [surfaceShadow, dialogShadow],
    componentSamples: [
      { kind: 'button', count: 3, exampleText: '保存', states: [], width: 88, height: 36, color: '#ffffff', backgroundColor: '#2563eb', backgroundImage: buttonGradient, borderColor: '#2563eb', borderRadius: '8px', borderWidth: '1px', boxShadow: 'none' },
      { kind: 'surface', count: 4, states: [], width: 480, height: 180, color: '#111111', backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', borderWidth: '1px', boxShadow: surfaceShadow },
      { kind: 'dialog', count: 1, states: [], width: 480, height: 260, color: '#111111', backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', borderWidth: '1px', boxShadow: dialogShadow },
    ],
  }))
  assert.deepEqual(result.effects.gradients, [heroGradient, buttonGradient])
  assert.deepEqual(result.effects.shadows, [surfaceShadow, dialogShadow])
  assert.deepEqual(result.effects.semantic, { primaryControlGradient: buttonGradient, surfaceShadow, elevatedShadow: dialogShadow })
})

test('does not use a hero gradient or unrelated shadow when no matching component proves its role', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#2563eb', '#ffffff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    gradients: ['linear-gradient(135deg, #111827, #374151)'], shadows: ['0 12px 32px rgba(15, 23, 42, .2)'],
    componentSamples: [{ kind: 'surface', count: 1, states: [], width: 960, height: 320, color: '#ffffff', backgroundColor: '#111827', borderColor: '#111827', borderRadius: '0px', borderWidth: '0px', boxShadow: 'none' }],
  }))
  assert.equal(result.effects.semantic, undefined)
})

test('maps disabled opacity and motion only from real controls, not decorative page effects', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#2563eb', '#ffffff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    opacities: ['.2', '.55'], motionDurations: ['3s', '180ms'], motionEasings: ['linear', 'ease-out'],
    componentSamples: [
      { kind: 'surface', count: 1, states: [], width: 960, height: 300, color: '#111111', backgroundColor: '#ffffff', borderColor: '#ffffff', borderRadius: '0px', borderWidth: '0px', boxShadow: 'none', transitionDuration: '3s', transitionTimingFunction: 'linear' },
      { kind: 'button', count: 2, states: ['disabled'], width: 96, height: 36, color: '#ffffff', backgroundColor: '#2563eb', borderColor: '#2563eb', borderRadius: '8px', borderWidth: '1px', boxShadow: 'none', disabledOpacity: '.55', transitionDuration: '180ms', transitionTimingFunction: 'ease-out' },
    ],
  }))
  assert.equal(result.effects.semantic.disabledControlOpacity, .55)
  assert.deepEqual(result.motion.semantic, { controlDuration: '180ms', controlEasing: 'ease-out' })
  const noControlEvidence = createDesignSpecFromEvidence(evidence({
    colors: ['#2563eb', '#ffffff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px'],
    opacities: ['.2'], motionDurations: ['3s'], motionEasings: ['linear'],
    componentSamples: [{ kind: 'surface', count: 1, states: [], width: 960, height: 300, color: '#111111', backgroundColor: '#ffffff', borderColor: '#ffffff', borderRadius: '0px', borderWidth: '0px', boxShadow: 'none', transitionDuration: '3s', transitionTimingFunction: 'linear' }],
  }))
  assert.equal(noControlEvidence.effects.semantic, undefined)
  assert.equal(noControlEvidence.motion.semantic, undefined)
})

test('keeps pill controls, image assets, and textarea dimensions from redefining unrelated tokens', async () => {
  const { createDesignSpecFromEvidence, designEvidenceCoverage } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['#2563eb', '#ffffff'], fonts: ['Inter'], radius: ['999px', '8px'], spacing: ['8px'],
    iconSizes: [], inputHeights: [], controlHeights: ['160px'], componentKinds: ['image'],
    componentSamples: [
      { kind: 'button', count: 2, states: [], width: 120, height: 36, color: '#ffffff', backgroundColor: '#2563eb', borderColor: '#2563eb', borderRadius: '999px', borderWidth: '0px', boxShadow: 'none' },
      { kind: 'surface', count: 3, states: [], width: 480, height: 220, color: '#111111', backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px', borderWidth: '1px', boxShadow: 'none' },
      { kind: 'textarea', count: 1, states: [], width: 480, height: 160, color: '#111111', backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px', borderWidth: '1px', boxShadow: 'none' },
    ],
  }))
  assert.equal(result.spacing.cardRadius, 8)
  assert.equal(result.controls.radius, 80)
  assert.deepEqual(result.borders.radiusScale, [8])
  assert.equal(result.controls.iconSize, 16)
  assert.equal(result.controls.inputHeight, 38)
  const coverage = designEvidenceCoverage(evidence({ colors: ['#ffffff'], fonts: ['Inter'], radius: ['999px', '8px'], spacing: ['8px'], iconSizes: [], inputHeights: [], controlHeights: ['160px'], componentKinds: ['image'] }))
  assert.equal(coverage.find(item => item.id === 'controls').status, 'observed')
  assert.match(coverage.find(item => item.id === 'controls').detail, /未采到普通输入或图标尺寸/)
  assert.equal(coverage.find(item => item.id === 'components').status, 'observed')
})

test('does not mistake a colorful link for muted body text', async () => {
  const { createDesignSpecFromEvidence } = await designSystemModule()
  const result = createDesignSpecFromEvidence(evidence({
    colors: ['rgb(31, 35, 40)', 'rgb(9, 105, 218)', 'rgb(89, 99, 110)'], fonts: ['Mona Sans VF'], radius: ['6px'], spacing: ['8px'],
    pageBackgroundColors: ['rgb(255, 255, 255)'], backgroundColors: ['rgb(255, 255, 255)'], borderColors: ['rgb(208, 215, 222)'],
    textColors: ['rgb(31, 35, 40)', 'rgb(9, 105, 218)', 'rgb(89, 99, 110)'], accentColors: ['rgb(9, 105, 218)'],
  }))
  assert.equal(result.surfaces.textMuted, 'rgb(89, 99, 110)')
})
