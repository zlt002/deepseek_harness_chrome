import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

const READ_RESULT = { status: 'ok', resource: { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: 'Budget', fingerprint: 'doc-1' }, document: { blockCount: 1 } }

async function compileBackground() {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  return bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
}

const DEFAULT_FRAMES = [
  { frameId: 0, url: 'https://doc.midea.com/sheets/budget' },
  { frameId: 9, url: 'https://not-webedit.example/' },
  { frameId: 17, url: 'https://webedit.midea.com/edit/abc' },
]

async function driveOfficeReadRange({ sendMessageBehavior, frames = DEFAULT_FRAMES, probeWaitMs = 80, frameOperationMs, responseWaitMs = 3_000, request = {}, requests }) {
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
    const requestList = requests ?? [request]
    for (const [index, nextRequest] of requestList.entries()) {
      const priorResponses = nativeMessages.filter((message) => message.type === 'connector_response').length
      nativeListeners.forEach((listener) => listener({ type: 'connector_request', requestId: `read-${index + 1}`, runId: 'run-healing', generation: 'g-1', browserTarget: target, tool: 'light_document', action: 'read', offset: 0, limit: 20, ...nextRequest }))
      const settleDeadline = Date.now() + responseWaitMs
      while (nativeMessages.filter((message) => message.type === 'connector_response').length === priorResponses && Date.now() < settleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
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
  const realRead = sentToFrames.find((entry) => entry.message.action === 'read')
  assert.deepEqual(realRead.message, { type: 'office-document/v1', action: 'read', offset: 0, limit: 20 })
  assert.equal(realRead.options.frameId, 17)
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
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
    request: { tool: 'read_work_tab', tab: 1 },
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
      assert.equal(message.action, 'used_range')
      return Promise.resolve({ ok: true, result: { status: 'ok', usedRange: { address: 'A1:B2', text: '人事部' } } })
    },
  })
  assert.ok(probedFrames.some((entry) => entry.frameId === 6 && entry.type === 'office-spreadsheet/v1'))
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.kind, 'webedit_spreadsheet')
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
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'read').length, 1, 'exactly one real read must be sent')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
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
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'read').length, 1)
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
  assert.match(response.error.message, /1 WebEdit iframe\(s\), but none exposed a ready light-document editor within 0\.1s/, 'the error must distinguish frames-exist-but-not-ready from no-iframe-at-all')
  assert.ok(probeCount.value >= 2, 'the sweep must retry within the wait budget before giving up')
})

test('names read_work_tab when the frames host a ready spreadsheet but no light document', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/392' },
  ]
  const probedChannels = new Set()
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'light_document', action: 'read', offset: 0, limit: 20 },
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
  assert.match(response.error.message, /call read_work_tab/)
})

test('names light_document_read when the frames host a ready light document but no spreadsheet', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/d/77' },
  ]
  const { nativeMessages, sentToFrames } = await driveOfficeReadRange({
    frames,
    request: { tool: 'light_document', action: 'read', offset: 0, limit: 20 },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') {
        if (message.type === 'office-spreadsheet/v1') return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/d/77' } } })
      }
      assert.equal(message.type, 'office-document/v1')
      return Promise.resolve({ ok: true, result: READ_RESULT })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(sentToFrames.some((entry) => entry.message.action === 'read'), true)
})

test('list_work_tabs reports the probed spreadsheet identity instead of a hardcoded null', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/1' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/392' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/392-preload' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'list_work_tabs', range: undefined },
    sendMessageBehavior: (message, options) => {
      assert.equal(message.action, 'probe', 'context must only probe frames, never operate')
      if (message.type === 'office-spreadsheet/v1') {
        if (options.frameId === 5) return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/392', workbookName: null, sheetName: 'Sheet1', hasContent: true } } })
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/preload', workbookName: null, sheetName: 'Sheet1', hasContent: null } } })
      }
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
    },
  })
  assert.equal(sentToFrames.length, 6, 'one quick probe per frame across the three Office channels, no waiting sweep')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result.documentIdentity, { kind: 'webedit_spreadsheet', workbookName: null, sheetName: 'Sheet1', hasContent: true, webeditFrames: 2 })
  assert.deepEqual(response.result.pages[0].documentIdentity, { kind: 'webedit_spreadsheet', workbookName: null, sheetName: 'Sheet1', hasContent: true, webeditFrames: 2 })
})

