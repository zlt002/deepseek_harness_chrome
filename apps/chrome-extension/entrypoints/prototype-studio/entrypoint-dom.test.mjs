import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from '../../../../.generated/harness-product/node_modules/jsdom/lib/api.js'

let entrypointPromise
async function bundledEntrypoint() {
  entrypointPromise ??= build({
    entryPoints: [new URL('./main.tsx', import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'prototype-studio-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@vitejs\/plugin-react\/preamble$/ }, () => ({ path: 'vite-preamble', namespace: 'test-stub' }))
        buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: 'styles', namespace: 'test-stub' }))
        buildApi.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: '', loader: 'js' }))
      },
    }],
  })
  const result = await entrypointPromise
  return result.outputFiles[0].text
}

async function bundledStartupGuard() {
  return readFile(new URL('../../public/prototype-startup-guard.js', import.meta.url), 'utf8')
}

async function waitForText(root, expected, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (expected.test(root.textContent ?? '')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function referenceEvidence(id = 'ref-dom') {
  const source = { url: 'https://example.test/dashboard', title: '参考工作台', capturedAt: '2026-08-24T00:00:00.000Z' }
  const viewport = { width: 1280, height: 720, deviceScaleFactor: 2 }
  const pageSize = { width: 1280, height: 2400, sampledBands: 4 }
  const observations = ['跨 4 个页面区域提取颜色、排版、间距与组件。']
  const designTokens = {
    colors: ['#2563eb', '#ffffff', '#172033'], fonts: ['Inter'], radius: ['8px', '12px'], spacing: ['4px', '8px', '16px', '24px'],
    textColors: ['#172033', '#64748b'], backgroundColors: ['#ffffff', '#f7f8fc'], pageBackgroundColors: ['#f7f8fc'], borderColors: ['#e2e8f0'],
    accentColors: ['#2563eb'], accentBackgroundColors: ['#2563eb'], accentTextColors: ['#ffffff'], fontSizes: ['12px', '14px', '28px'], fontWeights: ['400', '700'],
    lineHeights: ['20px', '32px'], letterSpacings: ['0px'], textStyles: [{ kind: 'body', fontSize: '14px', fontWeight: '400', lineHeight: '20px', letterSpacing: '0px' }, { kind: 'heading', fontSize: '28px', fontWeight: '700', lineHeight: '32px', letterSpacing: '0px' }],
    borderWidths: ['1px'], borderStyles: ['solid'], shadows: [], gradients: [], opacities: [], buttonHeights: ['38px'], inputHeights: ['40px'], contentWidths: ['1080px'], iconSizes: ['16px'],
    componentKinds: ['button', 'table', 'input'], componentStates: [], motionDurations: ['160ms'], motionEasings: ['ease-out'], layoutPatterns: ['grid', 'flex-row'], responsiveBreakpoints: [768, 1024],
  }
  const fingerprintInput = { v: 1, source: { url: source.url, title: source.title }, viewport, pageSize, observations, designTokens }
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(fingerprintInput))).digest('hex')
  return { v: 1, id, source, viewport, pageSize, observations, designTokens, fingerprint }
}

function responsiveReferenceEvidence(id, width, height) {
  const evidence = referenceEvidence(id)
  evidence.viewport = { ...evidence.viewport, width, height }
  evidence.pageSize = { ...evidence.pageSize, width }
  const fingerprintInput = { v: 1, source: { url: evidence.source.url, title: evidence.source.title }, viewport: evidence.viewport, pageSize: evidence.pageSize, observations: evidence.observations, designTokens: evidence.designTokens }
  evidence.fingerprint = createHash('sha256').update(JSON.stringify(canonical(fingerprintInput))).digest('hex')
  return evidence
}

