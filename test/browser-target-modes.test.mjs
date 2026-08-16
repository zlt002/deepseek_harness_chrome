import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadBackground({ settings, activeTab, tabsById = {}, onStorageSet, transferNack = false, createdTab, waitForTransferAck }) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let runtimeListener
  let activatedListener
  let createdListener
  const nativeMessages = []
  const createdUrls = []
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
  const stored = { harnessBrowserTargetSettings: settings }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      connectNative,
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
    windows: { getLastFocused: async () => ({ id: activeTab.windowId }) },
    tabs: {
      query: async () => [activeTab],
      get: async (tabId) => tabsById[tabId] ?? (tabId === activeTab.id ? activeTab : undefined),
      create: async (options) => {
        createdUrls.push(options.url)
        return createdTab ?? Object.values(tabsById).find((tab) => tab.url === options.url)
      },
      onActivated: { addListener: (listener) => { activatedListener = listener } },
      onCreated: { addListener: (listener) => { createdListener = listener } },
    },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
  return {
    nativeMessages,
    createdUrls,
    sendRuntimeMessage: (message) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('runtime response timeout')), 100)
      const keepChannelOpen = runtimeListener(message, {}, (response) => {
        clearTimeout(timeout)
        resolve(response)
      })
      if (keepChannelOpen !== true) {
        clearTimeout(timeout)
        reject(new Error('runtime message did not keep its response channel open'))
      }
    }),
    activateTab: (tabId) => activatedListener({ tabId }),
    createTab: (tab) => createdListener(tab),
    emitNative: (message, portIndex = ports.length - 1) => ports[portIndex].emit(message),
    disconnectNative: () => ports.at(-1).disconnect(),
    cleanup: () => {
      delete globalThis.chrome
      delete globalThis.defineBackground
    },
  }
}

test('sidepanel ensure-harness resolves the last-focused active tab for the default follow-active-tab mode', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/follow', title: 'Follow target' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab,
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.deepEqual(response, { ok: true, url: 'http://127.0.0.1:43123' })
    assert.deepEqual(background.nativeMessages, [{
      type: 'start',
      browserTarget: { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://docs.example.test/follow' },
    }])
  } finally {
    background.cleanup()
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
    background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const restored = await background.sendRuntimeMessage({ type: 'get-browser-target-settings' })
    assert.deepEqual(restored.settings.candidate, {
      browser: 'chrome', windowId: 7, tabId: 43, url: second.url,
    })
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(background.nativeMessages.length, 1)
    assert.equal(background.nativeMessages[0].type, 'start')
  } finally {
    background.cleanup()
  }
})

test('follow-active-tab uses the tab activated after one office turn for the next office turn', async () => {
  const baidu = { id: 42, windowId: 7, url: 'https://www.baidu.com/', title: 'Baidu' }
  const wb = { id: 43, windowId: 7, url: 'https://wb.example.test/', title: 'WB' }
  const baiduTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: baidu.url }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab: baidu, tabsById: { 43: wb },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'baidu-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'office_get_context',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({
      type: 'connector_request', requestId: 'wb-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'office_get_context',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const transferIndex = background.nativeMessages.findIndex((message) => message.type === 'transfer-browser-target' && message.requestId === 'wb-turn')
    const responseIndex = background.nativeMessages.findIndex((message) => message.type === 'connector_response' && message.requestId === 'wb-turn')
    assert.notEqual(transferIndex, -1)
    assert.ok(responseIndex > transferIndex)
    const secondTurn = background.nativeMessages[responseIndex]
    assert.equal(secondTurn.result.pageIdentity.url, wb.url)
  } finally {
    background.cleanup()
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
    background.activateTab(43)
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
    background.cleanup()
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
    background.cleanup()
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

test('pinned office_get_context returns every available checked tab, keeps the primary, and reports unavailable tabs', async () => {
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
      type: 'connector_request', requestId: 'multi-context', runId: 'run-follow', generation: 'generation-multi', tool: 'office_get_context',
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
  }
})