test('list_work_tabs prefers a ready light document over a blank preloaded spreadsheet', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2089336886234255362' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/o/2089336886234255362' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/preload' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'list_work_tabs', range: undefined },
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

test('list_work_tabs prefers a /office/p/ presentation resource over a spreadsheet shell false positive', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/99' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/99' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'list_work_tabs', range: undefined },
    sendMessageBehavior: (message) => {
      assert.equal(message.action, 'probe')
      if (message.type === 'office-spreadsheet/v1') {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/p/99', workbookName: 'outer-shell.xlsx', hasContent: true } } })
      }
      if (message.type === 'office-presentation/v1') {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', documentName: '路线图.pptx', path: '/weboffice/office/p/99', slideCount: 3, fingerprint: 'ppt-99' } } })
      }
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
    },
  })
  assert.equal(sentToFrames.length, 3, 'the identity sweep must probe document, spreadsheet, and presentation runtimes')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result.documentIdentity, { kind: 'webedit_presentation', presentationName: '路线图.pptx', slideCount: 3, hasContent: null, webeditFrames: 1 })
})

test('list_work_tabs recognizes an empty presentation when only its frame URL exposes /office/p/', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/101' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/101' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'list_work_tabs', range: undefined },
    sendMessageBehavior: (message) => {
      assert.equal(message.action, 'probe')
      if (message.type === 'office-spreadsheet/v1') {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/moewebv7/document-cloud', workbookName: 'outer-shell.xlsx', sheetName: 'Sheet1', hasContent: true } } })
      }
      if (message.type === 'office-presentation/v1') {
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '空白演示.pptx', path: '/moewebv7/document-cloud', slideCount: 0, fingerprint: 'ppt-101' } } })
      }
      return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result.documentIdentity, { kind: 'webedit_presentation', presentationName: '空白演示.pptx', slideCount: 0, hasContent: null, webeditFrames: 1 })
  assert.deepEqual(response.result.pages[0].documentIdentity, { kind: 'webedit_presentation', presentationName: '空白演示.pptx', slideCount: 0, hasContent: null, webeditFrames: 1 })
})

test('read_work_tab reads a detected presentation through its presentation iframe', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/100' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/100' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'read_work_tab', tab: 1 },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') {
        if (message.type === 'office-presentation/v1') {
          return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '路线图.pptx', path: '/weboffice/office/p/100', slideCount: 2, fingerprint: 'ppt-100' } } })
        }
        return Promise.resolve({ ok: true, result: { status: 'probe', ready: false } })
      }
      assert.deepEqual(message, { type: 'office-presentation/v1', action: 'get_context' })
      return Promise.resolve({ ok: true, result: { objects: [{ text: '第一张：路线图' }] } })
    },
  })
  assert.ok(sentToFrames.some((entry) => entry.message.type === 'office-presentation/v1' && entry.message.action === 'get_context'))
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.equal(response.result.kind, 'webedit_presentation')
  assert.match(response.result.content, /第一张：路线图/)
})

test('heals a presentation iframe and forwards the presentation request unchanged', async () => {
  const missingReceiver = new Error('Could not establish connection. Receiving end does not exist.')
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '路线图.pptx', path: '/weboffice/office/p/101', slideCount: 2, fingerprint: 'ppt-101' }
  let probes = 0
  const { injections, sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames: [
      { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/101' },
      { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/101' },
    ],
    request: { tool: 'presentation', action: 'write', offset: undefined, limit: undefined, operation: 'manage_objects', payload: { objects: [] }, resource, precondition: { resourceFingerprint: 'ppt-101', slideCount: 2 } },
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') {
        probes += 1
        return probes === 1 ? Promise.reject(missingReceiver) : Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      }
      assert.equal(options.frameId, 5)
      return Promise.resolve({ ok: true, result: { status: 'verified_write', resource, observed: { verified: true } } })
    },
  })
  assert.equal(probes, 2)
  assert.deepEqual(injections, [{ target: { tabId: 42, frameIds: [5] }, files: ['content-scripts/office-read.js'] }])
  const forwarded = sentToFrames.find((entry) => entry.message.action === 'write')
  assert.deepEqual(forwarded.message, { type: 'office-presentation/v1', action: 'write', operation: 'manage_objects', payload: { objects: [] }, resource, precondition: { resourceFingerprint: 'ppt-101', slideCount: 2 } })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
})

