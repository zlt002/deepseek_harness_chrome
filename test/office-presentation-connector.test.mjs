import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserConnector } from '../apps/native-server/src/connector.mjs'
import { CONNECTOR_TOOLS, PRESENTATION_WRITE_ACTIONS, PRESENTATION_WRITE_OPERATIONS, PRESENTATION_WRITE_PAYLOAD_FIELDS } from '../apps/native-server/src/transport/connector-tool-catalog.mjs'
import { OfficeDocumentWriteRecordStore } from '../apps/native-server/src/office/office-document-write-record-store.mjs'

async function call(endpoint, name, arguments_, id = 1) {
  const response = await fetch(`${endpoint.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) })
  return response.json()
}

function previewSummary(payloadKeys = []) {
  return { payloadKeys, target: {}, effect: {} }
}

function capabilitiesResult(resource, { renderScene = false } = {}) {
  return {
    ready: true,
    capabilities: {
      slides: true, context: true, objects: true, selection: true, text: true,
      save: true, export: false, tables: true, charts: false, notes: true,
      comments: false, metadata: false, structure: false,
      ...(renderScene ? { render_scene: true } : {}),
    },
    methods: ['slides:getSlides', 'save:save', ...(renderScene ? ['render_scene:Shapes.AddTextbox'] : [])],
    operations: Object.fromEntries(PRESENTATION_WRITE_OPERATIONS.map((operation) => [operation, { actions: operation === 'manage_slides' ? ['add'] : operation === 'save' ? ['save'] : renderScene && operation === 'render_scene' ? ['replace_scene'] : [] }])),
    resource,
  }
}

test('presentation_get_capabilities is a no-argument resource-bound read through inspect_capabilities', async () => {
  const tool = CONNECTOR_TOOLS.find((candidate) => candidate.name === 'presentation_get_capabilities')
  const previewTool = CONNECTOR_TOOLS.find((candidate) => candidate.name === 'presentation_write_preview')
  assert.deepEqual(tool.inputSchema, { type: 'object', additionalProperties: false, properties: {} })
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  for (const [operation, actions] of Object.entries(PRESENTATION_WRITE_ACTIONS)) {
    assert.match(previewTool.inputSchema.properties.payload.description, new RegExp(operation))
    for (const action of actions) assert.match(previewTool.inputSchema.properties.payload.description, new RegExp(action))
  }

  const target = { browser: 'chrome', windowId: 4, tabId: 93, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/93?id=93' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '能力探测.pptx', documentId: '93', path: '/weboffice/office/p/93', slideCount: 2, fingerprint: 'ppt-capabilities-93' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
      browserTarget: request.browserTarget, result: capabilitiesResult(resource, { renderScene: true }),
    }))
  } })
  connector.bindBrowserTarget('presentation-capabilities-run', target); const endpoint = await connector.start()
  try {
    const response = await call(endpoint, 'presentation_get_capabilities', {})
    assert.equal(requests.length, 1)
    assert.equal(requests[0].action, 'inspect_capabilities')
    assert.equal(requests[0].tool, 'presentation')
    assert.equal(Object.hasOwn(requests[0], 'resource'), false)
    assert.deepEqual(response.result.structuredContent.resource, resource)
    assert.deepEqual(response.result.structuredContent.operations.save.actions, ['save'])
    assert.deepEqual(response.result.structuredContent.operations.manage_slides.actions, ['add'])
    assert.equal(response.result.structuredContent.capabilities.render_scene, true)
    assert.deepEqual(response.result.structuredContent.operations.render_scene.actions, ['replace_scene'])
    assert.ok(response.result.structuredContent.methods.includes('render_scene:Shapes.AddTextbox'))

    const rejected = await call(endpoint, 'presentation_get_capabilities', { browserTarget: target }, 2)
    assert.equal(rejected.error.code, -32602)
    assert.equal(requests.length, 1, 'model-supplied targets must be rejected before Extension dispatch')
  } finally { await connector.stop() }
})

test('an empty presentation exposes capabilities and previews only its first-slide add', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 94, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/94?id=94' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '空白演示.pptx', documentId: '94', path: '/weboffice/office/p/94', slideCount: 0, fingerprint: 'ppt-empty-94' }
  const afterResource = { ...resource, slideCount: 1, fingerprint: 'ppt-empty-94-after-add' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    const result = request.action === 'inspect_capabilities' ? capabilitiesResult(resource)
      : request.action === 'write' ? { status: 'verified_write', operation: request.operation, resource: afterResource, observed: { currentSlide: 0, slideCount: 1, verified: true, resource: afterResource } }
        : { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 0, currentSlide: null, activeSlide: null, slide: null, target: null, selection: null, operationState: [] }, summary: previewSummary(Object.keys(request.payload)) }
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
      browserTarget: request.browserTarget, result,
    }))
  } })
  connector.bindBrowserTarget('presentation-empty-run', target); const endpoint = await connector.start()
  try {
    const capabilities = await call(endpoint, 'presentation_get_capabilities', {})
    assert.equal(capabilities.result.isError, undefined, JSON.stringify(capabilities.result))
    assert.deepEqual(capabilities.result.structuredContent.resource, resource)
    assert.deepEqual(capabilities.result.structuredContent.operations.manage_slides.actions, ['add'])

    const preview = await call(endpoint, 'presentation_write_preview', { operation: 'manage_slides', payload: { action: 'add', index: -1 } }, 2)
    assert.equal(preview.result.isError, undefined, JSON.stringify(preview.result))
    assert.equal(preview.result.structuredContent.resource.slideCount, 0)
    assert.equal(preview.result.structuredContent.operation, 'manage_slides')

    const committed = await call(endpoint, 'presentation_write_commit', { challenge: preview.result.structuredContent.challenge }, 3)
    assert.equal(committed.result.isError, undefined, JSON.stringify(committed.result))
    assert.equal(committed.result.structuredContent.resource.slideCount, 1)
    assert.equal(requests[2].action, 'write')
    assert.equal(requests[2].resource.slideCount, 0)
    assert.equal(requests[2].precondition.slideCount, 0)
  } finally { await connector.stop() }
})

test('presentation_get_capabilities rejects unbounded or unbound runtime results', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 92, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/92?id=92' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '边界.pptx', slideCount: 1, fingerprint: 'ppt-capabilities-92' }
  let attempt = 0
  const connector = new BrowserConnector({ requestExtension: (request) => {
    attempt += 1
    const result = capabilitiesResult(resource)
    if (attempt === 1) delete result.resource
    else if (attempt === 2) result.methods = ['x'.repeat(129)]
    else result.operations.manage_slides.actions = ['generic_script']
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
  } })
  connector.bindBrowserTarget('presentation-capabilities-bounds-run', target); const endpoint = await connector.start()
  try {
    for (let id = 1; id <= 3; id += 1) {
      const response = await call(endpoint, 'presentation_get_capabilities', {}, id)
      assert.equal(response.result.isError, true)
      assert.match(response.result.content[0].text, /invalid presentation result/)
    }
  } finally { await connector.stop() }
})

test('presentation_get_capabilities preserves the runtime failure code and message', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 91, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/91?id=91' }
  const connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation,
    browserTarget: request.browserTarget, error: { code: 'unsupported', message: 'WebEdit presentation capability inspection is unavailable' },
  })) })
  connector.bindBrowserTarget('presentation-capabilities-error-run', target); const endpoint = await connector.start()
  try {
    const response = await call(endpoint, 'presentation_get_capabilities', {})
    assert.equal(response.result.isError, true)
    assert.match(response.result.content[0].text, /\"code\":\"unsupported\"/)
    assert.match(response.result.content[0].text, /capability inspection is unavailable/)
  } finally { await connector.stop() }
})

test('presentation preview requires explicit slide/object targets and accepts numeric chart strings', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 911, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/911?id=911' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '显式目标.pptx', documentId: '911', path: '/weboffice/office/p/911', slideCount: 2, fingerprint: 'ppt-explicit-911' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => {
    requests.push(request)
    queueMicrotask(() => connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint }, summary: previewSummary(Object.keys(request.payload)) },
    }))
  } })
  connector.bindBrowserTarget('presentation-explicit-target-run', target); const endpoint = await connector.start()
  try {
    const missingSlide = await call(endpoint, 'presentation_write_preview', { operation: 'edit_selection', payload: { action: 'update', edit: { x: 1 } } })
    const missingObject = await call(endpoint, 'presentation_write_preview', { operation: 'manage_objects', payload: { action: 'delete', slideIndex: 0 } }, 2)
    const missingTextBox = await call(endpoint, 'presentation_write_preview', { operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, text: 'x' } }, 3)
    for (const result of [missingSlide, missingObject, missingTextBox]) assert.equal(result.error.code, -32602)
    assert.equal(requests.length, 0, 'invalid target-free requests must not reach a runtime that could choose the first object')

    const chart = await call(endpoint, 'presentation_write_preview', { operation: 'manage_charts', payload: { action: 'insert', slideIndex: 0, chartType: '51', left: 1, top: 2, width: 30, height: 20 } }, 4)
    assert.equal(chart.result.isError, undefined)
    assert.deepEqual(requests[0].payload.chartType, '51', 'the runtime receives the documented numeric string and normalizes it to its Number enum')
    assert.equal(chart.result.structuredContent.summary.confirmation.chart.chartType, 51)
    for (const [operation, payload] of [
      ['manage_tables', { action: 'insert', slideIndex: 0, rows: 1, columns: 1, left: 1, top: 2, width: 3, height: 4, useScale: true }],
      ['manage_charts', { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 3, height: 4, chartStyle: 240 }],
      ['render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'x', left: 1, top: 2, width: 3, height: 4, color: '#f00' }] }],
    ]) {
      const rejected = await call(endpoint, 'presentation_write_preview', { operation, payload }, requests.length + 10)
      assert.equal(rejected.error.code, -32602, operation)
    }
  } finally { await connector.stop() }
})

test('presentation connector rejects unknown top-level fields for every published action before runtime dispatch', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 912, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/912?id=912' }
  const requests = []
  const connector = new BrowserConnector({ requestExtension: (request) => { requests.push(request) } })
  connector.bindBrowserTarget('presentation-unknown-fields-run', target); const endpoint = await connector.start()
  const examples = {
    'manage_slides:add': { action: 'add' }, 'manage_slides:delete': { action: 'delete', slideIndex: 0 }, 'manage_slides:select': { action: 'select', slideIndex: 0 },
    'render_scene:replace_scene': { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'x', left: 1, top: 2, width: 3, height: 4 }] },
    'render_slide_visual:replace_visual': { action: 'replace_visual', slideIndex: 0, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', left: 0, top: 0, width: 960, height: 540 },
    'edit_selection:update': { action: 'update', slideIndex: 0, edit: { x: 1 } },
    'manage_objects:delete': { action: 'delete', slideIndex: 0, objectIndex: 0 }, 'manage_objects:update': { action: 'update', slideIndex: 0, objectIndex: 0, object: { x: 1 } },
    'manage_tables:insert': { action: 'insert', slideIndex: 0, rows: 1, columns: 1, left: 1, top: 2, width: 3, height: 4 },
    'manage_charts:insert': { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 3, height: 4 },
    'manage_notes:replace': { action: 'replace', slideIndex: 0, text: 'x' }, 'manage_comments:add': { action: 'add', slideIndex: 0, text: 'x' },
    'manage_metadata:set_builtin': { action: 'set_builtin', name: 'Title', value: 'x' },
    'manage_structure:move_slide': { action: 'move_slide', slideIndex: 0, toIndex: 1 }, 'manage_structure:move_section': { action: 'move_section', sectionIndex: 0, toPos: 1 },
    'replace_text_box:replace': { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: 'x' }, 'save:save': { action: 'save' },
  }
  try {
    assert.deepEqual(Object.keys(examples).sort(), Object.keys(PRESENTATION_WRITE_PAYLOAD_FIELDS).sort())
    let id = 1
    for (const [key, payload] of Object.entries(examples)) {
      const [operation] = key.split(':')
      const rejected = await call(endpoint, 'presentation_write_preview', { operation, payload: { ...payload, unapproved: true } }, id++)
      assert.equal(rejected.error.code, -32602, key)
    }
    for (const [operation, payload] of [
      ['edit_selection', { action: 'update', slideIndex: 0, edit: { x: 1, styleMode: true } }],
      ['manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: { x: 1, styleMode: true } }],
    ]) {
      const rejected = await call(endpoint, 'presentation_write_preview', { operation, payload }, id++)
      assert.equal(rejected.error.code, -32602, operation)
    }
    assert.equal(requests.length, 0, 'unknown payload fields must not reach the presentation runtime')
  } finally { await connector.stop() }
})

test('presentation previews through inspect_write and commits only a bound verified write', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 94, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/94?id=94' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', documentName: '计划.pptx', documentId: '94', path: '/editor', fingerprint: 'ppt-before' }
  const requests = []
  const connector = new BrowserConnector({ officeDocumentWriteStore: new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-presentation-${randomUUID()}.json`) }), requestExtension: (request) => {
    requests.push(request)
    const result = request.action === 'write'
      ? (() => { const after = { ...resource, fingerprint: 'ppt-after' }; return { status: 'verified_write', operation: request.operation, resource: after, observed: { verified: true, resource: after, slideCount: 2 } } })()
      : request.action === 'inspect_write'
        ? { status: 'ok', resource: { ...resource, slideCount: 2 }, operation: request.operation, precondition: { resourceFingerprint: 'ppt-before', slideCount: 2, operationNonce: 'inspect-94' }, summary: previewSummary(Object.keys(request.payload)) }
      : { status: 'ok', resource, slideCount: 2, currentSlide: 0, objects: [] }
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
  } })
  connector.bindBrowserTarget('presentation-run', target); const endpoint = await connector.start()
  try {
    const payload = { action: 'delete', slideIndex: 0, objectIndex: 0 }
    const preview = await call(endpoint, 'presentation_write_preview', { operation: 'manage_objects', payload })
    const challenge = preview.result.structuredContent.challenge
    assert.equal(requests[0].action, 'inspect_write')
    assert.equal(requests[0].operation, 'manage_objects')
    assert.deepEqual(requests[0].payload, payload)
    assert.deepEqual(preview.result.structuredContent.summary, {
      operation: 'manage_objects', target: { slideIndex: 0, objectIndex: 0 },
      requested: { keys: ['action', 'slideIndex', 'objectIndex'], fieldCount: 3, shapes: { action: 'text(6)', slideIndex: 'number', objectIndex: 'number' } },
      runtime: previewSummary(['action', 'slideIndex', 'objectIndex']),
      confirmation: { action: 'delete', target: { slideIndex: 0, objectIndex: 0 }, runtime: previewSummary(['action', 'slideIndex', 'objectIndex']) },
    })
    assert.equal(Object.hasOwn(preview.result.structuredContent, 'precondition'), false)
    const committed = await call(endpoint, 'presentation_write_commit', { challenge }, 2)
    assert.equal(committed.result.structuredContent.status, 'verified_write')
    assert.equal(requests.at(-1).tool, 'presentation')
    assert.deepEqual(requests.at(-1).precondition, { resourceFingerprint: 'ppt-before', slideCount: 2, operationNonce: 'inspect-94' })
    const replay = await call(endpoint, 'presentation_write_commit', { challenge }, 3)
    assert.equal(replay.result.isError, true)
  } finally { await connector.stop() }
})

