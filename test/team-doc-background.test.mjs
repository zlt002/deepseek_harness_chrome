import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const target = { browser: 'chrome', windowId: 7, tabId: 42, url: 'https://doc.midea.com/teamKnowledge/catalog/9007199254740993' }
const parent = { parentId: '9007199254740993', bookId: '9007199254740994', parentName: 'Root', canRead: true, canCreate: true, fingerprint: 'team-doc-parent-v1-abc12345' }
const detailDocumentId = '9007199254740995'
const detailParentId = '9007199254740991'
const detailBookId = '9007199254740990'
const detailTarget = { browser: 'chrome', windowId: 7, tabId: 42, url: `https://doc.midea.com/teamKnowledge/detail/docOnline/${detailDocumentId}?id=${detailDocumentId}` }
const sourceDocumentPath = '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/get'
const legacyListPath = '/g-kmp/team-knowledge-main/teamKnowledgeCatalog/getListByParentId'
const openApiListPath = '/g-kmp/team-knowledge-main/openApi/teamKnowledgeCatalog/getListByParentId'

function assertOpenApiListRequest(call) {
  assert.equal(call.url, openApiListPath)
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.credentials, 'include')
  const headers = Object.fromEntries(Object.entries(call.options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['businesssystem'], 'TEAM_KNOWLEDGE_BOOK')
  assert.deepEqual(JSON.parse(call.options.body), { bookId: parent.bookId, parentId: parent.parentId })
}

