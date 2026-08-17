import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { webcrypto } from 'node:crypto'

async function runtime(options = {}) {
  const state = options.state
  let xml = options.initialXml ?? '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="one">重复</p><p id="two">重复</p></apcanvas>'
  if (state) state.xml = xml
  const listeners = new Map()
  const window = { addEventListener(name, listener) { listeners.set(name, listener) }, dispatchEvent(event) { listeners.get(event.type)?.(event) } }
  const canvas = {
    async getDocXml() { return xml },
    async patch({ xml: patch }) { if (state) state.patchCalls = (state.patchCalls ?? 0) + 1; if (!options.ignoreFormat || !/<strong\b|<em\b|<h[1-6]\b/i.test(patch)) { const before = xml; xml = `<apcanvas>${/^<replace sel="\/\/apcanvas">([\s\S]*)<\/replace>$/.exec(patch)?.[1] ?? ''}</apcanvas>`; if (options.keepBlockId) { const escaped = String(options.keepBlockId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const original = new RegExp(`<(?:p|h[1-6]|li|blockquote|pre|codeBlock)\\b[^>]*\\bid=["']${escaped}["'][^>]*>[\\s\\S]*?<\\/(?:p|h[1-6]|li|blockquote|pre|codeBlock)>`, 'i').exec(before)?.[0]; if (original && !new RegExp(`\\bid=["']${escaped}["']`, 'i').test(xml)) xml = xml.replace('</apcanvas>', `${original}</apcanvas>`) } } if (state) state.xml = xml; return { success: true } },
  }
  const applySelection = (value) => {
    if (options.selectionInsert === 'throws') throw new Error('insert failed')
    if (options.selectionInsert === 'unchanged') return
    const next = options.selectionInsert === 'mismatch' ? 'unrelated content' : value
    xml = options.selectionReplace === true ? xml.replace('>重复<', `>${next}<`) : xml.replace('</apcanvas>', `<p id="inserted">${next}</p></apcanvas>`)
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
  const context = vm.createContext({ window, globalThis: null, APP: { openApi: { editor }, ...(options.otlSelection ? { OTL: { state: { selection: options.otlSelection } } } : {}) }, location: { href: 'https://webedit.midea.com/weboffice/office/o/1', origin: 'https://webedit.midea.com', pathname: '/weboffice/office/o/1' }, document: { title: '测试', createElement() { return { set innerHTML(value) { this.value = String(value).replace(/<[^>]+>/g, '') }, value: '' } } }, crypto: webcrypto, TextEncoder, Uint8Array, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } }, setTimeout, clearTimeout, Date })
  context.globalThis = context
  vm.runInContext(await readFile(new URL('../apps/chrome-extension/public/office-light-document-runtime.js', import.meta.url), 'utf8'), context)
  let id = 0
  return async (input) => new Promise((resolve) => {
    const requestId = String(++id)
    const response = (event) => { if (event.detail.id === requestId) { listeners.set('deepseek-harness-office-document-response/v1', undefined); resolve(event.detail) } }
    window.addEventListener('deepseek-harness-office-document-response/v1', response)
    window.dispatchEvent(new context.CustomEvent('deepseek-harness-office-document-request/v1', { detail: { id: requestId, ...input } }))
  })
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
    const inserted = await call({ action: 'write', operation: 'selection_insert', resource: read.result.resource, payload: { text: '光标写入', expectedSelectionFingerprint: read.result.document.selection.selectionFingerprint } })
    assert.equal(inserted.ok, true); assert.equal(state.selectionCalls, 1)
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
