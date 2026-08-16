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
  const selection = { async insertContent({ markdown, html, text }) { xml = xml.replace('</apcanvas>', `<p id="inserted">${markdown ?? html ?? text}</p></apcanvas>`) }, ...(options.selection ?? {}) }
  const documentApi = { selection, ...(options.documentApi ?? {}) }
  const editor = { canvas, document: documentApi, ...(options.editorApi ?? {}) }
  const context = vm.createContext({ window, globalThis: null, APP: { openApi: { editor } }, location: { href: 'https://webedit.midea.com/weboffice/office/o/1', origin: 'https://webedit.midea.com', pathname: '/weboffice/office/o/1' }, document: { title: '测试', createElement() { return { set innerHTML(value) { this.value = String(value).replace(/<[^>]+>/g, '') }, value: '' } } }, crypto: webcrypto, TextEncoder, Uint8Array, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } }, setTimeout, clearTimeout, Date })
  context.globalThis = context
  vm.runInContext(await readFile(new URL('../public/office-light-document-runtime.js', import.meta.url), 'utf8'), context)
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
  assert.deepEqual(Array.from(capabilities.result.document.capabilities.detectedButUnsupported), ['selectionRichReplace', 'exportPdf'])
  const selection = await call({ action: 'selection', payload: { maxChars: 100 } })
  assert.equal(selection.result.document.selection.supported, false); assert.equal(selection.result.document.selection.reason, 'selection_anchor_api_not_detected')
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
