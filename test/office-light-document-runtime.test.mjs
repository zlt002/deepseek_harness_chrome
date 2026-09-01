import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { webcrypto } from 'node:crypto'

async function runtime(options = {}) {
  const state = options.state
  let xml = options.initialXml ?? '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="one">重复</p><p id="two">重复</p></apcanvas>'
  if (state) state.xml = xml
  const bridgeChannel = options.bridgeChannel ?? 'test-channel-0123456789abcdef'
  const listeners = new Map()
  const window = {
    addEventListener(name, listener) { const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event) },
  }
  const canvas = {
    async getDocXml() { return xml },
    async patch({ xml: patch }) { if (state) state.patchCalls = (state.patchCalls ?? 0) + 1; if (options.rejectPatch) return { success: false }; if (!options.ignoreFormat || !/<strong\b|<em\b|<h[1-6]\b/i.test(patch)) { const before = xml; xml = `<apcanvas>${/^<replace sel="\/\/apcanvas">([\s\S]*)<\/replace>$/.exec(patch)?.[1] ?? ''}</apcanvas>`; if (options.regenerateIds) { let id = 0; xml = xml.replace(/\bid="[^"]*"/g, () => `id="rebuilt-${++id}"`) } if (options.tamperOutside) xml = xml.replace('>前置<', '>被篡改<'); if (options.keepBlockId) { const escaped = String(options.keepBlockId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const original = new RegExp(`<(?:p|h[1-6]|li|blockquote|pre|codeBlock)\\b[^>]*\\bid=["']${escaped}["'][^>]*>[\\s\\S]*?<\\/(?:p|h[1-6]|li|blockquote|pre|codeBlock)>`, 'i').exec(before)?.[0]; if (original && !new RegExp(`\\bid=["']${escaped}["']`, 'i').test(xml)) xml = xml.replace('</apcanvas>', `${original}</apcanvas>`) } } if (state) state.xml = xml; return { success: true } },
    ...(options.selectionInfo ? { canvas: { getSelectionInfo: () => options.selectionInfo } } : {}),
  }
  const applySelection = (value) => {
    if (options.selectionInsert === 'throws') throw new Error('insert failed')
    if (options.selectionInsert === 'unchanged') return
    const next = options.selectionInsert === 'mismatch' ? 'unrelated content' : value
    xml = options.selectionInsert === 'replace-selected' || options.selectionReplace === true
      ? xml.replace('已选内容', next).replace('选区', next).replace('>重复<', `>${next}<`)
      : xml.replace('</apcanvas>', `<p id="inserted">${next}</p></apcanvas>`)
    if (state) state.xml = xml
  }
  const selection = { async insertContent({ markdown, html, text }) {
    if (state) state.selectionCalls = (state.selectionCalls ?? 0) + 1
    applySelection(markdown ?? html ?? text)
  }, ...(options.selectionReplace === true ? { async replaceContent({ markdown, html, text }) {
    if (state) state.replaceCalls = (state.replaceCalls ?? 0) + 1
    applySelection(markdown ?? html ?? text)
  } } : {}), ...(options.selection ?? {}) }
  const documentApi = { selection, ...(options.documentApi ?? {}) }
  const editor = { canvas, document: documentApi, ...(options.editorApi ?? {}) }
  const context = vm.createContext({ window, globalThis: null, APP: { openApi: { editor }, ...(options.otlSelection ? { OTL: { state: { selection: options.otlSelection } } } : {}) }, location: { href: 'https://webedit.midea.com/weboffice/office/o/1', origin: 'https://webedit.midea.com', pathname: '/weboffice/office/o/1' }, document: { title: '测试', currentScript: { dataset: { deepseekHarnessChannel: bridgeChannel } }, createElement() { return { set innerHTML(value) { this.value = String(value).replace(/<[^>]+>/g, '') }, value: '' } } }, crypto: webcrypto, TextEncoder, Uint8Array, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } }, setTimeout, clearTimeout, Date })
  context.globalThis = context
  const runtimeSource = await readFile(new URL('../apps/chrome-extension/public/office-light-document-runtime.js', import.meta.url), 'utf8')
  const inject = (channel) => {
    context.document.currentScript = { dataset: { deepseekHarnessChannel: channel } }
    vm.runInContext(runtimeSource, context)
  }
  inject(bridgeChannel)
  let id = 0
  const responses = []
  window.addEventListener('deepseek-harness-office-document-response/v1', (event) => responses.push(event.detail))
  const request = (input, channel = bridgeChannel, requestId = String(++id)) => new Promise((resolve) => {
    const response = (event) => {
      const detail = event.detail
      if (detail?.type === 'response' && detail.channel === channel && detail.id === requestId && typeof detail.ok === 'boolean') {
        window.removeEventListener('deepseek-harness-office-document-response/v1', response)
        resolve(detail.ok ? { ok: true, result: detail.result } : { ok: false, error: detail.error })
      }
    }
    window.addEventListener('deepseek-harness-office-document-response/v1', response)
    options.beforeRequest?.({ window, CustomEvent: context.CustomEvent, requestId, bridgeChannel: channel, input })
    window.dispatchEvent(new context.CustomEvent('deepseek-harness-office-document-request/v1', { detail: { type: 'request', channel, id: requestId, request: input } }))
  })
  request.forChannel = (channel, input) => request(input, channel)
  request.reinject = (channel) => inject(channel)
  request.dispatchRaw = (channel, requestId, input) => window.dispatchEvent(new context.CustomEvent('deepseek-harness-office-document-request/v1', { detail: { type: 'request', channel, id: requestId, request: input } }))
  request.responses = responses
  return request
}

test('light-document runtime keeps title outside read indexes and verifies replace/format/delete/title by structure', async () => {
  const call = await runtime()
  const read = await call({ action: 'read' })
  const resource = read.result.resource
  assert.equal(read.result.document.blocks[0].id, 'one')
  const replace = await call({ action: 'write', operation: 'replace', resource, payload: { index: 0, text: '新内容' } })
  assert.equal(replace.ok, true); assert.equal(replace.result.observed.verified, true)
  const formatted = await call({ action: 'write', operation: 'format', resource: replace.result.resource, payload: { index: 0, style: { bold: true, blockType: 'h2' } } })
  assert.equal(formatted.ok, true)
  const deleted = await call({ action: 'write', operation: 'delete', resource: formatted.result.resource, payload: { id: 'two' } })
  assert.equal(deleted.ok, true); assert.equal(deleted.result.observed.verified, true)
  const titled = await call({ action: 'write', operation: 'title', resource: deleted.result.resource, payload: { text: '新标题' } })
  assert.equal(titled.ok, true); assert.equal(titled.result.observed.verified, true)
})

test('light-document runtime fails closed for unanchored inserts and rejects an unobserved format patch', async () => {
  const insert = await runtime()
  const read = await insert({ action: 'read' })
  const inserted = await insert({ action: 'write', operation: 'insert', resource: read.result.resource, payload: { markdown: '# 标题\n- 第一项\n- 第二项' } })
  assert.equal(inserted.ok, false); assert.equal(inserted.error.code, 'unsupported')
  const call = await runtime({ ignoreFormat: true })
  const stale = await call({ action: 'read' })
  const failed = await call({ action: 'write', operation: 'format', resource: stale.result.resource, payload: { index: 0, style: { bold: true, blockType: 'h2' } } })
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'readback_mismatch')
})

test('light-document runtime verifies selection_insert only from a stable snapshot with XML evidence', async () => {
  for (const [key, value] of [['markdown', '# 标题\n- 第一项'], ['html', '<strong>HTML内容</strong>'], ['text', '纯文本内容']]) {
    const state = {}
    const call = await runtime({ state, selection: {
      async getSelectionContent() { return { text: '已选内容' } },
      async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 5 } },
    } })
    const read = await call({ action: 'selection' })
    const payload = { [key]: value, expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint }
    const result = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload })
    assert.equal(result.ok, true, key)
    assert.equal(result.result.observed.verified, true)
    assert.equal(result.result.requested.payload.expectedSelectionFingerprint, payload.expectedSelectionFingerprint)
    assert.ok(result.result.observed.verifiedFragments.length > 0)
    assert.equal(state.selectionCalls, 1)
  }
})