function assertBusinessSystemHeader(options) {
  const headers = Object.fromEntries(Object.entries(options?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  assert.equal(headers.businesssystem, 'TEAM_KNOWLEDGE_BOOK')
}

async function loadBackground({ execute = async ({ func }) => func.name === 'inspectTeamDocParentInPage' ? { ok: true, parent } : null, sendMessage = async () => ({ ok: false }), initialTab = target } = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  let runtimeListener; const nativeMessages = []; const nativeListeners = new Set(); const executions = []
  const tab = { id: initialTab.tabId, windowId: initialTab.windowId, url: initialTab.url, title: 'Team Knowledge', status: 'complete' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: (listener) => nativeListeners.add(listener), removeListener: (listener) => nativeListeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-team-doc' } }))) },
  }
  const localStorage = {}
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: {
      session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} },
      local: { get: async (key) => ({ [key]: localStorage[key] }), set: async (value) => { Object.assign(localStorage, value) } },
    },
    windows: { getLastFocused: async () => ({ id: target.windowId }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async () => [tab], get: async (tabId) => { if (tabId !== tab.id) throw new Error('tab not found'); return { ...tab } },
      update: async (tabId, update) => { if (tabId !== tab.id) throw new Error('tab not found'); if (typeof update.url === 'string') tab.url = update.url; tab.status = 'complete'; return { ...tab } },
      sendMessage,
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    scripting: { executeScript: async (request) => { executions.push(request); return [{ result: await execute(request, tab) }] } },
    webNavigation: { getAllFrames: async () => tab.url === target.url ? [{ frameId: 0, url: tab.url }] : [{ frameId: 0, url: tab.url }, { frameId: 17, url: 'https://webedit.midea.com/weboffice/office/w/1' }] },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#team-doc-background-${Date.now()}-${Math.random()}`)
  await new Promise((resolve, reject) => { const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (open !== true) reject(new Error('ensure-harness did not retain the response channel')) })
  const sendNative = async (request) => {
    nativeListeners.forEach((listener) => listener(request))
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = nativeMessages.findLast((message) => message.type === 'connector_response' && message.requestId === request.requestId)
      if (response) return response
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return undefined
  }
  return { executions, localStorage, sendNative, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground } }
}

const inspectRequest = (overrides = {}) => ({ type: 'connector_request', requestId: 'inspect-1', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_doc_create', phase: 'inspect', ...overrides })
const createRequest = (overrides = {}) => ({ type: 'connector_request', requestId: 'create-1', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_doc_create', phase: 'create', parent, idempotencyIdentity: 'delivery-1', name: 'Migrated document', body: '# Migrated document\n', ...overrides })
const teamKnowledgeParent = { ...parent, parentType: 'directory' }
const itemRequest = (overrides = {}) => ({ type: 'connector_request', requestId: 'item-1', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_knowledge_item', action: 'create', parent: teamKnowledgeParent, kind: 'light_document', idempotencyIdentity: 'item-1', name: 'Child', body: '# Child', ...overrides })

test('validates Native team-doc requests and rejects Run/Browser Target drift before MAIN-world execution', async () => {
  const harness = await loadBackground()
  try {
    assert.equal(await harness.sendNative(inspectRequest({ requestId: 'malformed', phase: 'unknown' })), undefined)
    assert.equal(harness.executions.length, 0)
    const drifted = await harness.sendNative(inspectRequest({ requestId: 'drift', browserTarget: { ...target, tabId: 99 } }))
    assert.ok(drifted?.error); assert.equal(harness.executions.length, 0)
  } finally { harness.cleanup() }
})

test('creates a child light document only after the verified parent, rediscovery, and same-WebEdit body readback', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Child' }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest())
    assert.equal(response.result.status, 'verified_write')
    assert.equal(response.result.item.catalogId, '9007199254740995')
    assert.deepEqual(response.result.stages, ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'])
    assert.equal(response.result.readback.body, 'Child')
  } finally { harness.cleanup() }
})

test('persists the remote-create checkpoint before readback so a typed retry rediscoveries instead of creating again', async () => {
  let creates = 0; let rediscoveries = 0; let writes = 0
  const createdUrl = 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995'
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') { creates += 1; return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: createdUrl } }
    if (func.name === 'rediscoverTeamDocInPage') { rediscoveries += 1; assert.equal(args[0].kind, 'light_document'); return { ok: true, documentId: '9007199254740995', catalogId: '9007199254740995', url: createdUrl } }
    if (func.name === 'writeTeamDocInWebEdit') { writes += 1; return writes === 1 ? { ok: false, readbackMatches: false, error: 'lost_after_create' } : { ok: true, readbackMatches: true, observedBody: 'Child' } }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const first = await harness.sendNative(itemRequest({ requestId: 'checkpoint-first', idempotencyIdentity: 'checkpoint-item' }))
    assert.equal(first.result.status, 'partial_delivery')
    const retry = await harness.sendNative(itemRequest({ requestId: 'checkpoint-retry', idempotencyIdentity: 'checkpoint-item' }))
    assert.equal(retry.result.status, 'verified_write')
    assert.equal(creates, 1); assert.equal(rediscoveries, 1)
    assert.equal(JSON.stringify(harness.localStorage).includes('# Child'), false)
  } finally { harness.cleanup() }
})

test('creates a child spreadsheet only when its default sheet identity can be read back', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  let listCalls = 0
  let createPayload
  globalThis.location = new URL(target.url)
  globalThis.document = { referrer: '' }
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/openApi/teamKnowledgeCatalog/getListByParentId')) {
      listCalls += 1
      return new Response(JSON.stringify({ errorCode: '00000', data: listCalls === 1 ? [] : [{ catalogId: '9007199254740996', name: 'Child sheet', fileType: 8, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740996?id=9007199254740996' }] }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/getAllFileType')) return new Response(JSON.stringify({ errorCode: '00000', data: [{ type: 4, value: 'newword' }, { type: 8, value: 'newexcel' }] }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/add')) {
      createPayload = JSON.parse(options.body)
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740996' } }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`)
  }
  const harness = await loadBackground({
    execute: async ({ func }) => {
      if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
      if (func.name === 'createTeamDocInPage') return func({ bookId: parent.bookId, parentId: parent.parentId, name: 'Child sheet', kind: 'spreadsheet' })
      throw new Error(`unexpected function ${func.name}`)
    },
    sendMessage: async (_tabId, message) => {
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true } }
      assert.deepEqual(message, { type: 'office-read-range/v1', range: 'A1' })
      return { ok: true, result: { status: 'ok', resource: { kind: 'webedit_spreadsheet', origin: 'https://webedit.midea.com', workbookName: 'Child.xlsx', sheetName: 'Sheet1', fingerprint: 'sheet-1' }, range: { address: 'Sheet1!A1' } } }
    },
  })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'item-sheet', kind: 'spreadsheet', name: 'Child sheet', body: '' }))
    assert.equal(response.result.status, 'verified_write')
    assert.deepEqual(response.result.stages, ['parent_inspected', 'created', 'rediscovered', 'identity_readback_verified'])
    assert.equal(response.result.readback.resource.sheetName, 'Sheet1')
    assert.deepEqual(createPayload, { bookId: parent.bookId, parentId: parent.parentId, fileName: 'Child sheet', fileType: 8 })
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})

test('rejects a child spreadsheet when same-parent rediscovery reports the wrong dynamic file type', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  let listCalls = 0
  globalThis.location = new URL(target.url)
  globalThis.document = { referrer: '' }
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/openApi/teamKnowledgeCatalog/getListByParentId')) {
      listCalls += 1
      return new Response(JSON.stringify({ errorCode: '00000', data: listCalls === 1 ? [] : [{ catalogId: '9007199254740997', name: 'Wrong type', fileType: 4 }] }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/getAllFileType')) return new Response(JSON.stringify({ errorCode: '00000', data: [{ type: 4, value: 'newword' }, { type: 8, value: 'newexcel' }] }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/add')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740997' } }), { status: 200 })
    throw new Error(`unexpected fetch ${parsed.pathname}`)
  }
  let readbacks = 0
  const harness = await loadBackground({
    execute: async ({ func }) => {
      if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
      if (func.name === 'createTeamDocInPage') return func({ bookId: parent.bookId, parentId: parent.parentId, name: 'Wrong type', kind: 'spreadsheet' })
      throw new Error(`unexpected function ${func.name}`)
    },
    sendMessage: async (_tabId, message) => { readbacks += 1; return message.action === 'probe' ? { ok: true, result: { status: 'probe', ready: true } } : { ok: true } },
  })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'item-wrong-type', kind: 'spreadsheet', name: 'Wrong type', body: '' }))
    assert.equal(response.result.status, 'partial_delivery')
    assert.equal(response.result.failedAt, 'rediscover')
    assert.equal(response.result.error, 'team_knowledge_item_type_mismatch')
    assert.equal(readbacks, 0)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})

