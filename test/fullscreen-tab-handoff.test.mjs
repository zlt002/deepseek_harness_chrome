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

test('a side-panel-local handoff asks the persistent background to switch surfaces before the panel closes', async () => {
  const { openFullscreenTab, returnToSidePanel } = await loadHandoff()
  const requests = []
  await openFullscreenTab({
    runtime: { sendMessage: async (request) => { requests.push(request); return { ok: true } } },
  }, 7, 'session-current')

  assert.deepEqual(requests, [{ type: 'switch-harness-surface/v1', surface: 'fullscreen-tab', windowId: 7, sessionId: 'session-current' }])

  await returnToSidePanel({
    runtime: { sendMessage: async (request) => { requests.push(request); return { ok: true } } },
  }, 7, 42, 'session-current')
  assert.deepEqual(requests.at(-1), { type: 'switch-harness-surface/v1', surface: 'sidepanel', windowId: 7, tabId: 42, sessionId: 'session-current' })
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