test('light-document selection_insert permits stable collapsed public anchors and runtime coordinates', async () => {
  const cases = [
    { selection: { async getSelectionContent() { return { text: '' } }, async getSelectionAnchor() { return { blockId: 'one', start: 4, end: 4 } } } },
    { selection: { async getSelectionContent() { return { text: '' } } }, otlSelection: { from: 4, to: 4, anchor: 4, head: 4, empty: true } },
  ]
  for (const options of cases) {
    const state = {}; const call = await runtime({ ...options, state }); const read = await call({ action: 'selection' })
    assert.equal(read.result.document.selection.stable, true); assert.equal(read.result.document.selection.isCollapsed, true)
    assert.equal(read.result.document.selection.hasCaret, true); assert.equal(read.result.document.selection.hasSelection, false)
    assert.match(read.result.document.selection.selectionFingerprint, /^selection-v4-[0-9a-f]{32}$/)
    const inserted = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload: { text: '光标写入', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
    assert.equal(inserted.ok, true); assert.equal(state.selectionCalls, 1)
  }
})

test('light-document runtime reports independent verified selection strategies without requiring getSelectionAnchor', async () => {
  const call = await runtime({
    otlSelection: { from: 1, to: 4, anchor: 1, head: 4, empty: false },
    selectionInfo: { selected_tag_ids: ['one'] },
    selection: { async getSelectionContent() { return { text: '重复' } } },
  })
  const capability = await call({ action: 'read', payload: { kind: 'capabilities' } })
  assert.equal(capability.ok, true)
  const strategies = capability.result.document.capabilities.selectionStrategies
  assert.equal(strategies.content, true); assert.equal(strategies.coordinates, true); assert.equal(strategies.wholeBlock, true)
  assert.equal(strategies.insert, 'public_insert_content'); assert.equal(strategies.replace, 'full_canvas_patch_for_verified_whole_blocks')
  assert.equal(capability.result.document.capabilities.selection, true)
  assert.equal(capability.result.document.capabilities.currentWholeBlockReplaceable, true)
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.hasSelection, true)
  assert.equal(selected.result.document.selection.isCollapsed, false)
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, true)
})

test('light-document resource name and fingerprint use the same public title source', async () => {
  let title = '公开标题'
  const call = await runtime({ documentApi: { async getTitleContent() { return { text: title } } } })
  const first = await call({ action: 'read' })
  title = '更新标题'
  const second = await call({ action: 'read' })
  assert.equal(first.result.resource.documentName, '公开标题')
  assert.equal(second.result.resource.documentName, '更新标题')
  assert.notEqual(first.result.resource.fingerprint, second.result.resource.fingerprint)
})

test('light-document resource falls back to document.title when the public title shape is malformed', async () => {
  const call = await runtime({ documentApi: { async getTitleContent() { return { unexpected: 'object' } } } })
  const read = await call({ action: 'read' })
  assert.equal(read.result.resource.documentName, '测试')
  assert.notEqual(read.result.resource.documentName, '[object Object]')
})

test('empty body blocks_insert initializes an empty title only from its first h1 and reads both back', async () => {
  let title = ''
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent(value) { title = value; state.titleWrites = (state.titleWrites ?? 0) + 1; state.titleValues = [...(state.titleValues ?? []), value] },
  } })
  const read = await call({ action: 'read' })
  const payload = { blocks: [{ type: 'p', text: '摘要' }, { type: 'h1', html: '<strong>演示 PRD：团队任务管理助手</strong>' }] }
  const inspected = await call({ action: 'inspect_write', operation: 'blocks_insert', payload })
  assert.deepEqual(JSON.parse(JSON.stringify(inspected.result.document.title)), { supported: true, text: '', textLength: 0, truncated: false })
  const written = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload })
  assert.equal(written.ok, true)
  assert.equal(title, '演示 PRD：团队任务管理助手')
  assert.equal(state.titleWrites, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(written.result.observed.title)), { initialized: true, text: '演示 PRD：团队任务管理助手' })
  assert.deepEqual(state.titleValues, ['演示 PRD：团队任务管理助手'])
  assert.doesNotMatch(state.titleValues[0], /<|>|\*|_|#/, 'title API receives plain readable text, not XML or Markdown')
  assert.match(state.xml, /<h1[^>]*>.*演示 PRD：团队任务管理助手/)
})

test('a single blank paragraph is semantic-empty and initializes the first h1 as title', async () => {
  let title = ''
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle><p id=""></p></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent(value) { title = value; state.titleWrites = (state.titleWrites ?? 0) + 1 },
  } })
  const read = await call({ action: 'read' })
  assert.equal(read.result.document.blockCount, 1, 'the physical empty paragraph must not be silently dropped from the raw read')
  assert.equal(read.result.resource.documentName, null, 'the empty title remains null even though WebEdit carries one physical blank paragraph')
  const payload = { blocks: [{ type: 'h1', text: '演示 PRD：智能工单管理系统' }] }
  const inspected = await call({ action: 'inspect_write', operation: 'blocks_insert', payload })
  assert.deepEqual(JSON.parse(JSON.stringify(inspected.result.document.emptyBody)), { semantic: true, physicalBlockCount: 1, blankParagraphCount: 1 })
  const written = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload })
  assert.equal(written.ok, true)
  assert.equal(title, '演示 PRD：智能工单管理系统')
  assert.equal(state.titleWrites, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(written.result.observed.title)), { initialized: true, text: '演示 PRD：智能工单管理系统' })
})

test('blocks_insert never overwrites an existing title when the body has one blank paragraph', async () => {
  let title = '已有标题'
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title">已有标题</outlineTitle><p id=""></p></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent(value) { title = value; state.titleWrites = (state.titleWrites ?? 0) + 1 },
  } })
  const read = await call({ action: 'read' })
  const written = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h1', text: '正文标题' }] } })
  assert.equal(written.ok, true)
  assert.equal(title, '已有标题')
  assert.equal(state.titleWrites ?? 0, 0)
  assert.equal(written.result.observed.title, undefined)
})

test('blocks_insert does not guess a title when one blank paragraph has no h1', async () => {
  let title = ''
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle><p id="\u200B">\u200B</p></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent(value) { title = value; state.titleWrites = (state.titleWrites ?? 0) + 1 },
  } })
  const read = await call({ action: 'read' })
  const written = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h2', text: '二级标题' }] } })
  assert.equal(written.ok, true)
  assert.equal(title, '')
  assert.equal(state.titleWrites ?? 0, 0)
  assert.equal(written.result.observed.title, undefined)
})

test('readable content or an empty non-paragraph structure is never semantic-empty', async () => {
  for (const xml of [
    '<apcanvas><outlineTitle id="title"></outlineTitle><p id="one">已有正文</p></apcanvas>',
    '<apcanvas><outlineTitle id="title"></outlineTitle><h2 id="one"></h2></apcanvas>',
    '<apcanvas><outlineTitle id="title"></outlineTitle><table id="one"></table></apcanvas>',
    '<apcanvas><outlineTitle id="title"></outlineTitle><ul id="one"></ul></apcanvas>',
    '<apcanvas><outlineTitle id="title"></outlineTitle><codeBlock id="one" lang="plaintext"><![CDATA[]]></codeBlock></apcanvas>',
  ]) {
    const call = await runtime({ initialXml: xml, documentApi: { async getTitleContent() { return { text: '' } }, async setTitleContent() { assert.fail('non-empty structure must not initialize title') } } })
    const inspected = await call({ action: 'inspect_write', operation: 'blocks_insert', payload: { blocks: [{ type: 'h1', text: '不应取标题' }] } })
    assert.equal(inspected.result.document.emptyBody.semantic, false, xml)
  }
})

test('a readable paragraph prevents automatic title initialization even when this insert contains h1', async () => {
  let title = ''
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle><p id="one">已有正文</p></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent() { state.titleWrites = (state.titleWrites ?? 0) + 1 },
  } })
  const read = await call({ action: 'read' })
  const written = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h1', text: '后续章节标题' }] } })
  assert.equal(written.ok, true)
  assert.equal(title, '')
  assert.equal(state.titleWrites ?? 0, 0)
  assert.equal(written.result.observed.title, undefined)
})

test('a failed automatic title write does not report success or write the body', async () => {
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle></apcanvas>', documentApi: {
    async getTitleContent() { return { text: '' } },
    async setTitleContent() { throw new Error('title failed') },
  } })
  const read = await call({ action: 'read' })
  const failed = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h1', text: '不能误报' }] } })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'runtime_error')
  assert.match(failed.error.message, /body was not written/)
  assert.equal(state.patchCalls ?? 0, 0)
  assert.doesNotMatch(state.xml, /不能误报/)
})

test('an automatic title readback failure does not write the body or report success', async () => {
  const state = {}
  const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle></apcanvas>', documentApi: {
    async getTitleContent() { return { text: '' } },
    async setTitleContent() { state.titleWrites = (state.titleWrites ?? 0) + 1 },
  } })
  const read = await call({ action: 'read' })
  const failed = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h1', text: '回读失败' }] } })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'readback_mismatch')
  assert.match(failed.error.message, /body was not written/)
  assert.equal(state.titleWrites, 1)
  assert.equal(state.patchCalls ?? 0, 0)
  assert.doesNotMatch(state.xml, /回读失败/)
})

