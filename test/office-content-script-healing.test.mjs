import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const READ_RESULT = { status: 'ok', resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Budget.xlsx', sheetName: 'Summary', fingerprint: 'webedit:budget-summary' }, range: { address: 'Summary!A1:B1', rowCount: 1, columnCount: 2, rows: [{ index: 1, cells: [{ address: 'A1', row: 1, column: 1, text: 'A', value: 'A', formula: null }, { address: 'B1', row: 1, column: 2, text: '2', value: 2, formula: null }] }] } }

async function compileBackground() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

const DEFAULT_FRAMES = [
  { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
  { frameId: 9, url: 'https://not-webedit.example/' },
  { frameId: 17, url: 'https://webedit.midea.com/edit/abc' },
]

async function driveOfficeReadRange({ sendMessageBehavior, frames = DEFAULT_FRAMES, probeWaitMs = 80, frameOperationMs, request = {} }) {
  const compiled = await compileBackground()
  let runtimeListener
  const sentToFrames = []
  const injections = []
  const nativeMessages = []
  const nativeListeners = new Set()
  const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/sheets/budget' }
  const tab = { id: 42, windowId: 7, url: target.url, title: 'Budget' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: (listener) => nativeListeners.add(listener), removeListener: (listener) => nativeListeners.delete(listener) },
    postMessage: (message) => {
      nativeMessages.push(message)
      if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-healing' } })))
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
        return sendMessageBehavior(message, options)
      },
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    scripting: { executeScript: async (injection) => { injections.push(injection); return [] } },
    webNavigation: { getAllFrames: async () => frames },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  globalThis.__DSH_OFFICE_PROBE_WAIT_MS = probeWaitMs
  if (frameOperationMs !== undefined) globalThis.__DSH_OFFICE_FRAME_OPERATION_MS = frameOperationMs
  try {
    await import(`data:text/javascript,${encodeURIComponent(compiled)}#office-healing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await new Promise((resolve, reject) => {
      const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error)))
      if (open !== true) reject(new Error('ensure-harness did not retain the response channel'))
    })
    nativeListeners.forEach((listener) => listener({ type: 'connector_request', requestId: 'read-1', runId: 'run-healing', generation: 'g-1', browserTarget: target, tool: 'office_read_range', range: 'Summary!A1:B1', ...request }))
    const settleDeadline = Date.now() + 3_000
    while (!nativeMessages.some((message) => message.type === 'connector_response') && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return { sentToFrames, injections, nativeMessages }
  } finally {
    delete globalThis.chrome
    delete globalThis.defineBackground
    delete globalThis.__DSH_OFFICE_PROBE_WAIT_MS
    delete globalThis.__DSH_OFFICE_FRAME_OPERATION_MS
  }
}

test('re-injects the content script and retries once when the WebEdit frame lost its receiver', async () => {
  const missingReceiver = new Error('Could not establish connection. Receiving end does not exist.')
  const probeReady = { ok: true, result: { status: 'probe', ready: true } }
  let probes = 0
  const { sentToFrames, injections, nativeMessages } = await driveOfficeReadRange({
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') { probes += 1; return probes === 1 ? Promise.reject(missingReceiver) : Promise.resolve(probeReady) }
      assert.equal(options.frameId, 17)
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.equal(probes, 2, 'probe must be retried exactly once after re-injection')
  assert.deepEqual(injections, [{ target: { tabId: 42, frameIds: [17] }, files: ['content-scripts/office-read.js'] }])
  const realRead = sentToFrames.find((entry) => entry.message.range !== undefined)
  assert.deepEqual(realRead.message, { type: 'office-read-range/v1', range: 'Summary!A1:B1' })
  assert.equal(realRead.options.frameId, 17)
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.range.rows[0].cells[1].value, 2)
})

test('keeps the error transparent when re-injection does not revive the frame', async () => {
  const { injections, nativeMessages } = await driveOfficeReadRange({
    sendMessageBehavior: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
  })
  assert.equal(injections.length, 1, 'healing must be attempted once, not looped')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'runtime_error')
  assert.match(response.error.message, /Could not establish connection/)
})

test('does not re-inject for unrelated sendMessage failures', async () => {
  const { injections, nativeMessages } = await driveOfficeReadRange({
    sendMessageBehavior: () => Promise.reject(new Error('The message port closed before a response was received.')),
  })
  assert.equal(injections.length, 0, 'healing is reserved for the missing-receiver case')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.match(response.error.message, /message port closed/)
})

test('uses the ready spreadsheet frame when a sibling WebEdit iframe never answers probe', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2079459209604050946' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/o/preload' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/392034640740352' },
  ]
  const probedFrames = []
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    probeWaitMs: 400,
    request: { tool: 'office_spreadsheet', action: 'selection', range: undefined },
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') {
        probedFrames.push({ type: message.type, frameId: options.frameId })
        if (options.frameId === 5) return new Promise(() => {})
        if (message.type === 'office-spreadsheet/v1' && options.frameId === 6) {
          return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/392034640740352', workbookName: null, sheetName: 'Sheet1', hasContent: true } } })
        }
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
      }
      assert.equal(options.frameId, 6, 'the hung preload must not block the ready spreadsheet')
      assert.equal(message.action, 'selection')
      return Promise.resolve({ ok: true, result: { status: 'ok', resource: READ_RESULT.resource, selection: { supported: true, address: 'D11:G20', rowsCount: 10, columnsCount: 4, singleCell: false, value2: [['人事部']] } } })
    },
  })
  assert.ok(probedFrames.some((entry) => entry.frameId === 6 && entry.type === 'office-spreadsheet/v1'))
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.selection.address, 'D11:G20')
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'selection').length, 1)
})

test('skips WebEdit frames whose editor runtime is not ready and uses the ready one', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
    { frameId: 5, url: 'https://webedit.midea.com/ad-banner' },
    { frameId: 6, url: 'https://webedit.midea.com/edit/abc' },
  ]
  const probedFrames = []
  const { sentToFrames, injections, nativeMessages } = await driveOfficeReadRange({
    frames,
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') {
        probedFrames.push(options.frameId)
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: options.frameId === 6 } })
      }
      assert.equal(options.frameId, 6, 'real operation must go to the ready frame')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.deepEqual([...new Set(probedFrames)].sort((left, right) => left - right), [5, 6], 'every webedit candidate must be probed')
  assert.equal(injections.length, 0, 'no healing needed: receivers answered')
  assert.equal(sentToFrames.filter((entry) => entry.message.range !== undefined).length, 1, 'exactly one real read must be sent')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.range.rows[0].cells[1].value, 2)
})

test('prefers the content-bearing WebEdit frame when several editors are ready', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/blank-preload' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/real-doc' },
  ]
  const probe = (identity) => ({ ok: true, result: { status: 'probe', ready: true, identity } })
  const blankPreload = { path: '/weboffice/office/s/blank-preload', workbookName: null, sheetName: 'Sheet1', hasContent: null }

  const first = await driveOfficeReadRange({
    frames,
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') return Promise.resolve(probe(options.frameId === 6 ? { path: '/weboffice/office/s/real-doc', workbookName: 'Budget.xlsx', sheetName: 'Summary', hasContent: true } : blankPreload))
      assert.equal(options.frameId, 6, 'the real document must win over the earlier blank preload')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.equal(first.nativeMessages.find((message) => message.type === 'connector_response').error, undefined)

  const second = await driveOfficeReadRange({
    frames,
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') return Promise.resolve(probe(options.frameId === 5 ? { path: '/weboffice/office/s/blank-preload', workbookName: 'Notes.xlsx', sheetName: 'Sheet1', hasContent: null } : blankPreload))
      assert.equal(options.frameId, 5, 'a named workbook beats an unnamed blank preload even without a content signal')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.equal(second.nativeMessages.find((message) => message.type === 'connector_response').error, undefined)
})

test('keeps first-ready order when no identity distinguishes the frames', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
    { frameId: 5, url: 'https://webedit.midea.com/edit/abc' },
    { frameId: 6, url: 'https://webedit.midea.com/edit/def' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/edit/' + options.frameId, hasContent: null } } })
      assert.equal(options.frameId, 5, 'ties must keep getAllFrames order, not flip to a later frame')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.equal(sentToFrames.filter((entry) => entry.message.range !== undefined).length, 1)
  assert.equal(nativeMessages.find((message) => message.type === 'connector_response').error, undefined)
})

test('reports a transparent unsupported error when no WebEdit frame becomes ready', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
    { frameId: 5, url: 'https://webedit.midea.com/ad-banner' },
  ]
  const probeCount = { value: 0 }
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    sendMessageBehavior: () => { probeCount.value += 1; return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } }) },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'unsupported')
  assert.match(response.error.message, /1 WebEdit iframe\(s\), but none exposed a ready editor runtime within 0\.1s/, 'the error must distinguish frames-exist-but-not-ready from no-iframe-at-all')
  assert.ok(probeCount.value >= 2, 'the sweep must retry within the wait budget before giving up')
})

test('names office_spreadsheet when the frames host a ready spreadsheet but no light document', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/392' },
  ]
  const probedChannels = new Set()
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_document', action: 'selection', range: undefined },
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') {
        probedChannels.add(message.type)
        if (message.type === 'office-document/v1') return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: options.frameId === 5, identity: { path: '/weboffice/office/s/392', workbookName: null, sheetName: 'Sheet1', hasContent: null } } })
      }
      return Promise.reject(new Error('the real selection must never run when the light-document channel stays silent'))
    },
  })
  assert.ok(probedChannels.has('office-spreadsheet/v1'), 'the sibling channel must be probed once before giving up')
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'selection').length, 0)
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'unsupported')
  assert.match(response.error.message, /none exposed a ready light-document editor within 0\.1s/)
  assert.match(response.error.message, /1 of them expose a ready WebEdit spreadsheet runtime instead/)
  assert.match(response.error.message, /call office_spreadsheet/)
})

test('names office_document when the frames host a ready light document but no spreadsheet', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/d/77' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_spreadsheet', action: 'context', range: undefined },
    sendMessageBehavior: (message) => {
      if (message.action !== 'probe') return Promise.reject(new Error('the real context must never run'))
      if (message.type === 'office-spreadsheet/v1') return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/d/77' } } })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'unsupported')
  assert.match(response.error.message, /none exposed a ready spreadsheet runtime within 0\.1s/)
  assert.match(response.error.message, /call office_document/)
})

test('office_get_context reports the probed spreadsheet identity instead of a hardcoded null', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/392' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/392-preload' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_get_context', range: undefined },
    sendMessageBehavior: (message, options) => {
      assert.equal(message.action, 'probe', 'context must only probe frames, never operate')
      if (message.type === 'office-spreadsheet/v1') {
        if (options.frameId === 5) return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/392', workbookName: null, sheetName: 'Sheet1', hasContent: true } } })
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/preload', workbookName: null, sheetName: 'Sheet1', hasContent: null } } })
      }
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
    },
  })
  assert.equal(sentToFrames.length, 4, 'one quick probe per frame per channel, no waiting sweep')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result.documentIdentity, { kind: 'webedit_spreadsheet', workbookName: null, sheetName: 'Sheet1', hasContent: true, webeditFrames: 2 })
  assert.deepEqual(response.result.pages[0].documentIdentity, { kind: 'webedit_spreadsheet', workbookName: null, sheetName: 'Sheet1', hasContent: true, webeditFrames: 2 })
})

test('office_get_context prefers a ready light document over a blank preloaded spreadsheet', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2089336886234255362' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/o/2089336886234255362' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/preload' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_get_context', range: undefined },
    sendMessageBehavior: (message, options) => {
      assert.equal(message.action, 'probe', 'context must only probe frames, never operate')
      if (message.type === 'office-document/v1' && options.frameId === 5) {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/o/2089336886234255362' } } })
      }
      if (message.type === 'office-spreadsheet/v1' && options.frameId === 6) {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/preload', workbookName: null, sheetName: 'Sheet1', hasContent: null } } })
      }
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result.documentIdentity, { kind: 'webedit_light_document', workbookName: null, sheetName: null, hasContent: null, webeditFrames: 2 })
  assert.deepEqual(response.result.pages[0].documentIdentity, { kind: 'webedit_light_document', workbookName: null, sheetName: null, hasContent: null, webeditFrames: 2 })
})

test('office_get_context keeps null only when no webedit frame answers ready', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/some/page' },
    { frameId: 5, url: 'https://webedit.midea.com/booting' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_get_context', range: undefined },
    sendMessageBehavior: () => Promise.resolve({ ok: true, result: { status: 'probe', ready: false } }),
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.result.documentIdentity, null)
  assert.equal(response.result.pages[0].documentIdentity, null)
})

test('keeps the plain none-ready error when the sibling channel is also silent', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/392' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'office_document', action: 'selection', range: undefined },
    sendMessageBehavior: () => Promise.resolve({ ok: true, result: { status: 'probe', ready: false } }),
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'unsupported')
  assert.match(response.error.message, /none exposed a ready light-document editor within 0\.1s\.$/)
  assert.ok(!response.error.message.includes('instead'), 'no wrong-type hint when nothing is ready anywhere')
})

test('times out a hung WebEdit operation after the ready probe instead of stalling Native', async () => {
  const { nativeMessages } = await driveOfficeReadRange({
    probeWaitMs: 80,
    frameOperationMs: 200,
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true } })
      return new Promise(() => {})
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'timeout')
  assert.match(response.error.message, /did not finish the editor runtime operation within 0\.2s/)
})

test('keeps sweeping until a slow-booting editor becomes ready instead of failing on the first probe', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
    { frameId: 5, url: 'https://webedit.midea.com/edit/abc' },
  ]
  const probeCount = { value: 0 }
  const { sentToFrames, injections, nativeMessages } = await driveOfficeReadRange({
    frames,
    probeWaitMs: 900,
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') {
        probeCount.value += 1
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: probeCount.value >= 3 } })
      }
      assert.equal(options.frameId, 5, 'the real operation must wait for the booting editor, not fail early')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  assert.equal(probeCount.value, 3, 'the editor reported ready exactly on the third sweep')
  assert.equal(injections.length, 0)
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.range.rows[0].cells[1].value, 2)
  assert.equal(sentToFrames.filter((entry) => entry.message.range !== undefined).length, 1, 'exactly one real read must be sent')
})
