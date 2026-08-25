import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function schema() {
  const source = await readFile(new URL('../src/prototype-document.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(output)}#${Date.now()}`)
}

function documentFixture() {
  return { v: 1, id: 'signup-prototype', title: '注册', designSpecId: 'design-main', initialScreenId: 'welcome', screens: [{ id: 'welcome', title: '欢迎', nodes: [{ id: 'heading', type: 'text', text: '欢迎', tone: 'heading' }, { id: 'go-signup', type: 'button', label: '开始', action: { type: 'navigate', targetScreenId: 'signup' } }, { id: 'signup-modal', type: 'modal', title: '说明', children: [{ id: 'modal-copy', type: 'text', text: '安全演示' }] }] }, { id: 'signup', title: '注册', nodes: [{ id: 'email', type: 'input', label: '邮箱', inputType: 'email' }, { id: 'submit', type: 'button', label: '提交', action: { type: 'submit-success', targetScreenId: 'welcome' } }, { id: 'tabs', type: 'tabs', tabs: [{ id: 'basic', label: '基础', children: [{ id: 'card', type: 'card', children: [{ id: 'list', type: 'list', items: [{ id: 'item-one', title: '第一项' }] }] }] }] }] }] }
}

test('accepts the bounded V1 component and action language', async () => {
  const { validatePrototypeDocument } = await schema()
  const document = documentFixture()
  document.shell = { productName: '供应商平台', placement: 'sidebar', items: [{ id: 'nav-welcome', label: '首页', targetScreenId: 'welcome' }, { id: 'nav-signup', label: '注册', targetScreenId: 'signup' }] }
  const result = validatePrototypeDocument(document)
  assert.equal(result.ok, true)
  assert.equal(result.value.screens.length, 2)
  assert.equal(result.value.shell.items.length, 2)

  const missingScreen = structuredClone(document); missingScreen.shell.items[1].targetScreenId = 'missing'
  assert.equal(validatePrototypeDocument(missingScreen).ok, false)
  const duplicateItem = structuredClone(document); duplicateItem.shell.items[1].id = 'nav-welcome'
  assert.equal(validatePrototypeDocument(duplicateItem).ok, false)
})

test('accepts safe product-dashboard components and rejects malformed tables or selects', async () => {
  const { validatePrototypeDocument, collectPrototypeElementIds } = await schema()
  const doc = documentFixture()
  doc.screens[0].nodes.push({
    id: 'dashboard-layout', type: 'group', layout: 'grid-3', children: [
      { id: 'metric-revenue', type: 'metric', label: '本月收入', value: '¥128,000', detail: '较上月增加 12%', tone: 'positive' },
      { id: 'risk-badge', type: 'badge', text: '有风险', tone: 'danger' },
      { id: 'owner-select', type: 'input', label: '负责人', inputType: 'select', options: [{ label: '张三', value: 'zhang-san' }] },
      { id: 'notes', type: 'input', label: '备注', inputType: 'textarea' },
      { id: 'risk-alert', type: 'alert', title: '存在延期风险', detail: '请在今天完成处理', tone: 'warning' },
      { id: 'completion', type: 'progress', label: '本月完成度', value: 72, detail: '72 / 100', tone: 'primary' },
      { id: 'weekly-chart', type: 'chart', label: '周趋势', bars: [{ label: '周一', value: 12 }, { label: '周二', value: 18 }] },
    ],
  }, { id: 'project-table', type: 'table', label: '项目列表', columns: [{ key: 'name', label: '项目' }, { key: 'status', label: '状态' }], rows: [{ id: 'project-one', values: ['供应商平台', '进行中'], action: { type: 'open-modal', targetId: 'signup-modal' } }] })
  const result = validatePrototypeDocument(doc)
  assert.equal(result.ok, true, result.errors?.join('\n'))
  assert.equal(collectPrototypeElementIds(doc).has('project-one'), true)
  const wrongColumns = structuredClone(doc); wrongColumns.screens[0].nodes.at(-1).rows[0].values = ['只有一列']
  assert.equal(validatePrototypeDocument(wrongColumns).ok, false)
  const missingOptions = structuredClone(doc); missingOptions.screens[0].nodes.at(-2).children[2].options = []
  assert.equal(validatePrototypeDocument(missingOptions).ok, false)
  const invalidProgress = structuredClone(doc); invalidProgress.screens[0].nodes.at(-2).children[5].value = 101
  assert.equal(validatePrototypeDocument(invalidProgress).ok, false)
  const invalidChart = structuredClone(doc); invalidChart.screens[0].nodes.at(-2).children[6].bars = []
  assert.equal(validatePrototypeDocument(invalidChart).ok, false)
  const drawer = structuredClone(doc); drawer.screens[0].nodes[2].placement = 'drawer-right'
  assert.equal(validatePrototypeDocument(drawer).ok, true)
})

test('accepts mature product navigation, empty results, pagination, disabled actions, and required fields', async () => {
  const { validatePrototypeDocument, collectPrototypeElementIds } = await schema()
  const doc = documentFixture()
  doc.stateVariables = [{ id: 'results-page', initialValue: '1', allowedValues: ['1', '2', '3'] }]
  doc.screens[1].nodes.unshift(
    { id: 'signup-path', type: 'breadcrumb', items: [{ id: 'crumb-home', label: '首页', targetScreenId: 'welcome' }, { id: 'crumb-signup', label: '注册' }] },
    { id: 'empty-results', type: 'empty-state', title: '还没有成员', detail: '邀请成员后会显示在这里', actionLabel: '邀请成员', action: { type: 'open-modal', targetId: 'signup-modal' } },
    { id: 'results-pagination', type: 'pagination', label: '成员列表分页', pageCount: 3, bindStateId: 'results-page' },
    { id: 'disabled-export', type: 'button', label: '导出', disabled: true },
  )
  doc.screens[1].nodes.find(node => node.id === 'email').required = true
  doc.screens[1].nodes.find(node => node.id === 'email').errorText = '请输入有效邮箱'
  const result = validatePrototypeDocument(doc)
  assert.equal(result.ok, true, result.errors?.join('\n'))
  assert.equal(collectPrototypeElementIds(doc).has('crumb-home'), true)

  const missingPageState = structuredClone(doc); missingPageState.stateVariables[0].allowedValues = ['1', '2']
  assert.equal(validatePrototypeDocument(missingPageState).ok, false)
  const unpairedEmptyAction = structuredClone(doc); delete unpairedEmptyAction.screens[1].nodes[1].actionLabel
  assert.equal(validatePrototypeDocument(unpairedEmptyAction).ok, false)
  const executableRequired = structuredClone(doc); executableRequired.screens[1].nodes.find(node => node.id === 'email').required = 'yes'
  assert.equal(validatePrototypeDocument(executableRequired).ok, false)
})

test('rejects executable-code-shaped fields and unsupported components', async () => {
  const { validatePrototypeDocument } = await schema()
  const evil = documentFixture(); evil.screens[0].nodes[0].script = 'alert(1)'
  assert.equal(validatePrototypeDocument(evil).ok, false)
  const unsupported = documentFixture(); unsupported.screens[0].nodes[0].type = 'iframe'
  assert.equal(validatePrototypeDocument(unsupported).ok, false)
})

test('rejects a visually complete but non-interactive fake prototype', async () => {
  const { validatePrototypeDocument } = await schema()
  const staticOnly = { v: 1, id: 'static-prototype', title: '静态看板', designSpecId: 'design-main', initialScreenId: 'dashboard', screens: [{ id: 'dashboard', title: '数据看板', nodes: [{ id: 'heading', type: 'text', text: '经营数据', tone: 'heading' }, { id: 'revenue', type: 'metric', label: '本月收入', value: '¥128,000' }] }] }
  const result = validatePrototypeDocument(staticOnly)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /至少需要一条可演示交互流程/)
})

test('rejects a clickable but content-empty mockup instead of treating one button as a complete product', async () => {
  const { validatePrototypeDocument } = await schema()
  const shallow = { v: 1, id: 'shallow-prototype', title: '敷衍原型', designSpecId: 'design-main', initialScreenId: 'home', screens: [{ id: 'home', title: '首页', nodes: [{ id: 'title', type: 'text', text: '产品首页' }, { id: 'open', type: 'button', label: '查看', action: { type: 'open-modal', targetId: 'detail' } }, { id: 'detail', type: 'modal', title: '详情', children: [{ id: 'copy', type: 'text', text: '这里是详情' }] }] }] }
  const result = validatePrototypeDocument(shallow)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /至少需要 6 个组件、3 种组件类型/)
})

