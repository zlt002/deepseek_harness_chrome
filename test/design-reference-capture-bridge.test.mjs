import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function captureGate() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'runDesignReferenceCaptureOnce')
  assert.notEqual(declaration, undefined)
  const compiled = ts.transpileModule(declaration.getText(file).replace(/^export\s+/, ''), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(`${compiled}\nexport { runDesignReferenceCaptureOnce }`)}#${Date.now()}`)
}

async function captureRequest() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'requestDesignReferenceCapture')
  assert.notEqual(declaration, undefined)
  const compiled = ts.transpileModule(declaration.getText(file), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript,${encodeURIComponent(`${compiled}\nexport { requestDesignReferenceCapture }`)}#${Date.now()}`)
}

test('offers reference capture on a Browser Target and keeps the command nonce-bound', async () => {
  const [control, bridge, sidepanel] = await Promise.all([
    readFile(new URL('../packages/harness-ui-browser-target/src/client/BrowserTargetControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../packages/harness-ui-browser-target/src/client/active-tab-bridge.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(control, /正在提取…/)
  assert.match(control, /disabled=\{captureBusy\}/)
  assert.match(control, /制作 AI 原型/)
  assert.match(control, /无需先勾选，也无需设为主目标/)
  assert.match(control, /合并提取设计规范/)
  assert.match(control, /合并参考/)
  assert.match(control, /不会切换、导航或调整你的浏览器/)
  assert.match(control, /非当前可见页不会强行截图/)
  assert.match(control, /role=\{captureBusy \? 'status' : undefined\}/)
  assert.match(control, /capture-design-references/)
  assert.match(bridge, /capture-design-reference/)
  assert.match(bridge, /capturingDesignReferenceTabId/)
  assert.match(sidepanel, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(sidepanel, /capture-design-reference\/v1/)
  assert.match(sidepanel, /requestDesignReferenceCapture/)
  assert.match(sidepanel, /135_000/)
  assert.match(sidepanel, /提取设计规范超时，已自动结束/)
})

test('coalesces consecutive reference-capture commands until the first request settles', async () => {
  const { runDesignReferenceCaptureOnce } = await captureGate()
  const pending = { current: undefined }
  const busy = []; let captures = 0; let release
  const capture = () => { captures += 1; return new Promise(resolve => { release = resolve }) }
  const first = runDesignReferenceCaptureOnce(pending, 7, tabId => busy.push(tabId), capture)
  const duplicate = await runDesignReferenceCaptureOnce(pending, 8, tabId => busy.push(tabId), capture)
  assert.equal(duplicate, undefined)
  assert.equal(captures, 1)
  assert.deepEqual(busy, [7])
  release({ ok: true })
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(busy, [7, undefined])
})

test('ends a lost background capture callback and allows the busy state to clear', async t => {
  const originalWindow = globalThis.window; const originalChrome = globalThis.chrome
  t.after(() => { globalThis.window = originalWindow; globalThis.chrome = originalChrome })
  let timeoutCleared = false
  globalThis.window = { setTimeout: callback => { queueMicrotask(callback); return 17 }, clearTimeout: id => { if (id === 17) timeoutCleared = true } }
  globalThis.chrome = { runtime: { lastError: undefined, sendMessage() {} } }
  const { requestDesignReferenceCapture } = await captureRequest()
  const result = await requestDesignReferenceCapture({ browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test' }, 'session-1')
  assert.deepEqual(result, { ok: false, error: '提取设计规范超时，已自动结束。请确认网页加载完成后重试。' })
  assert.equal(timeoutCleared, false)
})

test('turns a synchronous extension messaging failure into a retryable capture result', async t => {
  const originalWindow = globalThis.window; const originalChrome = globalThis.chrome
  t.after(() => { globalThis.window = originalWindow; globalThis.chrome = originalChrome })
  let timeoutCleared = false
  globalThis.window = { setTimeout: () => 23, clearTimeout: id => { if (id === 23) timeoutCleared = true } }
  globalThis.chrome = { runtime: { lastError: undefined, sendMessage() { throw new Error('extension context invalidated') } } }
  const { requestDesignReferenceCapture } = await captureRequest()
  const result = await requestDesignReferenceCapture({ browser: 'chrome', windowId: 1, tabId: 2, url: 'https://example.test' }, 'session-1')
  assert.deepEqual(result, { ok: false, error: 'extension context invalidated' })
  assert.equal(timeoutCleared, true)
})

test('background capture validates the Side Panel and the same Browser Target before persisting', async () => {
  const background = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  assert.match(background, /request\.type === 'capture-design-reference\/v1'/)
  assert.match(background, /request\.type === 'capture-design-references\/v1'/)
  assert.match(background, /browserTargets\.length < 2 \|\| browserTargets\.length > 3/)
  assert.match(background, /design-reference-capture-progress\/v1/)
  assert.match(background, /!isSidePanelSender\(sender\) \|\| !validBrowserTarget\(request\.browserTarget\)/)
  assert.match(background, /!sameBrowserTarget\(liveBefore, browserTarget\)/)
  assert.match(background, /world: 'ISOLATED'/)
  assert.match(background, /captureVisibleTab\(browserTarget\.windowId, \{ format: 'jpeg', quality: 60 \}\)/)
  assert.match(background, /visibleTargetBeforeScreenshot/)
  assert.match(background, /visibleTargetAfterScreenshot/)
  assert.match(background, /Multi-reference capture deliberately skips the screenshot instead/)
  assert.match(background, /截图期间参考网页被切换/)
  assert.match(background, /!sameBrowserTarget\(liveAfter, browserTarget\)/)
  assert.match(background, /stored\?\.fingerprint !== item\.fingerprint/)
  assert.match(background, /PROTOTYPE_STUDIO_OPEN_PATH/)
  assert.match(background, /prototype-studio-snapshot\/v1/)
  assert.match(background, /prototype-studio-prompt\/v1/)
  assert.match(background, /prototype-studio\.html/)
})
