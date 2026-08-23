import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

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

async function loadBackground({ execute = async ({ func }) => func.name === 'inspectTeamDocParentInPage' ? { ok: true, parent } : null, sendMessage, initialTab = target, webeditLightDocument = false, webeditFrames, webeditProbeReadyAfter = 0, teamDocProbeWaitMs = 0, responseWaitAttempts = 200 } = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  let runtimeListener; const nativeMessages = []; const nativeListeners = new Set(); const executions = []
  const tab = { id: initialTab.tabId, windowId: initialTab.windowId, url: initialTab.url, title: 'Team Knowledge', status: 'complete' }
  const tabUpdates = []
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: (listener) => nativeListeners.add(listener), removeListener: (listener) => nativeListeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-team-doc' } }))) },
  }
  const localStorage = {}
  let webeditProbeCalls = 0
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
      update: async (tabId, update) => { if (tabId !== tab.id) throw new Error('tab not found'); tabUpdates.push({ ...update }); if (typeof update.url === 'string') tab.url = update.url; tab.status = 'complete'; return { ...tab } },
      sendMessage: async (tabId, message, options) => {
        if (webeditLightDocument && message?.action === 'probe') {
          webeditProbeCalls += 1
          return webeditProbeCalls > webeditProbeReadyAfter ? { ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/o/1' } } } : { ok: false }
        }
        if (sendMessage === undefined && message?.type === 'office-document/v1' && message?.action === 'probe' && options?.frameId === 17) {
          return { ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/o/1', hasContent: true } } }
        }
        return sendMessage?.(tabId, message, options) ?? { ok: false }
      },
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    scripting: { executeScript: async (request) => { executions.push(request); return [{ result: await execute(request, tab) }] } },
    webNavigation: { getAllFrames: async () => webeditFrames === undefined
      ? webeditLightDocument ? [{ frameId: 0, url: tab.url }, { frameId: 17, url: 'https://webedit.midea.com/weboffice/office/o/1' }] : tab.url === target.url ? [{ frameId: 0, url: tab.url }] : [{ frameId: 0, url: tab.url }, { frameId: 17, url: 'https://webedit.midea.com/weboffice/office/w/1' }]
      : typeof webeditFrames === 'function' ? webeditFrames() : webeditFrames },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  globalThis.__DSH_TEAM_DOC_PROBE_WAIT_MS = teamDocProbeWaitMs
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#team-doc-background-${Date.now()}-${Math.random()}`)
  await new Promise((resolve, reject) => { const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error))); if (open !== true) reject(new Error('ensure-harness did not retain the response channel')) })
  const sendNative = async (request) => {
    nativeListeners.forEach((listener) => listener(request))
    for (let attempt = 0; attempt < responseWaitAttempts; attempt += 1) {
      const response = nativeMessages.findLast((message) => message.type === 'connector_response' && message.requestId === request.requestId)
      if (response) return response
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return undefined
  }
  return { executions, tabUpdates, localStorage, sendNative, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.__DSH_TEAM_DOC_PROBE_WAIT_MS } }
}

const teamKnowledgeParent = { ...parent, parentType: 'directory' }
const itemRequest = (overrides = {}) => ({ type: 'connector_request', requestId: 'item-1', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_knowledge_batch', action: 'create', parent: teamKnowledgeParent, kind: 'light_document', idempotencyIdentity: 'item-1', name: 'Child', body: '# Child', ...overrides })


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

test('waits for each batch item confirmation after in-memory XML readback before it leaves the created light document', async () => {
  const calls = []
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    calls.push({ name: func.name, args })
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Child' }
    if (func.name === 'waitForTeamKnowledgeUserConfirmation') return { status: 'confirmed' }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest({
      requestId: 'item-confirmed',
      userConfirmation: { itemIndex: 2, totalItems: 3 },
    }))
    assert.equal(response.result.status, 'verified_write')
    assert.deepEqual(calls.map((call) => call.name), [
      'inspectTeamDocParentInPage', 'createTeamDocInPage', 'writeTeamDocInWebEdit',
      'waitForTeamKnowledgeUserConfirmation', 'writeTeamDocInWebEdit',
    ])
    assert.deepEqual(calls[3].args, [{ name: 'Child', itemIndex: 2, totalItems: 3 }])
    assert.deepEqual(harness.tabUpdates.map((update) => update.url), [
      'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995',
      target.url,
      'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995',
      target.url,
    ])
  } finally { harness.cleanup() }
})

