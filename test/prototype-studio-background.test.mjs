import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { bundleTypescript } from './helpers/bundle-typescript.mjs'

const uuid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`
const generationRequestId = `generation-${uuid(1)}`
const productBrief = { v: 1, audience: '采购经理', coreTask: '筛选供应商并完成准入审批', requiredPages: ['工作台', '供应商列表', '审批详情'], requiredFlows: ['筛选供应商', '打开详情', '通过或驳回申请'] }
const authorization = (n, openedAt = Date.now() - n) => ({
  projectId: `prototype-${uuid(n)}`,
  referenceId: `ref-${uuid(n)}`,
  sessionId: `session-${n}`,
  capability: `${uuid(n)}${uuid(n)}`,
  openedAt,
})

const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const productBriefFingerprint = createHash('sha256').update(JSON.stringify(canonical(productBrief))).digest('hex')
function referenceEvidence(item) {
  const evidence = {
    v: 1, id: item.referenceId,
    source: { url: 'https://example.test/reference', title: 'Reference', capturedAt: '2026-08-24T00:00:00.000Z' },
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    observations: ['跨多个区域采集页面设计规范。'],
    designTokens: { colors: ['#3977e8', '#ffffff'], fonts: ['Inter'], radius: ['8px'], spacing: ['8px', '16px'] },
    screenshotDataUrl: 'data:image/jpeg;base64,YQ==', screenshotFingerprint: 'a'.repeat(64),
  }
  const fingerprintInput = { v: 1, source: { url: evidence.source.url, title: evidence.source.title }, viewport: evidence.viewport, observations: evidence.observations, designTokens: evidence.designTokens, screenshotFingerprint: evidence.screenshotFingerprint }
  evidence.fingerprint = createHash('sha256').update(JSON.stringify(canonical(fingerprintInput))).digest('hex')
  return evidence
}

async function loadBackground(sessionStore, options = {}) {
  const sourceUrl = new URL('../apps/chrome-extension/entrypoints/background.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const compiled = await bundleTypescript(source, sourceUrl)
  let listener
  const fetches = []; const runtimeMessages = []; const nativeListeners = new Set(); const nativeMessages = []; const tabsCreated = []
  const localStore = options.localStore ?? {}
  const activeTab = { id: 2, windowId: 1, url: 'https://example.test/reference', title: 'Reference', status: 'complete' }
  globalThis.__ACCRUI_PROTOTYPE_HOST_TIMEOUT_MS = options.prototypeHostTimeoutMs
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    if (options.fetchImpl !== undefined) return options.fetchImpl(url, init)
    return new Response(JSON.stringify({ evidence: [], revisions: [], currentRevisionId: undefined }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  globalThis.chrome = {
    action: { onClicked: { addListener: () => {} } },
    runtime: {
      id: 'test', lastError: undefined,
      getURL: path => `chrome-extension://test/${path.replace(/^\//, '')}`,
      onMessage: { addListener: value => { listener = value } },
      onConnect: { addListener: () => {} },
      sendMessage: async message => { runtimeMessages.push(message); return { ok: true } },
      connectNative: () => ({
        onDisconnect: { addListener: () => {}, removeListener: () => {} },
        onMessage: { addListener: value => nativeListeners.add(value), removeListener: value => nativeListeners.delete(value) },
        postMessage: message => {
          nativeMessages.push(message)
          if (message.type === 'start') queueMicrotask(() => nativeListeners.forEach(value => value({ type: 'server_started', payload: { url: 'http://127.0.0.1:43123', runId: 'run-prototype', knowledgeProxyUrl: 'http://127.0.0.1:43124/knowledge-proxy', knowledgeProxyToken: 'native-connector-token-abcdefghijklmnopqrstuvwxyz' } })))
          if (message.type === 'sign-prototype-recovery') queueMicrotask(() => nativeListeners.forEach(value => value({
            type: 'prototype_recovery_signed', requestId: message.requestId,
            assertion: { v: 1, purpose: 'prototype-studio-capability-recovery', runId: 'run-prototype', projectId: message.payload.projectId, expectedSessionId: message.payload.expectedSessionId, referenceId: message.payload.referenceId, evidenceFingerprint: message.payload.evidenceFingerprint, capabilityFingerprint: message.payload.capabilityFingerprint, expectedRecoveryEpoch: message.payload.expectedRecoveryEpoch, nonce: uuid(9), issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
            signature: 'a'.repeat(88),
          })))
        },
        disconnect: () => {},
      }),
    },
    storage: {
      session: {
        get: async key => typeof key === 'string' ? { [key]: sessionStore[key] } : sessionStore,
        set: async value => Object.assign(sessionStore, value),
      },
      local: { get: async key => typeof key === 'string' ? { [key]: localStore[key] } : localStore, set: async value => Object.assign(localStore, value) },
    },
    windows: { getLastFocused: async () => ({ id: 1 }), onFocusChanged: { addListener: () => {} } },
    tabs: {
      query: async () => [activeTab], get: async () => activeTab, update: async () => activeTab, create: async options => { tabsCreated.push(options); return activeTab },
      onActivated: { addListener: () => {} }, onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    },
    sidePanel: { open: async () => {}, close: async () => {}, setOptions: async () => {} },
    scripting: { executeScript: async () => [] }, webNavigation: { getAllFrames: async () => [] },
  }
  globalThis.defineBackground = setup => setup()
  await import(`data:text/javascript,${encodeURIComponent(compiled)}#prototype-auth-${Date.now()}-${Math.random()}`)
  const snapshot = projectId => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-snapshot/v1', projectId }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  const confirmDesign = (projectId, designSpec) => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-confirm-design/v1', projectId, designSpec }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  const confirmBrief = (projectId, brief) => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-confirm-brief/v1', projectId, brief }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  const prompt = projectId => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-prompt/v1', projectId, requestId: generationRequestId, prompt: '生成供应商准入原型', brief: productBrief }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  const createVariant = projectId => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-create-variant/v1', projectId }, { url: `chrome-extension://test/prototype-studio.html?projectId=${projectId}`, tab: { id: 10, windowId: 1 } }, resolve)
    assert.equal(keep, true)
  })
  const recover = (projectId, referenceId, senderReferenceId = referenceId) => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-recover/v1', projectId, referenceId }, { url: `chrome-extension://test/prototype-studio.html?referenceId=${senderReferenceId}&projectId=${projectId}`, tab: { id: 10 } }, resolve)
    assert.equal(keep, true)
  })
  const recent = () => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-recent/v1' }, { url: 'chrome-extension://test/sidepanel.html' }, resolve)
    assert.equal(keep, true)
  })
  const openRecent = projectId => new Promise(resolve => {
    const keep = listener({ type: 'prototype-studio-open-recent/v1', projectId }, { url: 'chrome-extension://test/sidepanel.html' }, resolve)
    assert.equal(keep, true)
  })
  return { fetches, runtimeMessages, nativeMessages, tabsCreated, snapshot, confirmDesign, confirmBrief, prompt, createVariant, recover, recent, openRecent, cleanup: () => { delete globalThis.chrome; delete globalThis.defineBackground; delete globalThis.fetch; delete globalThis.__ACCRUI_PROTOTYPE_HOST_TIMEOUT_MS } }
}

