(() => {
  'use strict'
  const REQUEST = 'deepseek-harness-office-document-request/v1'
  const RESPONSE = 'deepseek-harness-office-document-response/v1'
  if (globalThis.__deepseekHarnessLightDocumentRuntime) return
  globalThis.__deepseekHarnessLightDocumentRuntime = true

  const fail = (code, message) => ({ ok: false, error: { code, message } })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const decode = (value) => {
    const box = document.createElement('textarea')
    box.innerHTML = String(value).replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<\/[^>]+>/g, '\n').replace(/<[^>]+>/g, '')
    return box.value.replace(/\n{2,}/g, '\n').trim()
  }
  const fingerprint = async (xml) => {
    const bytes = new TextEncoder().encode(`${location.href}\u0000${xml}`)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, '0')).join('')
  }
  const app = async () => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const candidate = globalThis.APP
      if (candidate && candidate.openApi && candidate.openApi.editor && candidate.openApi.editor.canvas && typeof candidate.openApi.editor.canvas.getDocXml === 'function') return candidate
      await sleep(50)
    }
    return null
  }
  const documentResource = async (xml) => ({
    kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: document.title || null, fingerprint: await fingerprint(xml),
  })
  const blocks = (xml, offset, limit) => {
    const inner = /^<apcanvas>([\s\S]*)<\/apcanvas>$/i.exec(xml)?.[1]
    if (inner === undefined) return null
    const all = [...inner.matchAll(/<(p|h[1-6]|outlineTitle|li|blockquote|pre|codeBlock|table)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .filter((match) => match[1].toLowerCase() !== 'outlinetitle')
      .map((match, index) => ({ index, id: /\bid=["']([^"']*)/i.exec(match[2])?.[1] || null, type: match[1].toLowerCase(), text: decode(match[3]) }))
    const page = all.slice(offset, offset + limit)
    return { blockCount: all.length, offset, limit, hasMore: offset + page.length < all.length, blocks: page }
  }
  const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const editableBlocks = (xml) => {
    const inner = /^<apcanvas>([\s\S]*)<\/apcanvas>$/i.exec(xml)?.[1]
    if (inner === undefined) return null
    const all = [...inner.matchAll(/<(p|h[1-6]|outlineTitle|li|blockquote|pre|codeBlock|table)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .map((match) => ({ start: match.index, end: match.index + match[0].length, xml: match[0], tag: match[1], attrs: match[2], body: match[3], id: /\bid=["']([^"']*)/i.exec(match[2])?.[1] || null, text: decode(match[3]) }))
    // The public read index deliberately excludes the document title.  Keep
    // that invariant here so a model can never replace title by using index 0.
    return { inner, all, list: all.filter((block) => block.tag.toLowerCase() !== 'outlinetitle') }
  }
  const targetBlock = (xml, payload) => {
    const parsed = editableBlocks(xml)
    if (!parsed) return null
    const index = Number.isInteger(payload?.index) ? payload.index : undefined
    const target = index === undefined ? parsed.list.find((block) => block.id && block.id === payload?.id) : parsed.list[index]
    return target ? { ...parsed, target } : null
  }
  const patchXml = async (current, beforeXml, inner) => {
    if (typeof current?.openApi?.editor?.canvas?.patch !== 'function') return fail('unsupported', 'WebEdit does not expose canvas.patch for light-document edits')
    const result = await current.openApi.editor.canvas.patch({ xml: `<replace sel="//apcanvas">${inner}</replace>`, sessionId: `deepseek-harness-${Date.now()}` })
    if (result && result.success === false) return fail('runtime_error', 'WebEdit rejected the light-document patch')
    let afterXml = await current.openApi.editor.canvas.getDocXml()
    const deadline = Date.now() + 3_000
    while (afterXml === beforeXml && Date.now() < deadline) { await sleep(50); afterXml = await current.openApi.editor.canvas.getDocXml() }
    return typeof afterXml === 'string' && afterXml !== beforeXml ? { ok: true, xml: afterXml } : fail('readback_mismatch', 'WebEdit did not report the light-document patch')
  }
  const semanticFragments = (markdown) => String(markdown).replace(/<!--[^]*?-->/g, '').split(/\n+/)
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[`*_~]/g, '').trim()).filter(Boolean).slice(0, 100)
  const read = async (input) => {
    const current = await app()
    if (!current) return fail('unsupported', 'WebEdit light-document runtime is not ready')
    const xml = await current.openApi.editor.canvas.getDocXml()
    if (typeof xml !== 'string') return fail('unsupported', 'WebEdit did not expose light-document XML')
    const resource = await documentResource(xml)
    const offset = Number.isInteger(input.offset) ? input.offset : 0
    const limit = Number.isInteger(input.limit) ? input.limit : 100
    const documentResult = blocks(xml, offset, limit)
    if (!documentResult) return fail('unsupported', 'The current WebEdit frame is not a light document')
    if (input.action === 'search') {
      const query = String(input.query || '').trim().toLocaleLowerCase()
      const matches = documentResult.blocks.filter((block) => block.text.toLocaleLowerCase().includes(query))
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, blocks: matches, search: query } } }
    }
    if (input.action === 'selection') {
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, selection: { supported: false, reason: 'selection_read_not_exposed_by_current_WebEdit_runtime' } } } }
    }
    return { ok: true, result: { status: 'ok', resource, document: documentResult } }
  }
  const write = async (input) => {
    const before = await read({ action: 'read', offset: 0, limit: 1 })
    if (!before.ok) return before
    const expected = input.resource
    if (!expected || JSON.stringify(expected) !== JSON.stringify(before.result.resource)) return fail('fingerprint_mismatch', 'The light document changed since inspect_write')
    const current = await app()
    const beforeXml = await current.openApi.editor.canvas.getDocXml()
    const markdown = typeof input.payload?.markdown === 'string' ? input.payload.markdown : typeof input.payload?.text === 'string' ? input.payload.text : ''
    if (input.operation === 'insert') {
      const selection = current?.openApi?.editor?.document?.selection
      if (!markdown.trim() || markdown.length > 100000) return fail('invalid_range', 'insert requires bounded markdown or text')
      if (!selection || typeof selection.insertContent !== 'function') return fail('unsupported', 'WebEdit does not expose light-document insertContent')
      await selection.insertContent({ markdown, insertBlow: false })
      let afterXml = await current.openApi.editor.canvas.getDocXml(); const deadline = Date.now() + 3_000
      while (afterXml === beforeXml && Date.now() < deadline) { await sleep(50); afterXml = await current.openApi.editor.canvas.getDocXml() }
      const observedText = typeof afterXml === 'string' ? decode(afterXml) : ''
      const fragments = semanticFragments(markdown)
      if (typeof afterXml !== 'string' || afterXml === beforeXml || fragments.length === 0 || !fragments.every((fragment) => observedText.includes(fragment))) return fail('readback_mismatch', 'WebEdit light-document readback differs from the requested insert')
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(afterXml), requested: { operation: 'insert', markdown }, observed: { text: observedText.slice(0, 12000), verifiedFragments: fragments } } }
    }
    const located = input.operation === 'title' ? editableBlocks(beforeXml) : targetBlock(beforeXml, input.payload)
    if (!located) return fail('invalid_range', 'light-document target block was not found')
    // A delete must be independently verifiable after CanvasPatch. Without a
    // stable block id it could succeed in the document and still be reported
    // as a failed write, leaving the caller with a dangerous partial result.
    if (input.operation === 'delete' && !located.target.id) return fail('invalid_range', 'delete requires a stable light-document block id')
    let inner = located.inner
    let expectedText = markdown
    if (input.operation === 'replace') {
      if (!markdown.trim()) return fail('invalid_range', 'replace requires bounded markdown or text')
      const replacement = `<p id="${escapeXml(located.target.id || '')}">${escapeXml(markdown)}</p>`
      inner = `${inner.slice(0, located.target.start)}${replacement}${inner.slice(located.target.end)}`
    } else if (input.operation === 'delete') {
      inner = `${inner.slice(0, located.target.start)}${inner.slice(located.target.end)}`; expectedText = located.target.text
    } else if (input.operation === 'format') {
      const style = input.payload?.style || {}; const body = escapeXml(located.target.text)
      const formatted = `${style.bold ? '<strong>' : ''}${style.italic ? '<em>' : ''}${body}${style.italic ? '</em>' : ''}${style.bold ? '</strong>' : ''}`
      const tag = /^h[1-6]$/i.test(style.blockType) ? style.blockType : located.target.tag
      const replacement = `<${tag}${located.target.attrs}>${formatted}</${tag}>`
      inner = `${inner.slice(0, located.target.start)}${replacement}${inner.slice(located.target.end)}`; expectedText = located.target.text
    } else if (input.operation === 'title') {
      if (!markdown.trim()) return fail('invalid_range', 'title requires bounded markdown or text')
      const title = located.all.find((block) => block.tag.toLowerCase() === 'outlinetitle')
      const replacement = `<outlineTitle id="${escapeXml(title?.id || '')}">${escapeXml(markdown)}</outlineTitle>`
      inner = title ? `${inner.slice(0, title.start)}${replacement}${inner.slice(title.end)}` : `${replacement}${inner}`
    } else return fail('unsupported', `Light-document ${String(input.operation)} is unsupported`)
    const patched = await patchXml(current, beforeXml, inner)
    if (!patched.ok) return patched
    const observedText = decode(patched.xml)
    const afterBlocks = editableBlocks(patched.xml)
    if (!afterBlocks) return fail('readback_mismatch', 'WebEdit did not return readable light-document XML')
    if (input.operation === 'delete') {
      if (!located.target.id || afterBlocks.all.some((block) => block.id === located.target.id)) return fail('readback_mismatch', 'WebEdit did not remove the exact target block')
    } else if (!observedText.includes(expectedText)) return fail('readback_mismatch', 'WebEdit light-document readback differs from the requested edit')
    if (input.operation === 'format') {
      const style = input.payload?.style || {}; const actual = afterBlocks.list.find((block) => block.id === located.target.id)
      if (!actual || (style.blockType && actual.tag.toLowerCase() !== String(style.blockType).toLowerCase())
        || (style.bold === true && !/<strong\b/i.test(actual.xml)) || (style.italic === true && !/<em\b/i.test(actual.xml))) return fail('readback_mismatch', 'WebEdit did not apply the requested light-document format')
    }
    return { ok: true, result: {
      status: 'verified_write', resource: await documentResource(patched.xml),
      requested: { operation: input.operation, payload: input.payload }, observed: { text: observedText.slice(0, 12000) },
    } }
  }
  window.addEventListener(REQUEST, (event) => {
    const input = event.detail
    if (!input || typeof input.id !== 'string') return
    const action = input.action
    const task = action === 'write' ? write(input) : read(input)
    void task.then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: input.id, ...payload } })))
      .catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: input.id, ...fail('runtime_error', 'WebEdit light-document operation failed') } })))
  })
})()