test('pinned restart rejects a tab whose URL no longer matches the saved Browser Target', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const pinned = { browser: 'chrome', windowId: 7, tabId: 52, url: 'https://docs.example.test/original' }
  const background = await loadBackground({
    settings: { mode: 'pinned-tabs', pinnedTabs: [pinned], primaryTabId: 52 }, activeTab,
    tabsById: { 52: { id: 52, windowId: 7, url: 'https://docs.example.test/navigated', title: 'Navigated' } },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'ensure-harness' })
    assert.equal(response.ok, false)
    assert.match(response.error, /Select it again/i)
    assert.equal(background.nativeMessages.length, 0)
  } finally {
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
  }
})

test('a correlated browser_open_tab Connector request creates a tab then transfers only that AI-created target', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const openedTab = { id: 66, windowId: 7, url: 'https://docs.example.test/opened', title: 'Opened' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab, createdTab: openedTab, tabsById: { 66: openedTab },
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'connector-open', runId: 'run-follow', generation: 'generation-open',
      tool: 'browser_open_tab', url: openedTab.url,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(background.nativeMessages.slice(1), [
      {
        type: 'transfer-browser-target', requestId: 'connector-open', runId: 'run-follow',
        browserTarget: { browser: 'chrome', windowId: 7, tabId: 66, url: openedTab.url },
      },
      {
        type: 'connector_response', requestId: 'connector-open', runId: 'run-follow', generation: 'generation-open',
        browserTarget: { browser: 'chrome', windowId: 7, tabId: 66, url: openedTab.url },
        result: { pageIdentity: { title: 'Opened', url: openedTab.url } },
      },
    ])
  } finally {
    background.cleanup()
  }
})

test('a browser_open_tab request received from a stale Native port is rejected before chrome.tabs.create', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.disconnectNative()
    background.emitNative({
      type: 'connector_request', requestId: 'stale-open', runId: 'run-follow', generation: 'old-generation',
      tool: 'browser_open_tab', url: 'https://docs.example.test/stale',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(background.createdUrls, [])
    assert.match(background.nativeMessages.at(-1).error, /stale Native connection/i)
  } finally {
    background.cleanup()
  }
})

test('a browser_open_tab queued after reconnect starts rejects its old Native port before chrome.tabs.create', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const background = await loadBackground({ settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    const restarting = background.sendRuntimeMessage({ type: 'restart-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'queued-stale-open', runId: 'run-follow', generation: 'old-generation',
      tool: 'browser_open_tab', url: 'https://docs.example.test/stale-after-reconnect',
    }, 0)
    await restarting
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.filter((message) => message.type === 'start').length, 2)
    assert.deepEqual(background.createdUrls, [])
    const response = background.nativeMessages.find((message) => message.requestId === 'queued-stale-open')
    assert.match(response.error, /stale Native connection/i)
  } finally {
    background.cleanup()
  }
})

test('restart waits for an already-started browser_open_tab transfer before replacing the Native Run', async () => {
  const activeTab = { id: 42, windowId: 7, url: 'https://docs.example.test/active', title: 'Active' }
  const openedTab = { id: 66, windowId: 7, url: 'https://docs.example.test/opened', title: 'Opened' }
  let releaseTransfer
  const transferAck = new Promise((resolve) => { releaseTransfer = resolve })
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] }, activeTab, createdTab: openedTab, tabsById: { 66: openedTab }, waitForTransferAck: transferAck,
  })
  try {
    await background.sendRuntimeMessage({ type: 'ensure-harness' })
    background.emitNative({
      type: 'connector_request', requestId: 'queued-open', runId: 'run-follow', generation: 'generation-open',
      tool: 'browser_open_tab', url: openedTab.url,
    })
    for (let attempt = 0; attempt < 10 && !background.nativeMessages.some((message) => message.type === 'transfer-browser-target'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.equal(background.nativeMessages.some((message) => message.type === 'transfer-browser-target'), true)
    const restarting = background.sendRuntimeMessage({ type: 'restart-harness' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(background.nativeMessages.filter((message) => message.type === 'start').length, 1)
    releaseTransfer()
    await restarting
    const responseIndex = background.nativeMessages.findIndex((message) => message.type === 'connector_response' && message.requestId === 'queued-open')
    const restartIndex = background.nativeMessages.findIndex((message, index) => index > 0 && message.type === 'start')
    assert.ok(responseIndex > 0)
    assert.ok(restartIndex > responseIndex)
  } finally {
    background.cleanup()
  }
})