test('restores a valid Prototype Studio authorization from session storage after a Service Worker restart', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore)
  try {
    const response = await background.snapshot(item.projectId)
    assert.equal(response.ok, true, JSON.stringify(response))
    const request = background.fetches.find(item => new URL(item.url).pathname.endsWith('/api/prototype-studio/snapshot'))
    assert.notEqual(request, undefined)
    assert.equal(request.init.headers.authorization, `Bearer ${item.capability}`)
  } finally { background.cleanup() }
})

test('does not restore malformed, expired, or surplus Prototype Studio authorizations', async () => {
  const legal = Array.from({ length: 9 }, (_, index) => authorization(index + 1, Date.now() - index - 1))
  const expired = authorization(10, Date.now() - 13 * 60 * 60_000)
  const sessionStore = {
    harnessPrototypeStudioAuthorizationsV1: {
      v: 1,
      authorizations: {
        ...Object.fromEntries(legal.map(item => [item.projectId, item])),
        [expired.projectId]: expired,
        injected: { projectId: legal[0].projectId, referenceId: legal[0].referenceId, sessionId: legal[0].sessionId, capability: 'not-a-capability', openedAt: Date.now() },
      },
    },
  }
  const background = await loadBackground(sessionStore)
  try {
    const response = await background.snapshot(legal[8].projectId)
    assert.equal(response.ok, false)
    assert.match(response.error, /授权已过期/)
    assert.equal(background.fetches.length, 0)
    const persisted = sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations
    assert.equal(Object.keys(persisted).length, 8)
    assert.equal(persisted[legal[8].projectId], undefined)
    assert.equal(persisted[expired.projectId], undefined)
    assert.equal(persisted.injected, undefined)
  } finally { background.cleanup() }
})