test('waits for a large PRD WebEdit readback to contain its tables and mermaid before showing confirmation', async () => {
  const calls = []
  const largePrd = [
    '# 客户管理 PRD',
    '## 目标',
    '支持客户全生命周期管理。',
    '| 编号 | 需求 | 优先级 |',
    '| --- | --- | --- |',
    ...Array.from({ length: 30 }, (_, index) => `| R${index + 1} | 需求 ${index + 1} | P${index % 3} |`),
    '```mermaid',
    'flowchart TD',
    'A[创建客户] --> B[校验资料]',
    'B --> C[提交审批]',
    '```',
  ].join('\n')
  let readbackAttempts = 0
  const harness = await loadBackground({ execute: async ({ func, args }) => {
    calls.push({ name: func.name, args })
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    if (func.name === 'writeTeamDocInWebEdit') {
      if (args[1] !== true) return { ok: false, failedAt: 'readback', error: 'team_doc_readback_mismatch', observedBody: '# 客户管理 PRD\n支持客户全生命周期管理。\n编号\t需求\t优先级' }
      readbackAttempts += 1
      return readbackAttempts === 1
        ? { ok: false, failedAt: 'readback', error: 'team_knowledge_document_persisted_readback_mismatch', observedBody: '# 客户管理 PRD\nR1\t需求 1\tP1' }
        : { ok: true, readbackMatches: true, observedBody: largePrd }
    }
    if (func.name === 'waitForTeamKnowledgeUserConfirmation') return { status: 'confirmed' }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest({
      requestId: 'large-prd-confirmation', name: '客户管理 PRD', body: largePrd,
      userConfirmation: { itemIndex: 2, totalItems: 2 },
    }))
    assert.equal(response.result.status, 'verified_write')
    assert.equal(readbackAttempts, 3)
    const confirmationIndex = calls.findIndex((call) => call.name === 'waitForTeamKnowledgeUserConfirmation')
    assert.equal(confirmationIndex >= 0, true)
    assert.deepEqual(calls.slice(0, confirmationIndex).map((call) => call.name), [
      'inspectTeamDocParentInPage', 'createTeamDocInPage', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit',
    ])
  } finally { harness.cleanup() }
})

test('stopping the per-document confirmation leaves the created light document open and reports partial delivery', async () => {
  const harness = await loadBackground({ execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
    if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
    if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Child' }
    if (func.name === 'waitForTeamKnowledgeUserConfirmation') return { status: 'stopped' }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest({
      requestId: 'item-stopped',
      userConfirmation: { itemIndex: 1, totalItems: 2 },
    }))
    assert.equal(response.result.status, 'partial_delivery')
    assert.equal(response.result.failedAt, 'confirmation')
    assert.equal(response.result.error, 'team_knowledge_user_confirmation_stopped')
    assert.deepEqual(harness.tabUpdates.map((update) => update.url), ['https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995'])
    assert.equal(harness.executions.filter((execution) => execution.func.name === 'writeTeamDocInWebEdit' && execution.args[1] === true).length, 0)
  } finally { harness.cleanup() }
})

for (const [confirmationStatus, expectedError] of [
  ['timeout', 'team_knowledge_user_confirmation_timeout'],
  ['unloaded', 'team_knowledge_user_confirmation_page_unloaded'],
]) {
  test(`reports ${confirmationStatus} while keeping the created light document open`, async () => {
    const harness = await loadBackground({ execute: async ({ func }) => {
      if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: teamKnowledgeParent }
      if (func.name === 'createTeamDocInPage') return { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995' }
      if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Child' }
      if (func.name === 'waitForTeamKnowledgeUserConfirmation') return { status: confirmationStatus }
      throw new Error(`unexpected function ${func.name}`)
    } })
    try {
      const response = await harness.sendNative(itemRequest({
        requestId: `item-confirmation-${confirmationStatus}`,
        userConfirmation: { itemIndex: 1, totalItems: 1 },
      }))
      assert.deepEqual(response.result, {
        status: 'partial_delivery',
        item: { catalogId: '9007199254740995', kind: 'light_document', name: 'Child', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995', fingerprint: 'team-knowledge-item-v1-9cd1a21b' },
        stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'],
        failedAt: 'confirmation',
        error: expectedError,
      })
      assert.deepEqual(harness.tabUpdates.map((update) => update.url), ['https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995'])
    } finally { harness.cleanup() }
  })
}


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
    assert.equal(harness.tabUpdates.at(-1).url, createdUrl)
    await globalThis.chrome.tabs.update(target.tabId, { url: target.url })
    const retry = await harness.sendNative(itemRequest({ requestId: 'checkpoint-retry', idempotencyIdentity: 'checkpoint-item' }))
    assert.equal(retry.result.status, 'verified_write')
    assert.equal(creates, 1); assert.equal(rediscoveries, 1)
    assert.equal(JSON.stringify(harness.localStorage).includes('# Child'), false)
  } finally { harness.cleanup() }
})