test('requires real targets for state transitions and unique stable ids', async () => {
  const { validatePrototypeDocument } = await schema()
  const missingTarget = documentFixture(); missingTarget.screens[0].nodes[1].action = { type: 'navigate' }
  assert.equal(validatePrototypeDocument(missingTarget).ok, false)
  const duplicate = documentFixture(); duplicate.screens[1].nodes[0].id = 'heading'
  assert.equal(validatePrototypeDocument(duplicate).ok, false)
  const booleanSetValue = documentFixture(); booleanSetValue.screens[0].nodes[1].action = { type: 'set-value', targetId: 'email', value: true }
  assert.equal(validatePrototypeDocument(booleanSetValue).ok, false)
  const extraOpenValue = documentFixture(); extraOpenValue.screens[0].nodes[1].action = { type: 'open-modal', targetId: 'signup-modal', value: 'unexpected' }
  assert.equal(validatePrototypeDocument(extraOpenValue).ok, false)
})

test('accepts bounded business state for approval and filters, but rejects undeclared references and values', async () => {
  const { validatePrototypeDocument } = await schema()
  const doc = documentFixture()
  doc.stateVariables = [
    { id: 'approval-status', initialValue: 'pending', allowedValues: ['pending', 'approved'] },
    { id: 'owner-filter', initialValue: 'all', allowedValues: ['all', 'mine'] },
  ]
  doc.screens[0].nodes.push(
    { id: 'approve', type: 'button', label: '通过审批', action: { type: 'set-state', targetId: 'approval-status', value: 'approved' }, visibleWhen: { stateId: 'approval-status', equals: 'pending' } },
    { id: 'approved-notice', type: 'alert', title: '已通过', tone: 'positive', visibleWhen: { stateId: 'approval-status', equals: 'approved' } },
    { id: 'owner-select', type: 'input', label: '负责人', inputType: 'select', bindStateId: 'owner-filter', options: [{ label: '全部', value: 'all' }, { label: '仅我负责', value: 'mine' }] },
    { id: 'mine-results', type: 'text', text: '仅显示我负责的结果', visibleWhen: { stateId: 'owner-filter', equals: 'mine' } },
  )
  assert.equal(validatePrototypeDocument(doc).ok, true)

  const unknownCondition = structuredClone(doc); unknownCondition.screens[0].nodes.at(-1).visibleWhen.stateId = 'missing-state'
  assert.equal(validatePrototypeDocument(unknownCondition).ok, false)
  const unknownAction = structuredClone(doc); unknownAction.screens[0].nodes.at(-4).action.targetId = 'missing-state'
  assert.equal(validatePrototypeDocument(unknownAction).ok, false)
  const invalidActionValue = structuredClone(doc); invalidActionValue.screens[0].nodes.at(-4).action.value = 'rejected'
  assert.equal(validatePrototypeDocument(invalidActionValue).ok, false)
  const invalidBinding = structuredClone(doc); invalidBinding.screens[0].nodes.at(-2).bindStateId = 'missing-state'
  assert.equal(validatePrototypeDocument(invalidBinding).ok, false)
  const invalidOption = structuredClone(doc); invalidOption.screens[0].nodes.at(-2).options[1].value = 'everyone'
  assert.equal(validatePrototypeDocument(invalidOption).ok, false)
})

