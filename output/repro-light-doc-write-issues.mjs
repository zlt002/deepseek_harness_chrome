// 自包含复现：轻文档写入链路的三个疑似缺陷
// 1) blocks_replace + ul/ol：文档已改但 readback 永远 mismatch（假阴性 → 记录进 uncertain，禁止重试）
// 2) decode() 把所有闭合标签换成换行：行内加粗被读成 "多级标题\n：xxx"
// 3) replace 操作直接把 markdown 原文塞进 <p>：语法字符以纯文本落盘
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'

async function runtime(options = {}) {
  const state = options.state
  let xml = options.initialXml ?? '<apcanvas><outlineTitle id="title">旧标题</outlineTitle><p id="one">重复</p><p id="two">重复</p></apcanvas>'
  if (state) state.xml = xml
  const listeners = new Map()
  const window = { addEventListener(name, listener) { listeners.set(name, listener) }, dispatchEvent(event) { listeners.get(event.type)?.(event) } }
  const canvas = {
    async getDocXml() { return xml },
    async patch({ xml: patch }) {
      if (state) state.patchCalls = (state.patchCalls ?? 0) + 1
      xml = `<apcanvas>${/^<replace sel="\/\/apcanvas">([\s\S]*)<\/replace>$/.exec(patch)?.[1] ?? ''}</apcanvas>`
      if (state) state.xml = xml
      return { success: true }
    },
  }
  const documentApi = { selection: {} }
  const editor = { canvas, document: documentApi }
  const context = vm.createContext({ window, globalThis: null, APP: { openApi: { editor } }, location: { href: 'https://webedit.midea.com/x', origin: 'https://webedit.midea.com', pathname: '/x' }, document: { title: '测试', createElement() { return { set innerHTML(value) { this.value = String(value).replace(/<[^>]+>/g, '') }, value: '' } } }, crypto: webcrypto, TextEncoder, Uint8Array, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } }, setTimeout, clearTimeout, Date })
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

// ── 问题 1：blocks_replace + ul ───────────────────────────────
{
  const state = {}
  const call = await runtime({ state })
  const read = await call({ action: 'read' })
  const result = await call({
    action: 'write', operation: 'blocks_replace', resource: read.result.resource,
    payload: { id: 'one', type: 'ul', items: ['甲项', '乙项'] },
  })
  console.log('[1] blocks_replace+ul →', JSON.stringify(result))
  console.log('[1] patch 调用次数 =', state.patchCalls, '；文档当前 XML =', state.xml)
  console.log('[1] 断言：写入已发生(patch=1) =', state.patchCalls === 1)
}

// ── 问题 2：decode 的行内标签换行伪影 ────────────────────────
{
  const call = await runtime({ initialXml: '<apcanvas><p id="b1"><span><strong>多级标题</strong>：清晰的内容层级结构</span></p></apcanvas>' })
  const read = await call({ action: 'read' })
  console.log('[2] 富文本块的 text 读回 =', JSON.stringify(read.result.document.blocks[0].text))
  console.log('[2] 期望（无换行）= "多级标题：清晰的内容层级结构"')
}

// ── 问题 3：replace 直接落盘 markdown 原文 ────────────────────
{
  const state = {}
  const call = await runtime({ state })
  const read = await call({ action: 'read' })
  const result = await call({
    action: 'write', operation: 'replace', resource: read.result.resource,
    payload: { index: 0, markdown: '## 小节\n- **要点**：说明文字' },
  })
  console.log('[3] replace(markdown) → ok =', result.ok, '；写入后 XML =', state.xml)
  const after = await call({ action: 'read' })
  console.log('[3] 落盘文本 =', JSON.stringify(after.result.document.blocks.map((b) => b.text)))
}