test('accepts a docOnline document parent when its child listing omits fileType but the exact child record says newword', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  const documentParent = { ...parent, parentId: detailDocumentId, bookId: detailBookId, parentName: 'Current light document', parentType: 'document', fingerprint: 'current-document-parent' }
  globalThis.location = new URL(detailTarget.url)
  globalThis.document = { referrer: '' }
  let childLists = 0
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getDataByParentId')) {
      childLists += 1
      return new Response(JSON.stringify({ errorCode: '00000', data: childLists === 1 ? [] : [{ catalogId: '9007199254740998', name: 'Second child' }] }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/getAllFileType')) return new Response(JSON.stringify({ errorCode: '00000', data: [{ type: 4, value: 'newword' }] }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/add')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740998' } }), { status: 200 })
    if (parsed.pathname.endsWith('/openApi/teamKnowledgeCatalog/get') && parsed.searchParams.get('catalogId') === '9007199254740998') {
      return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740998', fileType: 'newword' } }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func, args }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: documentParent }
    if (func.name === 'createTeamDocInPage') return func(...args)
    if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Second child' }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'document-parent-missing-type', browserTarget: detailTarget, parent: documentParent, name: 'Second child', body: 'Second child' }))
    assert.equal(response.result.status, 'verified_write')
    assert.equal(response.result.item.catalogId, '9007199254740998')
    assert.equal(childLists, 2)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})

test('continues a same-parent light-document create with unavailable catalog type only after WebEdit identity confirms it', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const originalDocument = globalThis.document
  const documentParent = { ...parent, parentId: detailDocumentId, bookId: detailBookId, parentName: 'Current light document', parentType: 'document', fingerprint: 'current-document-parent-provisional' }
  globalThis.location = new URL(detailTarget.url)
  globalThis.document = { referrer: '' }
  let childLists = 0
  const identityReads = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'https://doc.midea.com')
    if (parsed.pathname.endsWith('/teamKnowledgeCatalog/getDataByParentId')) {
      childLists += 1
      return new Response(JSON.stringify({ errorCode: '00000', data: childLists === 1 ? [] : [{ catalogId: '9007199254740996', name: 'Provisional child' }] }), { status: 200 })
    }
    if (parsed.pathname.endsWith('/teamKnowledge/getAllFileType')) return new Response(JSON.stringify({ errorCode: '00000', data: [{ type: 4, value: 'newword' }] }), { status: 200 })
    if (parsed.pathname.endsWith('/teamKnowledge/add')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740996' } }), { status: 200 })
    if (parsed.pathname.endsWith('/openApi/teamKnowledgeCatalog/get')) return new Response(JSON.stringify({ errorCode: '00000', data: { catalogId: '9007199254740996' } }), { status: 200 })
    throw new Error(`unexpected fetch ${parsed.pathname}${parsed.search}`)
  }
  const harness = await loadBackground({ initialTab: detailTarget,
    sendMessage: async (_tabId, message) => {
      if (message.action === 'probe') return { ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/o/1', hasContent: true } } }
      if (message.type === 'office-document/v1' && message.action === 'read') {
        identityReads.push(message)
        return { ok: true, result: { status: 'ok', resource: { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: 'Provisional child', fingerprint: 'child-identity' }, document: { blocks: [] } } }
      }
      return { ok: false }
    },
    execute: async ({ func, args }) => {
      if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: documentParent }
      if (func.name === 'createTeamDocInPage') return func(...args)
      if (func.name === 'writeTeamDocInWebEdit') return { ok: true, readbackMatches: true, observedBody: 'Provisional child' }
      throw new Error(`unexpected function ${func.name}`)
    },
  })
  try {
    const response = await harness.sendNative(itemRequest({ requestId: 'document-parent-provisional-type', browserTarget: detailTarget, parent: documentParent, name: 'Provisional child', body: 'Provisional child' }))
    assert.equal(response.result.status, 'verified_write')
    assert.equal(response.result.item.catalogId, '9007199254740996')
    assert.equal(identityReads.length, 1)
    assert.equal(childLists, 2)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument
  }
})


