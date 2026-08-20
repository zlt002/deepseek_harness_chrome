import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadHandoff() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/fullscreen-handoff.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

async function loadHarnessFrame() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/sidepanel/harness-frame.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript,${encodeURIComponent(compiled)}#${Date.now()}`)
}

test('a full-screen Tab opens the Side Panel synchronously in its click context while background prepares the handoff', async () => {
  const { openFullscreenTab, returnToSidePanel } = await loadHandoff()
  const requests = []
  await openFullscreenTab({
    runtime: { sendMessage: async (request) => { requests.push(request); return { ok: true } } },
  }, 7, 'session-current')

  assert.deepEqual(requests, [{ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId: 7, sessionId: 'session-current' }])

  let userGesture = true
  let resolvePreparation
  const opened = []
  const closed = []
  const paths = []
  const returned = returnToSidePanel({
    runtime: { sendMessage: (request) => {
      requests.push(request)
      return new Promise((resolve) => { resolvePreparation = resolve })
    } },
    sidePanel: {
      setOptions: async (options) => { paths.push(options) },
      close: async (options) => { closed.push(options) },
      open: async (options) => {
        assert.equal(userGesture, true, 'sidePanel.open must be invoked by the full-screen Tab click, not a background message handler')
        opened.push(options)
      },
    },
  }, 7, 42, 'session-current')
  userGesture = false
  assert.deepEqual(opened, [{ windowId: 7 }], 'the user-activation protected API is called before any await')
  assert.deepEqual(closed, [{ windowId: 7 }], 'an already-open Side Panel is replaced before the new instance starts')
  assert.deepEqual(paths, [{ path: 'sidepanel.html?dshHarnessHandoffTabId=42&dshHarnessSessionId=session-current' }], 'the replacement panel gets the session identity without waiting for a background map')
  assert.deepEqual(requests.at(-1), { type: 'prepare-sidepanel-handoff/v1', windowId: 7, tabId: 42, sessionId: 'session-current' })
  resolvePreparation({ ok: true })
  await returned
})

test('the Tab URL and its loopback iframe bridge retain the selected Harness session identity', async () => {
  const { FullscreenHarnessTabUrlForSession, HarnessFrameSource } = await loadHarnessFrame()
  const tabUrl = FullscreenHarnessTabUrlForSession('chrome-extension://test/sidepanel.html', 'session-current')
  assert.equal(tabUrl, 'chrome-extension://test/sidepanel.html?dshHarnessSurface=fullscreen-tab&dshHarnessSessionId=session-current')
  const frameUrl = HarnessFrameSource('http://127.0.0.1:43123/', {
    nonce: 'nonce', parentOrigin: 'chrome-extension://test', surface: 'fullscreen-tab', sessionId: 'session-current',
  })
  assert.equal(new URL(frameUrl).searchParams.get('dshHarnessSessionId'), 'session-current')
})