test('presentation previews expose bounded confirmation details for tables, scenes, and added slides', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 940, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/940?id=940' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '可确认摘要.pptx', documentId: '940', path: '/weboffice/office/p/940', slideCount: 3, fingerprint: 'ppt-summary-940' }
  const connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
    result: { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint, operation: request.operation }, summary: previewSummary(Object.keys(request.payload)) },
  })) })
  connector.bindBrowserTarget('presentation-summary-run', target); const endpoint = await connector.start()
  try {
    const table = await call(endpoint, 'presentation_write_preview', {
      operation: 'manage_tables',
      payload: { action: 'insert', slideIndex: 1, rows: 4, columns: 6, left: 10, top: 20, width: 300, height: 180 },
    })
    assert.deepEqual(table.result.structuredContent.summary.confirmation, {
      action: 'insert', table: { slideIndex: 1, rows: 4, columns: 6, position: { left: 10, top: 20, width: 300, height: 180 } },
    })

    const longText = '敏感摘要'.repeat(80)
    const scene = await call(endpoint, 'presentation_write_preview', {
      operation: 'render_scene',
      payload: { action: 'replace_scene', slideIndex: 0, elements: [
        { type: 'text', text: longText, left: 1, top: 2, width: 30, height: 10 },
        { type: 'table', rows: 2, columns: 3, left: 1, top: 14, width: 30, height: 20 },
        { type: 'chart', chartType: 'pie', left: 35, top: 2, width: 30, height: 20 },
        { type: 'image', fileName: '/private/design/hero.png', left: 35, top: 24, width: 30, height: 20 },
      ] },
    }, 2)
    const confirmation = scene.result.structuredContent.summary.confirmation
    assert.equal(confirmation.action, 'replace_scene')
    assert.deepEqual(confirmation.target, { slideIndex: 0 })
    assert.equal(confirmation.elementCount, 4)
    assert.deepEqual(confirmation.elements.map((element) => element.type), ['text', 'table', 'chart', 'image'])
    assert.equal(confirmation.elements[0].text, longText.slice(0, 240))
    assert.equal(confirmation.elements[0].textLength, longText.length)
    assert.equal(confirmation.elements[0].textTruncated, true)
    assert.deepEqual(confirmation.elements[1], { index: 1, type: 'table', position: { left: 1, top: 14, width: 30, height: 20 }, rows: 2, columns: 3 })
    assert.equal(confirmation.elements[2].chartType, 'pie')
    assert.equal(confirmation.elements[3].fileName, 'hero.png')
    assert.doesNotMatch(JSON.stringify(confirmation), /private\/design/)

    const add = await call(endpoint, 'presentation_write_preview', { operation: 'manage_slides', payload: { action: 'add', index: -1 } }, 3)
    assert.deepEqual(add.result.structuredContent.summary.confirmation, { action: 'add', insertion: { index: -1 } })
  } finally { await connector.stop() }
})

