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
  const state = { values: [[null]], formulas: [[null]], merged: null, filter: null, rowHeight: null, columnWidth: null, format: {} }
  const precondition = { version: 2, targets: [{ range: 'A1', state }, { range: 'B1', state }] }
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
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-write-1', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'write', resource, operation: 'replace_range_text', payload: { range: 'A1', what: 'a', replacement: 'b' }, precondition }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(sent, [{ tabId: 42, message: { type: 'office-spreadsheet/v1', action: 'write', resource, operation: 'replace_range_text', payload: { range: 'A1', what: 'a', replacement: 'b' }, precondition }, options: { frameId: 17 } }])
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-validation-invalid', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'set_data_validation', payload: { range: 'A1', validationType: 'unknown', formula1: 'x' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-validation-missing-formula2', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'set_data_validation', payload: { range: 'A1', validationType: 'wholeNumber', formula1: '1' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-hyperlink-dangerous', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'add_hyperlink', payload: { range: 'A1', url: 'javascript:alert(1)', subAddress: '', textToDisplay: 'Bad' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-hyperlink-dangerous-reference', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'add_hyperlink', payload: { range: 'A1', url: '', subAddress: '[Other.xlsx]Sheet1!A1', textToDisplay: 'Bad reference' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-hyperlink-url-dangerous-reference', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'add_hyperlink', payload: { range: 'A1', url: 'https://example.com/', subAddress: 'javascript:alert(1)', textToDisplay: 'Bad combined reference' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-hyperlink-safe-sheet-reference', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'add_hyperlink', payload: { range: 'A1', url: '', subAddress: "'Sales 2026'!$A$1:$B$2", textToDisplay: 'Sales' } }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'sheet-hyperlink-safe-name-reference', runId: 'spreadsheet-background-run', generation: 'g-1', browserTarget: target, tool: 'office_spreadsheet', action: 'inspect_write', operation: 'add_hyperlink', payload: { range: 'A1', url: '', subAddress: 'QuarterlySales', textToDisplay: 'Quarterly sales' } }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(sent.length, 3)
    const response = nativeMessages.find((message) => message.type === 'connector_response')
    assert.deepEqual(response.error, { code: 'readback_mismatch', message: 'readback differs' })
  } finally { delete globalThis.chrome; delete globalThis.defineBackground }
})
