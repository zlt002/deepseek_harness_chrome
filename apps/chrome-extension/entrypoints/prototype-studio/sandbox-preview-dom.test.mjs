import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { JSDOM } from '../../../../.generated/harness-product/node_modules/jsdom/lib/api.js'

async function sandboxModule() {
  const schemaSource = await readFile(new URL('../../../../packages/harness-ui-prototype-studio/src/prototype-document.ts', import.meta.url), 'utf8')
  const schemaJs = ts.transpileModule(schemaSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const schemaUrl = `data:text/javascript;base64,${Buffer.from(schemaJs).toString('base64')}`
  const source = await readFile(new URL('./sandbox-preview.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'", `from '${schemaUrl}'`)
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}`)
}

const evidence = { v: 1, id: 'ref-dom', source: { url: 'https://example.test/reference', title: '参考', capturedAt: '2026-08-24T00:00:00.000Z' }, viewport: { width: 1280, height: 720, deviceScaleFactor: 2 }, observations: ['蓝色主按钮'], designTokens: { colors: ['#2563eb', '#ffffff'], fonts: ['system-ui'], radius: ['8px'], spacing: ['8px'] }, fingerprint: 'a'.repeat(64) }
const designSpec = { v: 1, id: 'design-dom', name: '参考规范', basedOnEvidenceIds: ['ref-dom'], summary: '沿用蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '主要操作' }, { name: '背景', value: '#ffffff', usage: '页面背景' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
const document = {
  v: 1, id: 'prototype-dom', title: '真实交互测试', designSpecId: 'design-dom', initialScreenId: 'home',
  shell: { productName: '测试产品', placement: 'top', items: [{ id: 'nav-home', label: '首页', targetScreenId: 'home' }, { id: 'nav-done', label: '完成', targetScreenId: 'done' }] },
  screens: [
    { id: 'home', title: '首页', nodes: [
      { id: 'email', type: 'input', label: '邮箱', inputType: 'email', required: true },
      { id: 'summary', type: 'card', label: '当前摘要', children: [{ id: 'summary-copy', type: 'text', text: '可用键盘选择的卡片内容。' }] },
      { id: 'disabled-action', type: 'button', label: '暂不可用', disabled: true },
      { id: 'notes', type: 'list', label: '说明', items: [{ id: 'note-a', title: '只读说明' }] },
      { id: 'trail', type: 'breadcrumb', items: [{ id: 'crumb-home', label: '工作台', targetScreenId: 'home' }, { id: 'crumb-current', label: '供应商列表' }] },
      { id: 'records', type: 'table', label: '项目列表', columns: [{ key: 'name', label: '名称' }], rows: [{ id: 'record-a', values: ['供应商准入'], action: { type: 'open-modal', targetId: 'help' } }, { id: 'record-b', values: ['只读记录'] }] },
      { id: 'open-help', type: 'button', label: '查看说明', action: { type: 'open-modal', targetId: 'help' } },
      { id: 'submit', type: 'button', label: '提交', action: { type: 'submit-success', targetScreenId: 'done' } },
      { id: 'help', type: 'modal', title: '说明', children: [{ id: 'help-copy', type: 'text', text: '这是可信运行器弹窗。' }] },
    ] },
    { id: 'done', title: '完成', nodes: [{ id: 'done-title', type: 'text', tone: 'heading', text: '提交成功' }] },
  ],
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('generated srcdoc consumes the confirmed effects, border, control, spacing, and responsive tokens', async () => {
  const { sandboxPreviewSrcDoc } = await sandboxModule()
  const completeSpec = {
    ...designSpec,
    spacing: { ...designSpec.spacing, scale: [4, 8, 16, 24], sectionGap: 40, contentWidth: 1080 },
    borders: { width: 2, style: 'dashed', radiusScale: [4, 10, 18] },
    effects: { shadows: ['0 8px 24px rgba(0,0,0,.18)', '0 24px 60px rgba(0,0,0,.28)'], gradients: ['linear-gradient(90deg,#2563eb,#1d4ed8)'], opacities: [.65], semantic: { surfaceShadow: '0 8px 24px rgba(0,0,0,.18)', elevatedShadow: '0 24px 60px rgba(0,0,0,.28)', primaryControlGradient: 'linear-gradient(90deg,#2563eb,#1d4ed8)', disabledControlOpacity: .65 } },
    controls: { height: 40, buttonHeight: 40, inputHeight: 44, iconSize: 20, radius: 10 },
    responsive: { breakpoints: [680, 1024], layoutPatterns: ['grid', 'flex-row'] },
    motion: { durations: ['240ms'], easings: ['ease-in-out'], semantic: { controlDuration: '240ms', controlEasing: 'ease-in-out' } },
  }
  const srcdoc = sandboxPreviewSrcDoc(document, completeSpec, [evidence], '1234567890abcdef1234567890abcdef')
  assert.match(srcdoc, /--border-style:dashed/)
  assert.match(srcdoc, /--control-radius:10px/)
  assert.match(srcdoc, /--section-gap:40px/)
  assert.match(srcdoc, /--disabled-opacity:0\.65/)
  assert.match(srcdoc, /--gradient:linear-gradient\(90deg,#2563eb,#1d4ed8\)/)
  assert.match(srcdoc, /--surface-shadow:0 8px 24px rgba\(0,0,0,.18\)/)
  assert.match(srcdoc, /--elevated-shadow:0 24px 60px rgba\(0,0,0,.28\)/)
  assert.match(srcdoc, /--duration:240ms;--easing:ease-in-out/)
  assert.match(srcdoc, /@media\(max-width:680px\)/)
})

test('raw hero effects stay visible in the specification but are not globally applied without a semantic role', async () => {
  const { sandboxPreviewSrcDoc } = await sandboxModule()
  const rawOnlySpec = {
    ...designSpec,
    effects: {
      shadows: ['0 12px 36px rgba(15,23,42,.24)'],
      gradients: ['linear-gradient(135deg,#111827,#374151)'],
      opacities: [],
    },
  }
  const srcdoc = sandboxPreviewSrcDoc(document, rawOnlySpec, [evidence], '1234567890abcdef1234567890abcdef')
  assert.match(srcdoc, /--surface-shadow:none/)
  assert.match(srcdoc, /--elevated-shadow:none/)
  assert.match(srcdoc, /--gradient:none/)
  assert.match(srcdoc, /--disabled-opacity:0\.5/)
  assert.match(srcdoc, /--duration:160ms;--easing:ease-out/)
  assert.match(srcdoc, /box-shadow:var\(--surface-shadow\)/)
  assert.match(srcdoc, /\.modal\{[^}]*box-shadow:var\(--elevated-shadow\)/)
})

test('generated srcdoc really navigates, validates forms, opens modals, and keeps select mode read-only', async () => {
  const { sandboxPreviewSrcDoc } = await sandboxModule()
  const nonce = '1234567890abcdef1234567890abcdef'
  const srcdoc = sandboxPreviewSrcDoc(document, designSpec, [evidence], nonce)
  const posted = []
  const dom = new JSDOM(srcdoc, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.requestAnimationFrame = callback => { callback(0); return 1 }
      window.parent.postMessage = message => posted.push(message)
    },
  })
  const { window } = dom
  await flush()
  const byId = id => window.document.querySelector(`[data-prototype-element-id="${id}"]`)
  const announcement = window.document.querySelector('#screen-announcement')
  assert.equal(window.document.querySelector('#root')?.hasAttribute('aria-live'), false)
  assert.equal(announcement?.getAttribute('role'), 'status')
  assert.equal(announcement?.textContent, '当前页面：首页')

  byId('open-help').click()
  assert.equal(window.document.querySelector('[role="dialog"]')?.getAttribute('aria-label'), '说明')
  window.document.querySelector('.modal-close').click()
  assert.equal(window.document.querySelector('[role="dialog"]'), null)
  assert.equal(byId('records').querySelectorAll('th').length, 2)
  assert.equal(byId('records').querySelector('button')?.getAttribute('aria-label'), '项目列表：打开 供应商准入')
  byId('records').querySelector('button').click()
  assert.equal(window.document.querySelector('[role="dialog"]')?.getAttribute('aria-label'), '说明')
  window.document.querySelector('.modal-close').click()

  byId('submit').click()
  assert.equal(window.document.querySelector('main')?.getAttribute('aria-label'), '首页')
  assert.equal(window.document.querySelector('#email-error')?.getAttribute('role'), 'alert')
  const email = byId('email').querySelector('input')
  email.value = 'pm@example.test'
  email.dispatchEvent(new window.Event('input', { bubbles: true }))
  byId('submit').click()
  assert.equal(window.document.querySelector('main')?.getAttribute('aria-label'), '完成')
  assert.equal(announcement?.textContent, '当前页面：完成')
  assert.match(window.document.body.textContent, /提交成功/)

  byId('nav-home').click()
  window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { v: 1, type: 'prototype-preview-mode/v1', schema: 'prototype-document/v1', nonce, mode: 'select' } }))
  assert.equal(byId('summary').tabIndex, 0)
  assert.equal(byId('note-a').tagName, 'DIV')
  assert.equal(byId('note-a').tabIndex, 0)
  assert.equal(byId('record-b').tabIndex, 0)
  assert.equal(byId('crumb-current').tabIndex, 0)
  assert.equal(byId('summary-copy').tabIndex, 0)
  assert.equal(byId('disabled-action').disabled, false)
  byId('summary-copy').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  byId('disabled-action').dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'summary-copy'), true)
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'disabled-action'), true)
  byId('note-a').dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'note-a'), true)
  byId('record-b').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  byId('crumb-current').dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'record-b'), true)
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'crumb-current'), true)
  byId('records').querySelector('button').click()
  assert.equal(window.document.querySelector('[role="dialog"]'), null)
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'record-a'), true)
  byId('open-help').click()
  assert.equal(window.document.querySelector('[role="dialog"]'), null)
  assert.equal(posted.some(message => message.type === 'prototype-selection/v1' && message.selection.elementId === 'open-help'), true)
  dom.window.close()
})
