import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'
import { JSDOM } from '../.generated/harness-product/node_modules/jsdom/lib/api.js'

async function loadSessionRunLock() {
  const source = await readFile(new URL('../packages/harness-ui-browser-target/src/client/session-run-lock.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}-${Math.random()}`)
}

test('composer keeps the draft and surfaces Browser Target preparation failures', async () => {
  const hub = await readFile(new URL('../.generated/harness-product/packages/client/ui-conversation/src/client/input/hub.ts', import.meta.url), 'utf8')
  const preparationFailure = hub.indexOf("shell?.notify('error', error instanceof Error ? error.message : String(error))")
  const commit = hub.indexOf('shell?.commitSend(imageIds)')
  assert.ok(preparationFailure >= 0, 'a rejected Browser Target lock must be visible to the user')
  assert.ok(commit > preparationFailure, 'the draft is committed only after every submission guard succeeds')
})

async function loadBackground({ settings, activeTab, tabsById = {}, sessionStorage, onStorageSet, transferNack = false, createdTab, waitForTransferAck, executeScript, reload, teamDocProbeWaitMs = 0, closeSidePanel, openSidePanel, setSidePanelOptions, manifestVersion, runtimeGetUrl, backgroundFetch, runtimeResponseTimeoutMs = 100 } = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  let runtimeListener
  let activatedListener
  let createdListener
  let updatedListener
  let currentActiveTab = activeTab
  const completedNavigationListeners = new Set()
  const nativeMessages = []
  const createdUrls = []
  const removedTabs = []
  const ports = []
  const connectNative = () => {
    const nativeMessageListeners = new Set()
    const nativeDisconnectListeners = new Set()
    const port = {
      onDisconnect: {
        addListener: (listener) => nativeDisconnectListeners.add(listener),
        removeListener: (listener) => nativeDisconnectListeners.delete(listener),
      },
      onMessage: {
        addListener: (listener) => nativeMessageListeners.add(listener),
        removeListener: (listener) => nativeMessageListeners.delete(listener),
      },
      postMessage: (message) => {
        nativeMessages.push(message)
        if (message.type === 'start') {
          queueMicrotask(() => {
            for (const listener of nativeMessageListeners) {
              listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-follow' } })
            }
          })
        }
        if (message.type === 'transfer-browser-target') {
          void (async () => {
            await waitForTransferAck
            for (const listener of nativeMessageListeners) {
              listener(transferNack
                ? { type: 'browser_target_transfer_failed', requestId: message.requestId, error: 'Browser Target transfer does not match the active Harness Run.' }
                : { type: 'browser_target_transferred', requestId: message.requestId, payload: { runId: message.runId, browserTarget: message.browserTarget } })
            }
          })()
        }
      },
      disconnect: () => {
        for (const listener of nativeDisconnectListeners) listener()
      },
      emit: (message) => {
        for (const listener of nativeMessageListeners) listener(message)
      },
    }
    ports.push(port)
    return port
  }
  const stored = sessionStorage ?? { harnessBrowserTargetSettings: settings }
  const originalFetch = globalThis.fetch
  if (backgroundFetch !== undefined) globalThis.fetch = backgroundFetch
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      connectNative,
      getManifest: manifestVersion ? () => ({ version: manifestVersion }) : undefined,
      getURL: runtimeGetUrl ?? ((path) => `chrome-extension://test/${path}`),
      lastError: undefined,
      onMessage: { addListener: (listener) => { runtimeListener = listener } },
      sendMessage: async () => {},
    },
    storage: { session: {
      get: async () => stored,
      set: async (value) => {
        await onStorageSet?.(value, stored)
        Object.assign(stored, value)
      },
    } },
    windows: { getLastFocused: async () => ({ id: currentActiveTab.windowId }) },
    tabs: {
      query: async () => [currentActiveTab],
      get: async (tabId) => tabsById[tabId] ?? (tabId === currentActiveTab.id ? currentActiveTab : undefined),
      create: async (options) => {
        createdUrls.push(options.url)
        return createdTab ?? Object.values(tabsById).find((tab) => tab.url === options.url)
      },
      remove: async (tabId) => { removedTabs.push(tabId) },
      reload: async (tabId) => {
        await reload?.(tabId)
        for (const listener of completedNavigationListeners) listener({ tabId, frameId: 0 })
      },
      onActivated: { addListener: (listener) => { activatedListener = listener } },
      onCreated: { addListener: (listener) => { createdListener = listener } },
      onUpdated: { addListener: (listener) => { updatedListener = listener } },
    },
    scripting: { executeScript: async (options) => executeScript?.(options) ?? [] },
    webNavigation: {
      getAllFrames: async () => [],
      onCompleted: {
        addListener: (listener) => completedNavigationListeners.add(listener),
        removeListener: (listener) => completedNavigationListeners.delete(listener),
      },
    },
    sidePanel: {
      open: async (options) => openSidePanel?.(options),
      close: async (options) => closeSidePanel?.(options),
      setOptions: async (options) => setSidePanelOptions?.(options),
    },
  }
  globalThis.defineBackground = (setup) => setup()
  globalThis.__DSH_TEAM_DOC_PROBE_WAIT_MS = teamDocProbeWaitMs
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
  return {
    nativeMessages,
    sessionStorage: stored,
    createdUrls,
    removedTabs,
    sendRuntimeMessage: (message, sender = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('runtime response timeout')), runtimeResponseTimeoutMs)
      const keepChannelOpen = runtimeListener(message, sender, (response) => {
        clearTimeout(timeout)
        resolve(response)
      })
      if (keepChannelOpen !== true) {
        clearTimeout(timeout)
        reject(new Error('runtime message did not keep its response channel open'))
      }
    }),
    activateTab: (tabId) => {
      currentActiveTab = tabsById[tabId] ?? currentActiveTab
      activatedListener({ tabId })
    },
    createTab: (tab) => createdListener(tab),
    updateActiveTab: (changeInfo, tab) => {
      currentActiveTab = tab
      updatedListener(tab.id, changeInfo, tab)
    },
    emitNative: (message, portIndex = ports.length - 1) => ports[portIndex].emit(message),
    disconnectNative: () => ports.at(-1).disconnect(),
    cleanup: async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      globalThis.fetch = originalFetch
      delete globalThis.chrome
      delete globalThis.defineBackground
      delete globalThis.__DSH_TEAM_DOC_PROBE_WAIT_MS
    },
  }
}

test('background creates the selected-session full-screen Harness Tab before closing the side panel', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/follow', title: 'Follow target' }
  const closeCalls = []
  let background
  let createdAtClose = 0
  background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab,
    manifestVersion: '1.1.75',
    closeSidePanel: async (options) => { createdAtClose = background.createdUrls.length; closeCalls.push(options) },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId: 7, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: true })
    const createdUrl = new URL(background.createdUrls[0])
    assert.equal(createdUrl.protocol, 'chrome-extension:')
    assert.equal(createdUrl.host, 'test')
    assert.equal(createdUrl.searchParams.get('dshHarnessSurface'), 'fullscreen-tab')
    assert.equal(createdUrl.searchParams.get('dshHarnessSessionId'), 'session-current')
    assert.match(createdUrl.searchParams.get('dshHarnessHandoffNonce'), /^[A-Za-z0-9._:-]{32,160}$/)
    assert.equal(createdAtClose, 1, 'the persistent background creates the Tab before it closes the side-panel document')
    assert.deepEqual(closeCalls, [{ windowId: 7 }])
  } finally {
    await background.cleanup()
  }
})