test('does not verify a spreadsheet when the post-create frame reads back a light-document resource', async () => {
  const harness = await loadBackground({
    execute: async ({ func }) => {
      if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
      if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740998', documentId: '9007199254740998', kind: 'spreadsheet', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740998?id=9007199254740998' }
      throw new Error(`unexpected function ${func.name}`)
    },
    sendMessage: async (_tabId, message) => {
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true } }
      return { ok: true, result: { status: 'ok', resource: { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: 'Wrong page', fingerprint: 'doc-1' } } }
    },
  })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'item-wrong-readback', kind: 'spreadsheet', name: 'Wrong page', body: '' }))
    assert.equal(response.result.status, 'partial_delivery')
    assert.equal(response.result.failedAt, 'unsupported')
    assert.equal(response.result.error, 'team_knowledge_spreadsheet_identity_unavailable')
  } finally { harness.cleanup() }
})

test('keeps a generic child item partial when the create API returns HTTP 200 with a business error', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') return { ok: false, failedAt: 'create', error: 'team_knowledge_create_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'item-business-failure', kind: 'spreadsheet', name: 'Child sheet', body: '' }))
    assert.deepEqual(response.result, { status: 'partial_delivery', item: null, stages: ['parent_inspected'], failedAt: 'create', error: 'team_knowledge_create_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } })
  } finally { harness.cleanup() }
})

