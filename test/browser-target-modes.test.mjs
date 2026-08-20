import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadBackground({ settings, activeTab, tabsById = {}, onStorageSet, transferNack = false, createdTab, waitForTransferAck, executeScript, teamDocProbeWaitMs = 0, closeSidePanel, openSidePanel, setSidePanelOptions } = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let runtimeListener
  let activatedListener
  let createdListener
  let updatedListener
  let currentActiveTab = activeTab
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
  const stored = { harnessBrowserTargetSettings: settings }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      connectNative,
      getURL: (path) => `chrome-extension://test/${path}`,
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
      onActivated: { addListener: (listener) => { activatedListener = listener } },
      onCreated: { addListener: (listener) => { createdListener = listener } },
      onUpdated: { addListener: (listener) => { updatedListener = listener } },
    },
    scripting: { executeScript: async (options) => executeScript?.(options) ?? [] },
    webNavigation: { getAllFrames: async () => [] },
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
    createdUrls,
    removedTabs,
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
    cleanup: () => {
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
    closeSidePanel: async (options) => { createdAtClose = background.createdUrls.length; closeCalls.push(options) },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId: 7, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(background.createdUrls, ['chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessSessionId=session-current'])
    assert.equal(createdAtClose, 1, 'the persistent background creates the Tab before it closes the side-panel document')
    assert.deepEqual(closeCalls, [{ windowId: 7 }])
  } finally {
    background.cleanup()
  }
})

test('background replaces an already-open Side Panel before closing the full-screen Tab and restores the selected session', async () => {
  const fullScreenTab = { id: 91, windowId: 7, url: 'chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab', title: 'ACCRUI' }
  const steps = []
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: fullScreenTab,
    closeSidePanel: async (options) => { steps.push(['close', options]) },
    openSidePanel: async (options) => { steps.push(['open', options]) },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'switch-harness-surface/v1', surface: 'sidepanel', windowId: 7, tabId: 91, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(steps, [
      ['close', { windowId: 7 }],
      ['open', { windowId: 7 }],
    ])
    assert.deepEqual(background.removedTabs, [], 'the full-screen Tab stays open until the side panel applies the session')
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true, sessionId: 'session-current', tabId: 91 })
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 91, sessionId: 'session-other' }), { ok: false, error: 'The Harness side-panel handoff does not match the restored session.' })
    assert.deepEqual(background.removedTabs, [], 'an invalid session ACK must not close the full-screen Tab')
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 91, sessionId: 'session-current' }), { ok: true })
    assert.deepEqual(background.removedTabs, [91])
  } finally {
    background.cleanup()
  }
})

test('background leaves the full-screen Tab open when the replacement Side Panel cannot open', async () => {
  const fullScreenTab = { id: 91, windowId: 7, url: 'chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab', title: 'ACCRUI' }
  const background = await loadBackground({
    settings: { mode: 'follow-active-tab', pinnedTabs: [] },
    activeTab: fullScreenTab,
    openSidePanel: async () => { throw new Error('side-panel-open-failed') },
  })
  try {
    const response = await background.sendRuntimeMessage({ type: 'switch-harness-surface/v1', surface: 'sidepanel', windowId: 7, tabId: 91, sessionId: 'session-current' })
    assert.deepEqual(response, { ok: false, error: 'side-panel-open-failed' })
    assert.deepEqual(background.removedTabs, [])
    assert.deepEqual(await background.sendRuntimeMessage({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true })
  } finally {
    background.cleanup()
  }
})

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
      browserTarget: baiduTarget, tool: 'list_work_tabs',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.activateTab(43)
    await new Promise((resolve) => setTimeout(resolve, 0))
    background.emitNative({
      type: 'connector_request', requestId: 'wb-turn', runId: 'run-follow', generation: 'generation-1',
      browserTarget: baiduTarget, tool: 'list_work_tabs',
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
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
    background.cleanup()
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
