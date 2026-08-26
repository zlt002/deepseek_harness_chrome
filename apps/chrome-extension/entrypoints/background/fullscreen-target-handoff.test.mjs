import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadModule() {
  const source = await readFile(new URL('./fullscreen-target-handoff.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace("import type { BrowserTarget } from '../../../native-server/src/connector-protocol.mjs'", '')
    .replace("import type { BrowserTargetSettings } from './browser-target-state'", '')
  return import(`data:text/javascript,${encodeURIComponent(javascript)}#${Date.now()}-${Math.random()}`)
}

test('captures the pre-fullscreen Browser Target before the extension Tab becomes active', async () => {
  const { preserveFullscreenBrowserTarget } = await loadModule()
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://example.test/' }
  const calls = []
  let settings = { mode: 'follow-active-tab', pinnedTabs: [] }
  const result = await preserveFullscreenBrowserTarget(
    7,
    async (windowId) => { calls.push(['resolve', windowId]); return target },
    async (mutator) => { calls.push(['persist']); settings = mutator(settings); return settings },
  )
  assert.deepEqual(result, target)
  assert.deepEqual(settings.candidate, target)
  assert.deepEqual(calls, [['resolve', 7], ['persist']])
})

test('fails safely when the original Browser Target was closed', async () => {
  const { preserveFullscreenBrowserTarget } = await loadModule()
  let persisted = false
  await assert.rejects(
    preserveFullscreenBrowserTarget(7, async () => { throw new Error('The original tab is closed.') }, async () => { persisted = true; return { mode: 'follow-active-tab', pinnedTabs: [] } }),
    /original tab is closed/,
  )
  assert.equal(persisted, false)
})

test('fullscreen switching captures the target before creating the active extension Tab', async () => {
  const source = await readFile(new URL('../background.ts', import.meta.url), 'utf8')
  const capture = source.indexOf('await preserveFullscreenBrowserTarget(windowId')
  const create = source.indexOf('await chrome.tabs.create({ windowId, active: true', capture)
  assert.ok(capture >= 0, 'fullscreen handoff must preserve the original target')
  assert.ok(create > capture, 'target preservation must happen before Chrome activates fullscreen-tab')
})