function savedPrototypeBundle(evidence) {
  const designSpec = { v: 1, id: 'design-dom', name: '参考规范', basedOnEvidenceIds: [evidence.id], summary: '沿用参考网页的蓝白配色。', colors: [{ name: '主色', value: '#2563eb', usage: '主要操作' }, { name: '底色', value: '#ffffff', usage: '页面背景' }], typography: { fontFamily: 'system-ui', headingWeight: 700, bodySize: 14 }, spacing: { base: 8, cardRadius: 8 }, principles: ['清晰'] }
  const document = {
    v: 1, id: 'prototype-dom-flow', title: '供应商准入', designSpecId: designSpec.id, initialScreenId: 'home',
    screens: [
      { id: 'home', title: '首页', nodes: [{ id: 'heading', type: 'text', text: '供应商准入', tone: 'heading' }, { id: 'go-detail', type: 'button', label: '打开详情', action: { type: 'navigate', targetScreenId: 'detail' } }, { id: 'summary', type: 'card', children: [{ id: 'metric', type: 'metric', label: '待审批', value: '8' }] }] },
      { id: 'detail', title: '详情', nodes: [{ id: 'search', type: 'input', label: '搜索供应商', inputType: 'search' }, { id: 'records', type: 'list', items: [{ id: 'record-one', title: '供应商 A' }] }, { id: 'back', type: 'button', label: '返回', action: { type: 'navigate', targetScreenId: 'home' } }] },
    ],
  }
  const revisionId = 'rev-dom-flow'
  return { designSpec, document, revisionId, revisions: [{ id: revisionId, createdAt: '2026-08-24T01:00:00.000Z', changeSummary: '初始原型', current: true }] }
}

function replaceControlValue(window, control, value) {
  const prototype = control instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, value)
  control.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('startup guard replaces a failed module load with a retryable explanation', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    dom.window.dispatchEvent(new dom.window.Event('error'))
    await waitForText(dom.window.document.getElementById('root'), /AI 原型工具启动失败/)
    const failure = dom.window.document.querySelector('[data-prototype-startup-guard="failed"]')
    assert.equal(failure?.getAttribute('role'), 'alert')
    assert.match(failure.textContent, /AI 原型工具启动失败/)
    assert.match(failure.textContent, /参考网页和已保存版本没有丢失/)
    assert.equal(failure.querySelector('button')?.textContent, '重新加载页面')
  } finally {
    dom.window.close()
  }
})

test('startup guard explains when the development server is unavailable', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><script src="http://127.0.0.1:3101/entrypoints/prototype-studio/main.tsx"></script></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    dom.window.dispatchEvent(new dom.window.Event('error'))
    await waitForText(dom.window.document.getElementById('root'), /旧扩展页面或旧端口/)
    const failure = dom.window.document.querySelector('[data-prototype-startup-guard="failed"]')
    assert.match(failure?.textContent ?? '', /edge:\/\/extensions/)
    assert.match(failure?.textContent ?? '', /关闭当前旧原型页面并重新打开/)
    assert.match(failure?.textContent ?? '', /如果仍失败，再恢复本地开发服务/)
    assert.match(failure?.textContent ?? '', /本地开发服务不可达/)
  } finally {
    dom.window.close()
  }
})

test('startup guard identifies an old extension page or dev port before blaming the server', async () => {
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="prototype-studio-2026-08-25-r2"><body><div id="root"></div><script src="http://127.0.0.1:3100/entrypoints/prototype-studio/main.tsx"></script></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    dom.window.dispatchEvent(new dom.window.Event('error'))
    await waitForText(dom.window.document.getElementById('root'), /旧扩展页面或旧端口/)
    const failure = dom.window.document.querySelector('[data-prototype-startup-guard="failed"]')
    assert.match(failure?.textContent ?? '', /本地开发服务不可达/)
    assert.match(failure?.textContent ?? '', /edge:\/\/extensions/)
    assert.match(failure?.textContent ?? '', /点击本扩展“重新加载”/)
    assert.match(failure?.textContent ?? '', /关闭当前旧原型页面并重新打开/)
    assert.match(failure?.textContent ?? '', /如果仍失败，再恢复本地开发服务/)
  } finally {
    dom.window.close()
  }
})