test('presentation previews make every mutation target and payload concrete', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 941, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/941?id=941' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '完整确认.pptx', documentId: '941', path: '/weboffice/office/p/941', slideCount: 3, fingerprint: 'ppt-summary-941' }
  const runtimeSummary = { payloadKeys: ['action'], target: { slideIndex: 1, objectIndex: 2, object: { id: 'shape-2', type: 'textBox' } }, effect: { action: 'delete', object: { id: 'shape-2', type: 'textBox', text: '旧标题' } } }
  const observed = { currentSlide: 1, slide: { index: 1, id: 'slide-2', shapeCount: 4 }, target: { index: 2, id: 'shape-2', type: 'textBox', text: '旧标题' } }
  const connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
    result: { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint, operation: request.operation, ...observed }, summary: runtimeSummary },
  })) })
  connector.bindBrowserTarget('presentation-every-confirmation-run', target); const endpoint = await connector.start()
  try {
    const readConfirmation = async (operation, payload, id) => {
      const result = await call(endpoint, 'presentation_write_preview', { operation, payload }, id)
      assert.equal(result.result.isError, undefined, JSON.stringify(result.result))
      return result.result.structuredContent.summary.confirmation
    }
    const slideDelete = await readConfirmation('manage_slides', { action: 'delete', slideIndex: 1 }, 1)
    assert.deepEqual(slideDelete.target, { slideIndex: 1 })
    assert.deepEqual(slideDelete.runtime, runtimeSummary)
    assert.deepEqual(slideDelete.observed, { currentSlide: 1, slide: observed.slide, object: observed.target })

    const selection = await readConfirmation('edit_selection', { action: 'update', slideIndex: 1, edit: { x: 5, y: 6, replaceText: '新标题' } }, 2)
    assert.deepEqual(selection.target, { slideIndex: 1 })
    assert.equal(selection.edit.replaceText.text, '新标题')

    const objectDelete = await readConfirmation('manage_objects', { action: 'delete', slideIndex: 1, objectIndex: 2 }, 3)
    assert.deepEqual(objectDelete.target, { slideIndex: 1, objectIndex: 2 })
    assert.deepEqual(objectDelete.runtime.effect.object, runtimeSummary.effect.object)
    assert.deepEqual(objectDelete.observed.object, observed.target)

    const chart = await readConfirmation('manage_charts', { action: 'insert', slideIndex: 1, chartType: '51', left: 1, top: 2, width: 30, height: 20 }, 4)
    assert.deepEqual(chart.chart, { slideIndex: 1, chartType: 51, position: { left: 1, top: 2, width: 30, height: 20 } })

    const notes = await readConfirmation('manage_notes', { action: 'replace', slideIndex: 1, text: '演讲备注' }, 5)
    assert.equal(notes.text.text, '演讲备注')
    const comments = await readConfirmation('manage_comments', { action: 'add', slideIndex: 1, text: '需要法务确认', replyer: '张三' }, 6)
    assert.equal(comments.replyer, '张三')

    const metadata = await readConfirmation('manage_metadata', { action: 'set_builtin', name: 'Title', value: '季度复盘' }, 7)
    assert.deepEqual(metadata.metadata, { name: 'Title', value: { text: '季度复盘', textLength: 4, textTruncated: false } })

    const move = await readConfirmation('manage_structure', { action: 'move_slide', slideIndex: 1, toIndex: 2 }, 8)
    assert.deepEqual(move.move, { fromIndex: 1, toIndex: 2 })
    const sectionMove = await readConfirmation('manage_structure', { action: 'move_section', sectionIndex: 2, toPos: 3 }, 9)
    assert.deepEqual(sectionMove.move, { sectionIndex: 2, toPos: 3 })

    const textBox = await readConfirmation('replace_text_box', { action: 'replace', slideIndex: 1, textBoxIndex: 2, text: '替换后的标题' }, 10)
    assert.deepEqual(textBox.target, { slideIndex: 1, textBoxIndex: 2 })
    assert.equal(textBox.text.text, '替换后的标题')
    const save = await readConfirmation('save', { action: 'save' }, 11)
    assert.equal(save.action, 'save')
  } finally { await connector.stop() }
})