test('recovers an expired project through a Native Host signed assertion and verified readback', async () => {
  const item = authorization(1)
  const evidence = referenceEvidence(item)
  const sessionStore = {}
  const localStore = { harnessPrototypeStudioRecoveriesV1: { v: 1, projects: { [item.projectId]: { projectId: item.projectId, referenceId: item.referenceId, sessionId: item.sessionId, evidenceFingerprint: evidence.fingerprint, recoveryEpoch: 0, updatedAt: Date.now() } } } }
  let rotatedCapability
  const background = await loadBackground(sessionStore, { localStore, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    if (path.endsWith('/recover')) {
      assert.equal(init.headers.authorization, undefined)
      assert.deepEqual(Object.keys(body).sort(), ['assertion', 'capability', 'signature'])
      assert.equal(body.assertion.projectId, item.projectId)
      assert.equal(body.assertion.expectedSessionId, item.sessionId)
      assert.equal(body.assertion.referenceId, item.referenceId)
      assert.equal(body.assertion.evidenceFingerprint, evidence.fingerprint)
      assert.equal(body.assertion.expectedRecoveryEpoch, 0)
      rotatedCapability = body.capability
      return new Response(JSON.stringify({ status: 'verified_write', projectId: item.projectId, sessionId: item.sessionId, referenceId: item.referenceId, evidenceFingerprint: evidence.fingerprint, capabilityFingerprint: createHash('sha256').update(rotatedCapability).digest('hex'), recoveryEpoch: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path.endsWith('/snapshot')) {
      assert.equal(init.headers.authorization, `Bearer ${rotatedCapability}`)
      return new Response(JSON.stringify({ projectId: item.projectId, sessionId: item.sessionId, evidence: [{ id: item.referenceId, fingerprint: evidence.fingerprint }], recoveryEpoch: 1, revisions: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected path: ${path}`)
  } })
  try {
    const before = await background.snapshot(item.projectId)
    assert.equal(before.ok, false)
    assert.equal(before.code, 'prototype_authorization_expired')
    assert.equal(before.recoveryAvailable, true)
    assert.match(before.error, /原型和历史版本仍安全保留/)

    const recovered = await background.recover(item.projectId, item.referenceId)
    assert.equal(recovered.ok, true, JSON.stringify(recovered))
    assert.equal(recovered.snapshot.projectId, item.projectId)
    const persisted = sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations[item.projectId]
    assert.equal(persisted.sessionId, item.sessionId)
    assert.equal(persisted.referenceId, item.referenceId)
    assert.equal(persisted.capability, rotatedCapability)
    assert.equal(localStore.harnessPrototypeStudioRecoveriesV1.projects[item.projectId].recoveryEpoch, 1)
    assert.equal(JSON.stringify(localStore.harnessPrototypeStudioRecoveriesV1).includes('capability'), false)
    assert.equal(background.nativeMessages.some(message => message.type === 'sign-prototype-recovery'), true)

    const after = await background.snapshot(item.projectId)
    assert.equal(after.ok, true, JSON.stringify(after))
  } finally { background.cleanup() }
})

test('lists and opens recently saved projects without persisting any capability or screenshot', async () => {
  const item = authorization(1)
  const binding = { projectId: item.projectId, referenceId: item.referenceId, sessionId: item.sessionId, evidenceFingerprint: 'a'.repeat(64), recoveryEpoch: 0, updatedAt: Date.now(), referenceTitle: '供应商工作台', referenceUrl: 'https://example.test/reference' }
  const localStore = { harnessPrototypeStudioRecoveriesV1: { v: 1, projects: { [item.projectId]: binding } } }
  const background = await loadBackground({}, { localStore })
  try {
    const recent = await background.recent()
    assert.equal(recent.ok, true, JSON.stringify(recent))
    assert.deepEqual(recent.projects, [{ projectId: item.projectId, referenceId: item.referenceId, referenceTitle: '供应商工作台', referenceUrl: 'https://example.test/reference', updatedAt: binding.updatedAt, authorizationActive: false }])
    assert.equal(JSON.stringify(localStore.harnessPrototypeStudioRecoveriesV1).includes('capability'), false)
    assert.equal(JSON.stringify(localStore.harnessPrototypeStudioRecoveriesV1).includes('screenshot'), false)
    const opened = await background.openRecent(item.projectId)
    assert.equal(opened.ok, true, JSON.stringify(opened))
    const url = new URL(background.tabsCreated.at(-1).url)
    assert.equal(url.pathname, '/prototype-studio.html')
    assert.equal(url.searchParams.get('projectId'), item.projectId)
    assert.equal(url.searchParams.get('referenceId'), item.referenceId)
  } finally { background.cleanup() }
})

test('refuses recovery when the explicit page identity does not match the requested reference', async () => {
  const item = authorization(1)
  const evidence = referenceEvidence(item)
  const background = await loadBackground({}, { localStore: { harnessPrototypeReferencesV1: { v: 1, references: { [item.referenceId]: evidence } } } })
  try {
    const response = await background.recover(item.projectId, item.referenceId, 'ref-wrong-page')
    assert.equal(response.ok, false)
    assert.match(response.error, /当前原型页面不匹配/)
    assert.equal(background.fetches.length, 0)
  } finally { background.cleanup() }
})

test('persists the exact design spec before allowing the first prototype request', async () => {
  const item = authorization(1)
  const confirmedDesignSpec = { v: 1, id: 'design-confirmed', basedOnEvidenceIds: [item.referenceId], colors: [{ name: '主要色', value: '#3977e8' }] }
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore, { fetchImpl: async url => {
    const path = new URL(url).pathname
    const body = path.endsWith('/confirm-design')
      ? { status: 'verified_write', designSpecFingerprint: 'a'.repeat(64) }
      : path.endsWith('/confirm-brief')
        ? { status: 'verified_write', productBrief, productBriefFingerprint }
      : path.endsWith('/begin-generation')
        ? { status: 'verified_write', requestId: generationRequestId }
        : { projectId: item.projectId, evidence: [{ id: item.referenceId }], revisions: [], designConfirmed: true, confirmedDesignSpec, productBrief }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  try {
    const confirmation = await background.confirmDesign(item.projectId, confirmedDesignSpec)
    assert.equal(confirmation.ok, true, JSON.stringify(confirmation))
    const briefConfirmation = await background.confirmBrief(item.projectId, productBrief)
    assert.equal(briefConfirmation.ok, true, JSON.stringify(briefConfirmation))
    const response = await background.prompt(item.projectId)
    assert.equal(response.ok, true, JSON.stringify(response))
    const prototypeRequests = background.fetches.filter(request => new URL(request.url).pathname.startsWith('/api/prototype-studio/'))
    assert.deepEqual(prototypeRequests.map(request => new URL(request.url).pathname), ['/api/prototype-studio/confirm-design', '/api/prototype-studio/confirm-brief', '/api/prototype-studio/snapshot', '/api/prototype-studio/begin-generation'])
    assert.deepEqual(JSON.parse(prototypeRequests[0].init.body).designSpec, confirmedDesignSpec)
    assert.equal(JSON.parse(prototypeRequests[3].init.body).prompt, '生成供应商准入原型')
    const forwarded = background.runtimeMessages.find(message => message.type === 'prototype-studio-prompt-forward/v1')
    assert.deepEqual(forwarded.payload.designSpec, confirmedDesignSpec)
    assert.deepEqual(forwarded.payload.productBrief, productBrief)
  } finally { background.cleanup() }
})

test('rejects a confirmed design spec bound to another reference', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore, { fetchImpl: async () => new Response(JSON.stringify({ error: 'The confirmed design specification does not match the authorized reference evidence.' }), { status: 400, headers: { 'content-type': 'application/json' } }) })
  try {
    const response = await background.confirmDesign(item.projectId, { v: 1, id: 'design-wrong', basedOnEvidenceIds: ['ref-another-page'] })
    assert.equal(response.ok, false)
    assert.match(response.error, /does not match the authorized reference evidence/)
    assert.equal(background.runtimeMessages.some(message => message.type === 'prototype-studio-prompt-forward/v1'), false)
  } finally { background.cleanup() }
})

test('rejects a product requirement readback with a different fingerprint', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore, { fetchImpl: async () => new Response(JSON.stringify({ status: 'verified_write', productBrief, productBriefFingerprint: '0'.repeat(64) }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  try {
    const response = await background.confirmBrief(item.projectId, productBrief)
    assert.equal(response.ok, false)
    assert.match(response.error, /没有完成安全保存和同内容回读/)
  } finally { background.cleanup() }
})

test('never forwards an AI request before the user confirms the design spec', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore)
  try {
    const response = await background.prompt(item.projectId)
    assert.equal(response.ok, false)
    assert.match(response.error, /请先查看并确认网页设计规范/)
    assert.equal(background.runtimeMessages.some(message => message.type === 'prototype-studio-prompt-forward/v1'), false)
  } finally { background.cleanup() }
})

test('creates a new design project from the same verified reference while preserving old history', async () => {
  const item = authorization(1)
  const evidence = referenceEvidence(item)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const localStore = { harnessPrototypeReferencesV1: { v: 1, references: { [item.referenceId]: evidence } } }
  const background = await loadBackground(sessionStore, { localStore, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    if (!new URL(url).pathname.endsWith('/open')) throw new Error(`Unexpected path: ${new URL(url).pathname}`)
    return new Response(JSON.stringify({ projectId: body.projectId, sessionId: body.sessionId, evidence: body.evidence, recoveryEpoch: 0, revisions: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  try {
    const response = await background.createVariant(item.projectId)
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.notEqual(response.projectId, item.projectId)
    assert.equal(response.referenceId, item.referenceId)
    const opened = background.fetches.find(request => new URL(request.url).pathname.endsWith('/api/prototype-studio/open'))
    assert.notEqual(opened, undefined)
    const body = JSON.parse(opened.init.body)
    assert.equal(body.projectId, response.projectId)
    assert.equal(body.sessionId, item.sessionId)
    assert.equal(body.evidence[0].id, item.referenceId)
    assert.equal(body.evidence[0].screenshotDataUrl, undefined)
    assert.notEqual(sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations[item.projectId], undefined)
    assert.notEqual(sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations[response.projectId], undefined)
    assert.equal(background.tabsCreated.length, 1)
    const studioUrl = new URL(background.tabsCreated[0].url)
    assert.equal(studioUrl.searchParams.get('referenceId'), item.referenceId)
    assert.equal(studioUrl.searchParams.get('projectId'), response.projectId)
  } finally { background.cleanup() }
})

test('refuses a new design project when the stored reference fingerprint changed', async () => {
  const item = authorization(1)
  const evidence = referenceEvidence(item); evidence.observations = ['内容被篡改。']
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const localStore = { harnessPrototypeReferencesV1: { v: 1, references: { [item.referenceId]: evidence } } }
  const background = await loadBackground(sessionStore, { localStore })
  try {
    const response = await background.createVariant(item.projectId)
    assert.equal(response.ok, false)
    assert.match(response.error, /校验失败/)
    assert.equal(background.fetches.length, 0)
    assert.equal(background.tabsCreated.length, 0)
    assert.deepEqual(Object.keys(sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations), [item.projectId])
  } finally { background.cleanup() }
})

test('returns a readable error instead of leaving Prototype Studio loading forever when Host stalls', async () => {
  const item = authorization(1)
  const sessionStore = { harnessPrototypeStudioAuthorizationsV1: { v: 1, authorizations: { [item.projectId]: item } } }
  const background = await loadBackground(sessionStore, {
    prototypeHostTimeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })
  try {
    const result = await Promise.race([
      background.snapshot(item.projectId),
      new Promise(resolve => setTimeout(() => resolve({ timedOutWaitingForExtension: true }), 500)),
    ])
    assert.equal(result.timedOutWaitingForExtension, undefined, 'Prototype Studio snapshot request never returned')
    assert.equal(result.ok, false)
    assert.match(result.error, /原型服务连接超时/)
  } finally { background.cleanup() }
})

test('retains the new session capability and reads back a recovery committed after its HTTP response timed out', async () => {
  const item = authorization(7)
  const evidence = referenceEvidence(item)
  const sessionStore = {}
  const localStore = { harnessPrototypeStudioRecoveriesV1: { v: 1, projects: { [item.projectId]: { projectId: item.projectId, referenceId: item.referenceId, sessionId: item.sessionId, evidenceFingerprint: evidence.fingerprint, recoveryEpoch: 0, updatedAt: Date.now() } } } }
  let committed = false
  let recoveredCapability
  const background = await loadBackground(sessionStore, { localStore, prototypeHostTimeoutMs: 25, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    if (path.endsWith('/recover')) {
      recoveredCapability = body.capability
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          setTimeout(() => { committed = true }, 45)
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    }
    if (path.endsWith('/snapshot')) {
      if (!committed || init.headers.authorization !== `Bearer ${recoveredCapability}`) return new Response(JSON.stringify({ error: 'Prototype project capability is invalid.' }), { status: 401, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ projectId: item.projectId, sessionId: item.sessionId, evidence: [{ id: item.referenceId, fingerprint: evidence.fingerprint }], recoveryEpoch: 1, revisions: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected path: ${path}`)
  } })
  try {
    const response = await background.recover(item.projectId, item.referenceId)
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.equal(sessionStore.harnessPrototypeStudioAuthorizationsV1.authorizations[item.projectId].capability, recoveredCapability)
    assert.equal(localStore.harnessPrototypeStudioRecoveriesV1.projects[item.projectId].recoveryEpoch, 1)
  } finally { background.cleanup() }
})
