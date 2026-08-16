import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('routes office_spreadsheet writes only to the WebEdit iframe and forwards runtime failures', async () => {
  const source = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener
  const sent = []; const nativeMessages = []; const listeners = new Set()
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/sheets/budget' }
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'sheet-1' }
  const precondition = { version: 1, range: 'A1', state: { values: [[null]], formulas: [[null]], merged: null, filter: null, rowHeight: null, columnWidth: null, format: {} } }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} }, onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => listeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'spreadsheet-background-run' } }))) },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } }, runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} } }, windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: { query: async () => [{ id: 42, windowId: 7, url: target.url, title: 'Budget' }], get: async () => ({ id: 42, windowId: 7, url: target.url, title: 'Budget' }), sendMessage: async (tabId, message, options) => { sent.push({ tabId, message, options }); return { ok: false, error: { code: 'readback_mismatch', message: 'readback differs' } } }, onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: target.url }, { frameId: 9, url: 'https://wrong.example/' }, { frameId: 17, url: 'https://webedit.midea.com/edit/abc' }] }, sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-spreadsheet-${Date.now()}`)
    await new Promise((resolve, reject) => { const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (open !== true) reject(new Error('ensure-harness did not retain the response channel')) })
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-write-1', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'write', resource, operation: 'set_values', payload: { range: 'A1', values: [[1]] }, precondition }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(sent, [{ tabId: 42, message: { type: 'office-spreadsheet/v1', action: 'write', resource, operation: 'set_values', payload: { range: 'A1', values: [[1]] }, precondition }, options: { frameId: 17 } }])
    const response = nativeMessages.find((message) => message.type === 'connector_response')
    assert.deepEqual(response.error, { code: 'readback_mismatch', message: 'readback differs' })
  } finally { delete globalThis.chrome; delete globalThis.defineBackground }
})