test('startup guard stops watching after the editor has mounted', async () => {
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="test-build"><body><div id="root" data-prototype-studio-mounted="true"><main>正常编辑器</main></div></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    await new Promise(resolve => setTimeout(resolve, 1_550))
    dom.window.dispatchEvent(new dom.window.Event('unhandledrejection'))
    await new Promise(resolve => setTimeout(resolve, 20))
    const root = dom.window.document.getElementById('root')
    assert.equal(root?.textContent, '正常编辑器')
    assert.equal(root?.querySelector('[data-prototype-startup-guard="failed"]'), null)
  } finally {
    dom.window.close()
  }
})

test('startup guard reports a React startup exception with build identity and retry', async () => {
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="test-build"><body><div id="root" data-prototype-studio-mounted="true"><main>编辑器</main></div><script src="http://127.0.0.1:3101/entrypoints/prototype-studio/main.tsx"></script></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    dom.window.dispatchEvent(new dom.window.CustomEvent('prototype-studio-startup-failure', { detail: { message: 'React 渲染失败：测试错误' } }))
    await waitForText(dom.window.document.getElementById('root'), /React 渲染失败：测试错误/)
    const failure = dom.window.document.querySelector('[data-prototype-startup-guard="failed"]')
    assert.match(failure?.textContent ?? '', /构建版本：test-build/)
    assert.match(failure?.textContent ?? '', /React 渲染失败：测试错误/)
    assert.equal(failure?.querySelector('button')?.textContent, '重新加载页面')
  } finally {
    dom.window.close()
  }
})

test('startup guard catches a mounted root that is later cleared', async () => {
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="test-build"><body><div id="root" data-prototype-studio-mounted="true"><main>编辑器</main></div></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  try {
    dom.window.eval(await bundledStartupGuard())
    dom.window.document.getElementById('root')?.replaceChildren()
    await waitForText(dom.window.document.getElementById('root'), /编辑器根节点被清空/)
    assert.match(dom.window.document.getElementById('root')?.textContent ?? '', /构建版本：test-build/)
  } finally {
    dom.window.close()
  }
})

test('Prototype Studio refuses a stale page and shows the script build identity', async () => {
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="stale-page"><body><div id="root"></div></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /页面与脚本版本不一致/)
    assert.match(root?.textContent ?? '', /构建版本：prototype-studio-2026-08-25-r4/)
    assert.equal(root?.querySelector('button')?.textContent, '重新加载页面')
  } finally {
    dom.window.close()
  }
})

test('Prototype Studio converts a React render exception into a visible startup failure', async () => {
  const evidence = referenceEvidence()
  const projectId = 'prototype-dom-render-error'
  const dom = new JSDOM('<!doctype html><html data-prototype-studio-build="prototype-studio-2026-08-25-r4"><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { configurable: true, get() { throw new Error('测试 sessionStorage 故障') } })
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } },
    runtime: {
      lastError: undefined,
      sendMessage(_message, callback) { callback({ ok: true, snapshot: { projectId, evidence: [{ fingerprint: evidence.fingerprint }], revisions: [], designConfirmed: false } }) },
    },
  }
  dom.window.console.error = () => {}
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /React 渲染失败：测试 sessionStorage 故障/)
    assert.match(root?.textContent ?? '', /构建版本：prototype-studio-2026-08-25-r4/)
    assert.equal(root?.querySelector('button')?.textContent, '重新加载页面')
  } finally {
    dom.window.close()
  }
})