test('presentation refuses a write without an explicit verified readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 95, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/95?id=95' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '计划.pptx', fingerprint: 'ppt-before' }
  const connector = new BrowserConnector({ officeDocumentWriteStore: new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-presentation-${randomUUID()}.json`) }), requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result: request.action === 'write' ? { status: 'verified_write', operation: request.operation, resource, observed: {} } : request.action === 'inspect_write' ? { status: 'ok', resource: { ...resource, slideCount: 1 }, operation: request.operation, precondition: { resourceFingerprint: 'ppt-before' }, summary: previewSummary() } : { status: 'ok', resource, slideCount: 1 } })) })
  connector.bindBrowserTarget('presentation-readback-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'presentation_write_preview', { operation: 'save', payload: { action: 'save' } })
    const commit = await call(endpoint, 'presentation_write_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(commit.result.isError, true)
    assert.match(commit.result.content[0].text, /invalid presentation result/)
  } finally { await connector.stop() }
})

test('presentation_get_selection accepts its structured resource result without requiring a context readback', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 96, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/96?id=96' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '选择.pptx', documentId: '96', path: '/weboffice/office/p/96', slideCount: 2, fingerprint: 'ppt-selection' }
  const connector = new BrowserConnector({
    requestExtension: (request) => {
      queueMicrotask(() => {
        connector.acceptExtensionResponse({
          type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
          result: { resource, selection: { selectedShape: { id: 'shape-1', type: 'textBox' }, selectionFingerprint: 'selection-1' }, selectedShape: { id: 'shape-1' } },
        })
      })
    },
  })
  connector.bindBrowserTarget('presentation-selection-run', target); const endpoint = await connector.start()
  try {
    const selection = await call(endpoint, 'presentation_get_selection', {})
    assert.deepEqual(selection.result.structuredContent.resource, resource)
    assert.equal(selection.result.structuredContent.selection.selectionFingerprint, 'selection-1')
  } finally { await connector.stop() }
})

test('preserves the extension presentation precondition and context failures verbatim', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 97, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/97?id=97' }
  const codes = ['precondition_required', 'selection_changed', 'context_mismatch', 'invalid_request', 'write_rejected']
  let index = 0
  const connector = new BrowserConnector({ requestExtension: (request) => queueMicrotask(() => connector.acceptExtensionResponse({
    type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
    error: { code: codes[index++], message: 'runtime-specific failure' },
  })) })
  connector.bindBrowserTarget('presentation-errors-run', target); const endpoint = await connector.start()
  try {
    for (const code of codes) {
      const response = await call(endpoint, 'presentation_get_selection', {}, index + 1)
      assert.equal(response.result.isError, true)
      assert.match(response.result.content[0].text, new RegExp(`\\"code\\":\\"${code}\\"`))
    }
  } finally { await connector.stop() }
})

test('keeps a post-mutation presentation write_incomplete error and fences the write as uncertain', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 971, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/971?id=971' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '回滚失败.pptx', documentId: '971', path: '/weboffice/office/p/971', slideCount: 2, fingerprint: 'ppt-incomplete-971' }
  const details = { deletedCount: 2, totalOldShapes: 3, createdCount: 1, rollbackComplete: false, observed: { objects: [{ id: 'shape-1', bounds: { x: 1, y: 2, width: 3, height: 4 } }] } }
  const store = new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-presentation-incomplete-${randomUUID()}.json`) })
  let writes = 0
  const connector = new BrowserConnector({ officeDocumentWriteStore: store, requestExtension: (request) => queueMicrotask(() => {
    if (request.action === 'write') {
      writes += 1
      connector.acceptExtensionResponse({
        type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
        error: { code: 'write_incomplete', message: 'render_scene rollback could not restore the original slide', details },
      })
      return
    }
    connector.acceptExtensionResponse({
      type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget,
      result: { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint, slideCount: 2 }, summary: previewSummary(Object.keys(request.payload ?? {})) },
    })
  }) })
  connector.bindBrowserTarget('presentation-incomplete-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'presentation_write_preview', { operation: 'render_scene', payload: { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'x', left: 1, top: 1, width: 1, height: 1 }] } })
    const challenge = preview.result.structuredContent.challenge
    const commit = await call(endpoint, 'presentation_write_commit', { challenge }, 2)
    assert.equal(commit.result.isError, true)
    assert.match(commit.result.content[0].text, /"code":"write_incomplete"/)
    assert.match(commit.result.content[0].text, /"rollbackComplete":false/)
    assert.match(commit.result.content[0].text, /"objects":\[\{"id":"shape-1"/)
    const identity = `presentation-write:${createHash('sha256').update(challenge).digest('hex').slice(0, 48)}`
    assert.equal((await store.load(identity))?.state, 'uncertain')
    const replay = await call(endpoint, 'presentation_write_commit', { challenge }, 3)
    assert.equal(replay.result.isError, true)
    assert.equal(writes, 1, 'an incomplete mutation must never be automatically retried')
  } finally { await connector.stop() }
})