test('binds a presentation preview to its resource and commits only to that same ready iframe', async () => {
  const previewResource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '预算.pptx', documentId: '202', path: '/weboffice/office/p/202', slideCount: 2, fingerprint: 'ppt-202' }
  const otherResource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '路线图.pptx', documentId: '201', path: '/weboffice/office/p/201', slideCount: 3, fingerprint: 'ppt-201' }
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/202' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/p/202' },
  ]
  const mutations = []
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    requests: [
      { tool: 'presentation', action: 'inspect_write', operation: 'manage_objects', payload: { objects: [] } },
      { tool: 'presentation', action: 'get_context' },
      { tool: 'presentation', action: 'write', operation: 'manage_objects', payload: { objects: [] }, resource: previewResource, precondition: { resourceFingerprint: 'ppt-202', slideCount: 2 } },
    ],
    sendMessageBehavior: (message, options) => {
      const resource = options.frameId === 6 ? previewResource : otherResource
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      if (message.action === 'inspect_write') {
        // The preview has bound frame 6. A second ready presentation appears
        // before commit, reproducing the route-order bug without model input.
        frames.splice(1, 0, { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/201' })
        assert.equal(options.frameId, 6)
        return Promise.resolve({ ok: true, result: { status: 'ok', resource: previewResource, precondition: { resourceFingerprint: 'ppt-202', slideCount: 2 } } })
      }
      if (message.action === 'get_context') {
        assert.equal(options.frameId, 6, 'subsequent reads must stay on the presentation frame bound by the preview')
        return Promise.resolve({ ok: true, result: { status: 'ok', resource: previewResource, slideCount: 2 } })
      }
      if (message.action === 'write') {
        mutations.push(options.frameId)
        assert.equal(options.frameId, 6, 'commit must use the iframe selected by the preview resource, not frame order')
        return Promise.resolve({ ok: true, result: { status: 'verified_write', resource: { ...previewResource, fingerprint: 'ppt-202-after' }, observed: { verified: true } } })
      }
      throw new Error(`unexpected presentation action: ${message.action}`)
    },
  })
  assert.deepEqual(mutations, [6])
  const responses = nativeMessages.filter((message) => message.type === 'connector_response')
  assert.equal(responses.length, 3)
  assert.equal(responses[0].error, undefined)
  assert.equal(responses[1].error, undefined)
  assert.equal(responses[2].error, undefined)
})

test('routes an empty presentation first-slide preview and commit with its zero-slide identity intact', async () => {
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '空白演示.pptx', documentId: '204', path: '/weboffice/office/p/204', slideCount: 0, fingerprint: 'ppt-empty-204' }
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/204' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/204' },
  ]
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    requests: [
      { tool: 'presentation', action: 'inspect_write', operation: 'manage_slides', payload: { action: 'add', index: -1 } },
      { tool: 'presentation', action: 'write', operation: 'manage_slides', payload: { action: 'add', index: -1 }, resource, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 0 } },
    ],
    sendMessageBehavior: (message, options) => {
      assert.equal(options.frameId, 5)
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      if (message.action === 'inspect_write') return Promise.resolve({ ok: true, result: { status: 'ok', resource, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 0 } } })
      assert.equal(message.type, 'office-presentation/v1')
      assert.equal(message.action, 'write')
      assert.equal(message.operation, 'manage_slides')
      assert.deepEqual(message.payload, { action: 'add', index: -1 })
      assert.deepEqual(message.resource, resource)
      assert.deepEqual(message.precondition, { resourceFingerprint: resource.fingerprint, slideCount: 0 })
      return Promise.resolve({ ok: true, result: { status: 'verified_write', resource: { ...resource, slideCount: 1, fingerprint: 'ppt-empty-204-after-add' }, observed: { verified: true } } })
    },
  })
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'write').length, 1)
  const responses = nativeMessages.filter((message) => message.type === 'connector_response')
  assert.equal(responses.length, 2)
  assert.equal(responses[0].error, undefined)
  assert.equal(responses[1].error, undefined)
})

