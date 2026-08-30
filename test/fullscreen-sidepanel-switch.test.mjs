import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'
import { createBrowserTargetProtocol } from '../packages/harness-ui-browser-target/src/client/protocol.js'

const backgroundSource = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')

async function loadBackgroundHandoff({ tabs: initialTabs = [], sidePanel = {}, storageState = {} } = {}) {
  const compiled = await bundleTypescript(backgroundSource, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  const tabs = new Map(initialTabs.map(tab => [tab.id, { ...tab }]))
  let messageListener
  const removed = []
  const setOptionsCalls = []
  const listeners = () => ({ addListener() {}, removeListener() {} })
  const localStorage = { async get(key) { return { [key]: storageState[key] } }, async set(value) { Object.assign(storageState, value) }, async remove(key) { delete storageState[key] } }
  globalThis.defineBackground = setup => setup()
  globalThis.chrome = {
    runtime: {
      getURL: path => `chrome-extension://test/${String(path).replace(/^\//, '')}`,
      lastError: undefined,
      onMessage: { addListener: listener => { messageListener = listener } },
      onConnect: listeners(),
      sendMessage: async () => {},
    },
    action: { onClicked: listeners() },
    sidePanel: {
      open: async options => { sidePanel.open?.(options) },
      close: async options => { sidePanel.close?.(options) },
      setOptions: async options => { setOptionsCalls.push(options); sidePanel.setOptions?.(options) },
    },
    tabs: {
      get: async tabId => tabs.get(tabId),
      remove: async tabId => { removed.push(tabId); tabs.delete(tabId) },
      query: async () => [],
      onActivated: listeners(), onCreated: listeners(), onUpdated: listeners(), onRemoved: listeners(),
    },
    windows: { onFocusChanged: listeners(), getLastFocused: async () => ({ id: 1 }) },
    storage: { local: localStorage, session: localStorage },
    webNavigation: { onCommitted: listeners() },
    scripting: { executeScript: async () => [] },
  }
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#fullscreen-background-${Date.now()}`)
  assert.equal(typeof messageListener, 'function', 'background must register its runtime message handler')
  const send = (request, sender = { url: 'chrome-extension://test/sidepanel.html' }) => new Promise(resolve => {
    const keepAlive = messageListener(request, sender, response => resolve(response))
    if (keepAlive === false) resolve(undefined)
  })
  return { send, removed, setOptionsCalls, tabs, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground } }
}

