import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { JSDOM } from '../../../.generated/harness-product/node_modules/jsdom/lib/api.js'
import { PrototypeProjectStore } from '../../../packages/harness-ui-prototype-studio/src/prototype-store.mjs'

async function captureModule() {
  const schemaSource = await readFile(new URL('../../../packages/harness-ui-prototype-studio/src/prototype-document.ts', import.meta.url), 'utf8')
  const schemaJs = ts.transpileModule(schemaSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const schemaUrl = `data:text/javascript;base64,${Buffer.from(schemaJs).toString('base64')}`
  const captureSource = await readFile(new URL('./design-reference-capture.ts', import.meta.url), 'utf8')
  const captureJs = ts.transpileModule(captureSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("from '../../../packages/harness-ui-prototype-studio/src/prototype-document'", `from '${schemaUrl}'`)
  return import(`data:text/javascript,${encodeURIComponent(captureJs)}#${Date.now()}`)
}

test('bounds DOM discovery before inspecting styles on very large pages', async () => {
  const source = await readFile(new URL('./design-reference-capture.ts', import.meta.url), 'utf8')
  assert.match(source, /const candidateLimit = 12_000/)
  assert.match(source, /document\.createTreeWalker\(document\.body, NodeFilter\.SHOW_ELEMENT\)/)
  assert.match(source, /candidateLimitReached = walker\.nextNode\(\) !== null/)
  assert.doesNotMatch(source, /querySelectorAll<HTMLElement>\('\*'\)/)
  assert.match(source, /页面元素超过 \$\{candidateLimit\} 个/)
  assert.match(source, /const cssRuleLimit = 20_000/)
  assert.doesNotMatch(source, /Array\.from\(rules\)\.slice/)
})

test('walks SVG elements as design evidence instead of dropping non-HTML elements', async () => {
  const source = await readFile(new URL('./design-reference-capture.ts', import.meta.url), 'utf8')
  assert.match(source, /const priority = \(element: Element\)/)
  assert.match(source, /if \(!\(next instanceof Element\)\) break/)
  assert.doesNotMatch(source, /next instanceof HTMLElement/)
  assert.match(source, /node instanceof HTMLElement \? node\.innerText : node\.textContent/)
})

test('captures a real compact SVG from a synthetic DOM', async t => {
  const mediaRules = Array.from({ length: 13 }, (_, index) => `@media (min-width:${300 + index * 10}px){.item-${index}{display:block}}`).join('')
  const dom = new JSDOM(`<!doctype html><html style="opacity:1"><head><style>${mediaRules}</style><style>button:focus{outline:2px solid rgb(1, 2, 3);outline-offset:2px}</style></head><body style="opacity:1"><button style="opacity:1">保存</button><svg aria-label="搜索" style="display:block;opacity:1;width:16px;height:16px" viewBox="0 0 16 16"><path d="M1 1h4" /></svg></body></html>`, { url: 'https://example.test/product', pretendToBeVisual: true })
  const keys = ['window', 'document', 'location', 'innerWidth', 'innerHeight', 'scrollY', 'devicePixelRatio', 'Element', 'HTMLElement', 'NodeFilter', 'MediaList', 'getComputedStyle']
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => {
    for (const [key, descriptor] of descriptors) descriptor === undefined ? delete globalThis[key] : Object.defineProperty(globalThis, key, descriptor)
    dom.window.close()
  })
  const { window } = dom
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window }, document: { configurable: true, value: window.document }, location: { configurable: true, value: window.location },
    innerWidth: { configurable: true, value: 1_280 }, innerHeight: { configurable: true, value: 720 }, scrollY: { configurable: true, value: 0 }, devicePixelRatio: { configurable: true, value: 1 },
    Element: { configurable: true, value: window.Element }, HTMLElement: { configurable: true, value: window.HTMLElement }, NodeFilter: { configurable: true, value: window.NodeFilter }, MediaList: { configurable: true, value: window.MediaList }, getComputedStyle: { configurable: true, value: window.getComputedStyle.bind(window) },
  })
  window.Element.prototype.getBoundingClientRect = function () {
    const isIcon = this.tagName.toLowerCase() === 'svg'
    return { x: 0, y: 0, top: 0, right: isIcon ? 16 : 320, bottom: isIcon ? 16 : 40, left: 0, width: isIcon ? 16 : 320, height: isIcon ? 16 : 40, toJSON() { return this } }
  }
  const { captureDesignReferencePage } = await captureModule()
  const captured = captureDesignReferencePage()
  assert.equal(captured.samples.some(sample => sample.tag === 'svg' && sample.rect.width === 16 && sample.rect.height === 16), true)
  assert.equal(captured.responsiveBreakpoints.length, 12)
  assert.deepEqual(captured.declaredFocusStyles, [{ width: '2px', style: 'solid', color: 'rgb(1, 2, 3)', offset: '2px' }])
})