test('Prototype Studio renders the complete design review from a verified reference', async () => {
  const evidence = referenceEvidence()
  const projectId = 'prototype-dom12345'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        assert.equal(message.type, 'prototype-studio-snapshot/v1')
        callback({ ok: true, snapshot: { projectId, evidence: [{ fingerprint: evidence.fingerprint }], revisions: [], designConfirmed: false } })
      },
    },
  }

  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /确认网页设计规范/)
    assert.match(root.textContent, /完整设计规范/)
    assert.match(root.textContent, /这些规范组成的示例页面/)
    assert.match(root.textContent, /颜色系统/)
    assert.match(root.textContent, /排版系统/)
    assert.match(root.textContent, /间距、布局与响应式/)
    assert.match(root.textContent, /边框、圆角与视觉效果/)
    assert.match(root.textContent, /组件与交互状态/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === '确认并交给 AI'), true)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === '调整规范'), true)
  } finally {
    dom.window.close()
  }
})

test('Prototype Studio labels three same-page viewport captures as measured responsive evidence', async () => {
  const evidence = [responsiveReferenceEvidence('ref-responsive-desktop', 1280, 800), responsiveReferenceEvidence('ref-responsive-tablet', 768, 900), responsiveReferenceEvidence('ref-responsive-mobile', 390, 780)]
  const projectId = 'prototype-responsive-review'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence[0].id}&projectId=${projectId}`, runScripts: 'outside-only', pretendToBeVisual: true })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto }); Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() }); dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = { storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: Object.fromEntries(evidence.map(item => [item.id, item])) } }) } }, runtime: { lastError: undefined, sendMessage(message, callback) { assert.equal(message.type, 'prototype-studio-snapshot/v1'); callback({ ok: true, snapshot: { projectId, evidence, revisions: [], designConfirmed: false } }) } } }
  try {
    dom.window.eval(await bundledEntrypoint()); const root = dom.window.document.getElementById('root'); await waitForText(root, /确认网页设计规范/)
    assert.match(root.textContent, /同一网页实测 1280 \/ 768 \/ 390px/)
    assert.match(root.textContent, /3真实采集尺寸/)
    assert.doesNotMatch(root.textContent, /当前只在一个浏览器宽度实测/)
  } finally { dom.window.close() }
})

test('opens a legacy single-reference project when its old Host snapshot has only the verified fingerprint', async () => {
  const evidence = referenceEvidence()
  const projectId = 'prototype-dom-legacy-single'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only', pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } },
    runtime: { lastError: undefined, sendMessage(message, callback) {
      assert.equal(message.type, 'prototype-studio-snapshot/v1')
      callback({ ok: true, snapshot: { projectId, evidence: [{ fingerprint: evidence.fingerprint }], revisions: [], designConfirmed: false } })
    } },
  }
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /确认网页设计规范/)
    assert.match(root?.textContent ?? '', /完整设计规范/)
  } finally { dom.window.close() }
})

test('rejects a multi-reference Host snapshot when any page is only a legacy fingerprint', async () => {
  const primary = referenceEvidence('ref-dom-primary')
  const auxiliary = referenceEvidence('ref-dom-auxiliary')
  const projectId = 'prototype-dom-strict-multi'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${primary.id}&projectId=${projectId}`,
    runScripts: 'outside-only', pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [primary.id]: primary, [auxiliary.id]: auxiliary } } }) } },
    runtime: { lastError: undefined, sendMessage(_message, callback) {
      callback({ ok: true, snapshot: { projectId, evidence: [primary, { fingerprint: auxiliary.fingerprint }], revisions: [], designConfirmed: false } })
    } },
  }
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /原型服务中的参考网页证据不存在或校验失败/)
    assert.match(root?.textContent ?? '', /原型服务中的参考网页证据不存在或校验失败/)
  } finally { dom.window.close() }
})

test('opens an old project from Host evidence after local reference eviction and explains the missing screenshot', async () => {
  const localEvidence = referenceEvidence()
  const { screenshotDataUrl: _screenshot, ...hostEvidence } = localEvidence
  const projectId = 'prototype-host-evidence'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${localEvidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only', pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: {} } }) } },
    runtime: { lastError: undefined, sendMessage(message, callback) {
      assert.equal(message.type, 'prototype-studio-snapshot/v1')
      callback({ ok: true, snapshot: { projectId, evidence: [hostEvidence], revisions: [], designConfirmed: false } })
    } },
  }
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /确认网页设计规范/)
    assert.match(root.textContent, /参考截图已清理/)
    assert.match(root.textContent, /完整设计规范、已确认需求和原型历史仍由可信服务保留/)
  } finally { dom.window.close() }
})