test('refuses a presentation commit when no ready iframe matches its approved resource', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/203' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/201' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/p/202' },
  ]
  const resources = {
    5: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '路线图.pptx', documentId: '201', path: '/weboffice/office/p/201', slideCount: 3, fingerprint: 'ppt-201' },
    6: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '预算.pptx', documentId: '202', path: '/weboffice/office/p/202', slideCount: 2, fingerprint: 'ppt-202' },
  }
  const mutations = []
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'presentation', action: 'write', operation: 'save', payload: {}, resource: { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '不存在.pptx', documentId: '203', path: '/weboffice/office/p/203', slideCount: 1, fingerprint: 'ppt-203' }, precondition: { resourceFingerprint: 'ppt-203', slideCount: 1 } },
    sendMessageBehavior: (message, options) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource: resources[options.frameId] } })
      mutations.push(options.frameId)
      return Promise.resolve({ ok: true, result: { status: 'verified_write', resource: resources[options.frameId], observed: { verified: true } } })
    },
  })
  assert.deepEqual(mutations, [], 'a wrong presentation target must fail before any mutation API is invoked')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'context_mismatch')
  assert.match(response.error.message, /No ready presentation iframe matches the approved Resource Identity/)
})

test('forwards presentation capability inspection without model-controlled target fields', async () => {
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '路线图.pptx', path: '/weboffice/office/p/102', slideCount: 2, fingerprint: 'ppt-102' }
  const capabilities = { ready: true, capabilities: { context: true }, methods: [], operations: { save: { actions: ['save'] } }, resource }
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames: [
      { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/102' },
      { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/102' },
    ],
    request: { tool: 'presentation', action: 'inspect_capabilities', offset: undefined, limit: undefined },
    sendMessageBehavior: (message, options) => {
      assert.equal(options.frameId, 5)
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      assert.deepEqual(message, { type: 'office-presentation/v1', action: 'inspect_capabilities' })
      return Promise.resolve({ ok: true, result: capabilities })
    },
  })
  const forwarded = sentToFrames.find((entry) => entry.message.action === 'inspect_capabilities')
  assert.deepEqual(forwarded.message, { type: 'office-presentation/v1', action: 'inspect_capabilities' })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
  assert.deepEqual(response.result, capabilities)
})

test('forwards spreadsheet write preconditions without dropping the verified-write fence', async () => {
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-101' }
  const precondition = { version: 2, targets: [{ range: 'A1', state: { values: [[1]] } }], resourceFingerprint: 'sheet-101' }
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    request: { tool: 'spreadsheet', action: 'write', offset: undefined, limit: undefined, operation: 'set_values', payload: { range: 'A1', values: [[42]] }, resource, precondition },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/101', workbookName: '预算.xlsx', sheetName: 'Sheet1', hasContent: true } } })
      if (message.action === 'context') return Promise.resolve({ ok: true, result: { status: 'ok', resource } })
      return Promise.resolve({ ok: true, result: { status: 'verified_write', resource, observed: { verified: true } } })
    },
  })
  const forwarded = sentToFrames.find((entry) => entry.message.action === 'write')
  assert.deepEqual(forwarded.message, { type: 'office-spreadsheet/v1', action: 'write', operation: 'set_values', payload: { range: 'A1', values: [[42]] }, resource, precondition })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `expected success, got ${JSON.stringify(response.error)}`)
})

