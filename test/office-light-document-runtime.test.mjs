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
    async patch({ xml: patch }) { if (state) state.patchCalls = (state.patchCalls ?? 0) + 1; if (!options.ignoreFormat || !/<strong\b|<em\b|<h[1-6]\b/i.test(patch)) xml = `<apcanvas>${/^<replace sel="\/\/apcanvas">([\s\S]*)<\/replace>$/.exec(patch)?.[1] ?? ''}</apcanvas>`; if (state) state.xml = xml; return { success: true } },
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