test('turns bounded computed styles and one screenshot into fingerprinted evidence', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const raw = {
    v: 1,
    source: { url: 'https://example.test/product', title: '产品页' },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    pageSize: { width: 1280, height: 2880, sampledBands: 4 },
    samples: [{
      tag: 'button', text: '开始', rect: { x: 20, y: 30, width: 120, height: 40 },
      color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(37, 99, 235)', borderColor: 'rgb(37, 99, 235)',
      fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '21px', letterSpacing: '0.2px', borderRadius: '8px', borderWidth: '1px', borderStyle: 'solid',
      padding: '8px 16px', margin: '0px', gap: '8px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)', backgroundImage: 'linear-gradient(90deg, rgb(37, 99, 235), rgb(29, 78, 216))', opacity: '.55', transitionDuration: '160ms', transitionTimingFunction: 'ease-out', state: 'disabled',
      display: 'flex', position: 'static', gridTemplateColumns: 'none', flexDirection: 'row', outlineColor: 'rgb(37, 99, 235)', outlineWidth: '2px', outlineStyle: 'solid', outlineOffset: '2px',
    }],
    responsiveBreakpoints: [640, 768, 1024],
    declaredInteractionStates: ['hover', 'active', 'focus-visible'],
    captureCoverage: { candidateElements: 1323, inspectedElements: 640, sampledElements: 2, accessibleStylesheets: 8, opaqueStylesheets: 3, iframeElements: 1, unloadedImages: 2, horizontalOverflow: true, limitations: ['仅在当前 1280px 宽度实测。', '1 个 iframe 的内部页面没有采集。'] },
  }
  raw.samples.unshift({ ...raw.samples[0], tag: 'body', text: '', state: undefined, rect: { x: 0, y: 0, width: 1280, height: 2880 }, color: 'rgb(31, 41, 55)', backgroundColor: 'rgb(248, 250, 252)', borderColor: 'rgb(248, 250, 252)' })
  raw.samples.push({ ...raw.samples[1], tag: 'dialog', role: 'dialog', text: '确认操作', state: undefined, rect: { x: 320, y: 180, width: 520, height: 320 }, color: 'rgb(31, 41, 55)', backgroundColor: 'rgb(255, 255, 255)', borderColor: 'rgb(226, 232, 240)', boxShadow: '0 16px 48px rgba(0, 0, 0, 0.18)', position: 'fixed', transitionDuration: '0s', transitionTimingFunction: 'ease' })
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj', new Date('2026-08-23T00:00:00Z'))
  assert.match(result.id, /^ref-/)
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/)
  assert.match(result.screenshotFingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.designTokens.fonts, ['Inter'])
  assert.deepEqual(result.designTokens.fontSizes, ['14px'])
  assert.deepEqual(result.designTokens.lineHeights, ['21px'])
  assert.deepEqual(result.designTokens.textStyles, [{ kind: 'body', fontSize: '14px', fontWeight: '600', lineHeight: '21px', letterSpacing: '0.2px' }])
  assert.deepEqual(result.designTokens.accentBackgroundColors, ['rgb(37, 99, 235)'])
  assert.deepEqual(result.designTokens.accentTextColors, ['rgb(255, 255, 255)'])
  assert.deepEqual(result.designTokens.borderWidths, ['1px'])
  assert.deepEqual(result.designTokens.borderStyles, ['solid'])
  assert.deepEqual(result.designTokens.pageBackgroundColors, ['rgb(248, 250, 252)'])
  assert.deepEqual(result.designTokens.elevatedBackgroundColors, ['rgb(255, 255, 255)'])
  assert.equal(result.designTokens.shadows.length, 2)
  assert.equal(result.designTokens.gradients.length, 1)
  assert.deepEqual(result.designTokens.motionDurations, ['160ms'])
  assert.deepEqual(result.designTokens.motionEasings, ['ease-out'])
  assert.deepEqual(result.designTokens.buttonHeights, ['40px'])
  assert.deepEqual(result.designTokens.componentKinds, ['button', 'dialog'])
  assert.equal(result.designTokens.componentSamples[0].kind, 'button')
  assert.equal(result.designTokens.componentSamples[0].count, 1)
  assert.equal(result.designTokens.componentSamples[0].exampleText, '开始')
  assert.equal(result.designTokens.componentSamples[0].backgroundImage, 'linear-gradient(90deg, rgb(37, 99, 235), rgb(29, 78, 216))')
  assert.equal(result.designTokens.componentSamples[0].disabledOpacity, '.55')
  assert.equal(result.designTokens.componentSamples[0].transitionDuration, '160ms')
  assert.equal(result.designTokens.componentSamples[0].transitionTimingFunction, 'ease-out')
  assert.equal(result.designTokens.componentSamples[0].width, 120)
  assert.equal(result.designTokens.componentStates.includes('button:disabled'), true)
  assert.equal(result.designTokens.componentStates.includes('css:hover'), false)
  assert.match(result.captureCoverage.limitations.at(-1), /CSS 声明了 hover、active、focus-visible 状态，但采集未触发/)
  assert.deepEqual(result.designTokens.layoutPatterns, ['flex-row'])
  assert.deepEqual(result.designTokens.responsiveBreakpoints, [640, 768, 1024])
  assert.deepEqual(result.designTokens.focusStyles, [{ width: '2px', style: 'solid', color: 'rgb(37, 99, 235)', offset: '2px' }])
  assert.equal(result.viewport.width, 1280)
  assert.deepEqual(result.pageSize, { width: 1280, height: 2880, sampledBands: 4 })
  assert.deepEqual(result.captureCoverage, raw.captureCoverage)
  assert.match(result.observations[0], /跨 4 个纵向区域/)
  assert.match(result.observations[1], /候选元素 1323 个，检查 640 个/)
})

