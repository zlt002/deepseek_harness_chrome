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
  const context = vm.createContext({ window, globalThis: null, APP: { openApi: { editor: { canvas, document: { selection: { async insertContent({ markdown }) { xml = xml.replace('</apcanvas>', `<p id="inserted">${markdown}</p></apcanvas>`) } } } } } }, location: { href: 'https://webedit.midea.com/weboffice/office/o/1', origin: 'https://webedit.midea.com', pathname: '/weboffice/office/o/1' }, document: { title: '测试', createElement() { return { set innerHTML(value) { this.value = String(value).replace(/<[^>]+>/g, '') }, value: '' } } }, crypto: webcrypto, TextEncoder, Uint8Array, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } }, setTimeout, clearTimeout, Date })
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
  assert.equal(replace.ok, true); assert.match(replace.result.observed.text, /旧标题/); assert.match(replace.result.observed.text, /新内容/)
  const formatted = await call({ action: 'write', operation: 'format', resource: replace.result.resource, payload: { index: 0, style: { bold: true, blockType: 'h2' } } })
  assert.equal(formatted.ok, true)
  const deleted = await call({ action: 'write', operation: 'delete', resource: formatted.result.resource, payload: { id: 'two' } })
  assert.equal(deleted.ok, true); assert.match(deleted.result.observed.text, /新内容/)
  const titled = await call({ action: 'write', operation: 'title', resource: deleted.result.resource, payload: { text: '新标题' } })
  assert.equal(titled.ok, true); assert.match(titled.result.observed.text, /新标题/)
})

test('light-document runtime treats markdown inserts semantically and rejects an unobserved format patch', async () => {
  const insert = await runtime()
  const read = await insert({ action: 'read' })
  const inserted = await insert({ action: 'write', operation: 'insert', resource: read.result.resource, payload: { markdown: '# 标题\n- 第一项\n- 第二项' } })
  assert.equal(inserted.ok, true); assert.deepEqual(Array.from(inserted.result.observed.verifiedFragments), ['标题', '第一项', '第二项'])
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
