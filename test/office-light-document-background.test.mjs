import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

test('background forwards selection_insert to WebEdit and rejects unknown light-document operations', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener; const listeners = new Set(); const sent = []; const nativeMessages = []
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/109?id=109' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '选区文档', fingerprint: 'before' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} }, onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => listeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'light-document-background-run' } }))) },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } }, runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} } }, windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: { query: async () => [{ id: 42, windowId: 7, url: target.url, title: '文档' }], get: async () => ({ id: 42, windowId: 7, url: target.url, title: '文档' }), sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options })
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true } }
      return { ok: true, result: { status: 'ok', resource, document: {} } }
    }, onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: target.url }, { frameId: 17, url: 'https://webedit.midea.com/edit/abc' }] }, sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-light-document-background-${Date.now()}`)
    await new Promise((resolve, reject) => { const opened = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (opened !== true) reject(new Error('ensure-harness did not retain the response channel')) })
    const payload = { text: '写入内容', expectedSelectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef' }
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'selection-1', runId: 'light-document-background-run', generation: 'g-1', browserTarget: target, tool: 'light_document', action: 'write', resource, operation: 'selection_insert', payload }))
    listeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'unknown-1', runId: 'light-document-background-run', generation: 'g-1', browserTarget: target, tool: 'light_document', action: 'inspect_write', operation: 'unknown_operation', payload }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(sent.filter((entry) => entry.message.action !== 'probe'), [{ tabId: 42, message: { type: 'office-document/v1', action: 'write', resource, operation: 'selection_insert', payload }, options: { frameId: 17 } }])
    assert.equal(nativeMessages.filter((message) => message.type === 'connector_response').length, 1)
  } finally { delete globalThis.chrome; delete globalThis.defineBackground }
})

test('concurrent light-document writes fence per resource fingerprint while different documents proceed', async () => {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener; const listeners = new Set(); const sent = []; const nativeMessages = []
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/110?id=110' }
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: '并发文档', fingerprint: 'doc-a' }
  const tab = { id: 42, windowId: 7, url: target.url, title: '并发文档' }
  let releaseFirst; let writeCount = 0
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} }, onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => listeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'light-document-fence-run' } }))) },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } }, runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} } }, windows: { getLastFocused: async () => ({ id: 7 }), onFocusChanged: { addListener: () => {} } },
    tabs: { query: async () => [tab], get: async () => tab, sendMessage: async (tabId, message, options) => {
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true } }
      if (message.type === 'office-document/v1' && message.action === 'write') {
        sent.push({ tabId, message, options })
        if (writeCount++ === 0) await new Promise((resolve) => { releaseFirst = resolve })
        return { ok: true, result: { status: 'verified_write', resource: message.resource, requested: { operation: message.operation, payload: message.payload }, observed: { verified: true } } }
      }
      return { ok: true, result: { status: 'ok', resource: message.resource ?? resource, document: {} } }
    }, onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url: target.url }, { frameId: 17, url: 'https://webedit.midea.com/edit/abc' }] }, sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  const write = (requestId, fingerprint, text) => ({ type: 'connector_request', requestId, runId: 'light-document-fence-run', generation: 'g-1', browserTarget: target, tool: 'light_document', action: 'write', resource: { ...resource, fingerprint }, operation: 'replace', payload: { index: 0, text } })
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-light-document-fence-${Date.now()}`)
    await new Promise((resolve, reject) => { const opened = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (opened !== true) reject(new Error('ensure-harness did not retain the response channel')) })
    listeners.forEach((listener) => listener(write('w1', 'doc-a', '第一笔')))
    await new Promise((resolve) => setTimeout(resolve, 0))
    listeners.forEach((listener) => listener(write('w2', 'doc-b', '不同文档')))
    listeners.forEach((listener) => listener(write('w3', 'doc-a', '同一文档')))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent.length, 2, 'a different-fingerprint write proceeds while the first same-resource write is in flight; the same-fingerprint write stays fenced')
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sent.length, 3)
    assert.deepEqual(sent.map((entry) => entry.message.payload.text), ['第一笔', '不同文档', '同一文档'])
    assert.equal(nativeMessages.filter((message) => message.type === 'connector_response' && message.requestId === 'w3').length, 1)
  } finally { delete globalThis.chrome; delete globalThis.defineBackground }
})