test('collects easing only for active transitions and keeps a real ease curve', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const base = {
    tag: 'button', text: '操作', rect: { x: 0, y: 0, width: 120, height: 40 }, color: '#111111', backgroundColor: '#ffffff', borderColor: '#dddddd',
    fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '0px', borderRadius: '8px', borderWidth: '1px', borderStyle: 'solid',
    padding: '8px', margin: '0px', gap: '0px', boxShadow: 'none', backgroundImage: 'none', opacity: '1', display: 'block', position: 'static',
  }
  const raw = {
    v: 1, source: { url: 'https://example.test/motion', title: '动效页' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, pageSize: { width: 1280, height: 720, sampledBands: 1 },
    samples: [
      { ...base, transitionDuration: '0s', transitionTimingFunction: 'ease' },
      { ...base, text: '保存', transitionDuration: '160ms', transitionTimingFunction: 'ease' },
      { ...base, text: '取消', transitionDuration: '0ms, 240ms', transitionTimingFunction: 'linear, cubic-bezier(0.2, 0, 0, 1)' },
    ],
  }
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj')
  assert.deepEqual(result.designTokens.motionDurations, ['160ms', '240ms'])
  assert.deepEqual(result.designTokens.motionEasings, ['cubic-bezier(0.2, 0, 0, 1)', 'ease'])
  assert.equal(result.designTokens.motionEasings.includes('linear'), false)
})

test('keeps the representative primary button pair instead of the first neutral button', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const base = {
    tag: 'button', rect: { x: 0, y: 0, width: 100, height: 36 }, fontFamily: 'Inter', fontSize: '14px', fontWeight: '600', lineHeight: '20px', letterSpacing: '0px', borderRadius: '8px', borderWidth: '1px', borderStyle: 'solid', padding: '8px', margin: '0px', gap: '0px', boxShadow: 'none', backgroundImage: 'none', opacity: '1', transitionDuration: '0s', transitionTimingFunction: 'ease',
  }
  const raw = {
    v: 1, source: { url: 'https://example.test/buttons', title: '按钮页' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, pageSize: { width: 1280, height: 720, sampledBands: 1 },
    samples: [
      { ...base, text: '取消', color: 'rgb(31, 35, 40)', backgroundColor: 'rgb(255, 255, 255)', borderColor: 'rgb(208, 215, 222)' },
      { ...base, text: '保存', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(21, 101, 192)', borderColor: 'rgb(21, 101, 192)' },
    ],
  }
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj')
  const button = result.designTokens.componentSamples.find(sample => sample.kind === 'button')
  assert.equal(button.count, 2)
  assert.equal(button.exampleText, '保存')
  assert.equal(button.color, 'rgb(255, 255, 255)')
  assert.equal(button.backgroundColor, 'rgb(21, 101, 192)')
})

test('captured reference evidence passes the trusted project-store boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'captured-reference-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { buildReferenceEvidence } = await captureModule()
  const schemaSource = await readFile(new URL('../../../packages/harness-ui-prototype-studio/src/prototype-document.ts', import.meta.url), 'utf8')
  const schemaJs = ts.transpileModule(schemaSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const contracts = await import(`data:text/javascript;base64,${Buffer.from(schemaJs).toString('base64')}#${Date.now()}`)
  const raw = {
    v: 1,
    // Chromium's structured-clone boundary may preserve values while changing
    // insertion order. Trusted verification must compare content, not key order.
    source: { title: '产品页', url: 'https://example.test/product' },
    viewport: { deviceScaleFactor: 2, height: 720, width: 1280 },
    pageSize: { width: 1280, height: 1440, sampledBands: 2 },
    samples: [{
      tag: 'button', text: '开始', rect: { x: 20, y: 30, width: 120, height: 40 },
      color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(37, 99, 235)', borderColor: 'rgb(37, 99, 235)',
      fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', borderRadius: '8px',
      padding: '8px 16px', margin: '0px', gap: '8px', boxShadow: 'none',
    }],
  }
  const evidence = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj', new Date('2026-08-23T00:00:00Z'))
  const transferred = JSON.parse(JSON.stringify(evidence))
  const store = new PrototypeProjectStore(root, contracts)
  const opened = await store.open({
    projectId: 'prototype-captured-reference',
    sessionId: 'session-1',
    capability: 'capability-abcdefghijklmnopqrstuvwxyz-1234567890',
    evidence: [transferred],
  })
  assert.equal(opened.evidence[0].fingerprint, evidence.fingerprint)
})

test('rejects non-http pages and oversized screenshots', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const raw = { v: 1, source: { url: 'chrome://settings', title: '设置' }, viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, samples: [{}] }
  await assert.rejects(() => buildReferenceEvidence(raw, 'data:image/jpeg;base64,YQ=='), /visual evidence/)
  const valid = { ...raw, source: { url: 'https://example.test', title: '参考' }, pageSize: { width: 1, height: 1, sampledBands: 1 } }
  await assert.rejects(() => buildReferenceEvidence(valid, `data:image/jpeg;base64,${'a'.repeat(2_000_000)}`), /too large/)
})