test('accepts a short non-nested action sequence for real approval flows', async () => {
  const { validatePrototypeDocument } = await schema()
  const doc = documentFixture()
  doc.stateVariables = [{ id: 'approval-status', initialValue: 'pending', allowedValues: ['pending', 'approved'] }]
  doc.screens[0].nodes.push({
    id: 'approve-and-close', type: 'button', label: '确认通过', action: { type: 'sequence', actions: [
      { type: 'set-state', targetId: 'approval-status', value: 'approved' },
      { type: 'close-modal', targetId: 'signup-modal' },
    ] },
  })
  assert.equal(validatePrototypeDocument(doc).ok, true)

  const nested = structuredClone(doc)
  nested.screens[0].nodes.at(-1).action.actions[0] = { type: 'sequence', actions: [{ type: 'set-state', targetId: 'approval-status', value: 'approved' }] }
  assert.equal(validatePrototypeDocument(nested).ok, false)
  const tooLong = structuredClone(doc)
  tooLong.screens[0].nodes.at(-1).action.actions = Array.from({ length: 5 }, () => ({ type: 'close-modal', targetId: 'signup-modal' }))
  assert.equal(validatePrototypeDocument(tooLong).ok, false)

  const tabSequence = structuredClone(doc)
  tabSequence.screens[1].nodes[2].tabs[0].action = { type: 'sequence', actions: [{ type: 'close-modal', targetId: 'signup-modal' }] }
  const invalidTabSequence = validatePrototypeDocument(tabSequence)
  assert.equal(invalidTabSequence.ok, false)
  assert.match(invalidTabSequence.errors.join('\n'), /连续动作只能用于按钮、表格行或列表项/)
})

