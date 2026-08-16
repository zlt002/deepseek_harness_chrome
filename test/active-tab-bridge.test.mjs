import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('forwards Browser Target snapshots to the Harness iframe through the strict bridge', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /browser-target-snapshot\/v1/)
  assert.match(source, /browser-target-command\/v1/)
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(source, /value\.nonce !== frameNonce/)
  assert.match(source, /value\.sequence <= commandSequenceRef\.current/)
  assert.match(source, /bridgeSequenceRef\.current \+= 1/)
  assert.match(source, /useLayoutEffect\(\(\) => \{/)
})

test('accepts a Harness reconnect only from the nonce-bound loopback iframe', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(source, /value\.type === 'harness-reconnect\/v1' && value\.nonce === frameNonce/)
  assert.match(source, /void connect\(\)/)
})

test('publishes only read-only active-tab snapshots and serves the initial snapshot', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let runtimeListener
  let activatedListener
  const runtimeMessages = []
  const initial = { id: 11, windowId: 3, title: '初始标签', url: 'https://initial.example/', favIconUrl: 'https://initial.example/favicon.ico' }
  const next = { id: 12, windowId: 3, title: '下一个标签', url: 'https://next.example/' }
  let current = initial
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      onMessage: { addListener: (listener) => { runtimeListener = listener } },
      connectNative: () => { throw new Error('active-tab bridge must not connect Native') },
      sendMessage: async (message) => { runtimeMessages.push(message) },
      lastError: undefined,
    },
    windows: {
      getLastFocused: async () => ({ id: 3 }),
      onFocusChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [current],
      get: async (tabId) => tabId === next.id ? next : initial,
      onActivated: { addListener: (listener) => { activatedListener = listener } },
      onCreated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
  }
  globalThis.defineBackground = (setup) => setup()

  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
    const initialResponse = await new Promise((resolve, reject) => {
      const open = runtimeListener({ type: 'get-active-tab/v1' }, {}, resolve)
      if (open !== true) reject(new Error('initial snapshot request did not keep the response channel open'))
    })
    assert.equal(typeof initialResponse.epoch, 'string')
    assert.deepEqual(initialResponse, {
      ok: true,
      epoch: initialResponse.epoch,
      sequence: 1,
      tab: {
        windowId: 3, tabId: 11, title: '初始标签', url: 'https://initial.example/', favIconUrl: 'https://initial.example/favicon.ico',
      },
    })

    current = next
    activatedListener({ tabId: 12, windowId: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(runtimeMessages, [{
      type: 'active-tab-changed/v1',
      epoch: initialResponse.epoch,
      sequence: 2,
      tab: { windowId: 3, tabId: 12, title: '下一个标签', url: 'https://next.example/' },
    }])
    assert.equal(runtimeMessages.some((message) => message.type === 'transfer-browser-target'), false)
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
  }
})

test('publishes only the latest activation when Chrome tab lookups resolve out of order', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let activatedListener
  const runtimeMessages = []
  const pendingQueries = []
  const first = { id: 21, windowId: 3, title: '先激活', url: 'https://first.example/' }
  const latest = { id: 22, windowId: 3, title: '最后激活', url: 'https://latest.example/' }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => { runtimeMessages.push(message) },
      lastError: undefined,
    },
    storage: undefined,
    windows: {
      getLastFocused: async () => ({ id: 3 }),
      onFocusChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => await new Promise((resolve) => pendingQueries.push(resolve)),
      get: async (tabId) => tabId === latest.id ? latest : first,
      onActivated: { addListener: (listener) => { activatedListener = listener } },
      onCreated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
  }
  globalThis.defineBackground = (setup) => setup()

  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#race-${Date.now()}`)
    activatedListener({ tabId: first.id, windowId: 3 })
    activatedListener({ tabId: latest.id, windowId: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(pendingQueries.length, 2)
    pendingQueries[1]([latest])
    await new Promise((resolve) => setTimeout(resolve, 0))
    pendingQueries[0]([first])
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(runtimeMessages.length, 1)
    assert.equal(runtimeMessages[0].tab.tabId, latest.id)
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
  }
})

test('an update in a background window republishes the active tab from the focused window', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let updatedListener
  const runtimeMessages = []
  const foreground = { id: 31, windowId: 1, active: true, title: '前台窗口', url: 'https://foreground.example/' }
  const background = { id: 32, windowId: 2, active: true, title: '后台窗口', url: 'https://background.example/' }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => { runtimeMessages.push(message) },
      lastError: undefined,
    },
    storage: undefined,
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      onFocusChanged: { addListener: () => {} },
    },
    tabs: {
      query: async ({ windowId }) => windowId === 1 ? [foreground] : [background],
      get: async () => foreground,
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onUpdated: { addListener: (listener) => { updatedListener = listener } },
      onRemoved: { addListener: () => {} },
    },
  }
  globalThis.defineBackground = (setup) => setup()

  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#window-${Date.now()}`)
    updatedListener(background.id, { title: background.title }, background)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(runtimeMessages.length, 1)
    assert.equal(runtimeMessages[0].tab.tabId, foreground.id)
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
  }
})