test('a verified title followed by a rejected body patch reports write_incomplete', async () => {
  const state = {}
  let title = ''
  const call = await runtime({ state, rejectPatch: true, initialXml: '<apcanvas><outlineTitle id="title"></outlineTitle></apcanvas>', documentApi: {
    async getTitleContent() { return { text: title } },
    async setTitleContent(value) { title = value },
  } })
  const read = await call({ action: 'read' })
  const failed = await call({ action: 'write', operation: 'blocks_insert', resource: read.result.resource, payload: { blocks: [{ type: 'h1', text: '标题已写入' }, { type: 'p', text: '正文未写入' }] } })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'write_incomplete')
  assert.match(failed.error.message, /initialized title/)
  assert.equal(title, '标题已写入')
  assert.doesNotMatch(state.xml, /正文未写入/)
})

test('light-document caret capabilities keep selection readable while whole-block preview stays unavailable', async () => {
  const call = await runtime({
    otlSelection: { from: 3, to: 3, anchor: 3, head: 3, empty: true },
    selectionInfo: { selected_tag_ids: ['one'] },
    selection: { async getSelectionContent() { return { text: '' } } },
  })
  const capability = await call({ action: 'read', payload: { kind: 'capabilities' } })
  assert.equal(capability.result.document.capabilities.selection, true)
  assert.equal(capability.result.document.capabilities.currentWholeBlockReplaceable, false)
  assert.equal(capability.result.document.capabilities.verifiedSelectionInsert, true)
})

test('light-document bridge ignores stale or crossed envelopes and rejects old selection fingerprints', async () => {
  const state = {}
  const call = await runtime({ state, beforeRequest({ window, CustomEvent, requestId, input }) {
    window.dispatchEvent(new CustomEvent('deepseek-harness-office-document-response/v1', {
      detail: { type: 'response', channel: 'stale-channel-0123456789abcdef', id: requestId, ok: true, result: { status: 'wrong' } },
    }))
  }, selection: { async getSelectionContent() { return { text: '选区' } }, async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 3 } } } })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.ok, true)
  const rejected = await call({ action: 'write', operation: 'selection_insert', resource: selected.result.resource, payload: { text: '不应写入', expectedSelectionFingerprint: 'selection-v3-1234abcd' } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'unsupported')
  assert.equal(state.selectionCalls ?? 0, 0)
})