test('expired authorization offers explicit recovery and reopens the same project', async () => {
  const evidence = referenceEvidence()
  const projectId = 'prototype-recover12'
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  let recovered = false
  const messages = []
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(message)
        if (message.type === 'prototype-studio-recover/v1') { recovered = true; callback({ ok: true, snapshot: { projectId } }); return }
        assert.equal(message.type, 'prototype-studio-snapshot/v1')
        if (!recovered) { callback({ ok: false, code: 'prototype_authorization_expired', recoveryAvailable: true, error: '当前浏览器授权已过期，但原型和历史版本仍安全保留。请点击“恢复已有项目”。' }); return }
        callback({ ok: true, snapshot: { projectId, sessionId: 'session-recovery', evidence: [{ id: evidence.id, fingerprint: evidence.fingerprint }], revisions: [], designConfirmed: false } })
      },
    },
  }
  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /原型仍在，只需恢复访问/)
    assert.match(root.textContent, /不会重建项目，也不会删除任何历史版本/)
    const recoveryButton = [...root.querySelectorAll('button')].find(button => button.textContent === '恢复已有项目')
    assert.notEqual(recoveryButton, undefined)
    recoveryButton.click()
    await waitForText(root, /确认网页设计规范/)
    assert.deepEqual(messages.map(message => message.type), ['prototype-studio-snapshot/v1', 'prototype-studio-recover/v1', 'prototype-studio-snapshot/v1'])
    assert.equal(messages[1].projectId, projectId)
    assert.equal(messages[1].referenceId, evidence.id)
  } finally { dom.window.close() }
})

test('Prototype Studio entrypoint renders an actionable screen instead of staying blank', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'chrome-extension://test-extension/prototype-studio.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = { storage: { local: { get: async () => ({}) } }, runtime: { lastError: undefined, sendMessage() {} } }

  try {
    dom.window.eval(await bundledEntrypoint())
    const root = dom.window.document.getElementById('root')
    await waitForText(root, /暂时无法打开原型编辑器/)
    assert.notEqual(root?.textContent?.trim(), '')
    assert.match(root.textContent, /暂时无法打开原型编辑器/)
    assert.match(root.textContent, /请先在侧栏的 Browser Target 中找到网页/)
    assert.equal(root.querySelector('[role="alert"]') !== null, true)
  } finally {
    dom.window.close()
  }
})

async function mountPromptRecoveryEditor({ failFirstRecoveryRead = false, acceptPrompt = true } = {}) {
  const evidence = referenceEvidence()
  const projectId = 'prototype-dom-recovery'
  const saved = savedPrototypeBundle(evidence)
  const snapshot = {
    projectId, evidence: [{ fingerprint: evidence.fingerprint }], designConfirmed: true,
    designSpec: saved.designSpec, document: saved.document, revisions: saved.revisions, currentRevisionId: saved.revisionId,
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  let promptCalls = 0
  let promptStarted = false
  let recoveryReadFailed = false
  const runtime = {
    lastError: undefined,
    sendMessage(message, callback) {
      if (message.type === 'prototype-studio-snapshot/v1') {
        if (promptStarted && failFirstRecoveryRead && !recoveryReadFailed) {
          recoveryReadFailed = true
          runtime.lastError = { message: 'Temporary snapshot channel failure.' }
          callback(undefined)
          runtime.lastError = undefined
          return
        }
        callback({ ok: true, snapshot: structuredClone(snapshot) })
        return
      }
      if (message.type === 'prototype-studio-cancel-generation/v1') { callback({ ok: false, error: 'No active generation request.' }); return }
      assert.equal(message.type, 'prototype-studio-prompt/v1')
      promptCalls += 1
      promptStarted = true
      if (acceptPrompt) snapshot.generationAttempt = { status: 'pending', requestId: message.requestId, expectedRevisionId: saved.revisionId, prompt: message.prompt, at: new Date().toISOString() }
      runtime.lastError = { message: 'The message port closed before a response was received.' }
      callback(undefined)
      runtime.lastError = undefined
    },
  }
  dom.window.chrome = { storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } }, runtime }
  dom.window.eval(await bundledEntrypoint())
  const root = dom.window.document.getElementById('root')
  await waitForText(root, /继续完善整个原型/)
  const request = root.querySelector('textarea[aria-label="原型修改要求"]')
  assert.ok(request)
  replaceControlValue(dom.window, request, '增加供应商风险筛选')
  const send = [...root.querySelectorAll('button')].find(button => button.textContent === '完善整个原型')
  assert.ok(send)
  send.click()
  return { dom, root, promptCalls: () => promptCalls }
}