test('keeps a directory URL bound to that directory without document-parent lookup', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    calls.push(parsed.pathname + parsed.search)
    if (parsed.pathname.endsWith('/teamKnowledge/get')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: parent.parentId, name: parent.parentName, fileType: 11 } }))
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: parent.bookId } }))
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }))
    throw new Error(`unexpected directory inspect fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'directory-inspect' }))
    assert.equal(inspected.result.parent.parentId, parent.parentId)
    assert.equal(inspected.result.parent.parentName, parent.parentName)
    assert.equal(calls.some((call) => call.includes('/openApi/teamKnowledgeCatalog/get?')), false)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('refuses a non-directory catalog node before issuing any child-item create request', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledge/get')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: parent.parentId, name: 'A light document', fileType: 4 } }))
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: parent.bookId } }))
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }))
    throw new Error(`unexpected non-directory inspect fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const response = await harness.sendNative({ type: 'connector_request', requestId: 'item-non-directory', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_knowledge_item', action: 'inspect_parent' })
    assert.deepEqual(response.result, { status: 'partial_delivery', item: null, stages: [], failedAt: 'inspect', error: 'team_doc_directory_required' })
    assert.equal(harness.executions.map((request) => request.func.name).includes('createTeamDocInPage'), false)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('keeps HTTP success plus a Midea business error as Partial Delivery', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => func.name === 'inspectTeamDocParentInPage'
    ? { ok: true, parent }
    : { ok: false, failedAt: 'create', error: 'team_doc_create_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } } })
  try {
    const response = await harness.sendNative(createRequest())
    assert.deepEqual(response.result, { status: 'partial_delivery', documentId: null, stages: ['parent_inspected'], readbackMatches: false, failedAt: 'create', error: 'team_doc_create_failed', diagnostic: { httpStatus: 200, errorCode: '20001' } })
    assert.notEqual(response.result.status, 'verified_write')
  } finally { harness.cleanup() }
})

test('does not verify a create when same-parent rediscovery identity mismatches', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => func.name === 'inspectTeamDocParentInPage'
    ? { ok: true, parent }
    : { ok: false, failedAt: 'rediscover', error: 'team_doc_rediscover_mismatch', documentId: '9007199254740995', diagnostic: { httpStatus: 200, errorCode: '00000' } } })
  try {
    const response = await harness.sendNative(createRequest())
    assert.equal(response.result.status, 'partial_delivery'); assert.equal(response.result.failedAt, 'rediscover'); assert.equal(response.result.documentId, '9007199254740995')
  } finally { harness.cleanup() }
})

test('does not verify a WebEdit write when document body readback mismatches', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'createTeamDocInPage') return { ok: true, documentId: '9007199254740995', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    return { ok: false, failedAt: 'readback', error: 'team_doc_readback_mismatch', observedBody: 'different body' }
  } })
  try {
    const response = await harness.sendNative(createRequest())
    assert.equal(response.result.status, 'partial_delivery'); assert.equal(response.result.failedAt, 'readback'); assert.deepEqual(response.result.stages, ['parent_inspected', 'created', 'rediscovered']); assert.equal(response.result.readbackMatches, false)
  } finally { harness.cleanup() }
})

test('recovers only the recorded document id and preserves confirmed stages', async () => {
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'rediscoverTeamDocInPage') {
      assert.equal(args[0].documentId, '9007199254740995')
      return { ok: true, recovered: true, documentId: '9007199254740995', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    }
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const response = await harness.sendNative(createRequest({ requestId: 'recover-existing', recovery: {
      documentId: '9007199254740995', stages: ['parent_inspected', 'created'],
    } }))
    assert.equal(response.result.status, 'verified_write')
    assert.deepEqual(response.result.stages, ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'])
  } finally { harness.cleanup() }
})