test('preserves bounded spreadsheet write_incomplete details from the WebEdit frame', async () => {
  const resource = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-102' }
  const details = { operation: 'add_comment', observed: { range: { address: 'A1', comment: { text: '旧批注', author: '李四' } } }, rollbackComplete: false }
  const { nativeMessages } = await driveOfficeReadRange({
    request: { tool: 'spreadsheet', action: 'write', operation: 'add_comment', payload: { range: 'A1', text: '新批注' }, resource, precondition: { version: 2, resourceFingerprint: resource.fingerprint } },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/s/102', workbookName: '预算.xlsx', sheetName: 'Sheet1', hasContent: true } } })
      if (message.action === 'context') return Promise.resolve({ ok: true, result: { status: 'ok', resource } })
      return Promise.resolve({ ok: false, error: { code: 'write_incomplete', message: 'The comment write could not be fully read back.', details } })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.deepEqual(response.error, { code: 'write_incomplete', message: 'The comment write could not be fully read back.', details })
})

test('binds a spreadsheet preview to its Resource Identity when a preferred sibling appears before commit', async () => {
  const spreadsheetB = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-B' }
  const spreadsheetA = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '空白.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-A' }
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/204' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/204' },
  ]
  const mutations = []
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    requests: [
      { tool: 'spreadsheet', action: 'inspect_write', operation: 'set_values', payload: { range: 'A1', values: [[42]] } },
      { tool: 'spreadsheet', action: 'context' },
      { tool: 'spreadsheet', action: 'write', operation: 'set_values', payload: { range: 'A1', values: [[42]] }, resource: spreadsheetB, precondition: { version: 2, resourceFingerprint: 'sheet-B' } },
    ],
    sendMessageBehavior: (message, options) => {
      const resource = options.frameId === 6 ? spreadsheetB : spreadsheetA
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: `/weboffice/office/s/${options.frameId}`, workbookName: resource.workbookName, sheetName: resource.sheetName, hasContent: options.frameId === 5 } } })
      if (message.action === 'context') return Promise.resolve({ ok: true, result: { status: 'ok', resource } })
      if (message.action === 'inspect_write') {
        assert.equal(options.frameId, 6)
        frames.splice(1, 0, { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/preferred-now' })
        return Promise.resolve({ ok: true, result: { status: 'ok', resource: spreadsheetB, precondition: { version: 2, resourceFingerprint: 'sheet-B' } } })
      }
      if (message.action === 'write') {
        mutations.push(options.frameId)
        assert.equal(options.frameId, 6)
        return Promise.resolve({ ok: true, result: { status: 'verified_write', resource: { ...spreadsheetB, fingerprint: 'sheet-B-after' }, observed: { verified: true } } })
      }
      throw new Error(`unexpected spreadsheet action: ${message.action}`)
    },
  })
  assert.deepEqual(mutations, [6])
  assert.equal(nativeMessages.filter((message) => message.type === 'connector_response').every((message) => message.error === undefined), true)
})

test('uses the post-transition spreadsheet Resource Identity for the next same-target read', async () => {
  const sheet1 = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '预算.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-1' }
  const sheet2 = { ...sheet1, sheetName: 'Sheet2', fingerprint: 'sheet-2' }
  const other = { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: '其他.xlsx', sheetName: 'Sheet1', fingerprint: 'other-1' }
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/206' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/206-main' },
  ]
  let transitioned = false
  const { sentToFrames, nativeMessages } = await driveOfficeReadRange({
    frames,
    requests: [
      { tool: 'spreadsheet', action: 'context' },
      { tool: 'spreadsheet', action: 'inspect_write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' } },
      { tool: 'spreadsheet', action: 'write', operation: 'activate_worksheet', payload: { sheetName: 'Sheet2' }, resource: sheet1, precondition: { version: 2, resourceFingerprint: sheet1.fingerprint } },
      { tool: 'spreadsheet', action: 'context' },
    ],
    sendMessageBehavior: (message, options) => {
      const resource = options.frameId === 5 ? (transitioned ? sheet2 : sheet1) : other
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: `/weboffice/office/s/${options.frameId}`, workbookName: resource.workbookName, sheetName: resource.sheetName, hasContent: true } } })
      if (message.action === 'context') return Promise.resolve({ ok: true, result: { status: 'ok', resource } })
      if (message.action === 'inspect_write') {
        assert.equal(options.frameId, 5)
        frames.push({ frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/206-other' })
        return Promise.resolve({ ok: true, result: { status: 'ok', resource: sheet1, precondition: { version: 2, resourceFingerprint: sheet1.fingerprint } } })
      }
      if (message.action === 'write') {
        assert.equal(options.frameId, 5)
        transitioned = true
        return Promise.resolve({ ok: true, result: { status: 'verified_write', resource: sheet2, operation: 'activate_worksheet', observed: { verified: true } } })
      }
      throw new Error(`unexpected spreadsheet action: ${message.action}`)
    },
  })
  assert.equal(nativeMessages.filter((message) => message.type === 'connector_response').every((message) => message.error === undefined), true)
  const contextsAfterTransition = sentToFrames.filter((entry) => entry.message.action === 'context').slice(-1)
  assert.equal(contextsAfterTransition[0].options.frameId, 5, 'the next read must use the committed Sheet2 binding, not the sibling workbook')
  const responses = nativeMessages.filter((message) => message.type === 'connector_response')
  assert.equal(responses.at(-1).result.resource.sheetName, 'Sheet2')
})