test('a lost prompt response is recovered from the trusted generation snapshot without allowing a duplicate send', async () => {
  const { dom, root, promptCalls } = await mountPromptRecoveryEditor()
  try {
    await waitForText(root, /(?:发送回包中断，但已回读确认 AI 已接收请求|已恢复正在处理的生成请求)/)
    assert.match(root.textContent, /(?:发送回包中断，但已回读确认 AI 已接收请求|已恢复正在处理的生成请求)/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === 'AI 正在生成并校验…' && button.disabled), true)
    assert.equal(promptCalls(), 1)
  } finally {
    dom.window.close()
  }
})

test('a lost prompt response plus a temporary snapshot failure stays locked until readback recovers', async () => {
  const { dom, root, promptCalls } = await mountPromptRecoveryEditor({ failFirstRecoveryRead: true })
  try {
    await waitForText(root, /已恢复正在处理的生成请求/, 3_000)
    assert.match(root.textContent, /已恢复正在处理的生成请求/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === 'AI 正在生成并校验…' && button.disabled), true)
    assert.equal(promptCalls(), 1)
  } finally {
    dom.window.close()
  }
})

test('an ambiguous request that never reached the Host can be safely unlocked after cancel readback', async () => {
  const { dom, root, promptCalls } = await mountPromptRecoveryEditor({ failFirstRecoveryRead: true, acceptPrompt: false })
  try {
    await waitForText(root, /发送回包中断，并且暂时无法回读是否已接收/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === 'AI 正在生成并校验…' && button.disabled), true)
    const stop = [...root.querySelectorAll('button')].find(button => button.textContent === '停止本次生成')
    assert.ok(stop)
    stop.click()
    await waitForText(root, /确认停止生成/)
    const confirmStop = [...root.querySelectorAll('button')].find(button => button.textContent === '确认停止生成')
    assert.ok(confirmStop)
    confirmStop.click()
    await waitForText(root, /已回读确认服务端没有活跃生成/)
    assert.match(root.textContent, /已回读确认服务端没有活跃生成/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === '完善整个原型' && !button.disabled), true)
    assert.match(root.querySelector('textarea[aria-label="原型修改要求"]')?.value ?? '', /增加供应商风险筛选/)
    assert.equal(promptCalls(), 1)
  } finally {
    dom.window.close()
  }
})

function confirmedProductBrief() {
  return {
    v: 1,
    audience: '采购经理、供应商管理员',
    coreTask: '筛选供应商并完成准入审批',
    requiredPages: ['工作台', '供应商列表', '审批详情'],
    requiredModules: ['关键指标', '组合筛选', '供应商表格'],
    requiredFlows: ['筛选供应商', '打开审批详情', '通过或驳回申请'],
    notes: '展示负责人、风险和资质。',
  }
}