test('HTML Workbench picker clears native text selection for Shift multi-select and restores the page on cancel', async () => {
  const target = { id: 42, windowId: 7, url: 'file:///tmp/html-workbench-picker.html', title: 'Picker fixture' }
  const dom = new JSDOM('<main><p id="first">first selectable text</p><p id="second">second selectable text</p></main>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: target,
    executeScript: async (options) => {
      if (!options.args || !options.func) return []
      window.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } }
      window.CSS ??= { escape: value => value }
      const picker = window.eval(`(${options.func.toString()})`)
      await picker(...options.args)
      return []
    },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'html-workbench-select/v1', tabId: 42, sessionId: 'picker-session' }, { url: 'chrome-extension://test/sidepanel.html' })
    assert.deepEqual(response, { ok: true })
    const firstText = window.document.querySelector('#first').firstChild
    const selection = window.document.getSelection(); const range = window.document.createRange(); range.selectNodeContents(firstText); selection.removeAllRanges(); selection.addRange(range)
    const second = window.document.querySelector('#second')
    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true }); second.dispatchEvent(down)
    second.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    assert.equal(down.defaultPrevented, true, 'picker must block the pre-click native selection gesture')
    assert.equal(selection.rangeCount, 0, 'Shift multi-select must not leave a native text selection')
    assert.equal(second.hasAttribute('data-accrui-html-selected'), true)
    assert.equal(window.document.documentElement.getAttribute('data-accrui-html-workbench-picking'), 'true')
    ;[...window.document.querySelectorAll('#accrui-html-workbench-picker button')].find(button => button.textContent === '取消').click()
    assert.equal(window.document.documentElement.hasAttribute('data-accrui-html-workbench-picking'), false)
    assert.equal(window.document.querySelector('#accrui-html-workbench-picker'), null)
  } finally { await background.cleanup(); dom.window.close() }
})

test('HTML Workbench reads a same-URL local source when Chromium reports a readable status-0 response', async () => {
  const target = { id: 42, windowId: 7, url: 'file:///tmp/supply-hall.html', title: 'Supply hall' }
  const browserTarget = { browser: 'chrome', windowId: 7, tabId: target.id, url: target.url }
  const dom = new JSDOM('<main>Supply hall</main>', { url: target.url, runScripts: 'outside-only' })
  const { window } = dom
  const source = '<!doctype html><main>Supply hall</main>'
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: target,
    runtimeGetUrl: path => `https://extension.invalid/${path}`,
    backgroundFetch: async () => ({ ok: false }),
    executeScript: async (options) => {
      window.fetch = async (url) => {
        assert.equal(url, target.url)
        return { ok: false, status: 0, url: target.url, text: async () => source }
      }
      Object.defineProperty(window, 'crypto', { value: globalThis.crypto })
      window.TextEncoder = TextEncoder
      const injected = window.eval(`(${options.func.toString()})`)
      try {
        return [{ result: await injected() }]
      } catch (error) {
        assert.match(error.message, /^file_source_readback_0$/)
        return []
      }
    },
  })
  const responseFor = async (requestId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      const response = background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === requestId)
      if (response !== undefined) return response
    }
    throw new Error(`missing ${requestId} response`)
  }
  try {
    const started = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(started, { ok: true, url: 'http://127.0.0.1:43123' })
    background.emitNative({ type: 'connector_request', requestId: 'html-status-zero', runId: 'run-follow', generation: 'generation-1', browserTarget, tool: 'html_workbench', action: 'read' })
    const response = await responseFor('html-status-zero')
    assert.equal(response.error, undefined)
    assert.match(response.result.domFingerprint, /^[a-f0-9]{64}$/)
  } finally { await background.cleanup(); dom.window.close() }
})

test('HTML Workbench refresh readback fails closed until the loaded stylesheet hash and selected DOM state are observable', async () => {
  const target = { id: 42, windowId: 7, url: 'file:///tmp/supply-hall.html', title: 'Supply hall' }
  const browserTarget = { browser: 'chrome', windowId: 7, tabId: target.id, url: target.url }
  const stylesheetUrl = 'file:///tmp/supply-hall.css'
  const source = '<!doctype html><link rel="stylesheet" href="supply-hall.css"><p id="selected">Supply hall</p>'
  const stylesheet = '#selected { color: rgb(1, 2, 3); }'
  const fingerprint = (value) => createHash('sha256').update(value).digest('hex')
  const dom = new JSDOM('<!doctype html><link rel="stylesheet" href="supply-hall.css"><p id="selected">Supply hall</p>', { url: target.url, runScripts: 'outside-only' })
  const { window } = dom
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: target,
    runtimeGetUrl: path => `https://extension.invalid/${path}`,
    backgroundFetch: async () => ({ ok: false }),
    executeScript: async (options) => {
      window.fetch = async (url) => {
        if (url === target.url) return { ok: false, status: 0, url: target.url, text: async () => source }
        if (url === stylesheetUrl) return { ok: false, status: 0, url: stylesheetUrl, text: async () => stylesheet }
        throw new Error(`unexpected readback URL ${url}`)
      }
      Object.defineProperty(window, 'crypto', { value: globalThis.crypto })
      window.TextEncoder = TextEncoder
      const injected = window.eval(`(${options.func.toString()})`)
      return [{ result: await injected(...(options.args ?? [])) }]
    },
  })
  const responseFor = async (requestId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      const response = background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === requestId)
      if (response !== undefined) return response
    }
    throw new Error(`missing ${requestId} response`)
  }
  try {
    const started = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(started, { ok: true, url: 'http://127.0.0.1:43123' })
    background.emitNative({
      type: 'connector_request', requestId: 'html-css-stale-readback', runId: 'run-follow', generation: 'generation-1', browserTarget, tool: 'html_workbench', action: 'refresh_readback',
      expectedSourceFingerprint: fingerprint(source), expectedStylesheets: [{ url: stylesheetUrl, fingerprint: fingerprint('stale stylesheet') }], expectedAnchorSelectors: ['#selected'],
    })
    const stale = await responseFor('html-css-stale-readback')
    assert.equal(stale.error, undefined)
    assert.equal(stale.result.verified, false, 'a CSS-only stale readback must never be reported as a Verified Write')
    assert.equal(stale.result.error, 'html_workbench_readback_mismatch')
    background.emitNative({
      type: 'connector_request', requestId: 'html-css-readback', runId: 'run-follow', generation: 'generation-1', browserTarget, tool: 'html_workbench', action: 'refresh_readback',
      expectedSourceFingerprint: fingerprint(source), expectedStylesheets: [{ url: stylesheetUrl, fingerprint: fingerprint(stylesheet) }], expectedAnchorSelectors: ['#selected'],
    })
    const response = await responseFor('html-css-readback')
    assert.equal(response.error, undefined)
    assert.equal(response.result.verified, true)
    assert.equal(JSON.stringify(response.result.stylesheetFingerprints), JSON.stringify([{ url: stylesheetUrl, fingerprint: fingerprint(stylesheet) }]))
    assert.equal(JSON.stringify(response.result.anchorStates.map(item => item.selector)), JSON.stringify(['#selected']))
    assert.equal(typeof response.result.anchorStates[0].computedStyle.color, 'string')
  } finally { await background.cleanup(); dom.window.close() }
})

test('background prepares the Side Panel handoff but never calls the user-gesture-only open API', async () => {
  const handoffNonce = '9'.repeat(32)
  const fullScreenTab = { id: 91, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${handoffNonce}`, title: 'ACCRUI' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: fullScreenTab,
    openSidePanel: async () => { throw new Error('sidePanel.open() may only be called in response to a user gesture') },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(background.removedTabs, [], 'the full-screen Tab stays open until the side panel applies the session')
    assert.deepEqual((await background.sendRuntimeMessage({ type: 'get-sidepanel-handoff/v1', windowId: 7 })).nonce, handoffNonce)
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-other' }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: false, error: 'The Harness side-panel handoff does not match the restored session.' })
    assert.deepEqual(background.removedTabs, [], 'an invalid session ACK must not close the full-screen Tab')
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-current' }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: true })
    assert.deepEqual(background.removedTabs, [91])
  } finally {
    await background.cleanup()
  }
})

test('background preserves the full-screen Tab when handoff preparation identifies a Tab from another window', async () => {
  const handoffNonce = 'a'.repeat(32)
  const fullScreenTab = { id: 91, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${handoffNonce}`, title: 'ACCRUI' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: fullScreenTab,
    tabsById: { 91: { ...fullScreenTab, windowId: 8 } },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: false, error: 'The full-screen Harness Tab is no longer in this browser window.' })
    assert.deepEqual(background.removedTabs, [])
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true })
  } finally {
    await background.cleanup()
  }
})