test('refuses spreadsheet commit before mutation when the approved Resource Identity is absent', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/205' },
    { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/s/205-a' },
    { frameId: 6, url: 'https://webedit.midea.com/weboffice/office/s/205-b' },
  ]
  const resources = {
    5: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'A.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-A' },
    6: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'B.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-B' },
  }
  const mutations = []
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'spreadsheet', action: 'write', operation: 'set_values', payload: { range: 'A1', values: [[42]] }, resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'C.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-C' }, precondition: { version: 2, resourceFingerprint: 'sheet-C' } },
    sendMessageBehavior: (message, options) => {
      const resource = resources[options.frameId]
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, identity: { path: `/weboffice/office/s/${options.frameId}`, workbookName: resource.workbookName, sheetName: resource.sheetName, hasContent: true } } })
      if (message.action === 'context') return Promise.resolve({ ok: true, result: { status: 'ok', resource } })
      mutations.push(options.frameId)
      return Promise.resolve({ ok: true, result: { status: 'verified_write', resource, observed: { verified: true } } })
    },
  })
  assert.deepEqual(mutations, [])
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error.code, 'context_mismatch')
})

test('list_work_tabs keeps null only when no webedit frame answers ready', async () => {
  const frames = [
    { frameId: 0, url: 'https://doc.midea.com/some/page' },
    { frameId: 5, url: 'https://webedit.midea.com/booting' },
  ]
  const { nativeMessages } = await driveOfficeReadRange({
    frames,
    request: { tool: 'list_work_tabs', range: undefined },
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
    request: { tool: 'light_document', action: 'read', offset: 0, limit: 20 },
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
  assert.match(response.error.message, /did not finish the light-document editor operation within 0\.2s/)
})

test('keeps a slow presentation write alive past the read budget and below the Native deadline', async () => {
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '长写入.pptx', documentId: '300', path: '/weboffice/office/p/300', slideCount: 2, fingerprint: 'ppt-300' }
  const startedAt = Date.now()
  const { nativeMessages } = await driveOfficeReadRange({
    frames: [
      { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/300' },
      { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/300' },
    ],
    responseWaitMs: 11_000,
    request: { tool: 'presentation', action: 'write', operation: 'save', payload: {}, resource, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 2 } },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      if (message.action === 'write') return new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: { status: 'verified_write', resource: { ...resource, fingerprint: 'ppt-300-after' }, observed: { verified: true } } }), 8_250))
      throw new Error(`unexpected action: ${message.action}`)
    },
  })
  assert.ok(Date.now() - startedAt >= 8_000, 'the regression must exercise a write that outlives the 8s read budget')
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.equal(response.error, undefined, `the outer frame budget must not report a timeout while the write completes: ${JSON.stringify(response.error)}`)
})

test('preserves bounded post-mutation presentation failure details instead of flattening them', async () => {
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '不完整写入.pptx', documentId: '301', path: '/weboffice/office/p/301', slideCount: 2, fingerprint: 'ppt-301' }
  const details = { deletedCount: 2, totalOldShapes: 3, createdCount: 1, rollbackComplete: false }
  const { nativeMessages } = await driveOfficeReadRange({
    frames: [
      { frameId: 0, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/301' },
      { frameId: 5, url: 'https://webedit.midea.com/weboffice/office/p/301' },
    ],
    request: { tool: 'presentation', action: 'write', operation: 'render_scene', payload: { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'x', left: 1, top: 1, width: 1, height: 1 }] }, resource, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 2 } },
    sendMessageBehavior: (message) => {
      if (message.action === 'probe') return Promise.resolve({ ok: true, result: { status: 'probe', ready: true, resource } })
      return Promise.resolve({ ok: false, error: { code: 'write_incomplete', message: 'render_scene rollback could not restore the original slide', details } })
    },
  })
  const response = nativeMessages.find((message) => message.type === 'connector_response')
  assert.deepEqual(response.error, { code: 'write_incomplete', message: 'render_scene rollback could not restore the original slide', details })
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
  assert.equal(sentToFrames.filter((entry) => entry.message.action === 'read').length, 1, 'exactly one real read must be sent')
})