test('AI conversation suggestion fills an editable requirement draft without confirming it', async () => {
  const evidence = referenceEvidence(); const projectId = 'prototype-dom-suggestion'; const saved = savedPrototypeBundle(evidence); const brief = confirmedProductBrief()
  const snapshot = { projectId, evidence: [{ fingerprint: evidence.fingerprint }], designConfirmed: true, confirmedDesignSpec: saved.designSpec, revisions: [] }
  const messages = []
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`, runScripts: 'outside-only', pretendToBeVisual: true })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto }); Object.defineProperty(dom.window, 'sessionStorage', { value: memoryStorage() }); dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = { storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } }, runtime: { lastError: undefined, sendMessage(message, callback) {
    messages.push(message)
    if (message.type === 'prototype-studio-snapshot/v1') { callback({ ok: true, snapshot: structuredClone(snapshot) }); return }
    if (message.type === 'prototype-studio-suggest-brief/v1') { snapshot.briefSuggestionAttempt = { status: 'saved', requestId: message.requestId, expiresAt: Date.now() + 60_000 }; snapshot.suggestedProductBrief = brief; callback({ ok: true }); return }
    throw new Error(`Unexpected message: ${message.type}`)
  } } }
  try {
    dom.window.eval(await bundledEntrypoint()); const root = dom.window.document.getElementById('root'); await waitForText(root, /AI 从当前对话整理需求/)
    const suggest = [...root.querySelectorAll('button')].find(button => button.textContent === 'AI 从当前对话整理需求'); assert.ok(suggest); suggest.click()
    await waitForText(root, /AI 已根据当前对话整理成需求草稿/)
    assert.equal(root.querySelector('.brief-builder input')?.value, brief.audience)
    assert.match(root.querySelector('.brief-builder textarea')?.value ?? '', /供应商列表/)
    assert.equal([...root.querySelectorAll('button')].some(button => button.textContent === '保存并确认需求清单'), true)
    assert.equal(messages.some(message => message.type === 'prototype-studio-confirm-brief/v1'), false)
  } finally { dom.window.close() }
})

async function mountRequirementsUpdateEditor(draftStore = memoryStorage()) {
  const evidence = referenceEvidence()
  const projectId = 'prototype-dom-update'
  const saved = savedPrototypeBundle(evidence)
  const snapshot = {
    projectId, evidence: [{ fingerprint: evidence.fingerprint }], designConfirmed: true,
    designSpec: saved.designSpec, document: saved.document, revisions: saved.revisions, currentRevisionId: saved.revisionId,
    productBrief: confirmedProductBrief(),
  }
  const messages = []
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `chrome-extension://test-extension/prototype-studio.html?referenceId=${evidence.id}&projectId=${projectId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'crypto', { value: globalThis.crypto })
  Object.defineProperty(dom.window, 'sessionStorage', { value: draftStore })
  dom.window.ResizeObserver = class { observe() {} disconnect() {} }
  dom.window.chrome = {
    storage: { local: { get: async () => ({ harnessPrototypeReferencesV1: { v: 1, references: { [evidence.id]: evidence } } }) } },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        if (message.type === 'prototype-studio-snapshot/v1') { callback({ ok: true, snapshot: structuredClone(snapshot) }); return }
        if (message.type === 'prototype-studio-prompt/v1') { messages.push(message); callback({ ok: true }); return }
        throw new Error(`Unexpected message: ${message.type}`)
      },
    },
  }
  dom.window.eval(await bundledEntrypoint())
  const root = dom.window.document.getElementById('root')
  await waitForText(root, /更新产品需求/)
  return { dom, root, messages, draftStore, snapshot }
}

test('an unsent whole-prototype modification survives a tab refresh', async () => {
  const draftStore = memoryStorage()
  const first = await mountRequirementsUpdateEditor(draftStore)
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const request = first.root.querySelector('textarea[aria-label="原型修改要求"]')
    assert.ok(request); replaceControlValue(first.dom.window, request, '改成打开供应商风险抽屉')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.match(draftStore.getItem('prototype-studio-request-draft:v1:prototype-dom-update') ?? '', /供应商风险抽屉/)
  } finally { first.dom.window.close() }
  const restored = await mountRequirementsUpdateEditor(draftStore)
  try {
    await waitForText(restored.root, /已恢复上次未发送的修改要求/)
    assert.match(restored.root.querySelector('textarea[aria-label="原型修改要求"]')?.value ?? '', /供应商风险抽屉/)
  } finally { restored.dom.window.close() }
})