test('the extension shell shows an exclusive full-screen return control and delegates the transaction to background', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  const handoffControl = await readFile(new URL('../packages/harness-ui-browser-target/src/client/index.ts', import.meta.url), 'utf8')
  const handoffButton = await readFile(new URL('../packages/harness-ui-browser-target/src/client/FullscreenReturnControl.tsx', import.meta.url), 'utf8')
  assert.match(source, /async function openFullscreenTab\(sessionId\?/)
  assert.match(source, /async function returnToSidePanel\(sessionId\?/)
  assert.match(source, /returnToSidePanelFromFullscreen\(chrome, tab\.windowId, tab\.id, sessionId\)/)
  assert.match(source, /HarnessFrameSource\(url, \{[^}]*surface, productVersion/)
  assert.match(source, /get-sidepanel-handoff\/v1/)
  assert.match(source, /session-handoff-applied\/v1/)
  assert.match(source, /if \(!sidePanelHandoff\.ready\) return/)
  assert.match(source, /chrome\.runtime\.getManifest\(\)\.version/)
  assert.match(handoffControl, /const fullscreenTab = config\?\.surface === 'fullscreen-tab'/)
  assert.match(handoffControl, /if \(fullscreenTab\) ctx\.slots\.inject\('conversation\.session\.header\.utilities'/)
  assert.match(handoffButton, /aria-label=\{label\} title=\{label\} data-fullscreen-return-control/)
  assert.match(handoffButton, /const label = '收起全屏'/)
})

test('only the nonce-bound Harness iframe can request either surface handoff', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8')
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow \|\| event\.origin !== frameOrigin/)
  assert.match(source, /value\.type === 'open-fullscreen-tab\/v1' && value\.nonce === frameNonce/)
  assert.match(source, /value\.type === 'return-to-sidepanel\/v1' && value\.nonce === frameNonce/)
})

test('the executable iframe protocol ignores a forged nonce before changing handoff state', () => {
  const store = { value: undefined, set(value) { this.value = value } }
  const protocol = createBrowserTargetProtocol({ createStore: () => store, nonce: 'real-nonce', parentOrigin: 'chrome-extension://test' })
  const parent = {}
  const snapshot = { type: 'browser-target-snapshot/v1', nonce: 'forged-nonce', sequence: 1, settings: { mode: 'none', pinnedTabs: [] }, tabs: [] }
  assert.equal(protocol.accept({ source: parent, origin: 'chrome-extension://test', data: snapshot }, parent), false)
  assert.equal(store.value, undefined)
})

test('background records a valid side-panel handoff and exposes it until the session is applied', async () => {
  const nonce = 'a'.repeat(32)
  const background = await loadBackgroundHandoff({ tabs: [{ id: 42, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${nonce}` }] })
  try {
    assert.deepEqual(await background.send({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }), { ok: true })
    assert.deepEqual(await background.send({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true, tabId: 42, sessionId: 'session-current', nonce })
    assert.deepEqual(await background.send({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }), { ok: true })
    assert.deepEqual(background.removed, [42])
    assert.deepEqual(await background.send({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true })
  } finally {
    background.cleanup()
  }
})

test('failed preparation clears only its own handoff and never removes the wrong Tab', async () => {
  const nonce = 'b'.repeat(32)
  const background = await loadBackgroundHandoff({ tabs: [{ id: 42, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${nonce}` }] })
  try {
    const failed = await background.send({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 999, sessionId: 'session-current' })
    assert.equal(failed.ok, false)
    assert.deepEqual(background.removed, [])
    assert.deepEqual(await background.send({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true })

    assert.deepEqual(await background.send({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }), { ok: true })
    const mismatch = await background.send({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 42, nonce, sessionId: 'other-session' })
    assert.equal(mismatch.ok, false)
    assert.deepEqual(background.removed, [])
    const foreignSender = await background.send({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }, { url: 'https://evil.example/' })
    assert.equal(foreignSender.ok, false)
    assert.deepEqual(background.removed, [])
    assert.deepEqual(await background.send({ type: 'get-sidepanel-handoff/v1', windowId: 7 }), { ok: true, tabId: 42, sessionId: 'session-current', nonce })
  } finally {
    background.cleanup()
  }
})

test('worker reload requires the persisted nonce and session before removing the full-screen Tab', async () => {
  const nonce = 'd'.repeat(32)
  const storageState = {}
  const tabs = [{ id: 42, windowId: 7, url: `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${nonce}` }]
  const firstWorker = await loadBackgroundHandoff({ tabs, storageState })
  assert.deepEqual(await firstWorker.send({ type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }), { ok: true })
  firstWorker.cleanup()

  const reloadedWorker = await loadBackgroundHandoff({ tabs, storageState })
  try {
    reloadedWorker.tabs.get(42).url = `chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessHandoffNonce=${'e'.repeat(32)}`
    const forged = await reloadedWorker.send({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' })
    assert.equal(forged.ok, false)
    assert.deepEqual(reloadedWorker.removed, [])
    reloadedWorker.tabs.get(42).url = tabs[0].url
    assert.deepEqual(await reloadedWorker.send({ type: 'session-handoff-applied/v1', windowId: 7, tabId: 42, nonce, sessionId: 'session-current' }), { ok: true })
    assert.deepEqual(reloadedWorker.removed, [42])
  } finally {
    reloadedWorker.cleanup()
  }
})
