import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('routes office_read_range only to the WebEdit iframe in the exact bound Browser Target', async () => {
  const source = await readFile(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener
  const sentToFrames = []
  const nativeMessages = []
  const nativeListeners = new Set()
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/sheets/budget' }
  const tab = { id: 42, windowId: 7, url: target.url, title: 'Budget' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: (listener) => nativeListeners.add(listener), removeListener: (listener) => nativeListeners.delete(listener) },
    postMessage: (message) => {
      nativeMessages.push(message)
      if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-office-read' } })))
    },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} } },
    windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async () => [tab], get: async () => tab,
      sendMessage: async (tabId, message, options) => {
        sentToFrames.push({ tabId, message, options })
        return { ok: true, result: { status: 'ok', resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'webedit:budget-summary' }, range: { address: 'Summary!A1:B1', rowCount: 1, columnCount: 2, rows: [{ index: 1, cells: [{ address: 'A1', row: 1, column: 1, text: 'A', value: 'A', formula: null }, { address: 'B1', row: 1, column: 2, text: '2', value: 2, formula: null }] }] } } }
      },
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: target.url }, { frameId: 9, url: 'https://not-webedit.example/' }, { frameId: 17, url: 'https://webedit.midea.com/edit/abc' }] },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-read-${Date.now()}`)
    await new Promise((resolve, reject) => {
      const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error)))
      if (open !== true) reject(new Error('ensure-harness did not retain the response channel'))
    })
    nativeListeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'read-1', runId: 'run-office-read', generation: 'g-1', browserTarget: target, tool: 'office_read_range', range: 'Summary!A1:B1' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(sentToFrames, [{ tabId: 42, message: { type: 'office-read-range/v1', range: 'Summary!A1:B1' }, options: { frameId: 17 } }])
    const response = nativeMessages.find((message) => message.type === 'connector_response')
    assert.equal(response.browserTarget.tabId, 42)
    assert.equal(response.result.range.rows[0].cells[1].value, 2)
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
  }
})