test('light-document runtime rebinds a healed content-script channel, revokes the old channel, and scopes replay keys by channel', async () => {
  const oldChannel = 'old-channel-0123456789abcdef'
  const newChannel = 'new-channel-0123456789abcdef'
  const unknownChannel = 'unknown-channel-0123456789'
  const call = await runtime({ bridgeChannel: oldChannel })
  call.dispatchRaw(oldChannel, 'shared-request-id', { action: 'probe' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const beforeRebind = call.responses.length
  assert.equal(call.responses.at(-1).channel, oldChannel)

  call.reinject(newChannel)
  const healedProbe = await call.forChannel(newChannel, { action: 'probe' })
  const healedRead = await call.forChannel(newChannel, { action: 'read' })
  assert.equal(healedProbe.result.ready, true)
  assert.equal(healedRead.result.document.blockCount, 2)
  assert.equal(call.responses.at(-1).channel, newChannel)

  // A new channel may reuse an ID from a revoked channel; replay protection
  // is keyed by channel+id. Replaying it on the same channel is ignored.
  call.dispatchRaw(newChannel, 'shared-request-id', { action: 'probe' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const afterNewChannel = call.responses.length
  call.dispatchRaw(newChannel, 'shared-request-id', { action: 'probe' })
  call.dispatchRaw(oldChannel, 'old-channel-rejected', { action: 'probe' })
  call.dispatchRaw(unknownChannel, 'unknown-channel-rejected', { action: 'probe' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(call.responses.length, afterNewChannel)
  assert.equal(afterNewChannel, beforeRebind + 3)
})

test('light-document selection marks partial and ambiguous block ranges not replaceable before preview', async () => {
  const partial = await runtime({
    otlSelection: { from: 2, to: 8, anchor: 2, head: 8, empty: false }, selectionInfo: { selected_tag_ids: ['one', 'two'] },
    selection: { async getSelectionContent() { return { text: '复 重复' } } },
  })
  const partialRead = await partial({ action: 'selection' })
  assert.equal(partialRead.result.document.selection.hasSelection, true)
  assert.equal(partialRead.result.document.selection.wholeBlockReplaceable, false)

  const ambiguous = await runtime({
    otlSelection: { from: 1, to: 9, anchor: 1, head: 9, empty: false }, selectionInfo: { selected_tag_ids: ["p[@id='one']../p"] },
    selection: { async getSelectionContent() { return { text: '重复' } } },
  })
  const ambiguousRead = await ambiguous({ action: 'selection' })
  assert.equal(ambiguousRead.result.document.selection.selectionIdsValid, false)
  assert.equal(ambiguousRead.result.document.selection.wholeBlockReplaceable, false)
})

test('light-document selection accepts complete contiguous WebEdit list blocks when only selection content carries markers', async () => {
  const call = await runtime({
    initialXml: '<apcanvas><outlineTitle id="title">列表</outlineTitle><p id="one"><span>完成核对</span></p><p id="two"><span>校验结果</span></p><p id="three"><span>确认交付</span></p></apcanvas>',
    otlSelection: { from: 1, to: 12, anchor: 1, head: 12, empty: false },
    selectionInfo: { selected_tag_ids: ['one', 'two', 'three'] },
    selection: { async getSelectionContent() { return { text: '• 完成核对\n• 校验结果\n• 确认交付', markdown: '- 完成核对\n- 校验结果\n- 确认交付', html: '<html><head><meta charset="utf-8"></meta></head><body><div data-selection="true"><ul><li data-id="a">完成核对</li><li data-id="b">校验结果</li><li data-id="c">确认交付</li></ul></div></body></html>' } } },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.hasSelection, true)
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, true)
})

test('light-document selection accepts complete nested WebEdit list envelopes', async () => {
  const call = await runtime({
    initialXml: '<apcanvas><outlineTitle id="title">列表</outlineTitle><p id="one"><span>Phase 1（核心闭环）：基础能力</span></p><p id="two"><span>Phase 2（高级扩展）：扩展能力</span></p></apcanvas>',
    otlSelection: { from: 143, to: 256, anchor: 143, head: 256, empty: false },
    selectionInfo: { selected_tag_ids: ['one', 'two'] },
    selection: { async getSelectionContent() { return {
      text: '◦ Phase 1（核心闭环）：基础能力\n◦ Phase 2（高级扩展）：扩展能力',
      html: '<html><head><meta charset="utf-8"></meta></head><body><div><ul><ul><li><strong>Phase 1（核心闭环）</strong>：基础能力</li><li><strong>Phase 2（高级扩展）</strong>：扩展能力</li></ul></ul></div></body></html>',
    } } },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, true)
})

test('light-document selection still rejects a partial first WebEdit list item after HTML list proof', async () => {
  const call = await runtime({
    initialXml: '<apcanvas><outlineTitle id="title">列表</outlineTitle><p id="one"><span>完成核对</span></p><p id="two"><span>校验结果</span></p><p id="three"><span>确认交付</span></p></apcanvas>',
    otlSelection: { from: 2, to: 12, anchor: 2, head: 12, empty: false },
    selectionInfo: { selected_tag_ids: ['one', 'two', 'three'] },
    selection: { async getSelectionContent() { return { text: '• 成核对\n• 校验结果\n• 确认交付', markdown: '- 成核对\n- 校验结果\n- 确认交付', html: '<ul><li>成核对</li><li>校验结果</li><li>确认交付</li></ul>' } } },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, false)
})

test('light-document selection does not treat ordinary paragraphs as list proof', async () => {
  const call = await runtime({
    initialXml: '<apcanvas><outlineTitle id="title">正文</outlineTitle><p id="one"><span>完成核对</span></p><p id="two"><span>校验结果</span></p></apcanvas>',
    otlSelection: { from: 1, to: 8, anchor: 1, head: 8, empty: false },
    selectionInfo: { selected_tag_ids: ['one', 'two'] },
    selection: { async getSelectionContent() { return { text: '• 完成核对\n• 校验结果', html: '<p>完成核对</p><p>校验结果</p>' } } },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, false)
})

test('light-document selection rejects text, paragraphs, or a second list outside an enveloped WebEdit list', async () => {
  const base = '<html><head><meta charset="utf-8"></meta></head><body><div><ul><li>完成核对</li><li>校验结果</li></ul></div></body></html>'
  const invalid = [
    base.replace('<div>', '<div>说明'),
    base.replace('</ul>', '</ul><p>额外段落</p>'),
    base.replace('</div>', '</div><ul><li>第二列表</li></ul>'),
  ]
  for (const html of invalid) {
    const call = await runtime({
      initialXml: '<apcanvas><outlineTitle id="title">正文</outlineTitle><p id="one"><span>完成核对</span></p><p id="two"><span>校验结果</span></p></apcanvas>',
      otlSelection: { from: 1, to: 8, anchor: 1, head: 8, empty: false },
      selectionInfo: { selected_tag_ids: ['one', 'two'] },
      selection: { async getSelectionContent() { return { text: '• 完成核对\n• 校验结果', html } } },
    })
    const selected = await call({ action: 'selection' })
    assert.equal(selected.result.document.selection.wholeBlockReplaceable, false)
  }
})

test('light-document selection_insert rejects drift, ambiguity, runtime failure, and insufficient XML readback without replay', async () => {
  const stable = { async getSelectionContent() { return { text: '选区' } }, async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 3 } } }
  const driftState = {}; let content = '选区'
  const drift = await runtime({ state: driftState, selection: { ...stable, async getSelectionContent() { return { text: content } } } })
  const initial = await drift({ action: 'selection' }); content = '已漂移'
  const drifted = await drift({ action: 'write', operation: 'selection_insert', resource: initial.result.resource, payload: { text: '新内容', expectedSelectionFingerprint: initial.result.document.selection.selectionFingerprint } })
  assert.equal(drifted.ok, false); assert.equal(drifted.error.code, 'fingerprint_mismatch'); assert.equal(driftState.selectionCalls ?? 0, 0)

  for (const selection of [{ async getSelectionContent() { return { text: '选区' } } }, { async getSelectionContent() { return { text: '选区' } }, async getSelectionAnchor() { return { start: 1, end: 1 } } }]) {
    const state = {}; const call = await runtime({ state, selection }); const read = await call({ action: 'selection' }); assert.equal(read.ok, true, JSON.stringify(read))
    const rejected = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload: { text: '新内容', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid_range'); assert.equal(state.selectionCalls ?? 0, 0)
  }

  for (const mode of ['throws', 'unchanged', 'mismatch']) {
    const state = {}; const call = await runtime({ state, selectionInsert: mode, selection: stable }); const read = await call({ action: 'selection' })
    const rejected = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload: { text: '新内容', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
    assert.equal(rejected.ok, false, mode); assert.equal(rejected.error.code, mode === 'throws' ? 'runtime_error' : 'readback_mismatch'); assert.equal(state.selectionCalls, 1)
  }
})

test('light-document selection_insert replaces an arbitrary stable selection and rejects append-only readback', async () => {
  for (const [selectionInsert, expectedOk] of [['replace-selected', true], [undefined, false]]) {
    const state = {}
    const call = await runtime({ state, initialXml: '<apcanvas><outlineTitle id="title">标题</outlineTitle><p id="one">前缀选区后缀</p></apcanvas>', selectionInsert,
      selectionInfo: { selected_tag_ids: ['one'] }, otlSelection: { from: 3, to: 5, anchor: 3, head: 5, empty: false },
      selection: { async getSelectionContent() { return { text: '选区' } }, async getSelectionAnchor() { return { blockId: 'one', start: 3, end: 5 } } },
    })
    const selected = await call({ action: 'selection' })
    const result = await call({ action: 'write', operation: 'selection_content_replace', resource: selected.result.resource, payload: { text: '新内容', expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint } })
    assert.equal(result.ok, expectedOk, JSON.stringify(result))
    const after = await call({ action: 'read' })
    if (expectedOk) assert.equal(after.result.document.blocks[0].text, '前缀新内容后缀')
    else assert.equal(result.error.code, 'readback_mismatch')
  }
})

test('light-document selection_delete removes only a stable partial selection or complete stable blocks with readback', async () => {
  const partialState = {}
  const partial = await runtime({
    state: partialState,
    initialXml: '<apcanvas><outlineTitle id="title">标题</outlineTitle><p id="one">前缀已选内容后缀</p><p id="two">保留正文</p></apcanvas>',
    selectionReplace: true,
    selectionInfo: { selected_tag_ids: ['one'] }, otlSelection: { from: 3, to: 7, anchor: 3, head: 7, empty: false },
    selection: { async getSelectionContent() { return { text: '已选内容' } }, async getSelectionAnchor() { return { blockId: 'one', start: 3, end: 7 } } },
  })
  const selectedPartial = await partial({ action: 'selection' })
  const partialDeleted = await partial({ action: 'write', operation: 'selection_delete', resource: selectedPartial.result.resource, payload: { expectedSelectionFingerprint: selectedPartial.result.document.selection.selectionFingerprint } })
  assert.equal(partialDeleted.ok, true, JSON.stringify(partialDeleted))
  assert.equal(partialDeleted.result.observed.deletedSelectionText, '已选内容')
  assert.equal((await partial({ action: 'read' })).result.document.blocks.map((block) => block.text).join('|'), '前缀后缀|保留正文')
  assert.equal(partialState.replaceCalls, 1)

  const wholeState = {}
  const whole = await runtime({
    state: wholeState,
    initialXml: '<apcanvas><outlineTitle id="title">标题</outlineTitle><p id="one">第一段</p><p id="two">第二段</p><p id="three">保留段</p></apcanvas>',
    otlSelection: { from: 1, to: 10, anchor: 1, head: 10, empty: false }, selectionInfo: { selected_tag_ids: ['one', 'two'] },
    selection: { async getSelectionContent() { return { text: '第一段 第二段' } }, async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 10 } } },
  })
  const selectedWhole = await whole({ action: 'selection' })
  const wholeDeleted = await whole({ action: 'write', operation: 'selection_delete', resource: selectedWhole.result.resource, payload: { expectedSelectionFingerprint: selectedWhole.result.document.selection.selectionFingerprint } })
  assert.equal(wholeDeleted.ok, true, JSON.stringify(wholeDeleted))
  assert.deepEqual(Array.from(wholeDeleted.result.observed.deletedTagIds), ['one', 'two'])
  assert.equal((await whole({ action: 'read' })).result.document.blocks.map((block) => block.text).join('|'), '保留段')
  assert.equal(wholeState.patchCalls, 1)
})

test('light-document selection_delete rejects a partial table selection before mutation', async () => {
  const state = {}
  const call = await runtime({
    state,
    initialXml: '<apcanvas><outlineTitle id="title">标题</outlineTitle><table id="table"><tr><td><p id="">甲</p></td><td><p id="">乙</p></td></tr><tr><td><p id="">一</p></td><td><p id="">二</p></td></tr></table></apcanvas>',
    otlSelection: { from: 1, to: 4, anchor: 1, head: 4, empty: false }, selectionInfo: { selected_tag_ids: ["table[@id='table']/td"] },
    selection: { async getSelectionContent() { return { html: '<table><tr><td>甲</td><td>乙</td></tr><tr><td>一</td><td>二</td></tr></table>', text: '甲 乙 一 二' } } },
  })
  const selected = await call({ action: 'selection' })
  const rejected = await call({ action: 'write', operation: 'selection_delete', resource: selected.result.resource, payload: { expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'unsupported')
  assert.equal(state.patchCalls ?? 0, 0)
  assert.equal(state.replaceCalls ?? 0, 0)
})

test('light-document atomically replaces the uniquely selected containing table instead of appending a duplicate', async () => {
  const state = {}
  const initialXml = '<apcanvas><outlineTitle id="title">研发交付</outlineTitle><table id="evidence"><tr><td><p id="">Evidence ID</p></td><td><p id="">类型</p></td><td><p id="">事实或结论</p></td><td><p id="">来源</p></td><td><p id="">状态</p></td></tr><tr><td><p id="">E-001</p></td><td><p id="">用户事实</p></td><td><p id="">拒绝大面积改动首页架构</p></td><td><p id="">用户对话交互</p></td><td><p id="">已确认</p></td></tr><tr><td><p id="">E-002</p></td><td><p id="">知识依据</p></td><td><p id="">首页组件采用 van-tabs</p></td><td><p id="">远程代码库 H5_前端</p></td><td><p id="">已确认</p></td></tr></table><p id="after">表格后正文</p></apcanvas>'
  const call = await runtime({
    state,
    initialXml,
    otlSelection: { from: 506, to: 539, anchor: 506, head: 877, empty: false },
    selectionInfo: { selected_tag_ids: ["table[@id='evidence']/td"] },
    selection: {
      async getSelectionContent() {
        return {
          html: '<html><head><meta charset="utf-8"></meta></head><body><div><table><tr><td>类型</td><td>事实或结论</td><td>来源</td></tr><tr><td>用户事实</td><td>拒绝大面积改动首页架构</td><td>用户对话交互</td></tr><tr><td>知识依据</td><td>首页组件采用 van-tabs</td><td>远程代码库 H5_前端</td></tr></table></div></body></html>',
          text: '类型\n事实或结论\n来源\n用户事实\n拒绝大面积改动首页架构\n用户对话交互\n知识依据\n首页组件采用 van-tabs\n远程代码库 H5_前端',
        }
      },
    },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.wholeBlockReplaceable, false)
  assert.equal(selected.result.document.selection.selectionIdsValid, false)
  assert.equal(selected.result.document.selection.replaceStrategy, 'full_canvas_patch_selected_table')
  const result = await call({
    action: 'write', operation: 'selection_content_replace', resource: selected.result.resource,
    payload: {
      markdown: '| Evidence ID | 类型 | 事实或结论 | 来源 | 状态 |\n| --- | --- | --- | --- | --- |\n| E-001 | 用户事实 | 轻量交互增强 | 用户需求沟通 | 已确认 |\n| E-002 | 代码依据 | 首页采用 van-tabs 与虚拟滚动 | H5_前端 | 已确认 |\n| E-003 | 架构推断 | 派生计算状态单量 | 前端架构评估 | 已确认 |',
      expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint,
    },
  })
  assert.equal(state.selectionCalls ?? 0, 0)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(state.patchCalls, 1)
  const after = await call({ action: 'read' })
  assert.equal(after.result.document.blocks.filter((block) => block.type === 'table').length, 1)
  assert.match(after.result.document.blocks.find((block) => block.type === 'table').text, /E-003/)
  assert.equal(after.result.document.blocks.at(-1).text, '表格后正文')
})

test('light-document rejects an ambiguous selected table before any insert or patch', async () => {
  const state = {}
  const table = (id) => `<table id="${id}"><tr><td><p id="">类型</p></td><td><p id="">来源</p></td></tr><tr><td><p id="">用户事实</p></td><td><p id="">用户沟通</p></td></tr></table>`
  const call = await runtime({
    state,
    initialXml: `<apcanvas><outlineTitle id="title">重复表格</outlineTitle>${table('one')}${table('two')}</apcanvas>`,
    otlSelection: { from: 10, to: 20, anchor: 10, head: 20, empty: false },
    selectionInfo: { selected_tag_ids: ["table[@id='one']/td"] },
    selection: { async getSelectionContent() { return { html: '<table><tr><td>类型</td><td>来源</td></tr><tr><td>用户事实</td><td>用户沟通</td></tr></table>', text: '类型 来源 用户事实 用户沟通' } } },
  })
  const selected = await call({ action: 'selection' })
  assert.equal(selected.result.document.selection.replaceStrategy, 'unavailable')
  const result = await call({ action: 'write', operation: 'selection_content_replace', resource: selected.result.resource, payload: {
    markdown: '| 类型 | 来源 |\n| --- | --- |\n| 代码依据 | H5_前端 |',
    expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint,
  } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsupported')
  assert.equal(state.selectionCalls ?? 0, 0)
  assert.equal(state.patchCalls ?? 0, 0)
  const after = await call({ action: 'read' })
  assert.equal(after.result.document.blocks.filter((block) => block.type === 'table').length, 2)
})

test('light-document runtime inserts mermaid drawings, structured blocks, and selection replace with XML evidence', async () => {
  const emptyXml = '<apcanvas><outlineTitle id="title">未命名文档</outlineTitle></apcanvas>'
  const insert = await runtime({ initialXml: emptyXml })
  const empty = await insert({ action: 'read' })
  assert.equal(empty.result.document.blockCount, 0)
  const drawing = await insert({ action: 'write', operation: 'insert_drawing', resource: empty.result.resource, payload: { mermaid: 'flowchart TD\n开始 --> 结束', position: 'end' } })
  assert.equal(drawing.ok, true, JSON.stringify(drawing))
  assert.equal(drawing.result.observed.verified, true)
  assert.ok(drawing.result.observed.verifiedFragments.includes('flowchart'))
  const afterDrawing = await insert({ action: 'read' })
  assert.equal(afterDrawing.result.document.blocks.some((block) => block.type === 'codeblock' && block.language === 'mermaid'), true)

  const structured = await runtime({ initialXml: emptyXml })
  const before = await structured({ action: 'read' })
  const inserted = await structured({
    action: 'write', operation: 'blocks_insert', resource: before.result.resource,
    payload: {
      position: 'end',
      blocks: [
        { type: 'h2', text: '项目概述' },
        { type: 'p', text: '演示正文' },
        { type: 'ul', items: ['目标一项', '目标二项'] },
        { type: 'table', rows: [['负责人', '交付物'], ['张三', '说明书']] },
        { type: 'codeblock', language: 'mermaid', text: 'pie title 销量分布\n"A" : 40\n"B" : 60' },
      ],
    },
  })
  assert.equal(inserted.ok, true, JSON.stringify(inserted))
  assert.ok(inserted.result.observed.verifiedFragments.includes('项目概述'))
  assert.ok(inserted.result.observed.verifiedFragments.includes('销量分布'))
  const after = await structured({ action: 'read' })
  assert.equal(after.result.document.blocks.some((block) => block.type === 'table'), true)
  assert.equal(after.result.document.blocks.some((block) => block.type === 'codeblock' && block.language === 'mermaid'), true)

  const state = {}
  const replace = await runtime({
    state,
    initialXml: '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="one">已选内容</p></apcanvas>',
    selectionReplace: true,
    selection: {
      async getSelectionContent() { return { text: '已选内容' } },
      async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 5 } },
    },
  })
  const selected = await replace({ action: 'selection' })
  const replaced = await replace({ action: 'write', operation: 'selection_replace', resource: selected.result.resource, payload: { text: '改写内容', expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint } })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(state.replaceCalls, 1)
  assert.equal(state.selectionCalls ?? 0, 0)

  const collapsed = await runtime({ selection: { async getSelectionContent() { return { text: '' } }, async getSelectionAnchor() { return { blockId: 'one', start: 4, end: 4 } }, async replaceContent() { state.replaceCalls = 99 } } })
  const caret = await collapsed({ action: 'selection' })
  const rejectedCaret = await collapsed({ action: 'write', operation: 'selection_replace', resource: caret.result.resource, payload: { text: '不应写入', expectedSelectionFingerprint: caret.result.document.selection.selectionFingerprint } })
  assert.equal(rejectedCaret.ok, false)
  assert.equal(rejectedCaret.error.code, 'invalid_range')

  const missing = await runtime({ selection: { async getSelectionContent() { return { text: '已选内容' } }, async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 5 } } } })
  const read = await missing({ action: 'selection' })
  const rejected = await missing({ action: 'write', operation: 'selection_replace', resource: read.result.resource, payload: { text: '不应写入', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'unsupported')
})

test('light-document runtime inserts a Mermaid drawing immediately after the stable current selection', async () => {
  const call = await runtime({
    initialXml: '<apcanvas><outlineTitle id="title">演示文档</outlineTitle><p id="before">前置正文</p><p id="selected-one">能力一</p><p id="selected-two">能力二</p><p id="after">后置正文</p></apcanvas>',
    otlSelection: { from: 10, to: 20, anchor: 10, head: 20, empty: false },
    selectionInfo: { selected_tag_ids: ['selected-one', 'selected-two'] },
    selection: {
      async getSelectionContent() { return { text: '能力一 能力二' } },
      async getSelectionAnchor() { return { blockId: 'selected-one', start: 10, end: 20 } },
    },
  })
  const selected = await call({ action: 'selection' })
  const drawing = await call({
    action: 'write', operation: 'insert_drawing', resource: selected.result.resource,
    payload: {
      mermaid: 'flowchart TD\n开始 --> 结束', position: 'after_selection',
      expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint,
    },
  })
  assert.equal(drawing.ok, true, JSON.stringify(drawing))
  assert.deepEqual(Array.from(drawing.result.observed.insertion.selectedTagIds), ['selected-one', 'selected-two'])
  const after = await call({ action: 'read' })
  assert.deepEqual(Array.from(after.result.document.blocks, (block) => block.id), ['before', 'selected-one', 'selected-two', null, 'after'])
  assert.equal(after.result.document.blocks[3].language, 'mermaid')
})

test('light-document preview rejects incompatible Mermaid and stale insertion or deletion targets before approval', async () => {
  const call = await runtime({ initialXml: '<apcanvas><outlineTitle id="title">演示文档</outlineTitle><p id="current">当前正文</p></apcanvas>' })
  const read = await call({ action: 'read' })
  const incompatible = await call({ action: 'inspect_write', operation: 'insert_drawing', resource: read.result.resource, payload: { mermaid: 'xychart-beta\n  x-axis [一月, 二月]\n  bar [1, 2]', position: 'end' } })
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.error.code, 'invalid_range')
  assert.match(incompatible.error.message, /xychart-beta.*not supported|not supported.*xychart-beta/i)

  const compatible = await call({ action: 'inspect_write', operation: 'insert_drawing', resource: read.result.resource, payload: { mermaid: 'sequenceDiagram\n参与者甲->>参与者乙: 确认', position: 'end' } })
  assert.equal(compatible.ok, true, JSON.stringify(compatible))
  const sequence = await call({ action: 'write', operation: 'insert_drawing', resource: read.result.resource, payload: { mermaid: 'sequenceDiagram\n参与者甲->>参与者乙: 确认', position: 'end' } })
  assert.equal(sequence.ok, true, JSON.stringify(sequence))
  assert.equal(sequence.result.observed.observedBlocks[0].language, 'mermaid')

  const staleInsert = await call({ action: 'inspect_write', operation: 'insert_drawing', resource: read.result.resource, payload: { mermaid: 'flowchart TD\n开始 --> 结束', position: 'after', id: 'stale-id' } })
  assert.equal(staleInsert.ok, false)
  assert.equal(staleInsert.error.code, 'invalid_range')
  assert.match(staleInsert.error.message, /light_document_read/)

  const staleDelete = await call({ action: 'inspect_write', operation: 'blocks_delete', resource: read.result.resource, payload: { blocks: [{ id: 'stale-id' }] } })
  assert.equal(staleDelete.ok, false)
  assert.equal(staleDelete.error.code, 'invalid_range')
  assert.match(staleDelete.error.message, /light_document_read/)
})

test('light-document runtime atomically replaces a stable whole-block selection when replaceContent is unavailable', async () => {
  const state = {}
  const firstId = 'pxbYLFAvkv'; const secondId = 'pxbK7R0v8n'
  const call = await runtime({ state, initialXml: `<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="${firstId}">重复</p><p id="${secondId}">重复</p></apcanvas>`, otlSelection: { from: 1, to: 9, anchor: 1, head: 9, empty: false }, selectionInfo: { selected_tag_ids: [`p[@id='${firstId}']`, `p[@id='${secondId}']`] }, selection: {
    async getSelectionContent() { return { text: '重复 重复' } },
    async getSelectionAnchor() { return { blockId: `p[@id='${firstId}']`, start: 1, end: 9 } },
  } })
  const selected = await call({ action: 'selection' })
  assert.deepEqual(Array.from(selected.result.document.selection.selectedTagIds), [firstId, secondId])
  assert.equal(selected.result.document.selection.anchor.blockId, firstId)
  const result = await call({ action: 'write', operation: 'selection_replace', resource: selected.result.resource, payload: { text: '原子替换内容', expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(state.replaceCalls ?? 0, 0)
  assert.equal(state.patchCalls, 1)
  assert.ok(result.result.observed.replacedTagIds.includes(secondId))
})

test('light-document runtime rejects malformed or duplicate public selectedTagIds before CanvasPatch', async () => {
  for (const selectedTagIds of [["p[@id='one']../p"], ["p[@id='one']", "p[@id='one']"]]) {
    const state = {}
    const call = await runtime({ state, otlSelection: { from: 1, to: 9, anchor: 1, head: 9, empty: false }, selectionInfo: { selected_tag_ids: selectedTagIds }, selection: {
      async getSelectionContent() { return { text: '重复 重复' } },
      async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 9 } },
    } })
    const selected = await call({ action: 'selection' })
    assert.equal(selected.result.document.selection.selectionIdsValid, false)
    const result = await call({ action: 'write', operation: 'selection_blocks_replace', resource: selected.result.resource, payload: { expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint, blocks: [{ type: 'p', text: '不应写入' }] } })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unsupported')
    assert.equal(state.patchCalls ?? 0, 0)
  }
})

test('light-document runtime atomically replaces complete multi-block rich selections with structural readback', async () => {
  const state = {}
  const call = await runtime({ state, otlSelection: { from: 1, to: 9, anchor: 1, head: 9, empty: false }, selectionInfo: { selected_tag_ids: ['one', 'two'] }, selection: {
    async getSelectionContent() { return { text: '重复 重复' } },
    async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 9 } },
  } })
  const selected = await call({ action: 'selection' })
  const oldRichPath = await call({ action: 'write', operation: 'selection_replace', resource: selected.result.resource, payload: { markdown: '## 优化结论\n\n结构化正文', expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint } })
  assert.equal(oldRichPath.ok, false)
  assert.equal(oldRichPath.error.code, 'unsupported')
  const result = await call({ action: 'write', operation: 'selection_blocks_replace', resource: selected.result.resource, payload: {
    expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint,
    blocks: [{ type: 'h2', text: '优化结论' }, { type: 'p', text: '替换后的结构化正文' }, { type: 'table', rows: [['项', '结果'], ['选区', '已替换']] }],
  } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(state.patchCalls, 1)
  assert.equal(state.replaceCalls ?? 0, 0)
  assert.deepEqual(Array.from(result.result.observed.observedBlocks, (block) => block.type), ['h2', 'p', 'table'])
  assert.ok(result.result.observed.replacedTagIds.includes('two'))
})

test('light-document runtime verifies full CanvasPatch replacement when WebEdit regenerates every block id', async () => {
  const initialXml = '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="before">前置</p><p id="one">重复</p><p id="two">重复</p><blockquote id="after">后置</blockquote></apcanvas>'
  for (const [options, expectedOk] of [[{ regenerateIds: true }, true], [{ regenerateIds: true, tamperOutside: true }, false]]) {
    const state = {}
    const call = await runtime({ state, initialXml, ...options, otlSelection: { from: 1, to: 9, anchor: 1, head: 9, empty: false }, selectionInfo: { selected_tag_ids: ['one', 'two'] }, selection: {
      async getSelectionContent() { return { text: '重复 重复' } }, async getSelectionAnchor() { return { blockId: 'one', start: 1, end: 9 } },
    } })
    const selected = await call({ action: 'selection' })
    const result = await call({ action: 'write', operation: 'selection_blocks_replace', resource: selected.result.resource, payload: { expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint, blocks: [{ type: 'h2', text: '优化结论' }, { type: 'p', text: '替换正文' }] } })
    assert.equal(result.ok, expectedOk, JSON.stringify(result))
    assert.equal(state.patchCalls, 1)
    if (expectedOk) {
      assert.equal(result.result.observed.writeStrategy, 'full_canvas_patch')
      assert.equal(result.result.observed.idsRegenerated, true)
      assert.deepEqual(Array.from(result.result.observed.outsideSelectionBlocks, (block) => `${block.type}:${block.text}`), ['p:前置', 'blockquote:后置'])
    } else assert.equal(result.error.code, 'readback_mismatch')
  }
})

test('light-document runtime never CanvasPatches a partial first or last selected block', async () => {
  for (const content of ['复 重复', '重复 重']) {
    const state = {}
    const call = await runtime({ state, otlSelection: { from: 2, to: 8, anchor: 2, head: 8, empty: false }, selectionInfo: { selected_tag_ids: ['one', 'two'] }, selection: {
      async getSelectionContent() { return { text: content } },
      async getSelectionAnchor() { return { blockId: 'one', start: 2, end: 8 } },
    } })
    const selected = await call({ action: 'selection' })
    const result = await call({ action: 'write', operation: 'selection_blocks_replace', resource: selected.result.resource, payload: {
      expectedSelectionFingerprint: selected.result.document.selection.selectionFingerprint,
      blocks: [{ type: 'p', text: '不应删除整块' }],
    } })
    assert.equal(result.ok, false, content)
    assert.equal(result.error.code, 'unsupported')
    assert.equal(state.patchCalls ?? 0, 0)
  }
})

test('light-document selection_insert ignores checkbox markers when attesting XML fragments', async () => {
  const state = {}
  const call = await runtime({
    state,
    selection: { async getSelectionContent() { return { text: '' } }, async getSelectionAnchor() { return { blockId: 'one', start: 4, end: 4 } } },
  })
  const read = await call({ action: 'selection' })
  const result = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload: { markdown: '- [x] 已完成事项\n- [ ] 未完成事项', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.result.observed.verifiedFragments.includes('x'), false)
  assert.ok(result.result.observed.verifiedFragments.includes('已完成事项'))
})

test('light-document runtime rejects body replace on an empty document and names selection_insert', async () => {
  const initialXml = '<apcanvas><outlineTitle id="title">未命名文档</outlineTitle></apcanvas>'
  const state = {}
  const call = await runtime({ initialXml, state })
  const before = await call({ action: 'read' })
  assert.equal(before.result.document.blockCount, 0)
  const replaced = await call({ action: 'write', operation: 'replace', resource: before.result.resource, payload: { markdown: '演示内容' } })
  assert.equal(replaced.ok, false)
  assert.equal(replaced.error.code, 'invalid_range')
  assert.match(replaced.error.message, /selection_insert/)
  const batched = await call({ action: 'write', operation: 'blocks_replace', resource: before.result.resource, payload: { type: 'h1', text: '演示内容' } })
  assert.equal(batched.ok, false)
  assert.equal(batched.error.code, 'invalid_range')
  assert.match(batched.error.message, /no public replaceable block/)
  assert.equal(state.patchCalls ?? 0, 0)
})

test('light-document runtime rejects deleting a block without a stable id before CanvasPatch', async () => {
  const initialXml = '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p>不可验证删除</p></apcanvas>'
  const state = {}
  const call = await runtime({ initialXml, state })
  const before = await call({ action: 'read' })
  const deleted = await call({ action: 'write', operation: 'delete', resource: before.result.resource, payload: { index: 0 } })
  assert.equal(deleted.ok, false)
  assert.equal(deleted.error.code, 'invalid_range')
  assert.equal(state.patchCalls ?? 0, 0)
  assert.equal(state.xml, initialXml)
  const after = await call({ action: 'read' })
  assert.deepEqual(after.result.document.blocks, before.result.document.blocks)
})

test('light-document runtime pages rich reads and verifies public selection, block, title, and export contracts', async () => {
  let title = '旧标题'
  const call = await runtime({
    selection: { async getSelectionContent() { return { html: '<strong>选区</strong>', text: '选区', markdown: '**选区**' } }, async replaceContent() {} },
    documentApi: {
      async getWordCount() { return { words: 12, characters: 34 } },
      async getTitleContent() { return title }, async setTitleContent(next) { title = next },
      comments: { async getComments() { return [{ id: 'c1', text: '一' }, { id: 'c2', content: '二' }] } },
    },
    editorApi: { async exportAsPdf() { return { url: 'https://download.example.test/test.pdf?X-Amz-Signature=secret&Expires=2000000000' } } },
  })
  const titleRead = await call({ action: 'read', payload: { kind: 'title' } })
  assert.equal(titleRead.result.document.title.text, '旧标题')
  const initial = await call({ action: 'read' }); const resource = initial.result.resource
  const capabilities = await call({ action: 'read', payload: { kind: 'capabilities' } })
  assert.equal(capabilities.result.document.capabilities.selection, false); assert.equal(capabilities.result.document.capabilities.wordCount, true)
  assert.equal(capabilities.result.document.capabilities.currentWholeBlockReplaceable, false)
  assert.equal(capabilities.result.document.capabilities.selectionRichReplace, false)
  assert.equal(capabilities.result.document.capabilities.drawings, true)
  assert.equal(capabilities.result.document.capabilities.blockRichHtml, true)
  assert.deepEqual(Array.from(capabilities.result.document.capabilities.detectedButUnsupported), ['exportPdf'])
  const selection = await call({ action: 'selection', payload: { maxChars: 100 } })
  assert.equal(selection.ok, true); assert.equal(selection.result.document.selection.supported, true)
  assert.equal(selection.result.document.selection.stable, false)
  const words = await call({ action: 'read', payload: { kind: 'word_count' } })
  assert.equal(words.result.document.wordCount.words, 12)
  const comments = await call({ action: 'read', offset: 1, limit: 1, payload: { kind: 'comments' } })
  assert.deepEqual(Array.from(comments.result.document.comments, (item) => item.id), ['c2']); assert.equal(comments.result.document.hasMore, false)
  const block = await call({ action: 'read', payload: { kind: 'block', id: 'one', maxChars: 10 } })
  assert.equal(block.result.document.block.id, 'one')
  const titled = await call({ action: 'write', resource, operation: 'set_title', payload: { title: '新标题' } })
  assert.equal(titled.ok, true); assert.equal(titled.result.observed.title, '新标题')
  assert.notEqual(titled.result.resource.fingerprint, resource.fingerprint)
  const exported = await call({ action: 'write', resource: titled.result.resource, operation: 'export_pdf', payload: {} })
  assert.equal(exported.ok, false); assert.equal(exported.error.code, 'unsupported')
})

test('light-document search matches full block text while returning bounded summaries', async () => {
  const longText = `${'前'.repeat(140)}尾部关键词${'后'.repeat(20)}`
  const call = await runtime({ initialXml: `<apcanvas><outlineTitle id="title">标题</outlineTitle><p id="long">${longText}</p></apcanvas>` })
  const searched = await call({ action: 'search', query: '尾部关键词', offset: 0, limit: 10 })
  assert.equal(searched.ok, true)
  assert.equal(searched.result.document.total, 1)
  assert.equal(searched.result.document.blocks[0].id, 'long')
  assert.equal(searched.result.document.blocks[0].text.length, 120)
  assert.equal(searched.result.document.blocks[0].truncated, true)
  assert.equal('fullText' in searched.result.document.blocks[0], false)
})

test('light-document title read fails closed for missing, thrown, and malformed public APIs', async () => {
  const missing = await runtime({ documentApi: {} })
  const missingTitle = (await missing({ action: 'read', payload: { kind: 'title' } })).result.document.title
  assert.equal(missingTitle.supported, false); assert.equal(missingTitle.reason, 'title_api_not_detected')

  const thrown = await runtime({ documentApi: { async getTitleContent() { throw new Error('no title') } } })
  const thrownTitle = (await thrown({ action: 'read', payload: { kind: 'title' } })).result.document.title
  assert.equal(thrownTitle.supported, false); assert.equal(thrownTitle.reason, 'title_api_unreadable')

  const malformed = await runtime({ documentApi: { async getTitleContent() { return { value: 'not authoritative' } } } })
  const malformedTitle = (await malformed({ action: 'read', payload: { kind: 'title' } })).result.document.title
  assert.equal(malformedTitle.supported, false); assert.equal(malformedTitle.reason, 'title_api_unreadable')
})

test('light-document runtime verifies stable-ID batch edits while ambiguous selection and media remain fail-closed', async () => {
  const call = await runtime({ selection: { async getSelectionContent() { return { text: '选区', html: '<strong>选区</strong>' } } } })
  const initial = await call({ action: 'read' }); const resource = initial.result.resource
  const batch = await call({ action: 'write', resource, operation: 'blocks_batch_replace', payload: { replacements: [{ id: 'one', text: '第一段' }, { id: 'two', text: '第二段' }] } })
  assert.equal(batch.ok, true); assert.equal(batch.result.observed.verified, true)
  const deleted = await call({ action: 'write', resource: batch.result.resource, operation: 'blocks_batch_edit', payload: { deletions: [{ id: 'two' }] } })
  assert.equal(deleted.ok, true)
  const exactReplace = await call({ action: 'write', resource: deleted.result.resource, operation: 'selection_insert', payload: { html: '<em>不应写入</em>' } })
  assert.equal(exactReplace.ok, false); assert.equal(exactReplace.error.code, 'unsupported')
  const unsupported = await call({ action: 'write', resource: deleted.result.resource, operation: 'insert_image', payload: { url: 'https://example.test/a.png' } })
  assert.equal(unsupported.ok, false); assert.equal(unsupported.error.code, 'unsupported')
})

test('light-document runtime preserves batch delete/format contracts and reports ordered stable-id readback', async () => {
  const state = {}; const call = await runtime({ state })
  const initial = await call({ action: 'read' })
  const formatPayload = { blocks: [{ id: 'two', style: { italic: true } }, { id: 'one', style: { bold: true, blockType: 'h2' } }] }
  const formatted = await call({ action: 'write', resource: initial.result.resource, operation: 'blocks_format', payload: formatPayload })
  assert.equal(formatted.ok, true); assert.equal(formatted.result.requested.operation, 'blocks_format'); assert.deepEqual(formatted.result.requested.payload, formatPayload)
  assert.deepEqual(Array.from(formatted.result.observed.verifiedBlocks, (item) => item.id), ['two', 'one'])
  const deletePayload = { blocks: [{ id: 'two' }, { id: 'one' }] }
  const deleted = await call({ action: 'write', resource: formatted.result.resource, operation: 'blocks_delete', payload: deletePayload })
  assert.equal(deleted.ok, true); assert.equal(deleted.result.requested.operation, 'blocks_delete'); assert.deepEqual(deleted.result.requested.payload, deletePayload)
  assert.deepEqual(Array.from(deleted.result.observed.verifiedBlocks, (item) => ({ id: item.id, deleted: item.deleted })), [{ id: 'two', deleted: true }, { id: 'one', deleted: true }])
  assert.equal(state.patchCalls, 2)
})

test('light-document batch writes reject unstable ids before mutation and never attest partial mutation', async () => {
  const beforeState = {}; const before = await runtime({ state: beforeState }); const resource = (await before({ action: 'read' })).result.resource
  const unstable = await before({ action: 'write', resource, operation: 'blocks_delete', payload: { blocks: [{ index: 0 }] } })
  assert.equal(unstable.ok, false); assert.equal(beforeState.patchCalls ?? 0, 0)

  const partialState = {}; const partial = await runtime({ state: partialState, keepBlockId: 'two' }); const partialResource = (await partial({ action: 'read' })).result.resource
  const result = await partial({ action: 'write', resource: partialResource, operation: 'blocks_delete', payload: { blocks: [{ id: 'one' }, { id: 'two' }] } })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'readback_mismatch'); assert.equal(partialState.patchCalls, 1)
})

test('single and batch formatting preserve links and inline markup while changing only requested formatting', async () => {
  const initialXml = '<apcanvas><outlineTitle id="title">标题</outlineTitle><p id="one">前<a href="/x"><span class="mark">链接</span></a>后</p><p id="two"><span data-k="v">第二段</span></p></apcanvas>'
  const state = {}; const call = await runtime({ initialXml, state }); const resource = (await call({ action: 'read' })).result.resource
  const single = await call({ action: 'write', resource, operation: 'format', payload: { id: 'one', style: { bold: true, blockType: 'h2' } } })
  assert.equal(single.ok, true); assert.match(state.xml, /<h2 id="one"><strong>前<a href="\/x"><span class="mark">链接<\/span><\/a>后<\/strong><\/h2>/)
  const batch = await call({ action: 'write', resource: single.result.resource, operation: 'blocks_format', payload: { blocks: [{ id: 'one', style: { bold: false } }, { id: 'two', style: { italic: true } }] } })
  assert.equal(batch.ok, true); assert.doesNotMatch(state.xml, /<strong\b/)
  assert.match(state.xml, /<h2 id="one">前<a href="\/x"><span class="mark">链接<\/span><\/a>后<\/h2>/)
  assert.match(state.xml, /<p id="two"><em><span data-k="v">第二段<\/span><\/em><\/p>/)

  const ignored = await runtime({ initialXml, ignoreFormat: true }); const ignoredResource = (await ignored({ action: 'read' })).result.resource
  const mismatch = await ignored({ action: 'write', resource: ignoredResource, operation: 'blocks_format', payload: { blocks: [{ id: 'one', style: { italic: true } }] } })
  assert.equal(mismatch.ok, false); assert.equal(mismatch.error.code, 'readback_mismatch')
})

test('blocks_replace with ul/ol verifies structurally and keeps the target addressable', async () => {
  const state = {}; const call = await runtime({ state })
  const resource = (await call({ action: 'read' })).result.resource
  const replaced = await call({ action: 'write', resource, operation: 'blocks_replace', payload: { id: 'one', type: 'ul', items: ['甲项', '乙项'] } })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(replaced.result.observed.verified, true)
  assert.equal(state.patchCalls, 1)
  // The stable id must survive on the first generated paragraph so later
  // blocks_delete / blocks_format can still address the replacement.
  assert.match(state.xml, /<p id="one" paddingLeft="2">/)
  const olBatched = await call({ action: 'write', resource: replaced.result.resource, operation: 'blocks_batch_replace', payload: { replacements: [{ id: 'two', type: 'ol', items: ['第一', '第二'] }] } })
  assert.equal(olBatched.ok, true, JSON.stringify(olBatched))
  const final = await call({ action: 'read' })
  assert.equal(final.result.document.blocks.map((block) => block.text).join('|'), '- 甲项|- 乙项|1. 第一|2. 第二')
  const deleted = await call({ action: 'write', resource: olBatched.result.resource, operation: 'blocks_delete', payload: { ids: ['one'] } })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  const afterDelete = await call({ action: 'read' })
  assert.equal(afterDelete.result.document.blocks.map((block) => block.text).join('|'), '- 乙项|1. 第一|2. 第二')
})

test('replace parses markdown into structured blocks instead of dumping raw syntax', async () => {
  const state = {}; const call = await runtime({ state })
  const resource = (await call({ action: 'read' })).result.resource
  const replaced = await call({ action: 'write', resource, operation: 'replace', payload: { index: 0, markdown: '## 小节\n\n- **要点**：说明文字' } })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.equal(replaced.result.observed.verified, true)
  assert.doesNotMatch(state.xml, /##|\*\*/)
  const after = await call({ action: 'read' })
  assert.equal(after.result.document.blocks.map((block) => block.type).join('|'), 'h2|p|p')
  assert.equal(after.result.document.blocks[0].text, '小节')
  assert.equal(after.result.document.blocks[1].text, '- 要点：说明文字')
  assert.match(state.xml, /<strong>要点<\/strong>/)
})

test('team-knowledge batch document replacement atomically removes a prefilled PRD template', async () => {
  const state = {}
  const initialXml = [
    '<apcanvas><outlineTitle id="title">新建 PRD</outlineTitle>',
    '<h1 id="legacy-heading">八、测试关注点</h1>',
    '<h2 id="legacy-exception">（二）异常场景关注点</h2>',
    '<p id="legacy-copy">列出需要重点测试的异常场景，包括服务异常、数据异常、网络异常等。</p>',
    ...Array.from({ length: 55 }, (_, index) => `<p id="legacy-${index}">旧模板占位 ${index}</p>`),
    '</apcanvas>',
  ].join('')
  const generatedPrd = [
    '# 客户经理维护流程简化 PRD',
    '## 八、测试关注点',
    '### （二）验收清单',
    '#### 异常情况',
    '- 服务异常时提示用户稍后重试。',
  ].join('\n')
  const call = await runtime({ state, initialXml })
  const before = await call({ action: 'read' })
  const result = await call({
    action: 'write', operation: 'team_knowledge_batch_replace', resource: before.result.resource,
    payload: { markdown: generatedPrd, replaceScope: 'team_knowledge_batch_document' },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.result.observed.verified, true)
  assert.equal(state.patchCalls, 1)
  assert.match(state.xml, /异常情况/)
  assert.doesNotMatch(state.xml, /列出需要重点测试的异常场景/)
  assert.equal((state.xml.match(/测试关注点/g) ?? []).length, 1)
  assert.equal((state.xml.match(/旧模板占位/g) ?? []).length, 0)
})

test('team-knowledge batch document replacement initializes a completely blank child document in one CanvasPatch', async () => {
  const state = {}
  const generatedPrd = '# 产业带摸排表格线上化 PRD\n\n## 背景与目标\n\n完成线上化。'
  const call = await runtime({ state, initialXml: '<apcanvas></apcanvas>' })
  const before = await call({ action: 'read' })
  const result = await call({
    action: 'write', operation: 'team_knowledge_batch_replace', resource: before.result.resource,
    payload: { markdown: generatedPrd, replaceScope: 'team_knowledge_batch_document' },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.result.observed.verified, true)
  assert.equal(state.patchCalls, 1)
  assert.equal((state.xml.match(/<outlineTitle\b/gi) ?? []).length, 1)
  const after = await call({ action: 'read' })
  assert.equal(after.result.document.blocks.map((block) => `${block.type}:${block.text}`).join('|'), 'h1:产业带摸排表格线上化 PRD|h2:背景与目标|p:完成线上化。')
})

test('team-knowledge batch document replacement fails closed for ambiguous title structure', async () => {
  const markdown = '# PRD\n\n正文'
  for (const initialXml of [
    '<apcanvas><outlineTitle id="one">标题一</outlineTitle><outlineTitle id="two">标题二</outlineTitle></apcanvas>',
    '<apcanvas><p id="body">已有正文</p></apcanvas>',
  ]) {
    const state = {}
    const call = await runtime({ state, initialXml })
    const before = await call({ action: 'read' })
    const result = await call({
      action: 'write', operation: 'team_knowledge_batch_replace', resource: before.result.resource,
      payload: { markdown, replaceScope: 'team_knowledge_batch_document' },
    })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.error.code, 'invalid_range')
    assert.equal(state.patchCalls ?? 0, 0)
    assert.equal(state.xml, initialXml)
  }
})

test('reads keep inline closing tags on one line inside a paragraph', async () => {
  const call = await runtime({ initialXml: '<apcanvas><p id="b1"><span><strong>多级标题</strong>：清晰的内容层级结构</span></p></apcanvas>' })
  const read = await call({ action: 'read' })
  assert.equal(read.result.document.blocks[0].text, '多级标题：清晰的内容层级结构')
})
