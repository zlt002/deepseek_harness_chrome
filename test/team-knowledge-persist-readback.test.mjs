import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

const parentUrl = 'https://doc.midea.com/teamKnowledge/catalog/9007199254740993'
const createdUrl = 'https://doc.midea.com/teamKnowledge/detail/docOnline/9007199254740995?id=9007199254740995'
const target = { browser: 'chrome', windowId: 7, tabId: 42, url: parentUrl }
const parent = { parentId: '9007199254740993', bookId: '9007199254740994', parentName: 'Root', parentType: 'directory', canRead: true, canCreate: true, fingerprint: 'team-doc-parent-v1-abc12345' }

async function loadBackground({
  persistedReadback = (attempt) => attempt === 1
    ? { ok: false, failedAt: 'readback', error: 'team_knowledge_document_persisted_readback_mismatch', observedBody: '' }
    : { ok: true, readbackMatches: true, observedBody: 'Child' },
  readbackPollWindowMs,
} = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url), 'utf8')
  const compiled = await bundleTypescript(source, new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url))
  let runtimeListener
  const nativeListeners = new Set(); const nativeMessages = []; const executions = []; const navigations = []
  const tab = { id: target.tabId, windowId: target.windowId, url: target.url, title: 'Team Knowledge', status: 'complete' }
  const port = {
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    onMessage: { addListener: (listener) => nativeListeners.add(listener), removeListener: (listener) => nativeListeners.delete(listener) },
    postMessage: (message) => { nativeMessages.push(message); if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach((listener) => listener({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-team-doc' } }))) },
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: { connectNative: () => port, lastError: undefined, onMessage: { addListener: (listener) => { runtimeListener = listener } }, sendMessage: async () => {} },
    storage: { session: { get: async () => ({ harnessBrowserTargetSettings: { mode: 'follow-active-tab', pinnedTabs: [] } }), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    windows: { getLastFocused: async () => ({ id: target.windowId }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async () => [tab], get: async () => ({ ...tab }),
      update: async (_tabId, update) => { if (typeof update.url === 'string') { tab.url = update.url; navigations.push(update.url) }; tab.status = 'complete'; return { ...tab } },
      sendMessage: async (_tabId, message) => message?.action === 'probe' ? { ok: true, result: { status: 'probe', ready: true, identity: { path: '/weboffice/office/o/1', hasContent: true } } } : { ok: false },
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    scripting: { executeScript: async (request) => {
      executions.push(request)
      const name = request.func.name
      if (name === 'inspectTeamDocParentInPage') return [{ result: { ok: true, parent } }]
      if (name === 'createTeamDocInPage') return [{ result: { ok: true, catalogId: '9007199254740995', documentId: '9007199254740995', kind: 'light_document', url: createdUrl } }]
      if (name === 'writeTeamDocInWebEdit') {
        if (request.args[1] !== true) return [{ result: { ok: true, readbackMatches: true, observedBody: 'Child' } }]
        const persistedReadbackAttempt = executions.filter((execution) => execution.func.name === 'writeTeamDocInWebEdit' && execution.args[1] === true).length
        return [{ result: persistedReadback(persistedReadbackAttempt) }]
      }
      throw new Error(`unexpected function ${name}`)
    } },
    webNavigation: { getAllFrames: async () => tab.url === parentUrl ? [{ frameId: 0, url: tab.url }] : [{ frameId: 0, url: tab.url }, { frameId: 17, url: 'https://webedit.midea.com/weboffice/office/o/1' }] },
    sidePanel: { open: async () => {} },
  }
  globalThis.defineBackground = (setup) => setup()
  globalThis.__DSH_TEAM_DOC_READBACK_POLL_WINDOW_MS = readbackPollWindowMs
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#persist-readback-${Date.now()}-${Math.random()}`)
  await new Promise((resolve, reject) => {
    const open = runtimeListener({ type: 'ensure-harness' }, {}, (response) => response.ok ? resolve() : reject(new Error(response.error)))
    if (open !== true) reject(new Error('ensure-harness did not retain the response channel'))
  })
  const send = async (request) => {
    nativeListeners.forEach((listener) => listener(request))
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = nativeMessages.findLast((message) => message.type === 'connector_response' && message.requestId === request.requestId)
      if (response) return response
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return undefined
  }
  return { executions, navigations, send, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.__DSH_TEAM_DOC_READBACK_POLL_WINDOW_MS } }
}

test('retries a reopened Team Knowledge document when its first persisted WebEdit readback is empty', async () => {
  const harness = await loadBackground()
  try {
    const response = await harness.send({
      type: 'connector_request', requestId: 'persist-readback', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target,
      tool: 'team_knowledge_batch', action: 'create', parent, kind: 'light_document', idempotencyIdentity: 'persist-readback-item', name: 'Child', body: '# Child',
    })
    assert.equal(response.result.status, 'verified_write')
    assert.equal(response.result.readback.body, 'Child')
    assert.deepEqual(harness.executions.map((request) => request.func.name), ['inspectTeamDocParentInPage', 'createTeamDocInPage', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit'])
    assert.equal(harness.executions.filter((request) => request.func.name === 'writeTeamDocInWebEdit' && request.args[1] === true).length, 2)
    assert.deepEqual(harness.navigations, [createdUrl, parentUrl, createdUrl, parentUrl])
  } finally { harness.cleanup() }
})

test('fails closed and keeps the created Team Knowledge document open when persisted WebEdit readback stays empty', async () => {
  const harness = await loadBackground({
    readbackPollWindowMs: 10,
    persistedReadback: () => ({ ok: false, failedAt: 'readback', error: 'team_knowledge_document_persisted_readback_mismatch', observedBody: '' }),
  })
  try {
    const response = await harness.send({
      type: 'connector_request', requestId: 'persist-readback-stays-empty', runId: 'run-team-doc', generation: 'generation-1', browserTarget: target,
      tool: 'team_knowledge_batch', action: 'create', parent, kind: 'light_document', idempotencyIdentity: 'persist-readback-stays-empty-item', name: 'Child', body: '# Child',
    })
    assert.equal(response.result.status, 'partial_delivery')
    assert.equal(response.result.failedAt, 'readback')
    assert.equal(response.result.error, 'team_knowledge_document_persisted_readback_mismatch')
    assert.deepEqual(harness.executions.map((request) => request.func.name), ['inspectTeamDocParentInPage', 'createTeamDocInPage', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit', 'writeTeamDocInWebEdit', 'showTeamKnowledgeReadbackFailure'])
    assert.equal(harness.executions.filter((request) => request.func.name === 'writeTeamDocInWebEdit' && request.args[1] === true).length, 2)
    assert.deepEqual(harness.navigations, [createdUrl, parentUrl, createdUrl])
  } finally { harness.cleanup() }
})