test('uses OpenAPI children before create and again for post-create rediscovery', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  const calls = []
  globalThis.location = new URL(target.url)
  globalThis.document = { referrer: '' }
  let listCount = 0
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options }
    calls.push(call)
    if (call.url === openApiListPath) {
      listCount += 1
      const data = listCount === 1 ? [] : { page: { content: [{ catalogId: '9007199254740995', name: 'Migrated document' }] } }
      return new Response(JSON.stringify({ errorCode: '00000', data }), { status: 200 })
    }
    if (call.url.includes('/teamKnowledge/getAllFileType')) {
      return new Response(JSON.stringify({ errorCode: '00000', data: [{ type: 4, value: 'newword' }] }), { status: 200 })
    }
    if (call.url.includes('/teamKnowledge/add')) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740995' } }), { status: 200 })
    }
    if (call.url === legacyListPath) return new Response('not found', { status: 404 })
    throw new Error(`unexpected fetch: ${call.url}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'createTeamDocInPage') return func(...args)
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const response = await harness.sendNative(createRequest({ requestId: 'openapi-pre-post-create' }))
    assert.equal(response.result.status, 'verified_write')
    const listCalls = calls.filter((call) => call.url === openApiListPath)
    assert.equal(listCalls.length, 2)
    listCalls.forEach(assertOpenApiListRequest)
    assert.equal(calls.some((call) => call.url === legacyListPath), false)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})

test('checks for an exact-name conflict before calling the create endpoint', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  const calls = []
  globalThis.location = new URL(target.url)
  globalThis.document = { referrer: '' }
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options }
    calls.push(call)
    if (call.url === legacyListPath) return new Response('not found', { status: 404 })
    if (call.url === openApiListPath) return new Response(JSON.stringify({ errorCode: '00000', data: { records: [{ catalogId: '9007199254740998', name: 'Migrated document' }] } }), { status: 200 })
    throw new Error(`unexpected fetch: ${call.url}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage'
    ? { ok: true, parent }
    : func(...args) })
  try {
    const response = await harness.sendNative(createRequest({ requestId: 'exact-name-conflict' }))
    assert.equal(response.result.status, 'partial_delivery')
    assert.notEqual(response.result.error, 'team_doc_name_check_failed')
    assert.equal(response.result.error, 'team_doc_exact_name_conflict')
    assert.equal(response.result.documentId, null)
    assert.equal(calls.length, 1)
    assertOpenApiListRequest(calls[0])
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})