test('an existing prototype updates requirements as a whole-prototype request without replacing the saved brief early', async () => {
  const { dom, root, messages, snapshot } = await mountRequirementsUpdateEditor()
  try {
    const begin = [...root.querySelectorAll('button')].find(button => button.textContent === '更新产品需求')
    assert.ok(begin)
    begin.click()
    await waitForText(root, /更新产品需求并生成新版本/)
    assert.match(root.textContent, /更新产品需求并生成新版本/)
    assert.match(root.textContent, /当前版本仍使用旧需求；新版本通过校验并保存后才会更新。/)
    const builderFields = [...root.querySelectorAll('.brief-builder textarea')]
    assert.equal(builderFields.length, 3)
    assert.match(builderFields[0].value, /供应商列表/)
    assert.match(builderFields[2].value, /打开审批详情/)
    const sendBeforeChange = [...root.querySelectorAll('button')].find(button => button.textContent === '确认需求变更并生成新版本')
    assert.ok(sendBeforeChange)
    assert.equal(sendBeforeChange.disabled, true)
    replaceControlValue(dom.window, builderFields[0], '工作台\n供应商列表\n审批详情\n风险报表')
    replaceControlValue(dom.window, builderFields[2], '筛选供应商\n打开审批详情\n打开风险报表')
    await new Promise(resolve => setTimeout(resolve, 20))
    const send = [...root.querySelectorAll('button')].find(button => button.textContent === '确认需求变更并生成新版本')
    assert.ok(send)
    assert.equal(send.disabled, false)
    send.click()
    await waitForText(root, /AI 正在生成并校验原型/)
    assert.equal(messages.length, 1)
    assert.deepEqual(Array.from(messages[0].brief.requiredPages), ['工作台', '供应商列表', '审批详情', '风险报表'])
    assert.deepEqual(Array.from(messages[0].brief.requiredFlows), ['筛选供应商', '打开审批详情', '打开风险报表'])
    assert.equal('selection' in messages[0], false)
    assert.deepEqual(snapshot.productBrief, confirmedProductBrief(), 'the old brief remains authoritative until the new revision saves')
  } finally {
    dom.window.close()
  }
})

test('an unsent requirements update survives a tab refresh and can be cancelled back to the confirmed brief', async () => {
  const draftStore = memoryStorage()
  const first = await mountRequirementsUpdateEditor(draftStore)
  try {
    const begin = [...first.root.querySelectorAll('button')].find(button => button.textContent === '更新产品需求')
    assert.ok(begin)
    begin.click()
    await waitForText(first.root, /更新产品需求并生成新版本/)
    assert.match(first.root.textContent, /更新产品需求并生成新版本/)
    const notes = first.root.querySelector('textarea[aria-label="产品补充说明"]')
    assert.ok(notes)
    replaceControlValue(first.dom.window, notes, '新增风险报表和风险趋势图。')
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    first.dom.window.close()
  }
  const restored = await mountRequirementsUpdateEditor(draftStore)
  try {
    await waitForText(restored.root, /更新产品需求并生成新版本/)
    assert.match(restored.root.querySelector('textarea[aria-label="产品补充说明"]')?.value ?? '', /新增风险报表和风险趋势图/)
    const cancel = [...restored.root.querySelectorAll('button')].find(button => button.textContent === '取消更新')
    assert.ok(cancel)
    cancel.click()
    await waitForText(restored.root, /已取消本次需求更新/)
    assert.equal([...restored.root.querySelectorAll('button')].some(button => button.textContent === '更新产品需求'), true)
    assert.match(restored.root.textContent, /展示负责人、风险和资质/)
  } finally {
    restored.dom.window.close()
  }
})
