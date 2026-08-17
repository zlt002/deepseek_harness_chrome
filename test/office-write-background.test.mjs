import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('routes a fingerprint-bound office_write_range to the exact WebEdit frame and preserves verified readback', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener
  const sent = []; const nativeMessages = []; const listeners = new Set(); let releaseFirst; let sendCount = 0
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'webedit:budget-summary' }
  const tab = { id: 42, windowId: 7, url: target.url, title: 'Budget' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} }, onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => listeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-office-write' } }))) },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } }, runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} } }, windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: { query: async () => [tab], get: async () => tab, sendMessage: async (tabId, message, options) => {
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true } }
      sent.push({ tabId, message, options })
      if (sendCount++ === 0) await new Promise((resolve) => { releaseFirst = resolve })
      return { ok: true, result: { status: 'verified_write', resource, requested: { range: 'Summary!A1:B1', values: [['Revenue', 42]] }, observed: { range: 'Summary!A1:B1', values: [['Revenue', 42]] } } }
    }, onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: target.url }, { frameId: 17, url: 'https://webedit.midea.com/edit/abc' }] }, sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-write-${Date.now()}`)
    await new Promise((resolve, reject) => { const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (open !== true) reject(new Error('ensure-harness did not retain the response channel')) })
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'write-1', runId: 'run-office-write', generation: 'g-1', browserTarget: target, tool: 'office_write_range', range: 'Summary!A1:B1', values: [['Revenue', 42]], resource }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const anotherResource = { ...resource, fingerprint: 'webedit:another-sheet' }
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'write-2', runId: 'run-office-write', generation: 'g-1', browserTarget: target, tool: 'office_write_range', range: 'Summary!A1:B1', values: [['Revenue', 42]], resource: anotherResource }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'write-3', runId: 'run-office-write', generation: 'g-1', browserTarget: target, tool: 'office_write_range', range: 'Summary!A1:B1', values: [['Revenue', 42]], resource }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(sent.length, 2, 'different resource writes remain independent while same resource writes serialize')
    assert.deepEqual(sent[0], { tabId: 42, message: { type: 'office-write-range/v1', range: 'Summary!A1:B1', values: [['Revenue', 42]], resource }, options: { frameId: 17 } })
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(sent.length, 3)
    const response = nativeMessages.find((message) => message.type === 'connector_response')
    assert.deepEqual(response.result.requested, response.result.observed)
  } finally { delete globalThis.chrome; delete globalThis.defineBackground }
})