test('recovery page execution only rediscoveries the exact id and never posts create', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  let responseData = { list: [{ catalogId: '9007199254740995', name: 'Anything else' }] }
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', options })
    if (String(url) === legacyListPath) return new Response('not found', { status: 404 })
    if (String(url) === openApiListPath) return new Response(JSON.stringify({ errorCode: '00000', data: responseData }), { status: 200 })
    throw new Error(`unexpected fetch: ${String(url)}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'rediscoverTeamDocInPage') return func(...args)
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const record = { catalogId: '9007199254740995', name: 'Anything else' }
    const payloadVariants = [
      [{ label: 'array', data: [record] }],
      [{ label: 'records', data: { records: [record] } }],
      [{ label: 'list', data: { list: [record] } }],
      [{ label: 'items', data: { items: [record] } }],
      [{ label: 'content', data: { content: [record] } }],
      [{ label: 'rows', data: { rows: [record] } }],
      [{ label: 'page-records', data: { page: { records: [record] } } }],
      [{ label: 'page-list', data: { page: { list: [record] } } }],
    ].flat()
    for (const [index, variant] of payloadVariants.entries()) {
      responseData = variant.data
      const response = await harness.sendNative(createRequest({ requestId: `rediscover-only-${index}`, recovery: {
        documentId: '9007199254740995', stages: ['parent_inspected', 'created'],
      } }))
      assert.equal(response.result.status, 'verified_write', variant.label)
    }
    const listCalls = calls.filter((call) => call.method === 'POST')
    assert.equal(listCalls.length, payloadVariants.length)
    listCalls.forEach((call) => assertOpenApiListRequest(call))
    assert.equal(calls.some((call) => call.url === legacyListPath), false)
    assert.equal(calls.some((call) => call.url.includes('/teamKnowledge/add')), false)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('returns Verified Write only after create, same-parent rediscovery, WebEdit write, readback, and parent restoration', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'createTeamDocInPage') return { ok: true, documentId: '9007199254740995', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const response = await harness.sendNative(createRequest({ requestId: 'create-verified' }))
    assert.deepEqual(response.result, { status: 'verified_write', documentId: '9007199254740995', stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readbackMatches: true, observedBody: 'Migrated document' })
    assert.deepEqual(harness.executions.map((request) => request.func.name), ['inspectTeamDocParentInPage', 'createTeamDocInPage', 'writeTeamDocInWebEdit'])
  } finally { harness.cleanup() }
})

test('recovers an existing document without executing createTeamDocInPage again', async () => {
  let createCalls = 0
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent }
    if (func.name === 'createTeamDocInPage') {
      createCalls += 1
      return { ok: true, documentId: '9007199254740995', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    }
    if (func.name === 'rediscoverTeamDocInPage') return { ok: true, recovered: true, documentId: '9007199254740995', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
    return null
  } })
  try {
    const response = await harness.sendNative(createRequest({
      requestId: 'create-recovery',
      recovery: { documentId: '9007199254740995', stages: ['parent_inspected', 'created', 'rediscovered'] },
    }))
    assert.equal(response.result.status, 'verified_write')
    assert.equal(createCalls, 0, 'a recovery with a service-issued document identity must not create again')
    assert.deepEqual(harness.executions.map((request) => request.func.name), ['inspectTeamDocParentInPage', 'rediscoverTeamDocInPage', 'writeTeamDocInWebEdit'])
  } finally { harness.cleanup() }
})

test('resolves a detail-document URL to its real directory parent before create', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    calls.push({ path: parsed.pathname, search: parsed.search, options })
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, fileType: 'newword', name: 'Existing document' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, fileType: 'newword', name: 'Existing document' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailParentId, name: 'Real directory parent', fileType: 11 } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: detailBookId } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: '9007199254740988' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    }
    throw new Error(`unexpected inspect fetch: ${parsed.pathname}${parsed.search}`)
  }
  let createArgs
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return func(...args)
    if (func.name === 'createTeamDocInPage') {
      createArgs = args[0]
      return { ok: true, documentId: '9007199254740996', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740996?id=9007199254740996' }
    }
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'detail-inspect', browserTarget: detailTarget }))
    assert.equal(inspected.result.parent.parentId, detailParentId)
    assert.equal(inspected.result.parent.bookId, detailBookId)
    assert.equal(inspected.result.parent.parentName, 'Real directory parent')
    const created = await harness.sendNative(createRequest({ requestId: 'detail-create', browserTarget: detailTarget, parent: inspected.result.parent }))
    assert.equal(created.result.status, 'verified_write')
    assert.equal(createArgs.parentId, detailParentId)
    assert.equal(createArgs.bookId, detailBookId)
    const sourceLookup = calls.find((call) => call.path === sourceDocumentPath && call.search === `?catalogId=${detailDocumentId}`)
    assert.ok(sourceLookup)
    assertBusinessSystemHeader(sourceLookup.options)
    assert.ok(calls.some((call) => call.path.endsWith('/teamKnowledge/get') && call.search === `?catalogId=${detailParentId}`))
    assert.ok(calls.some((call) => call.path.endsWith('/teamKnowledgeCatalog/getBookId') && call.search === `?catalogId=${detailParentId}`))
    assert.ok(calls.some((call) => call.path.endsWith('/teamKnowledgeCatalog/getPermission') && call.search === `?catalogId=${detailParentId}`))
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('requires a directory parent for a detail-document URL and never enters create', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath && catalogId === detailDocumentId) {
      assertBusinessSystemHeader(options)
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, fileType: 'newword', name: 'Document without parent' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, fileType: 'newword', name: 'Document without parent' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: '9007199254740988' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    }
    throw new Error(`unexpected inspect fetch: ${parsed.pathname}${parsed.search}`)
  }
  let createCalls = 0
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return func(...args)
    if (func.name === 'createTeamDocInPage') {
      createCalls += 1
      return { ok: true, documentId: '9007199254740996', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740996?id=9007199254740996' }
    }
    return { ok: true, readbackMatches: true, observedBody: 'Migrated document' }
  } })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'detail-missing-parent', browserTarget: detailTarget }))
    assert.equal(inspected.result.error, 'team_doc_directory_required')
    assert.equal(harness.executions.some((request) => request.func.name === 'createTeamDocInPage'), false)
    const attemptedCreate = await harness.sendNative(createRequest({ requestId: 'detail-missing-parent-create', browserTarget: detailTarget, parent: {
      parentId: detailDocumentId, bookId: '9007199254740988', parentName: 'Document without parent', canRead: true, canCreate: true, fingerprint: 'wrong-document-parent',
    } }))
    assert.equal(attemptedCreate.result.error, 'team_doc_directory_required')
    assert.equal(createCalls, 0)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('falls back to the internal source lookup when docOnline OpenAPI lookup fails', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    calls.push(parsed.pathname + parsed.search)
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath) return new Response(JSON.stringify({ errorCode: '20001', errorMsg: 'do-not-expose' }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, name: 'Existing document' } }))
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailParentId, name: 'Fallback parent', fileType: 11 } }))
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: detailBookId } }))
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }))
    throw new Error(`unexpected fallback fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'source-fallback', browserTarget: detailTarget }))
    assert.equal(inspected.result.parent.parentId, detailParentId)
    assert.equal(inspected.result.parent.parentName, 'Fallback parent')
    assert.ok(calls.includes(`/g-kmp/team-knowledge-main/teamKnowledge/get?catalogId=${detailDocumentId}`))
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('returns redacted staged diagnostics when both docOnline source lookups fail', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname === sourceDocumentPath) return new Response(JSON.stringify({ errorCode: '20001', errorMsg: 'SECRET-OPENAPI-BODY' }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/get')) return new Response(JSON.stringify({ errorCode: 'INTERNAL_DOWN', errorMsg: 'SECRET-INTERNAL-BODY' }), { status: 503 })
    throw new Error(`unexpected dual-failure fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'source-dual-failure', browserTarget: detailTarget }))
    assert.equal(inspected.result.error, 'team_doc_parent_inspection_failed')
    assert.deepEqual(inspected.result.diagnostic, {
      stage: 'source_internal', httpStatus: 503, errorCode: 'INTERNAL_DOWN',
      attempts: [
        { stage: 'source_openapi', httpStatus: 200, errorCode: '20001' },
        { stage: 'source_internal', httpStatus: 503, errorCode: 'INTERNAL_DOWN' },
      ],
    })
    assert.doesNotMatch(JSON.stringify(inspected.result), /SECRET/)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('recovers a docOnline parent node through OpenAPI and derives bookId from the verified source node', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    calls.push({ path: parsed.pathname, search: parsed.search, options })
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, bookId: detailBookId, fileType: 'newword', name: 'Existing document' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: 'NODE_INTERNAL_DOWN', errorMsg: 'do-not-expose-node' }), { status: 503 })
    }
    if (parsed.pathname === sourceDocumentPath && catalogId === detailParentId) {
      assertBusinessSystemHeader(options)
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailParentId, name: 'OpenAPI parent', bookId: detailBookId, fileType: 11 } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: 'BOOK_INTERNAL_DOWN', errorMsg: 'do-not-expose-book' }), { status: 503 })
    }
    throw new Error(`unexpected resolved-parent fallback fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'resolved-parent-fallback', browserTarget: detailTarget }))
    assert.equal(inspected.result.parent.parentId, detailParentId)
    assert.equal(inspected.result.parent.bookId, detailBookId)
    assert.equal(inspected.result.parent.parentName, 'OpenAPI parent')
    assert.equal(calls.filter((call) => call.path === sourceDocumentPath && call.search === `?catalogId=${detailParentId}`).length, 1)
    assert.equal(calls.filter((call) => call.path.endsWith('/teamKnowledge/get') && call.search === `?catalogId=${detailParentId}`).length, 1)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('rejects a resolved parent when its source bookId disagrees with the docOnline source bookId', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, bookId: detailBookId, fileType: 'newword', name: 'Existing document' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailParentId, name: 'Mismatched parent', bookId: '9007199254740999' } }), { status: 200 })
    }
    throw new Error(`unexpected source book mismatch fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'source-book-mismatch', browserTarget: detailTarget }))
    assert.equal(inspected.result.error, 'team_doc_parent_book_id_mismatch')
    assert.equal(inspected.result.diagnostic.stage, 'node_internal')
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('returns a permission diagnostic when permission fetch throws and does not produce an approval parent', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) throw new Error('SECRET_PERMISSION_FAILURE')
    if (parsed.pathname.endsWith('/teamKnowledge/get')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: parent.parentId, name: parent.parentName, bookId: parent.bookId } }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) return new Response(JSON.stringify({ errorCode: '00000', data: { bookId: parent.bookId } }), { status: 200 })
    throw new Error(`unexpected permission diagnostic fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'permission-throw' }))
    assert.equal(inspected.result.error, 'team_doc_parent_inspection_failed')
    assert.deepEqual(inspected.result.diagnostic, { stage: 'permission', httpStatus: 0, errorCode: null })
    assert.equal(inspected.result.parent, undefined)
    assert.doesNotMatch(JSON.stringify(inspected.result), /SECRET_PERMISSION_FAILURE/)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('returns redacted staged diagnostics when a docOnline parent node fails internally and through OpenAPI', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(detailTarget.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    const catalogId = parsed.searchParams.get('catalogId')
    if (parsed.pathname === sourceDocumentPath && catalogId === detailDocumentId) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: detailDocumentId, parentId: detailParentId, fileType: 'newword', name: 'Existing document' } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/get') && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: 'NODE_INTERNAL_DOWN', errorMsg: 'SECRET-NODE-INTERNAL' }), { status: 503 })
    }
    if (parsed.pathname === sourceDocumentPath && catalogId === detailParentId) {
      return new Response(JSON.stringify({ errorCode: 'NODE_OPENAPI_DOWN', errorMsg: 'SECRET-NODE-OPENAPI' }), { status: 502 })
    }
    throw new Error(`unexpected parent-node dual failure fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'parent-node-dual-failure', browserTarget: detailTarget }))
    assert.equal(inspected.result.error, 'team_doc_parent_inspection_failed')
    assert.deepEqual(inspected.result.diagnostic, {
      stage: 'node_openapi', httpStatus: 502, errorCode: 'NODE_OPENAPI_DOWN',
      attempts: [
        { stage: 'node_internal', httpStatus: 503, errorCode: 'NODE_INTERNAL_DOWN' },
        { stage: 'node_openapi', httpStatus: 502, errorCode: 'NODE_OPENAPI_DOWN' },
      ],
    })
    assert.doesNotMatch(JSON.stringify(inspected.result), /SECRET-NODE/)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('returns staged diagnostics when book lookup and verified-node derivation both fail', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/get')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: parent.parentId, name: parent.parentName } }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) return new Response(JSON.stringify({ errorCode: 'BOOK_INTERNAL_DOWN', errorMsg: 'SECRET-BOOK-INTERNAL' }), { status: 503 })
    throw new Error(`unexpected book derivation failure fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'book-derivation-dual-failure' }))
    assert.equal(inspected.result.error, 'team_doc_parent_inspection_failed')
    assert.deepEqual(inspected.result.diagnostic, {
      stage: 'book_derived', httpStatus: 0, errorCode: null,
      attempts: [
        { stage: 'book_internal', httpStatus: 503, errorCode: 'BOOK_INTERNAL_DOWN' },
        { stage: 'book_derived', httpStatus: 0, errorCode: null },
      ],
    })
    assert.doesNotMatch(JSON.stringify(inspected.result), /SECRET-BOOK-INTERNAL/)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('ignores a stale bookId payload when the internal book lookup is not successful', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledge/get')) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: parent.parentId, name: parent.parentName, bookId: parent.bookId, fileType: 11 } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getPermission')) {
      return new Response(JSON.stringify({ errorCode: '00000', data: { canRead: true, canAddOrUpload: true } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getBookId')) {
      return new Response(JSON.stringify({ errorCode: 'BOOK_INTERNAL_DOWN', data: { bookId: '9007199254740999' } }), { status: 503 })
    }
    throw new Error(`unexpected stale bookId fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'stale-book-id' }))
    assert.equal(inspected.result.parent.bookId, parent.bookId)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})

test('captures response.text failures and does not OpenAPI-fallback a directory URL', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const calls = []
  globalThis.location = new URL(target.url)
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    calls.push(parsed.pathname + parsed.search)
    if (parsed.pathname.endsWith('/teamKnowledge/get')) {
      return { ok: true, status: 200, text: async () => { throw new Error('SECRET_NODE_TEXT') } }
    }
    throw new Error(`unexpected directory text failure fetch: ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const inspected = await harness.sendNative(inspectRequest({ requestId: 'directory-node-text-failure' }))
    assert.equal(inspected.result.error, 'team_doc_parent_inspection_failed')
    assert.deepEqual(inspected.result.diagnostic, { stage: 'node_internal', httpStatus: 0, errorCode: null })
    assert.equal(calls.some((call) => call.includes('/openApi/teamKnowledgeCatalog/get')), false)
    assert.doesNotMatch(JSON.stringify(inspected.result), /SECRET_NODE_TEXT/)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})