test('keeps the created catalog ID and checkpoint when post-create type verification is uncertain', async () => {
  const documentParent = { ...parent, parentId: detailDocumentId, bookId: detailBookId, parentName: 'Current light document', parentType: 'document', fingerprint: 'current-document-parent-uncertain' }
  const uncertain = {
    ok: false, failedAt: 'rediscover', error: 'team_knowledge_item_type_unavailable',
    catalogId: '9007199254740999', documentId: '9007199254740999', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740999?id=9007199254740999',
  }
  const uncertainRecovery = { ...uncertain }
  delete uncertainRecovery.url
  let creates = 0
  let rediscoveries = 0
  const harness = await loadBackground({ initialTab: detailTarget, execute: async ({ func }) => {
    if (func.name === 'inspectTeamDocParentInPage') return { ok: true, parent: documentParent }
    if (func.name === 'createTeamDocInPage') { creates += 1; return uncertain }
    if (func.name === 'rediscoverTeamDocInPage') { rediscoveries += 1; return uncertainRecovery }
    throw new Error(`unexpected function ${func.name}`)
  } })
  try {
    const request = { browserTarget: detailTarget, parent: documentParent, name: 'Uncertain child', body: 'Uncertain child', idempotencyIdentity: 'uncertain-child' }
    const first = await harness.sendNative(itemRequest({ requestId: 'uncertain-first', ...request }))
    assert.equal(first.result.status, 'partial_delivery')
    assert.equal(first.result.failedAt, 'rediscover')
    assert.equal(first.result.item.catalogId, '9007199254740999')
    const retry = await harness.sendNative(itemRequest({ requestId: 'uncertain-retry', ...request }))
    assert.equal(retry.result.status, 'partial_delivery')
    assert.equal(retry.result.item.catalogId, '9007199254740999')
    assert.equal(creates, 1)
    assert.equal(rediscoveries, 1)
  } finally { harness.cleanup() }
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
  const harness = await loadBackground({ responseWaitAttempts: 600, execute: async ({ func, args }) => func.name === 'inspectTeamDocParentInPage' ? func(...args) : null })
  try {
    const response = await harness.sendNative({ type: 'connector_request', requestId: 'item-non-directory', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target, tool: 'team_knowledge_batch', action: 'inspect_parent' })
    assert.deepEqual(response.result, { status: 'partial_delivery', item: null, stages: [], failedAt: 'inspect', error: 'team_doc_directory_required' })
    assert.equal(harness.executions.map((request) => request.func.name).includes('createTeamDocInPage'), false)
  } finally {
    harness.cleanup()
    globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation
  }
})