test('does not invent black borders from zero-width computed border colors', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const base = {
    text: '内容', rect: { x: 0, y: 0, width: 400, height: 40 }, color: 'rgb(31, 35, 40)', backgroundColor: 'rgb(255, 255, 255)',
    fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '0px', borderRadius: '0px', padding: '0px', margin: '0px', gap: '0px', boxShadow: 'none', backgroundImage: 'none', opacity: '1', transitionDuration: '0s', transitionTimingFunction: 'ease',
  }
  const raw = {
    v: 1, source: { url: 'https://example.test/product', title: '产品页' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, pageSize: { width: 1280, height: 720, sampledBands: 1 },
    samples: [
      { ...base, tag: 'p', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', borderStyle: 'none' },
      { ...base, tag: 'input', borderColor: 'rgb(208, 215, 222)', borderWidth: '1px', borderStyle: 'solid' },
    ],
  }
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj')
  assert.deepEqual(result.designTokens.borderColors, ['rgb(208, 215, 222)'])
  assert.equal(result.designTokens.colors.includes('rgb(0, 0, 0)'), false)
})

test('separates compact SVG icon evidence from avatar and thumbnail image evidence', async () => {
  const { buildReferenceEvidence } = await captureModule()
  const base = {
    rect: { x: 0, y: 0, width: 100, height: 40 }, color: 'rgb(31, 35, 40)', backgroundColor: 'rgb(255, 255, 255)', borderColor: 'rgb(208, 215, 222)',
    fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '0px', borderRadius: '8px', borderWidth: '1px', borderStyle: 'solid', padding: '8px', margin: '0px', gap: '0px', boxShadow: 'none', backgroundImage: 'none', opacity: '1', transitionDuration: '0s', transitionTimingFunction: 'ease', display: 'block', position: 'static',
  }
  const raw = {
    v: 1, source: { url: 'https://example.test/assets', title: '素材页' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, pageSize: { width: 1280, height: 720, sampledBands: 1 },
    samples: [
      { ...base, tag: 'svg', rect: { ...base.rect, width: 16, height: 16 } },
      { ...base, tag: 'svg', rect: { ...base.rect, width: 20, height: 20 } },
      { ...base, tag: 'img', role: 'img', rect: { ...base.rect, width: 64, height: 64 } },
      { ...base, tag: 'img', role: 'img', rect: { ...base.rect, width: 80, height: 80 } },
      { ...base, tag: 'img', role: 'img', rect: { ...base.rect, width: 96, height: 96 } },
      { ...base, tag: 'input', rect: { ...base.rect, height: 40 } },
      { ...base, tag: 'textarea', rect: { ...base.rect, height: 160 } },
    ],
  }
  const result = await buildReferenceEvidence(raw, 'data:image/jpeg;base64,YWJj')
  assert.deepEqual(result.designTokens.iconSizes, ['16px', '20px'])
  assert.deepEqual(result.designTokens.inputHeights, ['40px'])
  assert.equal(result.designTokens.componentKinds.includes('icon'), true)
  assert.equal(result.designTokens.componentKinds.includes('image'), true)
})