test('the URL-defined Side Panel handoff closes the full-screen Tab even if background preparation arrives late', async () => {
  const handoffNonce = 'b'.repeat(32)
  const fullScreenTab = { id: 91, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessSessionId=session-current&dshHarnessHandoffNonce=${handoffNonce}`, title: 'ACCRUI' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: fullScreenTab,
  })
  try {
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-current' }), { ok: true })
    const response = await background.sendRuntimeMessage({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 91, nonce: handoffNonce, sessionId: 'session-current' }, { url: 'chrome-extension://test/sidepanel.html' })
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(background.removedTabs, [91])
  } finally {
    await background.cleanup()
  }
})

test('sidepanel ensure-harness resolves the last-focused active tab for the default follow-active-tab mode', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/follow', title: 'Follow target' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab,
    manifestVersion: '1.1.75',
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(response, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(background.nativeMessages, [{
      type: 'start',
      productVersion: '1.1.75',
      browserTarget: { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://docs.example.test/follow' },
    }])
  } finally {
    await background.cleanup()
  }
})

test('product-owned extension Tabs are absent from the Browser Target roster', async () => {
  const reviewTab = { id: 91, windowId: 7, url: 'chrome-extension://test/markdown-review.html?reviewId=review-1', title: 'Markdown Review' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: reviewTab,
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(response.tabs, [])
  } finally {
    await background.cleanup()
  }
})

test('follow-active-tab keeps the last revalidated Browser Target while a product Tab is foreground', async () => {
  const page = { id: 42, windowId: 7, url: 'https://docs.example.test/review-source', title: 'Review source' }
  const candidate = { browser: 'chrome', windowId: 7, tabId: 42, url: page.url }
  const reviewTab = { id: 91, windowId: 7, url: 'chrome-extension://test/markdown-review.html?reviewId=review-1', title: 'Markdown Review' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [], candidate },
    activeTab: reviewTab,
    tabsById: { 42: page },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(response, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(background.nativeMessages, [{ type: 'start', browserTarget: candidate }])
  } finally {
    await background.cleanup()
  }
})

test('pinned mode treats a product-owned extension Tab as unavailable', async () => {
  const reviewTab = { id: 91, windowId: 7, url: 'chrome-extension://test/markdown-review.html?reviewId=review-1', title: 'Markdown Review' }
  const pinned = { browser: 'chrome', windowId: 7, tabId: 91, url: reviewTab.url }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [pinned], primaryTabId: 91 },
    activeTab: reviewTab,
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(response.ok, false)
    assert.match(response.error, /Select it again/i)
    assert.deepEqual(background.nativeMessages, [])
  } finally {
    await background.cleanup()
  }
})

test('transfer revalidation rejects a product-owned extension Tab', async () => {
  const page = { id: 42, windowId: 7, url: 'https://docs.example.test/source', title: 'Source' }
  const reviewTab = { id: 91, windowId: 7, url: 'chrome-extension://test/markdown-review.html?reviewId=review-1', title: 'Markdown Review' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: page,
    tabsById: { 91: reviewTab },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const response = await background.sendRuntimeMessage({
      type: 'transfer-browser-target',
      runId: 'run-follow',
      browserTarget: { browser: 'chrome', windowId: 7, tabId: 91, url: reviewTab.url },
    })
    assert.equal(response.ok, false)
    assert.match(response.error, /changed before transfer/i)
  } finally {
    await background.cleanup()
  }
})

test('manual tab activation updates only the next-Run candidate and never transfers a running Run', async () => {
  const first = { id: 42, windowId: 7, url: 'https://docs.example.test/first', title: 'First target' }
  const second = { id: 43, windowId: 7, url: 'https://docs.example.test/second', title: 'Second target' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: first, tabsById: { 43: second },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    await background.activateTab(43)
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some((message) => message.type === 'connector_response' && message.requestId === 'wb-turn'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const restored = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(restored.settings.candidate, {
      browser: 'chrome', windowId: 7, tabId: 43, url: second.url,
    })
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(background.nativeMessages.length, 1)
    assert.equal(background.nativeMessages[0].type, 'start')
  } finally {
    await background.cleanup()
  }
})

test('follow-active-tab keeps the Browser Target frozen after the Run starts, even when the active tab changes', async () => {
  const baidu = { id: 42, windowId: 7, url: 'https://www.baidu.com/', title: 'Baidu' }
  const wb = { id: 43, windowId: 7, url: 'https://wb.example.test/', title: 'WB' }
  const baiduTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: baidu.url }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: baidu, tabsById: { 42: baidu, 43: wb },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    // This is deliberately the target carried by the submission, not a later
    // active-tab lookup. Switch first to prove the lock retains the submitted
    // Browser Target.
    await background.activateTab(43)
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'lock-browser-target/v1', sessionId: 'session-follow', submissionId: 'follow-1', browserTarget: baiduTarget,
    }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'lock-browser-target/v1', sessionId: 'session-other', submissionId: 'follow-2', browserTarget: { browser: 'chrome', windowId: 7, tabId: 43, url: wb.url },
    }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: false, error: '另一个对话正在运行，结束后再试。' })
    background.emitNative({
      type: 'connector_request', requestId: 'baidu-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'list_work_tabs',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({
      type: 'connector_request', requestId: 'wb-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'list_work_tabs',
    })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some((message) => message.type === 'connector_response' && message.requestId === 'wb-turn'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const transferIndex = background.nativeMessages.findIndex((message) => message.type === 'transfer-browser-target' && message.requestId === 'wb-turn')
    const responseIndex = background.nativeMessages.findIndex((message) => message.type === 'connector_response' && message.requestId === 'wb-turn')
    assert.equal(transferIndex, -1, 'an active-tab change must not migrate an in-flight Run')
    const secondTurn = background.nativeMessages[responseIndex]
    assert.equal(secondTurn.result.pageIdentity.url, baidu.url)
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-follow', submissionId: 'follow-1' }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: true })
    background.emitNative({
      type: 'connector_request', requestId: 'after-complete', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'list_work_tabs',
    })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some((message) => message.type === 'connector_response' && message.requestId === 'after-complete'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const afterComplete = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'after-complete')
    assert.equal(afterComplete.result.pageIdentity.url, wb.url, 'completion restores follow-current Browser Target behavior')
  } finally {
    await background.cleanup()
  }
})

test('follow-active-tab permits concurrent sessions on the same frozen Browser Target', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const b = { id: 43, windowId: 7, url: 'https://docs.example.test/b', title: 'B' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const targetB = { browser: 'chrome', windowId: 7, tabId: b.id, url: b.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a, 43: b } })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA }, sender), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-b', submissionId: 'submission-b', browserTarget: targetA }, sender), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), {
      ok: true,
      lock: { sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA },
      locks: [
        { sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA },
        { sessionId: 'session-b', submissionId: 'submission-b', browserTarget: targetA },
      ],
    })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a' }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), {
      ok: true, lock: { sessionId: 'session-b', submissionId: 'submission-b', browserTarget: targetA },
    })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-c', submissionId: 'submission-c', browserTarget: targetB }, sender), { ok: false, error: '另一个对话正在运行，结束后再试。' })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-b', submissionId: 'submission-b' }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), { ok: true })
    await background.activateTab(b.id)
    background.emitNative({ type: 'connector_request', requestId: 'after-last-unlock', runId: 'run-follow', generation: 'generation-a', browserTarget: targetA, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'after-last-unlock'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'after-last-unlock').result.pageIdentity.url, b.url, 'follow mode returns only after the last owner releases')
  } finally {
    await background.cleanup()
  }
})

test('concurrent first locks for one Browser Target share a single Native transfer', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const transferGate = Promise.withResolvers()
  const background = await loadBackground({
    settings: { mode: 'none', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a }, waitForTransferAck: transferGate.promise,
    runtimeResponseTimeoutMs: 1_000,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const first = background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA }, sender)
    const second = background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-b', submissionId: 'submission-b', browserTarget: targetA }, sender)
    for (let attempt = 0; attempt < 20; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.filter(message => message.type === 'transfer-browser-target').length, 1, 'same-target owners must share the in-flight transfer')
    transferGate.resolve()
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true, locked: true }, { ok: true, locked: true }])
  } finally {
    transferGate.resolve()
    await background.cleanup()
  }
})

test('follow-active-tab caps concurrent Browser Target owners at the snapshot protocol limit', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a } })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    for (let index = 0; index < 32; index += 1) {
      assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: `session-${index}`, submissionId: `submission-${index}`, browserTarget: targetA }, sender), { ok: true, locked: true })
    }
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-32', submissionId: 'submission-32', browserTarget: targetA }, sender), {
      ok: false, error: '同时运行的对话过多，请等待一个对话结束后再试。',
    })
    const active = await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender)
    assert.equal(active.locks.length, 32)
  } finally {
    await background.cleanup()
  }
})

test('releasing a disappeared session lock lets the next session lock the same Run', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const b = { id: 43, windowId: 7, url: 'https://docs.example.test/b', title: 'B' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const targetB = { browser: 'chrome', windowId: 7, tabId: b.id, url: b.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a, 43: b } })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA }, sender), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a' }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-b', submissionId: 'submission-b', browserTarget: targetB }, sender), { ok: true, locked: true })
  } finally {
    await background.cleanup()
  }
})

test('a follow lock keeps its send-moment Browser Target while an in-flight settings save switches to none', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  let markNoneWriteStarted
  let releaseNoneWrite
  const noneWriteStarted = new Promise(resolve => { markNoneWriteStarted = resolve })
  const noneWriteReleased = new Promise(resolve => { releaseNoneWrite = resolve })
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a },
    onStorageSet: async (value) => {
      if (value.harnessBrowserTargetSettings?.mode === 'none') {
        markNoneWriteStarted()
        await noneWriteReleased
      }
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const changingPolicy = background.sendRuntimeMessage({ type: 'save-browser-target-settings', settings: { mode: 'none', pinnedTabs: [] } })
    await noneWriteStarted
    const locking = background.sendRuntimeMessage({
      type: 'lock-browser-target/v1', sessionId: 'session-follow', submissionId: 'send-moment-a', browserTarget: targetA,
    }, { url: 'chrome-extension://test/sidepanel.html' })
    releaseNoneWrite()
    await changingPolicy
    assert.deepEqual(await locking, { ok: true, locked: true })

    background.emitNative({ type: 'connector_request', requestId: 'still-a', runId: 'run-follow', generation: 'generation-a', browserTarget: targetA, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'still-a'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'still-a').result.pageIdentity.url, a.url)

    await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-follow', submissionId: 'send-moment-a' }, { url: 'chrome-extension://test/sidepanel.html' })
    background.emitNative({ type: 'connector_request', requestId: 'after-unlock-none', runId: 'run-follow', generation: 'generation-a', browserTarget: targetA, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'after-unlock-none'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.match(background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'after-unlock-none').error, /disabled/i)
  } finally {
    await background.cleanup()
  }
})

test('the sidepanel can recover only the active current-Run Browser Target lock after it is recreated', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const b = { id: 43, windowId: 7, url: 'https://docs.example.test/b', title: 'B' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a, 43: b } })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA }, sender), { ok: true, locked: true })
    await background.activateTab(b.id)
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), {
      ok: true, lock: { sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA },
    })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a' }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), { ok: true })
  } finally {
    await background.cleanup()
  }
})

test('a late same-session reconciliation removes only its own completed Run lock', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const b = { id: 43, windowId: 7, url: 'https://docs.example.test/b', title: 'B' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const targetB = { browser: 'chrome', windowId: 7, tabId: b.id, url: b.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a, 43: b } })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA }, sender), { ok: true, locked: true })
    background.emitNative({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-b' } })
    await background.activateTab(b.id)
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-b', browserTarget: targetB }, sender), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'reconcile-browser-target-lock/v1', sessionId: 'session-a', submissionId: 'submission-a' }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), {
      ok: true, lock: { sessionId: 'session-a', submissionId: 'submission-b', browserTarget: targetB },
    })
  } finally {
    await background.cleanup()
  }
})

test('an accepted follow lock ignores the initial idle reconciliation window so read_work_tab remains on A after B activates', async () => {
  const a = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const b = { id: 43, windowId: 7, url: 'https://docs.example.test/b', title: 'B' }
  const targetA = { browser: 'chrome', windowId: 7, tabId: a.id, url: a.url }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: a, tabsById: { 42: a, 43: b },
    executeScript: async ({ target }) => [{ result: target.tabId === a.id ? 'A visible text' : 'B visible text' }],
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget: targetA,
    }, { url: 'chrome-extension://test/sidepanel.html' }), { ok: true, locked: true })

    const { BrowserTargetSessionRunLock, shouldReconcileSessionRunTarget } = await loadSessionRunLock()
    const lifecycle = new BrowserTargetSessionRunLock('submission-a')
    lifecycle.accept({ running: false, queue: [] })
    const initialIdle = { running: false, queue: [] }
    const initialIdleMayReconcile = shouldReconcileSessionRunTarget(initialIdle, lifecycle)
    assert.equal(initialIdleMayReconcile, false, 'the acknowledged lock remains until this Run was actually observed')
    if (initialIdleMayReconcile) {
      await background.sendRuntimeMessage({ type: 'reconcile-browser-target-lock/v1', sessionId: 'session-a', submissionId: 'submission-a' }, { url: 'chrome-extension://test/sidepanel.html' })
    }

    await background.activateTab(b.id)
    background.emitNative({
      type: 'connector_request', requestId: 'read-after-b-activation', runId: 'run-follow', generation: 'generation-a',
      tool: 'read_work_tab', tab: 1, browserTarget: targetA, browserTargets: [targetA],
    })
    let response
    for (let attempt = 0; attempt < 20 && response === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      response = background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'read-after-b-activation')
    }
    assert.equal(response.error, undefined)
    assert.equal(response.result.pageIdentity.url, a.url)
    assert.equal(response.result.content, 'A visible text')
    lifecycle.observe({ running: true, queue: [] })
    assert.equal(shouldReconcileSessionRunTarget(initialIdle, lifecycle), true, 'only a Run observed as running may be released after it becomes idle')
  } finally {
    await background.cleanup()
  }
})

test('queue activity releases an accepted Browser Target lock after idle, including activity observed before accept', async () => {
  const { BrowserTargetSessionRunLock, shouldReconcileSessionRunTarget } = await loadSessionRunLock()
  const idle = { running: false, queue: [] }
  const queued = { running: false, queue: [{ id: 'queued-prompt' }] }

  const afterAccept = new BrowserTargetSessionRunLock('after-accept')
  assert.equal(afterAccept.accept(idle), false, 'initial idle is not a completion')
  assert.equal(shouldReconcileSessionRunTarget(queued, afterAccept), false, 'queue activity itself is not yet idle completion')
  assert.equal(shouldReconcileSessionRunTarget(idle, afterAccept), true, 'queue activity followed by idle releases the accepted lock')

  const beforeAccept = new BrowserTargetSessionRunLock('before-accept')
  assert.equal(shouldReconcileSessionRunTarget(queued, beforeAccept), false, 'activity may arrive before the composer acknowledgement')
  assert.equal(beforeAccept.accept(idle), true, 'an already-idle acknowledgement releases a lock whose queue activity was observed')

  const neverActive = new BrowserTargetSessionRunLock('never-active')
  assert.equal(neverActive.accept(idle), false, 'initial idle without any Run activity remains protected')
})

test('a restored idle session reconciles an accepted Browser Target lock after the background preserved its observed activity', async () => {
  const target = { id: 42, windowId: 7, url: 'https://docs.example.test/a', title: 'A' }
  const browserTarget = { browser: 'chrome', windowId: 7, tabId: target.id, url: target.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: target })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'lock-browser-target/v1', sessionId: 'session-a', submissionId: 'submission-a', browserTarget,
    }, sender), { ok: true, locked: true })
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'observe-browser-target-lock/v1', sessionId: 'session-a', submissionId: 'submission-a',
    }, sender), { ok: true })

    const projected = await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender)
    assert.deepEqual(projected, {
      ok: true,
      lock: { sessionId: 'session-a', submissionId: 'submission-a', browserTarget, observedActivity: true },
    })

    const { BrowserTargetSessionRunLock, shouldReconcileSessionRunTarget } = await loadSessionRunLock()
    const restored = BrowserTargetSessionRunLock.restore('submission-a', { observedActivity: projected.lock.observedActivity })
    assert.equal(shouldReconcileSessionRunTarget({ running: false, queue: [] }, restored), true, 'a remounted idle snapshot must release a Run that was known to have been active before the surface closed')
    assert.deepEqual(await background.sendRuntimeMessage({
      type: 'reconcile-browser-target-lock/v1', sessionId: 'session-a', submissionId: 'submission-a',
    }, sender), { ok: true })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-active-browser-target-lock/v1' }, sender), { ok: true })
  } finally {
    await background.cleanup()
  }
})

test('follow lock can bind a Run started with none mode and an unlock before transfer confirmation cancels it', async () => {
  const first = { id: 42, windowId: 7, url: 'https://docs.example.test/first', title: 'First' }
  const second = { id: 43, windowId: 7, url: 'https://docs.example.test/second', title: 'Second' }
  const firstTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: first.url }
  const sender = { url: 'chrome-extension://test/sidepanel.html' }
  const transferGate = Promise.withResolvers()
  const background = await loadBackground({
    settings: { mode: 'none', pinnedTabs: [] }, activeTab: first, tabsById: { 42: first, 43: second },
    waitForTransferAck: transferGate.promise,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    await background.sendRuntimeMessage({ type: 'save-browser-target-settings', settings: { mode: 'follow-active-tab', pinnedTabs: [] } })
    const locking = background.sendRuntimeMessage({ type: 'lock-browser-target/v1', sessionId: 'session-follow', submissionId: 'first', browserTarget: firstTarget }, sender)
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some(message => message.type === 'transfer-browser-target'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.some(message => message.type === 'transfer-browser-target'), true)
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'unlock-browser-target/v1', sessionId: 'session-follow', submissionId: 'first' }, sender), { ok: true })
    transferGate.resolve()
    assert.deepEqual(await locking, { ok: true, locked: false })
    await background.activateTab(43)
    background.emitNative({ type: 'connector_request', requestId: 'after-unlock', runId: 'run-follow', generation: 'generation-1', browserTarget: firstTarget, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !background.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'after-unlock'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const response = background.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'after-unlock')
    assert.equal(response.result.pageIdentity.url, second.url)
  } finally { await background.cleanup() }
})

test('fixed and unbound Browser Target policies apply when no follow-mode client lock was sent', async () => {
  const active = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const fixed = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/fixed' }
  const fixedTab = { id: 52, windowId: 7, url: fixed.url, title: 'Fixed' }
  const switched = { id: 43, windowId: 7, url: 'https://docs.example.test/switched', title: 'Switched' }
  const pinned = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [fixed], primaryTabId: 52 }, activeTab: active,
    tabsById: { 42: active, 43: switched, 52: fixedTab },
  })
  try {
    await pinned.sendRuntimeMessage({ type: 'ensure-harness' })
    pinned.activateTab(43)
    pinned.emitNative({ type: 'connector_request', requestId: 'fixed-after-complete', runId: 'run-follow', generation: 'generation-1', browserTarget: fixed, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !pinned.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'fixed-after-complete'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const fixedResponse = pinned.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'fixed-after-complete')
    assert.equal(fixedResponse.result.pageIdentity.url, fixed.url)
  } finally { pinned.cleanup() }

  const unbound = await loadBackground({ settings: { mode: 'none', pinnedTabs: [] }, activeTab: active, tabsById: { 42: active } })
  try {
    await unbound.sendRuntimeMessage({ type: 'ensure-harness' })
    unbound.emitNative({ type: 'connector_request', requestId: 'none-after-complete', runId: 'run-follow', generation: 'generation-1', browserTarget: { browser: 'chrome', windowId: 7, tabId: 42, url: active.url }, tool: 'list_work_tabs' })
    for (let attempt = 0; attempt < 20 && !unbound.nativeMessages.some(message => message.type === 'connector_response' && message.requestId === 'none-after-complete'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const noneResponse = unbound.nativeMessages.find(message => message.type === 'connector_response' && message.requestId === 'none-after-complete')
    assert.match(noneResponse.error, /disabled/i)
  } finally { unbound.cleanup() }
})

test('follow-active-tab refreshes a same-tab URL change before the next Office turn', async () => {
  const original = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/100', title: 'Original' }
  const selected = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/200', title: 'Selected parent' }
  const originalTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: original.url }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [], candidate: originalTarget }, activeTab: original,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.updateActiveTab({ url: selected.url, title: selected.title }, selected)
    background.emitNative({
      type: 'connector_request', requestId: 'selected-parent-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: originalTarget, tool: 'list_work_tabs',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'selected-parent-turn')
    assert.equal(response.error, undefined)
    assert.equal(response.result.pageIdentity.url, selected.url)
    const transfer = background.nativeMessages.find((message) => message.type === 'transfer-browser-target' && message.requestId === 'selected-parent-turn')
    assert.deepEqual(transfer.browserTarget, { browser: 'chrome', windowId: 7, tabId: 42, url: selected.url })
  } finally {
    await background.cleanup()
  }
})

test('Team Knowledge inspection transfers to a same-tab selected parent without an Office preflight', async () => {
  const original = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/100', title: 'Original' }
  const selected = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/200', title: 'Selected parent' }
  const originalTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: original.url }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [], candidate: originalTarget }, activeTab: original,
    executeScript: async () => [{ result: { ok: true, parent: { parentId: '200', bookId: '1', parentName: 'Selected parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-200' } } }],
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.updateActiveTab({ url: selected.url, title: selected.title }, selected)
    background.emitNative({
      type: 'connector_request', requestId: 'team-knowledge-inspect', runId: 'run-follow', generation: 'generation-1',
      browserTarget: originalTarget, tool: 'team_knowledge_batch', action: 'inspect_parent',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'team-knowledge-inspect')
    assert.equal(response.error, undefined)
    assert.equal(response.browserTarget.url, selected.url)
    assert.equal(response.result.status, 'ok')
    assert.equal(response.result.parent.parentId, '200')
    const transfer = background.nativeMessages.find((message) => message.type === 'transfer-browser-target' && message.requestId === 'team-knowledge-inspect')
    assert.deepEqual(transfer.browserTarget, { browser: 'chrome', windowId: 7, tabId: 42, url: selected.url })
  } finally {
    await background.cleanup()
  }
})

test('Team Knowledge create keeps its confirmed Browser Target when the user activates another tab', async () => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  const injectedTabIds = []
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: confirmed, tabsById: { 42: confirmed, 43: other },
    executeScript: async (options) => {
      injectedTabIds.push(options.target.tabId)
      return [{ result: { ok: true, parent } }]
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    await background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({
      type: 'connector_request', requestId: 'team-knowledge-confirmed-create', runId: 'run-follow', generation: 'generation-1',
      browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'create', parent, kind: 'light_document', name: 'Confirmed child', body: '# Confirmed child', idempotencyIdentity: 'team-batch:confirmed:0',
    })
    let response
    for (let attempt = 0; attempt < 10 && response === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'team-knowledge-confirmed-create')
    }
    assert.deepEqual(response.browserTarget, confirmedTarget)
    assert.deepEqual(injectedTabIds, [42])
    assert.equal(background.nativeMessages.some((message) => message.type === 'transfer-browser-target' && message.requestId === 'team-knowledge-confirmed-create'), false)
  } finally {
    await background.cleanup()
  }
})

test('Team Knowledge create fails closed when its confirmed Browser Target closes or navigates', async (t) => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  for (const [name, targetTab, expectedError] of [
    ['closes', undefined, /closed before Team Doc execution/],
    ['navigates', { ...confirmed, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/101', title: 'Different parent' }, /navigated before Team Doc execution/],
  ]) {
    await t.test(name, async () => {
      const injectedTabIds = []
      const background = await loadBackground({
        settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: confirmed, tabsById: { ...(targetTab === undefined ? {} : { 42: targetTab }), 43: other },
        executeScript: async (options) => { injectedTabIds.push(options.target.tabId); return [{ result: { ok: true, parent } }] },
      })
      try {
        await background.sendRuntimeMessage({ type: 'ensure-harness' })
        await background.activateTab(43)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const requestId = `team-knowledge-confirmed-create-${name}`
        background.emitNative({
          type: 'connector_request', requestId, runId: 'run-follow', generation: 'generation-1',
          browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'create', parent, kind: 'light_document', name: 'Confirmed child', body: '# Confirmed child', idempotencyIdentity: `team-batch:${name}:0`,
        })
        let response
        for (let attempt = 0; attempt < 10 && response === undefined; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === requestId)
        }
        assert.match(response.error, expectedError)
        assert.deepEqual(injectedTabIds, [])
        assert.equal(background.nativeMessages.some((message) => message.type === 'transfer-browser-target' && message.requestId === requestId), false)
      } finally {
        await background.cleanup()
      }
    })
  }
})

test('Team Knowledge retry preview keeps the original batch tab after a partial delivery and tab switch', async () => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: confirmed, tabsById: { 42: confirmed, 43: other },
    executeScript: async () => [{ result: { ok: true, parent } }],
  })
  const responseFor = async (requestId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === requestId)
      if (response !== undefined) return response
    }
    throw new Error(`missing ${requestId} response`)
  }
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({ type: 'connector_request', requestId: 'batch-preview', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: 'batch-partial', lease: 'acquire' })
    assert.deepEqual((await responseFor('batch-preview')).browserTarget, confirmedTarget)
    background.emitNative({
      type: 'connector_request', requestId: 'batch-partial-create', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget,
      tool: 'team_knowledge_batch', action: 'create', batchId: 'batch-partial', lease: 'reuse', parent, kind: 'light_document', name: 'Confirmed child', body: '# Confirmed child', idempotencyIdentity: 'team-batch:partial:0', userConfirmation: { itemIndex: 1, totalItems: 1 },
    })
    assert.equal((await responseFor('batch-partial-create')).result.status, 'partial_delivery')
    await background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({ type: 'connector_request', requestId: 'batch-retry-preview', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: 'batch-partial', lease: 'reuse' })
    assert.deepEqual((await responseFor('batch-retry-preview')).browserTarget, confirmedTarget)
  } finally {
    await background.cleanup()
  }
})

test('Team Knowledge completed batch release restores the configured follow target', async () => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: confirmed, tabsById: { 42: confirmed, 43: other },
    executeScript: async () => [{ result: { ok: true, parent } }],
  })
  const responseFor = async (requestId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === requestId)
      if (response !== undefined) return response
    }
    throw new Error(`missing ${requestId} response`)
  }
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({ type: 'connector_request', requestId: 'batch-acquire', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: 'batch-release', lease: 'acquire' })
    await responseFor('batch-acquire')
    await background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({ type: 'connector_request', requestId: 'batch-release', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'release', batchId: 'batch-release', lease: 'release', parent })
    const released = await responseFor('batch-release')
    assert.equal(released.result.status, 'ok')
    assert.equal(released.browserTarget.tabId, 43)
    background.emitNative({ type: 'connector_request', requestId: 'ordinary-follow', runId: 'run-follow', generation: 'generation-1', browserTarget: released.browserTarget, tool: 'list_work_tabs' })
    assert.equal((await responseFor('ordinary-follow')).browserTarget.tabId, 43)
  } finally {
    await background.cleanup()
  }
})

test('Team Knowledge batch lease survives a worker reload through session storage', async () => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  const responseFor = async (background, requestId) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === requestId)
      if (response !== undefined) return response
    }
    throw new Error(`missing ${requestId} response`)
  }
  const first = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: confirmed, tabsById: { 42: confirmed, 43: other },
    executeScript: async () => [{ result: { ok: true, parent } }],
  })
  try {
    await first.sendRuntimeMessage({ type: 'ensure-harness' })
    first.emitNative({ type: 'connector_request', requestId: 'reload-acquire', runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: 'batch-reload', lease: 'acquire' })
    await responseFor(first, 'reload-acquire')
  } finally {
    first.cleanup()
  }
  const reloaded = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: other, tabsById: { 42: confirmed, 43: other }, sessionStorage: first.sessionStorage,
    executeScript: async () => [{ result: { ok: true, parent } }],
  })
  try {
    await reloaded.sendRuntimeMessage({ type: 'ensure-harness' })
    reloaded.emitNative({ type: 'connector_request', requestId: 'reload-retry', runId: 'run-follow', generation: 'generation-1', browserTarget: { browser: 'chrome', windowId: 7, tabId: 43, url: other.url }, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: 'batch-reload', lease: 'reuse' })
    assert.deepEqual((await responseFor(reloaded, 'reload-retry')).browserTarget, confirmedTarget)
  } finally {
    reloaded.cleanup()
  }
})

test('Team Knowledge batch lease fails closed when its tab closes or navigates', async (t) => {
  const confirmed = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/100', title: 'Confirmed parent' }
  const other = { id: 43, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/200', title: 'Other parent' }
  const confirmedTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: confirmed.url }
  const parent = { parentId: '100', bookId: '1', parentName: 'Confirmed parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-100' }
  for (const [name, targetTab, expectedError] of [
    ['closes', undefined, /lease_target_closed/],
    ['navigates', { ...confirmed, url: 'https://doc.midea.com/teamKnowledge/detail/catalog/101', title: 'Different parent' }, /lease_target_navigated/],
  ]) {
    await t.test(name, async () => {
      const injectedTabIds = []
      const sessionStorage = {
        harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] },
        teamKnowledgeBatchLeasesV1: { [`run-follow\u0000batch-${name}`]: { runId: 'run-follow', batchId: `batch-${name}`, browserTarget: confirmedTarget, parentFingerprint: parent.fingerprint } },
      }
      const background = await loadBackground({
        settings: sessionStorage.harnessBrowserTargetSettings, activeTab: confirmed, tabsById: { ...(targetTab === undefined ? {} : { 42: targetTab }), 43: other }, sessionStorage,
        executeScript: async (options) => { injectedTabIds.push(options.target.tabId); return [{ result: { ok: true, parent } }] },
      })
      try {
        await background.sendRuntimeMessage({ type: 'ensure-harness' })
        await background.activateTab(43)
        await new Promise((resolve) => setTimeout(resolve, 0))
        const requestId = `lease-${name}`
        background.emitNative({ type: 'connector_request', requestId, runId: 'run-follow', generation: 'generation-1', browserTarget: confirmedTarget, tool: 'team_knowledge_batch', action: 'inspect_parent', batchId: `batch-${name}`, lease: 'reuse' })
        let response
        for (let attempt = 0; attempt < 20 && response === undefined; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === requestId)
        }
        assert.match(response.error, expectedError)
        assert.deepEqual(injectedTabIds, [])
      } finally {
        await background.cleanup()
      }
    })
  }
})

test('Team Knowledge waits for a same-tab candidate update before resolving its Browser Target', async () => {
  const original = { id: 42, windowId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/100', title: 'Original' }
  const selected = { id: 42, windowId: 7, active: true, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/200', title: 'Selected parent' }
  const originalTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: original.url }
  let markCandidateSaveStarted
  const candidateSaveStarted = new Promise((resolve) => { markCandidateSaveStarted = resolve })
  let releaseCandidateSave
  const candidateSaveMayFinish = new Promise((resolve) => { releaseCandidateSave = resolve })
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [], candidate: originalTarget }, activeTab: original,
    onStorageSet: async (value) => {
      if (value.harnessBrowserTargetSettings?.candidate?.url !== selected.url) return
      markCandidateSaveStarted()
      await candidateSaveMayFinish
    },
    executeScript: async () => [{ result: { ok: true, parent: { parentId: '200', bookId: '1', parentName: 'Selected parent', parentType: 'folder', canRead: true, canCreate: true, fingerprint: 'parent-200' } } }],
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.updateActiveTab({ url: selected.url, title: selected.title }, selected)
    background.emitNative({
      type: 'connector_request', requestId: 'candidate-race', runId: 'run-follow', generation: 'generation-1',
      browserTarget: originalTarget, tool: 'team_knowledge_batch', action: 'inspect_parent',
    })
    await candidateSaveStarted
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.some((message) => message.type === 'transfer-browser-target' && message.requestId === 'candidate-race'), false)
    releaseCandidateSave()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'candidate-race')
    assert.equal(response.error, undefined)
    assert.equal(response.browserTarget.url, selected.url)
  } finally {
    await background.cleanup()
  }
})

test('candidate updates serialize with settings saves without overwriting mode, pins, or primary', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const candidate = { id: 43, windowId: 7, url: 'https://docs.example.test/candidate', title: 'Candidate' }
  const firstPinned = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://docs.example.test/one' }
  const primaryPinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  let releaseCandidateSet
  const candidateSetStarted = new Promise((resolve) => { releaseCandidateSet = resolve })
  let unblockCandidateSet
  let userSaveStarted
  const userSaveObserved = new Promise((resolve) => { userSaveStarted = resolve })
  const waitForUserSave = new Promise((resolve) => { unblockCandidateSet = resolve })
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab, tabsById: { 43: candidate },
    onStorageSet: async (value) => {
      const next = value.harnessBrowserTargetSettings
      if (next?.candidate?.tabId === 43 && next.mode === 'follow-active-tab') {
        releaseCandidateSet()
        await waitForUserSave
      }
      if (next?.mode === 'pinned-tabs') userSaveStarted()
    },
  })
  try {
    await background.activateTab(43)
    await candidateSetStarted
    const saving = background.sendRuntimeMessage({
      type: 'save-browser-target-settings',
      settings: { mode: 'pinned-tabs', pinnedTabs: [firstPinned, primaryPinned], primaryTabId: 52 },
    })
    await Promise.race([userSaveObserved, new Promise((resolve) => setTimeout(resolve, 0))])
    unblockCandidateSet()
    await saving
    await new Promise((resolve) => setTimeout(resolve, 0))
    const restored = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(restored.settings, {
      mode: 'pinned-tabs', pinnedTabs: [firstPinned, primaryPinned], primaryTabId: 52,
      candidate: { browser: 'chrome', windowId: 7, tabId: 43, url: candidate.url },
    })
  } finally {
    await background.cleanup()
  }
})

test('sidepanel persists pinned multiple tabs with a primary target, and none starts without a Browser Target', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active target' }
  const firstPinned = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://docs.example.test/one' }
  const primaryPinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab,
    tabsById: {
      51: { id: 51, windowId: 7, url: firstPinned.url, title: 'Pinned one' },
      52: { id: 52, windowId: 7, url: primaryPinned.url, title: 'Pinned two' },
    },
  })
  try {
    const savedPinned = await background.sendRuntimeMessage({
      type: 'save-browser-target-settings',
      settings: { mode: 'pinned-tabs', pinnedTabs: [firstPinned, primaryPinned], primaryTabId: 52 },
    })
    assert.deepEqual(savedPinned, {
      ok: true,
      settings: { mode: 'pinned-tabs', pinnedTabs: [firstPinned, primaryPinned], primaryTabId: 52 },
    })
    const restored = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(restored.settings, savedPinned.settings)
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(background.nativeMessages.at(-1), {
      type: 'start', browserTarget: primaryPinned, browserTargets: [firstPinned, primaryPinned], unavailableBrowserTargets: [],
    })

    const savedNone = await background.sendRuntimeMessage({
      type: 'save-browser-target-settings', settings: { mode: 'none', pinnedTabs: [] },
    })
    assert.deepEqual(savedNone.settings, { mode: 'none', pinnedTabs: [] })
  } finally {
    await background.cleanup()
  }

  const noTargetBackground = await loadBackground({
    settings: { mode: 'none', pinnedTabs: [] }, activeTab,
  })
  try {
    const response = await noTargetBackground.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(response, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(noTargetBackground.nativeMessages, [{ type: 'start', browserTarget: undefined }])
  } finally {
    noTargetBackground.cleanup()
  }
})

test('pinned list_work_tabs returns every available checked tab, keeps the primary, and reports unavailable tabs', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const first = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://docs.example.test/one' }
  const primary = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  const stale = { browser: 'chrome', windowId: 7, tabId: 53, url: 'https://docs.example.test/closed' }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [first, primary, stale], primaryTabId: 52 }, activeTab,
    tabsById: {
      51: { id: 51, windowId: 7, url: first.url, title: 'Pinned one' },
      52: { id: 52, windowId: 7, url: primary.url, title: 'Pinned two' },
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'multi-context', runId: 'run-follow', generation: 'generation-multi', tool: 'list_work_tabs',
      browserTarget: primary, browserTargets: [first, primary], unavailableBrowserTargets: [{ browserTarget: stale, reason: 'closed_or_changed' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = background.nativeMessages.find((message) => message.requestId === 'multi-context')
    assert.deepEqual(response.browserTargets, [first, primary])
    assert.deepEqual(response.unavailableBrowserTargets, [{ browserTarget: stale, reason: 'closed_or_changed' }])
    assert.deepEqual(response.result.pages.map((page) => page.pageIdentity), [
      { title: 'Pinned one', url: first.url }, { title: 'Pinned two', url: primary.url },
    ])
    assert.equal(response.result.pages.find((page) => page.isPrimary)?.browserTarget.tabId, primary.tabId)
  } finally {
    await background.cleanup()
  }
})

test('saving next-Run policy preserves the current Run until explicit restart-harness reconnects it', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    await background.sendRuntimeMessage({ type: 'save-browser-target-settings', settings: { mode: 'none', pinnedTabs: [] } })
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(background.nativeMessages.length, 1)
    const restarted = await background.sendRuntimeMessage({ type: 'restart-harness' })
    assert.deepEqual(restarted, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(background.nativeMessages[1], { type: 'start', browserTarget: undefined })
  } finally {
    await background.cleanup()
  }
})

test('restart waits for an in-flight settings write before resolving its next-Run target policy', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  let markSetStarted
  let releaseWrite
  const setStarted = new Promise((resolve) => { markSetStarted = resolve })
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve })
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab,
    onStorageSet: async (value) => {
      if (value.harnessBrowserTargetSettings?.mode === 'none') {
        markSetStarted()
        await writeReleased
      }
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const saving = background.sendRuntimeMessage({ type: 'save-browser-target-settings', settings: { mode: 'none', pinnedTabs: [] } })
    await setStarted
    const restarting = background.sendRuntimeMessage({ type: 'restart-harness' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.length, 1)
    releaseWrite()
    await saving
    await restarting
    assert.deepEqual(background.nativeMessages[1], { type: 'start', browserTarget: undefined })
  } finally {
    await background.cleanup()
  }
})

test('pinned mode follows the same tab after it navigates and refreshes the saved URL', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const pinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/original' }
  const live = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/navigated' }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [pinned], primaryTabId: 52 }, activeTab,
    tabsById: { 52: { id: 52, windowId: 7, url: live.url, title: 'Navigated' } },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(response, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(background.nativeMessages, [{ type: 'start', browserTarget: live }])
    const restored = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(restored.settings.pinnedTabs, [live])
    assert.equal(restored.settings.primaryTabId, 52)
  } finally {
    await background.cleanup()
  }
})

test('pinned list_work_tabs transfers the live URL after a same-tab navigation', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const pinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/original' }
  const live = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/child' }
  const tabsById = { 52: { id: 52, windowId: 7, url: pinned.url, title: 'Original' } }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [pinned], primaryTabId: 52 }, activeTab, tabsById,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    tabsById[52] = { id: 52, windowId: 7, url: live.url, title: 'Child doc' }
    background.emitNative({
      type: 'connector_request', requestId: 'pin-nav', runId: 'run-follow', generation: 'generation-pin-nav',
      tool: 'list_work_tabs', browserTarget: pinned,
    })
    let response
    for (let attempt = 0; attempt < 10 && response === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'pin-nav')
    }
    assert.deepEqual(response.browserTarget, live)
    assert.deepEqual(response.result.pageIdentity, { title: 'Child doc', url: live.url })
    const transfer = background.nativeMessages.find((message) => message.type === 'transfer-browser-target')
    assert.deepEqual(transfer.browserTarget, live)
  } finally {
    await background.cleanup()
  }
})

test('read_work_tab captures visible text immediately and reports a host-permission miss', async () => {
  const first = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://open.bigmodel.cn/coding-plan/personal/usage' }
  const primary = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  const injections = []
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [first, primary], primaryTabId: 52 },
    activeTab: { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' },
    tabsById: {
      51: { id: 51, windowId: 7, url: first.url, title: '智谱AI开放平台' },
      52: { id: 52, windowId: 7, url: primary.url, title: 'Pinned two' },
    },
    executeScript: async (options) => {
      injections.push(options)
      throw new Error('Cannot access contents of url "https://open.bigmodel.cn/coding-plan/personal/usage". Extension manifest must request permission to access this host.')
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'read-tab-2', runId: 'run-follow', generation: 'generation-read',
      tool: 'read_work_tab', tab: 1, browserTarget: primary, browserTargets: [first, primary],
    })
    let response
    for (let attempt = 0; attempt < 20 && response === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'read-tab-2')
    }
    assert.equal(injections[0]?.injectImmediately, true)
    assert.equal(response.error.code, 'unsupported')
    assert.match(response.error.message, /host permission/i)
  } finally {
    await background.cleanup()
  }
})

test('read_work_tab reads a non-primary pinned page without changing the write target', async () => {
  const first = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://docs.example.test/one' }
  const primary = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  const injections = []
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [first, primary], primaryTabId: 52 },
    activeTab: { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' },
    tabsById: {
      51: { id: 51, windowId: 7, url: first.url, title: 'Pinned one' },
      52: { id: 52, windowId: 7, url: primary.url, title: 'Pinned two' },
    },
    executeScript: async (options) => {
      injections.push(options)
      return [{ result: 'visible text from first tab' }]
    },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'read-tab-1', runId: 'run-follow', generation: 'generation-read',
      tool: 'read_work_tab', tab: 1, browserTarget: primary, browserTargets: [first, primary],
    })
    let response
    for (let attempt = 0; attempt < 20 && response === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      response = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'read-tab-1')
    }
    assert.equal(response.error, undefined)
    assert.deepEqual(response.browserTarget, primary)
    assert.equal(response.result.tab, 1)
    assert.deepEqual(response.result.page, first)
    assert.equal(response.result.kind, 'web_page')
    assert.equal(response.result.content, 'visible text from first tab')
    assert.equal(response.result.isPrimary, false)
    assert.equal(injections[0]?.injectImmediately, true)
  } finally {
    await background.cleanup()
  }
})

test('a hung read_work_tab does not stall a later list_work_tabs roster', async () => {
  const first = { browser: 'chrome', windowId: 7, tabId: 51, url: 'https://docs.example.test/one' }
  const primary = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/two' }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [first, primary], primaryTabId: 52 },
    activeTab: { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' },
    tabsById: {
      51: { id: 51, windowId: 7, url: first.url, title: 'Pinned one' },
      52: { id: 52, windowId: 7, url: primary.url, title: 'Pinned two' },
    },
    executeScript: async () => new Promise(() => {}),
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'hung-read', runId: 'run-follow', generation: 'generation-hung',
      tool: 'read_work_tab', tab: 1, browserTarget: primary, browserTargets: [first, primary],
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    background.emitNative({
      type: 'connector_request', requestId: 'roster-after-hung', runId: 'run-follow', generation: 'generation-roster',
      tool: 'list_work_tabs', browserTarget: primary, browserTargets: [first, primary],
    })
    let roster
    for (let attempt = 0; attempt < 20 && roster === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      roster = background.nativeMessages.find((message) => message.type === 'connector_response' && message.requestId === 'roster-after-hung')
    }
    assert.equal(roster?.error, undefined)
    assert.deepEqual(roster.result.pages.map((page) => page.pageIdentity), [
      { title: 'Pinned one', url: first.url }, { title: 'Pinned two', url: primary.url },
    ])
    assert.equal(background.nativeMessages.find((message) => message.requestId === 'hung-read'), undefined)
  } finally {
    await background.cleanup()
  }
})

test('pinned restart rejects a pinned tab that was closed', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const pinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/original' }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [pinned], primaryTabId: 52 }, activeTab, tabsById: {},
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(response.ok, false)
    assert.match(response.error, /Select it again/i)
    assert.equal(background.nativeMessages.length, 0)
  } finally {
    await background.cleanup()
  }
})

test('a running Run moves only after the explicit runtime transfer-browser-target request is confirmed by Native', async () => {
  const first = { id: 42, windowId: 7, url: 'https://docs.example.test/first', title: 'First target' }
  const second = { id: 43, windowId: 7, url: 'https://docs.example.test/second', title: 'Second target' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: first, tabsById: { 43: second },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const response = await background.sendRuntimeMessage({
      type: 'transfer-browser-target',
      runId: 'run-follow',
      browserTarget: { browser: 'chrome', windowId: 7, tabId: 43, url: second.url },
    })
    assert.deepEqual(response, { ok: true })
    const transfer = background.nativeMessages.at(-1)
    assert.equal(transfer.type, 'transfer-browser-target')
    assert.equal(typeof transfer.requestId, 'string')
    assert.deepEqual(transfer.browserTarget, { browser: 'chrome', windowId: 7, tabId: 43, url: second.url })
  } finally {
    await background.cleanup()
  }
})

test('Native transfer NACK rejects the correlated runtime request immediately', async () => {
  const first = { id: 42, windowId: 7, url: 'https://docs.example.test/first', title: 'First target' }
  const second = { id: 43, windowId: 7, url: 'https://docs.example.test/second', title: 'Second target' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: first, tabsById: { 43: second }, transferNack: true,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const startedAt = performance.now()
    const response = await background.sendRuntimeMessage({
      type: 'transfer-browser-target', runId: 'wrong-run',
      browserTarget: { browser: 'chrome', windowId: 7, tabId: 43, url: second.url },
    })
    assert.equal(response.ok, false)
    assert.match(response.error, /does not match/i)
    assert.ok(performance.now() - startedAt < 100)
  } finally {
    await background.cleanup()
  }
})