test('presentation rejects a same-name readback whose fingerprint differs from its observed resource', async () => {
  const target = { browser: 'chrome', windowId: 4, tabId: 98, url: 'https://doc.midea.com/teamKnowledge/detail/docOnline/98?id=98' }
  const resource = { kind: 'webedit_presentation', origin: 'https://webedit.midea.com', presentationName: '同名.pptx', documentId: '98', path: '/weboffice/office/p/98', slideCount: 1, fingerprint: 'ppt-before' }
  const connector = new BrowserConnector({ officeDocumentWriteStore: new OfficeDocumentWriteRecordStore({ recordPath: join(tmpdir(), `dsh-presentation-${randomUUID()}.json`) }), requestExtension: (request) => {
    const result = request.action === 'inspect_write'
      ? { status: 'ok', resource, operation: request.operation, precondition: { resourceFingerprint: resource.fingerprint }, summary: previewSummary() }
      : { status: 'verified_write', operation: request.operation, resource: { ...resource, fingerprint: 'ppt-after' }, observed: { verified: true, resource: { ...resource, fingerprint: 'ppt-other' }, slideCount: 1 } }
    queueMicrotask(() => connector.acceptExtensionResponse({ type: 'connector_response', requestId: request.requestId, runId: request.runId, generation: request.generation, browserTarget: request.browserTarget, result }))
  } })
  connector.bindBrowserTarget('presentation-fingerprint-run', target); const endpoint = await connector.start()
  try {
    const preview = await call(endpoint, 'presentation_write_preview', { operation: 'save', payload: { action: 'save' } })
    const commit = await call(endpoint, 'presentation_write_commit', { challenge: preview.result.structuredContent.challenge }, 2)
    assert.equal(commit.result.isError, true)
    assert.match(commit.result.content[0].text, /invalid presentation result/)
  } finally { await connector.stop() }
})
