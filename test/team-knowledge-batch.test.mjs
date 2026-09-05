import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { TeamDocRecordStore } from '../apps/native-server/src/knowledge/team-doc-record-store.mjs'
import { TeamKnowledgeBatchRecordStore } from '../apps/native-server/src/knowledge/team-knowledge-batch-record-store.mjs'

const target = { browser: 'chrome', windowId: 1, tabId: 2, url: 'https://doc.midea.com/teamKnowledge/catalog/9' }
const parent = { parentId: '9', bookId: '10', parentName: 'Root', parentType: 'directory', canRead: true, canCreate: true, fingerprint: 'parent-batch-v1' }
const documents = [{ name: 'One', body: '# One\nsecret one' }, { name: 'Two', body: '# Two\nsecret two' }]

async function authoritativePmdBody() {
  const authority = (await readFile(new URL('../skills/pmd-prd/references/templates.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const blocks = [...authority.matchAll(/```markdown\s*\n([\s\S]*?)\n```/g)].map((match) => match[1])
  const materialise = (body) => body
    .replaceAll('{编号}', 'REQ')
    .replaceAll('{主题}', 'CRM')
    .replace(/\{[^{}\n]+\}/g, '已确认内容')
  const prdBody = blocks.find((body) => body.includes('# PRD:'))
  assert.ok(prdBody, 'authoritative PMD templates must expose one document body')
  return materialise(prdBody)
    .replace(/(\| 需求点 \| 阐述 \| 原有实现 \| 目标改动点 \|\n\|---\|---\|---\|---\|\n)\|[^\n]+\|/, '$1| 【修改】客户状态维护 | 客户停用后不能继续发起服务。 | 停用客户仍可发起服务。 | 阻止停用客户发起服务；研发定位：src/contracts/ContractDetail.java 的 statusColumn |')
    .replace('| 需求编号及链接 | 已确认内容 |  |  |', '| 需求编号及链接 | REQ：https://example.test/REQ |  |  |')
    .replace('| 产品经理 | 已确认内容 | 预估人天 | 已确认内容 |', '| 产品经理 | 已确认内容 | 预估人天 | 8人天 |')
}

// Matches Harness's current model-facing projection: it reads only top-level
// properties and required fields, ignoring JSON Schema composition such as oneOf.
function harnessProjectedArguments(schema) {
  return { required: schema.required ?? [], properties: Object.keys(schema.properties ?? {}).sort() }
}

function verified(request, id) {
  return { status: 'verified_write', item: { catalogId: id, kind: 'light_document', name: request.name, url: `https://doc.midea.com/teamKnowledge/detail/docOnline/${id}?id=${id}`, fingerprint: `item-${id}` }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written', 'readback_verified'], readback: { body: request.body } }
}

function visibleMarkdownReadback(body) {
  const visible = (value) => value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/~~([^~]+)~~/g, '$1').trim()
  return body.replace(/<!--[\s\S]*?-->/g, '').split(/\n+/).flatMap((sourceLine) => {
    const line = sourceLine.trim()
    if (!line || /^(?:`{3,}|~{3,}|-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return []
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map(visible)
      return cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? [] : [cells.join('\t')]
    }
    const heading = /^#{1,6}\s+/.test(line)
    const withoutBlockPrefix = line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    const fragment = visible(heading ? withoutBlockPrefix.replace(/^\d+(?:\.\d+)*[.)、．]?\s+/, '') : withoutBlockPrefix)
    return fragment ? [fragment] : []
  }).join('\n')
}

function lightDocumentRead(request) {
  const resource = { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: 'Batch document', fingerprint: 'light-document-v1' }
  if (request.action === 'write') {
    const fragments = request.payload.blocks.map((block) => block.text)
    return {
      status: 'verified_write', resource: { ...resource, fingerprint: 'light-document-v2' }, requested: { operation: request.operation, payload: request.payload },
      observed: { verified: true, verifiedFragments: fragments, fragmentEvidence: fragments.map((fragment) => ({ fragment, blockIds: ['block-1'] })), observedBlocks: [{ id: 'block-1', type: 'p', text: fragments.join(' ') }], replacedTagIds: ['block-1'] },
    }
  }
  const selection = request.action === 'selection'
    ? { supported: true, stable: true, truncated: false, hasSelection: true, isCollapsed: false, wholeBlockReplaceable: true, selectionFingerprint: 'selection-v4-1234567890abcdef1234567890abcdef', selectedTagIds: ['block-1'], content: { text: '旧内容' } }
    : undefined
  return { status: 'ok', resource, document: { blockCount: 1, offset: 0, limit: 1, hasMore: false, blocks: [{ id: 'block-1', type: 'p', text: '旧内容' }], ...(selection ? { selection } : {}) } }
}

async function open(responder, responseTarget = (request) => request.browserTarget, { releaseError, reportPrdEvent } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'team-knowledge-batch-'))
  const batchStore = new TeamKnowledgeBatchRecordStore({ recordPath: join(directory, 'batch.json') })
  const teamDocStore = new TeamDocRecordStore({ recordPath: join(directory, 'items.json') })
  let connector
  const requests = []
  connector = new BrowserConnector({ teamKnowledgeBatchStore: batchStore, teamDocStore, reportPrdEvent, requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => {
      const resolvedTarget = typeof responseTarget === 'function' ? responseTarget(request) : responseTarget
      if (request.action === 'inspect_parent') connector.bindBrowserTarget(request.runId, resolvedTarget)
      const envelope = releaseError && request.action === 'release'
        ? { error: releaseError }
        : { result: request.action === 'release' ? { status: 'ok', parent: request.parent } : responder(request) }
      assert.equal(connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: resolvedTarget, ...envelope }), true, `Connector rejected ${request.action}`)
    })
  } })
  connector.bindBrowserTarget('batch-run', target)
  const endpoint = await connector.start()
  const callTool = async (name, id, arguments_, meta) => {
    const owner = meta?.['io.deepseek.harness/parentSessionId'] ?? meta?.['io.deepseek.harness/sessionId']
    if (typeof owner === 'string') {
      const binding = connector.browserTargetRunBindings.current()
      assert.ok(binding?.runId && binding.browserTarget, 'test request requires a registered Browser Target before capture')
      assert.equal(connector.captureBrowserTarget(binding.runId, owner, `test-submission-${id}`, binding.browserTarget, binding.browserTargets, binding.unavailableBrowserTargets), true)
    }
    return (await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_, ...(meta === undefined ? {} : { _meta: meta }) } }), signal: AbortSignal.timeout(5_000) })).json()
  }
  const call = (id, arguments_, meta) => {
    const { action, parentFingerprint: _parentFingerprint, ...toolArguments } = arguments_
    const name = action === 'preview' ? 'team_knowledge_batch_preview' : action === 'create' ? 'team_knowledge_batch_create' : `team_knowledge_batch_${String(action)}`
    return callTool(name, id, toolArguments, meta)
  }
  return { connector, batchStore, teamDocStore, directory, requests, call, callTool }
}

async function preview(harness, batchId, items = documents, id = 1) { return harness.call(id, { action: 'preview', batchId, items }) }
async function create(harness, batchId, challenge, id = 2, meta) { return harness.call(id, { action: 'create', batchId, challenge }, meta) }
function recordPmdReviewAdoption(harness, body, sessionId = 'pmd-session') {
  const recorded = harness.connector.recordPmdPrdReviewAdoption({
    runId: 'batch-run', harnessSessionId: sessionId, reviewId: 'review-1', resourceId: 'resource-1',
    displayPath: 'pmd-workspace/spec/req-crm/REQ_CRM_PRD.md', revision: 'revision-1',
    fingerprint: 'a'.repeat(64), contentHash: createHash('sha256').update(body).digest('hex'),
  })
  assert.equal(recorded, true)
}
test('publishes, creates, reports status, and stores a body-free batch of light documents', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, String(++creates)))
  try {
    const list = await fetch(`${harness.connector.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${harness.connector.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(5_000) })
    const tools = (await list.json()).result.tools
    const previewTool = tools.find((candidate) => candidate.name === 'team_knowledge_batch_preview')
    const createTool = tools.find((candidate) => candidate.name === 'team_knowledge_batch_create')
    assert.equal(tools.some((candidate) => candidate.name === 'team_knowledge_batch'), false)
    assert.equal(tools.some((candidate) => candidate.name === 'team_knowledge_batch_status'), false)
    assert.deepEqual(harnessProjectedArguments(previewTool.inputSchema), { required: ['batchId', 'items'], properties: ['batchId', 'items'] })
    assert.deepEqual(previewTool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    assert.equal(previewTool.inputSchema.properties.items.maxItems, 10)
    assert.deepEqual(harnessProjectedArguments(createTool.inputSchema), { required: ['batchId', 'challenge'], properties: ['batchId', 'challenge'] })
    assert.match(createTool.description, /names and bodies must not be sent again/)
    const plan = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'batch-success', items: documents })
    const modelVisibleChallenge = plan.result.content[0].text.match(/创建凭证：([A-Za-z0-9_-]+)/)?.[1]
    assert.equal(modelVisibleChallenge, plan.result.structuredContent.challenge)
    assert.ok(plan.result.structuredContent.expiresAt - Date.now() > 9 * 60_000)
    const result = await harness.callTool('team_knowledge_batch_create', 2, { batchId: 'batch-success', challenge: modelVisibleChallenge })
    assert.equal(result.result.structuredContent.status, 'verified_write', JSON.stringify(result))
    assert.equal(result.result.content[0].text, '已完成 2 个子文档的创建、内容写入和回读验证。')
    assert.doesNotMatch(result.result.content[0].text, /team_knowledge_|partial_delivery/)
    assert.deepEqual(result.result.structuredContent.batch.items.map((item) => item.status), ['created', 'created'])
    assert.equal(result.result.structuredContent.batch.status, 'completed'); assert.equal(creates, 2)
    assert.deepEqual(harness.requests.filter((request) => request.tool === 'team_knowledge_batch').map((request) => [request.action, request.batchId, request.lease]), [
      ['inspect_parent', 'batch-success', 'acquire'],
      ['inspect_parent', 'batch-success', 'reuse'],
      ['create', 'batch-success', 'reuse'],
      ['create', 'batch-success', 'reuse'],
      ['release', 'batch-success', 'release'],
    ])
    const raw = await readFile(harness.batchStore.recordPath, 'utf8'); const itemRaw = await readFile(harness.teamDocStore.recordPath, 'utf8')
    assert.doesNotMatch(raw, /secret one|secret two|"body"/); assert.doesNotMatch(itemRaw, /secret one|secret two|"body"|observedBody/)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('lease cleanup failure never downgrades a verified or already-completed batch', async () => {
  let creates = 0
  const harness = await open(
    (request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, String(++creates)),
    (request) => request.browserTarget,
    { releaseError: 'session storage temporarily unavailable' },
  )
  try {
    const plan = await preview(harness, 'batch-release-failure')
    const completed = await create(harness, 'batch-release-failure', plan.result.structuredContent.challenge)
    assert.equal(completed.result.isError, undefined)
    assert.equal(completed.result.structuredContent.status, 'verified_write')
    const duplicate = await preview(harness, 'batch-release-failure', documents, 3)
    assert.equal(duplicate.result.isError, undefined)
    assert.equal(duplicate.result.structuredContent.status, 'already_completed')
    assert.equal(creates, 2)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('passes an independent visible user-confirmation context for every batch document', async () => {
  const confirmations = []
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    confirmations.push(request.userConfirmation)
    return verified(request, request.name === 'One' ? '101' : '102')
  })
  try {
    const plan = await preview(harness, 'batch-per-document-confirmation')
    const result = await create(harness, 'batch-per-document-confirmation', plan.result.structuredContent.challenge)
    assert.equal(result.result.structuredContent.status, 'verified_write', JSON.stringify(result))
    assert.deepEqual(confirmations, [
      { itemIndex: 1, totalItems: 2 },
      { itemIndex: 2, totalItems: 2 },
    ])
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('does not start the next document when the current document lacks user confirmation', async () => {
  const calls = []
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    calls.push(request.name)
    return { status: 'partial_delivery', item: { catalogId: '103', kind: 'light_document', name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/103?id=103', fingerprint: 'item-103' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'], failedAt: 'confirmation', error: 'team_knowledge_user_confirmation_stopped' }
  })
  try {
    const plan = await preview(harness, 'batch-stop-after-unconfirmed-document')
    const result = await create(harness, 'batch-stop-after-unconfirmed-document', plan.result.structuredContent.challenge)
    assert.equal(result.result.isError, true)
    assert.deepEqual(calls, ['One'])
    assert.deepEqual(result.result.structuredContent.batch.items.map((item) => item.status), ['failed', 'pending'])
    assert.match(result.result.content[0].text, /失败阶段：用户确认[\s\S]*尚未获得用户页面确认/)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects create-time item replay and does not create documents', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : (creates += 1, verified(request, '1')))
  try {
    const plan = await preview(harness, 'batch-drift')
    const response = await harness.call(2, { action: 'create', batchId: 'batch-drift', challenge: plan.result.structuredContent.challenge, items: documents })
    assert.equal(response.error.code, -32602); assert.equal(creates, 0)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('creates from the exact ephemeral preview snapshot without resending bodies', async () => {
  const requestedBodies = []
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    requestedBodies.push(request.body)
    return verified(request, String(requestedBodies.length))
  })
  try {
    const items = [{ name: 'Frozen one', body: '# Original one' }, { name: 'Frozen two', body: '# Original two' }]
    const plan = await preview(harness, 'batch-frozen', items)
    items[0].body = '# Mutated after preview'
    const response = await create(harness, 'batch-frozen', plan.result.structuredContent.challenge)
    assert.equal(response.result.structuredContent.status, 'verified_write')
    assert.deepEqual(requestedBodies, ['# Original one', '# Original two'])
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('fails safely when the ephemeral preview snapshot is unavailable', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++creates, verified(request, '1')))
  try {
    const plan = await preview(harness, 'batch-plan-missing')
    harness.connector.teamKnowledgeBatchChallenges.clear()
    const response = await create(harness, 'batch-plan-missing', plan.result.structuredContent.challenge)
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /team_knowledge_batch_approval_missing_or_already_used/)
    assert.equal(creates, 0)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('distinguishes an expired Approval Grant and never reaches creation', async () => {
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++creates, verified(request, '1')))
  try {
    const plan = await preview(harness, 'batch-expired')
    harness.connector.teamKnowledgeBatchChallenges.get(plan.result.structuredContent.challenge).expiresAt = Date.now() - 1
    const response = await create(harness, 'batch-expired', plan.result.structuredContent.challenge)
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /team_knowledge_batch_approval_expired/)
    assert.equal(creates, 0)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('resumes only failed items and accepts a completed duplicate without duplicate creates', async () => {
  const calls = []; let twoAttempts = 0
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    calls.push(request.name)
    if (request.name === 'Two' && ++twoAttempts === 1) return { status: 'partial_delivery', item: { catalogId: '2', kind: 'light_document', name: 'Two', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2?id=2', fingerprint: 'item-2' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'], failedAt: 'readback', error: 'team_knowledge_webedit_frame_unavailable', diagnostic: { httpStatus: 200, errorCode: '20001' } }
    return verified(request, request.name === 'One' ? '1' : '2')
  })
  try {
    const first = await preview(harness, 'batch-recover'); const partial = await create(harness, 'batch-recover', first.result.structuredContent.challenge)
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    assert.match(partial.result.content[0].text, /完成 1\/2 个子文档[\s\S]*失败阶段：内容回读[\s\S]*可重试：是[\s\S]*避免盲目重试/)
    assert.doesNotMatch(partial.result.content[0].text, /team_knowledge_|partial_delivery/)
    assert.deepEqual(partial.result.structuredContent.batch.items.map((item) => item.status), ['created', 'failed'])
    const retry = await preview(harness, 'batch-recover', documents, 3); const done = await create(harness, 'batch-recover', retry.result.structuredContent.challenge, 4)
    assert.equal(done.result.structuredContent.status, 'verified_write'); assert.deepEqual(calls, ['One', 'Two', 'Two'])
    const duplicate = await preview(harness, 'batch-recover', documents, 5); assert.equal(duplicate.result.structuredContent.status, 'already_completed')
    assert.equal(harness.requests.filter((request) => request.action === 'release' && request.batchId === 'batch-recover' && request.lease === 'release').length, 2)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('resumes only the failed item when the same tab remains on its created document', async () => {
  const documentTarget = { ...target, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2?id=2' }
  const calls = []; let inspectCount = 0; let twoAttempts = 0
  const harness = await open((request) => {
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    calls.push(request.name)
    if (request.name === 'Two' && ++twoAttempts === 1) return {
      status: 'partial_delivery',
      item: { catalogId: '2', kind: 'light_document', name: 'Two', url: documentTarget.url, fingerprint: 'item-2' },
      stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'],
      failedAt: 'readback',
      error: 'team_knowledge_document_persisted_readback_mismatch',
    }
    return verified(request, request.name === 'One' ? '1' : '2')
  }, (request) => request.action === 'inspect_parent' && ++inspectCount >= 3 ? documentTarget : request.browserTarget)
  try {
    const first = await preview(harness, 'batch-recover-after-navigation')
    const partial = await create(harness, 'batch-recover-after-navigation', first.result.structuredContent.challenge)
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    const retry = await preview(harness, 'batch-recover-after-navigation', documents, 3)
    assert.equal(typeof retry.result.structuredContent.challenge, 'string')
    const done = await create(harness, 'batch-recover-after-navigation', retry.result.structuredContent.challenge, 4)
    assert.equal(done.result.structuredContent.status, 'verified_write')
    assert.deepEqual(calls, ['One', 'Two', 'Two'])
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects a partial retry when the Browser Target moves to another tab', async () => {
  const otherTab = { ...target, tabId: 99, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/2?id=2' }
  let inspectCount = 0; let attempts = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++attempts, {
        status: 'partial_delivery',
        item: { catalogId: '2', kind: 'light_document', name: request.name, url: request.browserTarget.url, fingerprint: 'item-2' },
        stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'],
        failedAt: 'readback',
        error: 'team_knowledge_document_persisted_readback_mismatch',
      }), (request) => request.action === 'inspect_parent' && ++inspectCount >= 3 ? otherTab : request.browserTarget)
  try {
    const items = [{ name: 'One', body: '# One' }]
    const first = await preview(harness, 'batch-reject-other-tab', items)
    const partial = await create(harness, 'batch-reject-other-tab', first.result.structuredContent.challenge)
    assert.equal(partial.result.structuredContent.status, 'partial_delivery')
    const retry = await preview(harness, 'batch-reject-other-tab', items, 3)
    assert.equal(retry.result.isError, true)
    assert.match(retry.result.content[0].text, /Browser Target changed/)
    assert.equal(attempts, 1)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('serializes concurrent confirmed creates and accepts exactly ten items', async () => {
  let creates = 0
  const ten = Array.from({ length: 10 }, (_, index) => ({ name: `Doc ${index + 1}`, body: `body ${index + 1}` }))
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : (creates += 1, verified(request, String(creates))))
  try {
    const first = await preview(harness, 'batch-concurrent', ten); const second = await preview(harness, 'batch-concurrent', ten, 2)
    const [left, right] = await Promise.all([create(harness, 'batch-concurrent', first.result.structuredContent.challenge, 3), create(harness, 'batch-concurrent', second.result.structuredContent.challenge, 4)])
    assert.equal(left.result.structuredContent.status, 'verified_write'); assert.equal(right.result.structuredContent.status, 'verified_write'); assert.equal(creates, 10)
    const tooMany = await preview(harness, 'batch-too-many', [...ten, { name: 'Doc 11', body: 'body 11' }], 5)
    assert.equal(tooMany.error.code, -32602)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects non-canonical duplicate names before preview', async () => {
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    const response = await preview(harness, 'batch-spaces', [{ name: 'Doc', body: 'one' }, { name: 'Doc ', body: 'two' }])
    assert.equal(response.error.code, -32602)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('rejects a PMD batch without a valid PRD identity title', async () => {
  let inspections = 0
  const harness = await open((request) => { inspections += 1; return request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1') })
  try {
    const response = await preview(harness, 'pmd:req-crm', [{ name: 'REQ_CRM_PRD', body: '# 客户管理 PRD' }])
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /pmd_prd_template_invalid/)
    assert.equal(inspections, 0, 'invalid PMD bodies must fail before inspecting or mutating a Browser Target')
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('allows a .java locator in a PMD requirement development location', async () => {
  const body = await authoritativePmdBody()
  const items = [{ name: 'REQ_CRM_PRD', body }]
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    recordPmdReviewAdoption(harness, body)
    const response = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'pmd:req-code-locator', items }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(response.result.isError, undefined, JSON.stringify(response))
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('leaves PMD content semantics to the reviewed Skill output', async () => {
  const body = `${await authoritativePmdBody()}\n\n## 第八章伪定位\n\n| 定位项 | 位置 |\n|---|---|\n| 前端代码文件 | src/contracts/ContractDetail.java |`
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    recordPmdReviewAdoption(harness, body)
    const response = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'pmd:req-fake-locator', items: [{ name: 'REQ_CRM_PRD', body }] }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(response.result.isError, undefined, JSON.stringify(response))
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('creates the exact adopted PMD directly without a model receipt or page confirmation', async () => {
  const prdBody = await authoritativePmdBody()
  const events = []
  const harness = await open(
    (request) => request.action === 'inspect_parent'
      ? { status: 'ok', parent, capabilities: { light_document: true } }
      : { ...verified(request, '1'), readback: { body: visibleMarkdownReadback(request.body) } },
    (request) => request.browserTarget,
    { reportPrdEvent: async (event) => { events.push(event) } },
  )
  try {
    const items = [{ name: 'REQ_CRM_PRD', body: prdBody }]
    const missing = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'pmd:req-crm', items }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(missing.result.isError, true)
    assert.match(missing.result.content[0].text, /pmd_prd_review_adoption_required/)
    recordPmdReviewAdoption(harness, prdBody)
    const plan = await harness.callTool('team_knowledge_batch_preview', 2, { batchId: 'pmd:req-crm', items }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(plan.result.isError, undefined)
    const inspection = harness.requests.find((request) => request.action === 'inspect_parent' && request.batchId === 'pmd:req-crm')
    assert.equal(inspection.pmdReviewAdoption.contentHash, createHash('sha256').update(prdBody).digest('hex'))
    const result = await create(harness, 'pmd:req-crm', plan.result.structuredContent.challenge, 3, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(result.result.structuredContent.status, 'verified_write', JSON.stringify(result))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(events[0]?.generationEventId, 'review:review-1:generated')
    const createRequest = harness.requests.find((request) => request.action === 'create' && request.batchId === 'pmd:req-crm')
    assert.equal(createRequest.userConfirmation, undefined)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('keeps PMD adoption bound to its session, exact body, and first batch id', async () => {
  const prdBody = await authoritativePmdBody()
  const items = [{ name: 'REQ_CRM_PRD', body: prdBody }]
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '1'))
  try {
    recordPmdReviewAdoption(harness, prdBody)
    harness.connector.bindBrowserTarget('batch-run-after-review', target)
    const changed = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'pmd:req-crm', items: [{ ...items[0], body: `${prdBody}\n` }] }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(changed.result.isError, true)
    assert.match(changed.result.content[0].text, /pmd_prd_review_adoption_content_changed/)
    const crossSession = await harness.callTool('team_knowledge_batch_preview', 2, { batchId: 'pmd:req-crm', items }, { 'io.deepseek.harness/sessionId': 'other-session' })
    assert.equal(crossSession.result.isError, true)
    assert.match(crossSession.result.content[0].text, /pmd_prd_review_adoption_required/)
    const first = await harness.callTool('team_knowledge_batch_preview', 3, { batchId: 'pmd:req-crm', items }, { 'io.deepseek.harness/sessionId': 'tool-session', 'io.deepseek.harness/parentSessionId': 'pmd-session' })
    assert.equal(first.result.isError, undefined)
    const otherBatch = await harness.callTool('team_knowledge_batch_preview', 4, { batchId: 'pmd:req-other', items }, { 'io.deepseek.harness/sessionId': 'pmd-session' })
    assert.equal(otherBatch.result.isError, true)
    assert.match(otherBatch.result.content[0].text, /pmd_prd_review_adoption_batch_changed/)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('reports a body-free online-document event after every batch Verified Write', async () => {
  const events = []
  const harness = await open(
    (request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : { ...verified(request, '701'), readback: { body: visibleMarkdownReadback(request.body) } },
    (request) => request.browserTarget,
    { reportPrdEvent: async (event) => { events.push(event) } },
  )
  try {
    const items = [{ name: '普通在线文档', body: '# 内容' }]
    const plan = await harness.callTool('team_knowledge_batch_preview', 1, { batchId: 'batch:req-telemetry', items }, { 'io.deepseek.harness/sessionId': 'document-session' })
    const result = await create(harness, 'batch:req-telemetry', plan.result.structuredContent.challenge, 2, { 'io.deepseek.harness/sessionId': 'document-session' })
    assert.equal(result.result.structuredContent.status, 'verified_write', JSON.stringify(result))
    assert.equal(events.length, 1)
    assert.deepEqual({ ...events[0], occurredAt: '<time>', eventId: '<id>' }, {
      eventId: '<id>', eventType: 'document_published', outcome: 'succeeded', occurredAt: '<time>', sessionId: 'document-session', runId: 'batch-run', batchId: 'batch:req-telemetry', itemIndex: 0,
      documentName: '普通在线文档', documentCatalogId: '701', documentUrl: 'https://doc.midea.com/teamKnowledge/detail/docOnline/701?id=701',
    })
    assert.equal('body' in events[0], false)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('does not complete a batch from a schema-valid result for the wrong item', async () => {
  const harness = await open((request) => request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : {
    status: 'verified_write', item: { catalogId: '77', kind: 'spreadsheet', name: 'Wrong', url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/77?id=77', fingerprint: 'wrong-77' },
    stages: ['parent_inspected', 'created', 'rediscovered', 'identity_readback_verified'], readback: { resource: {} },
  })
  try {
    const plan = await preview(harness, 'batch-wrong-item', [{ name: 'Right', body: '# Right' }])
    const response = await create(harness, 'batch-wrong-item', plan.result.structuredContent.challenge)
    assert.equal(response.result.structuredContent.status, 'partial_delivery')
    assert.equal(response.result.structuredContent.batch.items[0].status, 'failed')
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('accepts a semantic light-document readback instead of requiring raw Markdown bytes', async () => {
  const markdown = '# Release plan\n\n## 1. Background\n\n1. Create\n2. Read back\n\n> Verified'
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : { ...verified(request, '88'), readback: { body: 'Release plan\nBackground\nCreate\nRead back\nVerified' } })
  try {
    const items = [{ name: 'Release plan', body: markdown }]
    const plan = await preview(harness, 'batch-semantic-readback', items)
    const response = await create(harness, 'batch-semantic-readback', plan.result.structuredContent.challenge)
    assert.equal(response.result.structuredContent.status, 'verified_write')
    assert.equal(response.result.structuredContent.batch.items[0].status, 'created')
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('reports a non-retryable item failure and does not blindly retry it', async () => {
  let createAttempts = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (++createAttempts, { status: 'partial_delivery', item: null, stages: ['parent_inspected'], failedAt: 'create', error: 'team_doc_exact_name_conflict' }))
  try {
    const items = [{ name: 'Duplicate', body: '# Duplicate' }]
    const first = await preview(harness, 'batch-non-retryable', items)
    const failed = await create(harness, 'batch-non-retryable', first.result.structuredContent.challenge)
    assert.match(failed.result.content[0].text, /Duplicate：失败阶段：创建；原因：服务端返回的结果无法安全确认[\s\S]*可重试：否/)
    const second = await preview(harness, 'batch-non-retryable', items, 3)
    const resumed = await create(harness, 'batch-non-retryable', second.result.structuredContent.challenge, 4)
    assert.equal(resumed.result.structuredContent.status, 'partial_delivery')
    assert.equal(createAttempts, 1)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('resumes the same document when persisted reopen readback is empty once', async () => {
  let createAttempts = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : ++createAttempts === 1
      ? { status: 'partial_delivery', item: { catalogId: '91', kind: 'light_document', name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/91?id=91', fingerprint: 'item-91' }, stages: ['parent_inspected', 'created', 'rediscovered', 'body_written'], failedAt: 'readback', error: 'team_knowledge_document_persisted_readback_mismatch' }
      : verified(request, '91'))
  try {
    const items = [{ name: 'Persisted retry', body: '# Persisted retry' }]
    const first = await preview(harness, 'batch-persisted-retry', items)
    const failed = await create(harness, 'batch-persisted-retry', first.result.structuredContent.challenge)
    assert.match(failed.result.content[0].text, /重新打开后未读到已持久化的正文[\s\S]*可重试：是/)
    const second = await preview(harness, 'batch-persisted-retry', items, 3)
    const resumed = await create(harness, 'batch-persisted-retry', second.result.structuredContent.challenge, 4)
    assert.equal(resumed.result.structuredContent.status, 'verified_write')
    assert.equal(createAttempts, 2)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('resumes the same empty document after the exact batch replace invalid-range failure', async () => {
  let createAttempts = 0
  const recoveries = []
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : (recoveries.push(request.recovery), ++createAttempts === 1)
      ? { status: 'partial_delivery', item: { catalogId: '92', kind: 'light_document', name: request.name, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/92?id=92', fingerprint: 'item-92' }, stages: ['parent_inspected', 'created', 'rediscovered'], failedAt: 'readback', error: 'team_doc_batch_replace_invalid_range' }
      : verified(request, '92'))
  try {
    const items = [{ name: 'Empty PRD recovery', body: '# Empty PRD recovery' }]
    const first = await preview(harness, 'batch-empty-prd-retry', items)
    const failed = await create(harness, 'batch-empty-prd-retry', first.result.structuredContent.challenge)
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /^未完成：/)
    assert.match(failed.result.content[0].text, /新建空白文档没有可替换的标题区块[\s\S]*可重试：是/)
    const second = await preview(harness, 'batch-empty-prd-retry', items, 3)
    const resumed = await create(harness, 'batch-empty-prd-retry', second.result.structuredContent.challenge, 4)
    assert.equal(resumed.result.structuredContent.status, 'verified_write')
    assert.equal(createAttempts, 2)
    assert.equal(recoveries[0], undefined)
    assert.deepEqual(recoveries[1], { catalogId: '92', stages: ['parent_inspected', 'created', 'rediscovered'] })
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('fences generic light-document mutations for an incomplete batch target, but permits reads and same-batch recovery', async () => {
  const documentTarget = { ...target, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/92?id=92' }
  let createAttempts = 0
  const genericRequests = []
  const harness = await open((request) => {
    if (request.tool === 'light_document') {
      genericRequests.push(request)
      return lightDocumentRead(request)
    }
    if (request.action === 'inspect_parent') return { status: 'ok', parent, capabilities: { light_document: true } }
    return ++createAttempts === 1
      ? { status: 'partial_delivery', item: { catalogId: '92', kind: 'light_document', name: request.name, url: documentTarget.url, fingerprint: 'item-92' }, stages: ['parent_inspected', 'created', 'rediscovered'], failedAt: 'readback', error: 'team_doc_readback_mismatch' }
      : verified(request, '92')
  })
  try {
    const items = [{ name: 'Empty PRD recovery', body: '# Empty PRD recovery' }]
    const first = await preview(harness, 'batch-empty-prd-fence', items)
    const failed = await create(harness, 'batch-empty-prd-fence', first.result.structuredContent.challenge)
    assert.equal(failed.result.structuredContent.status, 'partial_delivery')
    assert.match(failed.result.content[0].text, /可重试：是/)
    assert.equal(failed.result.structuredContent.batch.items[0].retryable, true)

    harness.connector.bindBrowserTarget('batch-run', documentTarget)
    const read = await harness.callTool('light_document_read', 3, {})
    assert.equal(read.result.structuredContent.status, 'ok', 'reads remain available for diagnosis')
    for (const [name, arguments_] of [
      ['light_document_write_preview', { operation: 'blocks_insert', payload: { blocks: [{ type: 'p', text: '不得绕过批量恢复' }] } }],
      ['light_document_write_commit', { challenge: 'stale-generic-challenge' }],
      ['light_document_selection_replace_preview', { blocks: [{ type: 'p', text: '不得绕过批量恢复' }] }],
      ['light_document_selection_replace_commit', { challenge: 'stale-selection-challenge' }],
    ]) {
      const blocked = await harness.callTool(name, 4 + genericRequests.length, arguments_)
      assert.equal(blocked.result.isError, true, `${name} must fail closed`)
      assert.match(blocked.result.content[0].text, /team_knowledge_batch_incomplete_write_fence[\s\S]*batch-empty-prd-fence/)
    }
    assert.equal(genericRequests.length, 1, 'only the read may reach the Extension while recovery is incomplete')

    const second = await preview(harness, 'batch-empty-prd-fence', items, 9)
    const resumed = await create(harness, 'batch-empty-prd-fence', second.result.structuredContent.challenge, 10)
    assert.equal(resumed.result.structuredContent.status, 'verified_write')
    assert.equal(createAttempts, 2)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('does not fence stage-eight selection edits after the batch is fully completed', async () => {
  const documentTarget = { ...target, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/93?id=93' }
  const genericRequests = []
  const harness = await open((request) => {
    if (request.tool === 'light_document') {
      genericRequests.push(request)
      return lightDocumentRead(request)
    }
    return request.action === 'inspect_parent' ? { status: 'ok', parent, capabilities: { light_document: true } } : verified(request, '93')
  })
  try {
    const items = [{ name: 'Completed PRD', body: '# Completed PRD' }]
    const first = await preview(harness, 'batch-completed-stage-eight', items)
    const completed = await create(harness, 'batch-completed-stage-eight', first.result.structuredContent.challenge)
    assert.equal(completed.result.structuredContent.status, 'verified_write')
    harness.connector.bindBrowserTarget('batch-run', documentTarget)
    const previewSelectionEdit = await harness.callTool('light_document_selection_replace_preview', 3, { blocks: [{ type: 'p', text: '阶段8选区更新' }] })
    assert.equal(previewSelectionEdit.result.isError, undefined)
    assert.equal(typeof previewSelectionEdit.result.structuredContent.challenge, 'string')
    const commitSelectionEdit = await harness.callTool('light_document_selection_replace_commit', 4, { challenge: previewSelectionEdit.result.structuredContent.challenge })
    assert.equal(commitSelectionEdit.result.structuredContent.status, 'verified_write')
    assert.deepEqual(genericRequests.map((request) => request.action), ['selection', 'write'])
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})

test('keeps the incomplete-batch write fence after a Native Connector restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'team-knowledge-batch-fence-restart-'))
  const batchStore = new TeamKnowledgeBatchRecordStore({ recordPath: join(directory, 'batch.json') })
  const documentTarget = { ...target, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/94?id=94' }
  await batchStore.create({
    batchId: 'batch-persisted-fence', targetFingerprint: 'target-fingerprint', contentFingerprint: 'content-fingerprint',
    items: [{ index: 0, name: 'Interrupted PRD', idempotencyIdentity: 'batch-item-94', contentHash: 'content-hash', status: 'failed', catalogId: '94', stages: ['parent_inspected', 'created', 'rediscovered'], error: 'team_doc_batch_replace_invalid_range' }],
  })
  let extensionRequests = 0
  const connector = new BrowserConnector({ teamKnowledgeBatchStore: batchStore, requestExtension: () => { extensionRequests += 1 } })
  connector.bindBrowserTarget('restarted-batch-run', documentTarget)
  const endpoint = await connector.start()
  try {
    const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'light_document_write_preview', arguments: { operation: 'blocks_insert', payload: { blocks: [{ type: 'p', text: '不得绕过恢复' }] } } } }), signal: AbortSignal.timeout(5_000) })
    const blocked = await response.json()
    assert.equal(blocked.result.isError, true)
    assert.match(blocked.result.content[0].text, /team_knowledge_batch_incomplete_write_fence[\s\S]*batch-persisted-fence/)
    assert.equal(extensionRequests, 0)
  } finally { await connector.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('rejects an inspect response that tries to migrate a batch to another tab', async () => {
  const migrated = { browser: 'chrome', windowId: 1, tabId: 7, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/9?id=9' }
  let creates = 0
  const harness = await open((request) => request.action === 'inspect_parent'
    ? { status: 'ok', parent, capabilities: { light_document: true } }
    : verified(request, String(++creates)), migrated)
  try {
    const plan = await preview(harness, 'migrated-batch', documents, 1)
    assert.equal(plan.result.isError, true)
    assert.match(plan.result.content[0].text, /Browser Target changed/)
    assert.equal(creates, 0)
  } finally { await harness.connector.stop(); await rm(harness.directory, { recursive: true, force: true }) }
})