test('binds design specs only to authorized reference evidence', async () => {
  const { validateReferenceEvidence, validateDesignSpec } = await schema()
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, captureCoverage: { candidateElements: 100, inspectedElements: 80, sampledElements: 40, accessibleStylesheets: 3, opaqueStylesheets: 1, iframeElements: 1, unloadedImages: 0, horizontalOverflow: false, limitations: ['iframe 内部页面未采集'] }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'], elevatedBackgroundColors: ['#ffffff'] }, fingerprint: 'a'.repeat(64) }
  assert.equal(validateReferenceEvidence(evidence).ok, true)
  const invalidElevated = structuredClone(evidence); invalidElevated.designTokens.elevatedBackgroundColors = ['url(javascript:alert(1))']
  assert.equal(validateReferenceEvidence(invalidElevated).ok, false)
  const invalidCoverage = structuredClone(evidence); invalidCoverage.captureCoverage.sampledElements = 81
  assert.equal(validateReferenceEvidence(invalidCoverage).ok, false)
  const spec = { v: 1, id: 'design-main', name: '参考风格', basedOnEvidenceIds: ['ref-one'], summary: '简洁', colors: [{ name: '蓝', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 12 }, principles: ['清晰'] }
  assert.equal(validateDesignSpec(spec, ['ref-one']).ok, true)
  spec.basedOnEvidenceIds = ['unapproved']; assert.equal(validateDesignSpec(spec, ['ref-one']).ok, false)
})

test('accepts a complete bounded design system and rejects executable CSS values', async () => {
  const { validateDesignSpec, prototypeDesignTokens } = await schema()
  const spec = {
    v: 1, id: 'design-complete', name: '完整规范', basedOnEvidenceIds: ['ref-one'], summary: '完整设计系统',
    colors: [{ name: '主要操作色', value: '#2563eb', usage: '按钮和链接' }, { name: '页面背景', value: '#f8fafc', usage: '页面底色' }],
    typography: { fontFamily: 'system-ui', headingWeight: 700, bodyWeight: 400, bodySize: 14, headingSize: 28, captionSize: 12, fontSizeScale: [12, 14, 20, 28], fontWeightScale: [400, 500, 700], lineHeightScale: [18, 22, 34], bodyLineHeight: 1.6, headingLineHeight: 1.2, letterSpacing: 0 },
    spacing: { base: 8, cardRadius: 12, scale: [4, 8, 12, 16, 24, 32], sectionGap: 32, contentWidth: 1120 },
    surfaces: { page: '#f8fafc', surface: '#ffffff', elevated: '#ffffff', text: '#172033', textMuted: '#64748b', border: '#e2e8f0' },
    borders: { width: 1, style: 'solid', radiusScale: [4, 8, 12] },
    effects: { shadows: ['0 8px 24px rgba(15, 23, 42, 0.12)'], gradients: ['linear-gradient(90deg, #2563eb, #1d4ed8)'], opacities: [.6, .8], semantic: { surfaceShadow: '0 8px 24px rgba(15, 23, 42, 0.12)', primaryControlGradient: 'linear-gradient(90deg, #2563eb, #1d4ed8)', disabledControlOpacity: .6 } },
    controls: { height: 40, buttonHeight: 40, inputHeight: 40, iconSize: 20, radius: 8 }, motion: { durations: ['160ms'], easings: ['ease-out'], semantic: { controlDuration: '160ms', controlEasing: 'ease-out' } },
    focus: { width: 2, style: 'solid', color: '#2563eb', offset: 2 }, responsive: { breakpoints: [640, 768, 1024], layoutPatterns: ['flex-row', 'grid'] }, principles: ['清晰一致'],
  }
  assert.equal(validateDesignSpec(spec, ['ref-one']).ok, true)
  const flat = prototypeDesignTokens({ ...spec, effects: { shadows: [], gradients: [], opacities: [] }, controls: { ...spec.controls, height: 40, buttonHeight: 36 } })
  assert.equal(flat.shadow, 'none')
  assert.equal(flat.controlHeight, '36px')
  assert.equal(flat.positive, '#16805c')
  assert.equal(flat.warning, '#8a5b08')
  assert.equal(flat.onWarning, '#ffffff')
  assert.equal(flat.danger, '#c2413b')
  assert.equal(flat.onDanger, '#ffffff')
  assert.equal(flat.focusWidth, '2px')
  assert.equal(flat.focusColor, '#2563eb')
  const projected = prototypeDesignTokens({ ...spec, borders: { ...spec.borders, style: 'dashed' }, controls: { ...spec.controls, radius: 10 } })
  assert.equal(projected.borderStyle, 'dashed')
  assert.equal(projected.controlRadius, '10px')
  assert.equal(projected.sectionGap, '32px')
  assert.equal(projected.gradient, 'linear-gradient(90deg, #2563eb, #1d4ed8)')
  assert.equal(projected.surfaceShadow, '0 8px 24px rgba(15, 23, 42, 0.12)')
  assert.equal(projected.elevatedShadow, 'none')
  assert.equal(projected.disabledOpacity, .6)
  assert.equal(projected.motionDuration, '160ms')
  assert.equal(projected.motionEasing, 'ease-out')
  assert.equal(projected.compactBreakpoint, 640)
  assert.equal(prototypeDesignTokens({ ...spec, typography: { ...spec.typography, fontFamily: 'Segoe UI' } }).font, 'Segoe UI')
  assert.equal(prototypeDesignTokens({ ...spec, typography: { ...spec.typography, fontFamily: 'Roboto' } }).font, 'Roboto')
  assert.equal(prototypeDesignTokens({ ...spec, typography: { ...spec.typography, fontFamily: 'Arial; background:url(evil)' } }).font, 'system-ui')
  const inventedRole = structuredClone(spec); inventedRole.effects.semantic.primaryControlGradient = 'linear-gradient(45deg, #ffffff, #000000)'
  assert.equal(validateDesignSpec(inventedRole, ['ref-one']).ok, false)
  const inventedOpacity = structuredClone(spec); inventedOpacity.effects.semantic.disabledControlOpacity = .3
  assert.equal(validateDesignSpec(inventedOpacity, ['ref-one']).ok, false)
  const inventedMotion = structuredClone(spec); inventedMotion.motion.semantic.controlDuration = '240ms'
  assert.equal(validateDesignSpec(inventedMotion, ['ref-one']).ok, false)
  spec.effects.gradients = ['linear-gradient(red, blue);background:url(https://evil.test)']
  assert.equal(validateDesignSpec(spec, ['ref-one']).ok, false)
})

test('resolves references after the full tree and rejects wrong target types, duplicate tab/list ids, and large payloads', async () => {
  const { validatePrototypeDocument, MAX_DOCUMENT_TEXT_BYTES } = await schema()
  const wrongModal = documentFixture(); wrongModal.screens[0].nodes[1].action = { type: 'open-modal', targetId: 'email' }
  assert.equal(validatePrototypeDocument(wrongModal).ok, false)
  const duplicateTab = documentFixture(); duplicateTab.screens[1].nodes[2].tabs[0].id = 'heading'
  assert.equal(validatePrototypeDocument(duplicateTab).ok, false)
  const huge = documentFixture(); huge.screens[0].nodes[0].text = 'x'.repeat(MAX_DOCUMENT_TEXT_BYTES + 1)
  assert.equal(validatePrototypeDocument(huge).ok, false)
})

test('requires matching design bundle and computes rather than trusting revision fingerprints', async () => {
  const { computeReferenceEvidenceFingerprint, createTrustedRevision, verifyReferenceEvidenceFingerprint, verifyTrustedRevision, validatePrototypeBundle } = await schema()
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, captureCoverage: { candidateElements: 100, inspectedElements: 80, sampledElements: 40, accessibleStylesheets: 3, opaqueStylesheets: 1, iframeElements: 1, unloadedImages: 0, horizontalOverflow: false, limitations: ['iframe 内部页面未采集'] }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] } }
  evidence.fingerprint = await computeReferenceEvidenceFingerprint(evidence)
  assert.equal(await verifyReferenceEvidenceFingerprint(evidence), true)
  const changedCoverage = structuredClone(evidence); changedCoverage.captureCoverage.limitations[0] = '伪造为全部采集'
  assert.equal(await verifyReferenceEvidenceFingerprint(changedCoverage), false)
  const spec = { v: 1, id: 'design-main', name: '参考风格', basedOnEvidenceIds: ['ref-one'], summary: '简洁', colors: [{ name: '蓝', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 12 }, principles: ['清晰'] }
  const doc = documentFixture()
  assert.equal(validatePrototypeBundle({ evidence: [evidence], designSpec: spec, document: doc }).ok, true)
  assert.equal(validatePrototypeBundle({ evidence: [evidence], designSpec: { ...spec, id: 'other-design' }, document: doc }).ok, false)
  const revision = await createTrustedRevision({ id: 'rev-one', author: 'agent', evidence: [evidence], designSpec: spec, document: doc, changeSummary: '初始版本', createdAt: '2026-08-23T00:00:00.000Z' })
  assert.equal(revision.ok, true)
  assert.equal(await verifyTrustedRevision(revision.value, spec, [evidence]), true)
  revision.value.documentFingerprint = '0'.repeat(64)
  assert.equal(await verifyTrustedRevision(revision.value, spec, [evidence]), false)
})

test('returns the exact design-system category when an agent revision is invalid', async () => {
  const { computeReferenceEvidenceFingerprint, createTrustedRevision } = await schema()
  const evidence = { v: 1, id: 'ref-one', source: { url: 'https://example.test', title: '参考', capturedAt: '2026-08-23T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['参考'], designTokens: { colors: ['#2563eb'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] } }
  evidence.fingerprint = await computeReferenceEvidenceFingerprint(evidence)
  const spec = { v: 1, id: 'design-main', name: '规范', basedOnEvidenceIds: ['ref-one'], summary: '规范', colors: [{ name: '主色', value: '#2563eb', usage: '按钮' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, surfaces: { page: 'not-a-color', surface: '#fff', elevated: '#fff', text: '#111', textMuted: '#666', border: '#ddd' }, principles: ['清晰'] }
  const result = await createTrustedRevision({ id: 'rev-one', author: 'agent', evidence: [evidence], designSpec: spec, document: documentFixture(), changeSummary: '生成' })
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /表面颜色/)
})
