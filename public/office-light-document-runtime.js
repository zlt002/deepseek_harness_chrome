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
  const fingerprint = async (xml, title = '') => {
    const bytes = new TextEncoder().encode(`${location.href}\u0000${title}\u0000${xml}`)
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
  const documentResource = async (xml, current) => {
    let title = document.title || ''
    try { const value = await documentApi(current)?.getTitleContent?.(); title = String(value?.text ?? value ?? title) } catch {}
    return { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: document.title || null, fingerprint: await fingerprint(xml, title) }
  }
  const blocks = (xml, offset, limit) => {
    const inner = /^<apcanvas>([\s\S]*)<\/apcanvas>$/i.exec(xml)?.[1]
    if (inner === undefined) return null
    const all = [...inner.matchAll(/<(p|h[1-6]|outlineTitle|li|blockquote|pre|codeBlock|table)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .filter((match) => match[1].toLowerCase() !== 'outlinetitle')
      .map((match, index) => { const text = decode(match[3]); return { index, id: /\bid=["']([^"']*)/i.exec(match[2])?.[1] || null, type: match[1].toLowerCase(), text: text.slice(0, 120), textLength: text.length, truncated: text.length > 120 } })
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
  const bounded = (value, fallback, maximum) => Number.isInteger(value) ? Math.min(Math.max(value, 0), maximum) : fallback
  const documentApi = (current) => current?.openApi?.editor?.document
  const selectionApi = (current) => documentApi(current)?.selection
  const editorApi = (current) => current?.openApi?.editor
  const readSelection = async (current, maxChars = 20_000) => {
    const selection = selectionApi(current)
    if (!selection || typeof selection.getSelectionContent !== 'function') return { supported: false, reason: 'selection_content_api_not_detected' }
    // The public API gives content but no stable range, anchor, or block id.
    // Do not issue a write from an ambiguous same-text selection.
    if (typeof selection.getSelectionAnchor !== 'function') return { supported: false, reason: 'selection_anchor_api_not_detected' }
    const value = await selection.getSelectionContent()
    const anchor = await selection.getSelectionAnchor()
    if (!anchor || typeof anchor !== 'object' || (!anchor.blockId && !anchor.anchorId && !Number.isInteger(anchor.start))) return { supported: false, reason: 'selection_anchor_unreadable' }
    const source = value && typeof value === 'object' ? value : { text: value }
    const content = {}; let remaining = Math.min(maxChars, 20_000)
    for (const key of ['html', 'text', 'markdown']) if (typeof source[key] === 'string' && remaining > 0) { content[key] = source[key].slice(0, remaining); remaining -= content[key].length }
    const serialized = JSON.stringify({ anchor, content })
    let hash = 2166136261
    for (let index = 0; index < serialized.length; index += 1) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 16777619) }
    return { supported: true, content, anchor: { blockId: anchor.blockId ?? null, anchorId: anchor.anchorId ?? null, start: Number.isInteger(anchor.start) ? anchor.start : null, end: Number.isInteger(anchor.end) ? anchor.end : null }, hasSelection: Object.values(content).some((item) => String(item).length > 0), selectionFingerprint: `selection-v2-${(hash >>> 0).toString(16).padStart(8, '0')}`, truncated: remaining === 0 }
  }
  const blockXml = (payload, preserveId = null) => {
    const items = Array.isArray(payload?.blocks) ? payload.blocks : [payload]
    if (items.length < 1 || items.length > 50) return null
    const source = items.map((item, index) => {
      const text = typeof item?.text === 'string' ? item.text : typeof item?.markdown === 'string' ? item.markdown : null
      const tag = /^(p|h[1-6]|li|blockquote|pre|codeBlock)$/i.test(String(item?.type ?? item?.blockType ?? 'p')) ? String(item.type ?? item.blockType ?? 'p') : null
      if (text === null || !text.trim() || text.length > 20_000 || !tag) return null
      const id = index === 0 && preserveId ? ` id="${escapeXml(preserveId)}"` : ''
      return `<${tag}${id}>${escapeXml(text)}</${tag}>`
    })
    return source.every(Boolean) ? source.join('') : null
  }
  const batchBlockItems = (operation, payload) => {
    const source = Array.isArray(payload?.blocks) ? payload.blocks
      : operation === 'blocks_delete' && Array.isArray(payload?.deletions) ? payload.deletions
        : operation === 'blocks_delete' && Array.isArray(payload?.ids) ? payload.ids.map((id) => ({ id }))
          : operation === 'blocks_format' && Array.isArray(payload?.formats) ? payload.formats
            : [payload]
    if (source.length < 1 || source.length > 50) return null
    const seen = new Set(); const items = []
    for (const item of source) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || item.id.length > 256 || seen.has(item.id)) return null
      seen.add(item.id)
      if (operation === 'blocks_delete') { items.push({ id: item.id }); continue }
      const style = item.style ?? payload?.style
      if (!style || typeof style !== 'object' || Array.isArray(style) || Object.keys(style).length < 1 || !Object.keys(style).every((key) => ['bold', 'italic', 'blockType'].includes(key))) return null
      if ((style.bold !== undefined && typeof style.bold !== 'boolean') || (style.italic !== undefined && typeof style.italic !== 'boolean') || (style.blockType !== undefined && !/^(p|h[1-6]|li|blockquote|pre|codeBlock)$/i.test(style.blockType))) return null
      items.push({ id: item.id, style: { ...(style.bold === undefined ? {} : { bold: style.bold }), ...(style.italic === undefined ? {} : { italic: style.italic }), ...(style.blockType === undefined ? {} : { blockType: style.blockType.toLowerCase() }) } })
    }
    return items
  }
  const formattedBlock = (target, style) => {
    if (!style || typeof style !== 'object' || Array.isArray(style) || Object.keys(style).length < 1 || !Object.keys(style).every((key) => ['bold', 'italic', 'blockType'].includes(key))) return null
    if ((style.bold !== undefined && typeof style.bold !== 'boolean') || (style.italic !== undefined && typeof style.italic !== 'boolean') || (style.blockType !== undefined && !/^(p|h[1-6]|li|blockquote|pre|codeBlock)$/i.test(style.blockType))) return null
    let body = target.body
    if (style.bold !== undefined) { body = body.replace(/<\/?strong\b[^>]*>/gi, ''); if (style.bold) body = `<strong>${body}</strong>` }
    if (style.italic !== undefined) { body = body.replace(/<\/?em\b[^>]*>/gi, ''); if (style.italic) body = `<em>${body}</em>` }
    const tag = style.blockType === undefined ? target.tag : style.blockType.toLowerCase()
    return { body, tag, xml: `<${tag}${target.attrs}>${body}</${tag}>` }
  }
  const patchAndVerify = async (current, beforeXml, inner, expected, operation, requested) => {
    const patched = await patchXml(current, beforeXml, inner)
    if (!patched.ok) return patched
    const after = editableBlocks(patched.xml)
    if (!after || !expected.length || !expected.every((item) => { const block = after.all.find((candidate) => candidate.id === item.id); return !!block && block.text === item.text && block.tag.toLowerCase() === item.type.toLowerCase() })) return fail('readback_mismatch', `WebEdit light-document ${operation} structural readback differs from the request`)
    return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested, observed: { verifiedBlocks: expected, verified: true } } }
  }
  const read = async (input) => {
    const current = await app()
    if (!current) return fail('unsupported', 'WebEdit light-document runtime is not ready')
    const xml = await current.openApi.editor.canvas.getDocXml()
    if (typeof xml !== 'string') return fail('unsupported', 'WebEdit did not expose light-document XML')
    const resource = await documentResource(xml, current)
    const offset = bounded(input.offset, 0, 100_000)
    const limit = Math.max(1, bounded(input.limit, 100, 200))
    const documentResult = blocks(xml, offset, limit)
    if (!documentResult) return fail('unsupported', 'The current WebEdit frame is not a light document')
    const readKind = input.payload?.kind
    if (readKind === 'capabilities') {
      const selection = selectionApi(current); const document = documentApi(current); const editor = editorApi(current)
      const comments = document?.comments ?? editor?.comments
      const detected = {
        selection: !!(selection && typeof selection.getSelectionContent === 'function' && typeof selection.getSelectionAnchor === 'function'), comments: !!(comments && (typeof comments.getComments === 'function' || typeof comments.getAllComments === 'function')),
        wordCount: !!(document && typeof document.getWordCount === 'function'), exactBlockRead: true, blockEdits: typeof current?.openApi?.editor?.canvas?.patch === 'function', blockRichHtml: false,
        selectionRichInsert: !!(selection && typeof selection.getSelectionContent === 'function' && typeof selection.getSelectionAnchor === 'function' && typeof selection.insertContent === 'function'), selectionRichReplace: false,
        // Export URLs are signed, browser-session-only values. No safe artifact
        // delivery handle exists in this MCP surface, so keep exports unavailable.
        exportPdf: false, exportDocx: false, images: false, pasteImage: false, drawings: false, selectionHighlight: false,
      }
      const detectedButUnsupported = [
        ...(selection && typeof selection.replaceContent === 'function' ? ['selectionRichReplace'] : []),
        ...['images', 'drawings', 'exportPdf', 'exportDocx'].filter((name) => (name === 'images' && typeof selection?.insertImage === 'function') || (name === 'drawings' && typeof selection?.insertTextDrawing === 'function') || (name === 'exportPdf' && typeof editor?.exportAsPdf === 'function') || (name === 'exportDocx' && typeof editor?.exportAsDocx === 'function')),
      ]
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, capabilities: { ...detected, detectedButUnsupported } } } }
    }
    if (readKind === 'word_count') {
      const document = documentApi(current)
      if (!document || typeof document.getWordCount !== 'function') return { ok: true, result: { status: 'ok', resource, document: { supported: false, reason: 'word_count_api_not_detected' } } }
      const wordCount = await document.getWordCount()
      return { ok: true, result: { status: 'ok', resource, document: { supported: true, wordCount: wordCount && typeof wordCount === 'object' ? wordCount : { words: wordCount } } } }
    }
    if (readKind === 'block') {
      const located = targetBlock(xml, input.payload)
      if (!located) return fail('invalid_range', 'light-document target block was not found')
      const maxChars = Math.max(1, bounded(input.payload?.maxChars, 12_000, 20_000))
      return { ok: true, result: { status: 'ok', resource, document: { block: { index: located.list.indexOf(located.target), id: located.target.id, type: located.target.tag.toLowerCase(), text: located.target.text.slice(0, maxChars), textLength: located.target.text.length, truncated: located.target.text.length > maxChars } } } }
    }
    if (readKind === 'comments') {
      const collection = documentApi(current)?.comments ?? editorApi(current)?.comments
      const get = collection && (collection.getComments ?? collection.getAllComments)
      if (typeof get !== 'function') return { ok: true, result: { status: 'ok', resource, document: { supported: false, reason: 'comments_api_not_detected' } } }
      const all = await get.call(collection)
      if (!Array.isArray(all)) return { ok: true, result: { status: 'ok', resource, document: { supported: false, reason: 'comments_api_not_readable' } } }
      const page = all.slice(offset, offset + limit).map((comment, index) => ({ index: offset + index, id: comment?.id ?? comment?.commentId ?? null, text: String(comment?.text ?? comment?.content ?? '').slice(0, 120), author: typeof comment?.author === 'string' ? comment.author.slice(0, 80) : null }))
      return { ok: true, result: { status: 'ok', resource, document: { supported: true, comments: page, offset, limit, total: all.length, hasMore: offset + page.length < all.length } } }
    }
    if (input.action === 'search') {
      const query = String(input.query || '').trim().toLocaleLowerCase()
      const all = blocks(xml, 0, 100_000)
      const matches = all.blocks.filter((block) => block.text.toLocaleLowerCase().includes(query))
      const page = matches.slice(offset, offset + limit)
      return { ok: true, result: { status: 'ok', resource, document: { blockCount: all.blockCount, offset, limit, hasMore: offset + page.length < matches.length, blocks: page, search: query, total: matches.length } } }
    }
    if (input.action === 'selection') {
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, selection: await readSelection(current, Math.max(1, bounded(input.payload?.maxChars, 20_000, 20_000))) } } }
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
    if (input.operation === 'blocks_delete' || input.operation === 'blocks_format') {
      const items = batchBlockItems(input.operation, input.payload)
      const parsed = editableBlocks(beforeXml)
      if (!items || !parsed) return fail('invalid_range', `${input.operation} requires one to fifty distinct stable block ids and bounded formatting`)
      const changes = []
      for (const item of items) {
        const target = parsed.list.find((block) => block.id === item.id)
        if (!target) return fail('invalid_range', `${input.operation} target block was not found by stable id`)
        if (input.operation === 'blocks_delete') { changes.push({ target, xml: '' }); continue }
        const formatted = formattedBlock(target, item.style)
        if (!formatted) return fail('invalid_range', 'blocks_format contains unsupported formatting')
        changes.push({ target, style: item.style, formatted, xml: formatted.xml })
      }
      let inner = parsed.inner
      for (const change of changes.slice().sort((left, right) => right.target.start - left.target.start)) inner = `${inner.slice(0, change.target.start)}${change.xml}${inner.slice(change.target.end)}`
      const patched = await patchXml(current, beforeXml, inner)
      if (!patched.ok) return patched
      const after = editableBlocks(patched.xml)
      if (!after) return fail('readback_mismatch', `WebEdit did not return readable ${input.operation} XML`)
      const verifiedBlocks = []
      for (const change of changes) {
        const actual = after.list.find((block) => block.id === change.target.id)
        if (input.operation === 'blocks_delete') {
          if (actual) return fail('readback_mismatch', 'WebEdit did not remove every requested stable block id')
          verifiedBlocks.push({ id: change.target.id, deleted: true })
          continue
        }
        const style = change.style
        if (!actual || actual.text !== change.target.text || actual.tag.toLowerCase() !== change.formatted.tag.toLowerCase() || actual.body !== change.formatted.body) return fail('readback_mismatch', 'WebEdit did not apply every requested stable block format without changing inline content')
        verifiedBlocks.push({ id: change.target.id, text: actual.text, type: actual.tag.toLowerCase(), style })
      }
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload, count: items.length }, observed: { verifiedBlocks, verified: true } } }
    }
    if (input.operation === 'insert' || input.operation === 'selection_rich_replace' || input.operation === 'selection_insert' || input.operation === 'insert_image' || input.operation === 'paste_image' || input.operation === 'insert_drawing' || input.operation === 'highlight_selection' || input.operation === 'export_pdf' || input.operation === 'export_docx') return fail('unsupported', `Light-document ${String(input.operation)} has no safe public readback and delivery contract`)
    if (input.operation === 'set_title') {
      const document = documentApi(current); const title = typeof input.payload?.title === 'string' ? input.payload.title.trim() : ''
      if (!document || typeof document.getTitleContent !== 'function' || typeof document.setTitleContent !== 'function' || !title || title.length > 500) return fail('unsupported', 'WebEdit does not expose readable title APIs')
      await document.setTitleContent(title)
      let observed = await document.getTitleContent(); const deadline = Date.now() + 1_500
      while (String(observed?.text ?? observed) !== title && Date.now() < deadline) { await sleep(50); observed = await document.getTitleContent() }
      if (String(observed?.text ?? observed) !== title) return fail('readback_mismatch', 'WebEdit title readback differs from the request')
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(await current.openApi.editor.canvas.getDocXml(), current), requested: { operation: 'set_title', payload: input.payload }, observed: { title, verified: true } } }
    }
    if (['blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit'].includes(input.operation)) {
      const parsed = editableBlocks(beforeXml)
      if (!parsed) return fail('unsupported', 'WebEdit did not expose editable light-document blocks')
      const replacements = input.operation === 'blocks_batch_replace' ? input.payload?.replacements : input.operation === 'blocks_batch_edit' ? input.payload?.edits ?? input.payload?.replacements : null
      const requested = input.operation === 'blocks_batch_edit' && Array.isArray(input.payload?.deletions)
        ? [...(Array.isArray(replacements) ? replacements.map((item) => ({ ...item, mode: item?.mode ?? 'replace' })) : []), ...input.payload.deletions.map((item) => ({ ...item, mode: 'delete' }))]
        : replacements ?? [input.payload]
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > 50) return fail('invalid_range', 'block edit requires one to fifty bounded edits')
      const changes = []
      for (const item of requested) {
        const mode = item?.mode ?? 'replace'
        const located = mode === 'insert' ? null : targetBlock(beforeXml, item)
        if (mode !== 'insert' && !located) return fail('invalid_range', 'light-document block target was not found')
        if (mode === 'insert') return fail('unsupported', 'block insert requires a stable public inserted-block identity')
        if (mode !== 'delete' && !located?.target?.id) return fail('invalid_range', 'block replacement requires a stable id for readback')
        if (mode === 'delete' && !located?.target?.id) return fail('invalid_range', 'block deletion requires a stable id for readback')
        const replacement = mode === 'delete' ? '' : blockXml(item, located?.target?.id ?? null)
        if (mode !== 'delete' && !replacement) return fail('invalid_range', 'block content must be bounded text/markdown blocks')
        changes.push({ start: located.target.start, end: located.target.end, xml: replacement, expected: mode === 'delete' ? null : { id: located.target.id, text: decode(replacement), type: String(item?.type ?? item?.blockType ?? 'p') } })
      }
      const duplicate = new Set(); if (changes.some((change) => { const key = `${change.start}:${change.end}`; if (duplicate.has(key)) return true; duplicate.add(key); return false })) return fail('invalid_range', 'block edit targets must be distinct')
      let inner = parsed.inner; for (const change of changes.slice().sort((left, right) => right.start - left.start)) inner = `${inner.slice(0, change.start)}${change.xml}${inner.slice(change.end)}`
      const expected = changes.map((change) => change.expected).filter(Boolean)
      const deletedIds = requested.filter((item) => item?.mode === 'delete').map((item) => targetBlock(beforeXml, item)?.target?.id).filter(Boolean)
      let result
      if (expected.length) result = await patchAndVerify(current, beforeXml, inner, expected, input.operation, { operation: input.operation, payload: input.payload, count: changes.length })
      else {
        const patched = await patchXml(current, beforeXml, inner)
        if (!patched.ok) return patched
        result = { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload, count: changes.length }, observed: { verified: true } } }
      }
      if (!result.ok) return result
      const afterBlocks = editableBlocks(await current.openApi.editor.canvas.getDocXml())
      if (!afterBlocks || deletedIds.some((id) => afterBlocks.all.some((block) => block.id === id))) return fail('readback_mismatch', 'WebEdit did not remove every requested light-document block')
      return result
    }
    if (input.operation === 'insert_image' || input.operation === 'insert_drawing' || input.operation === 'highlight_selection') return fail('unsupported', `WebEdit ${input.operation} is detected only when its operation-specific public API and readback contract are available`)
    const located = input.operation === 'title' ? editableBlocks(beforeXml) : targetBlock(beforeXml, input.payload)
    if (!located) return fail('invalid_range', 'light-document target block was not found')
    // A delete must be independently verifiable after CanvasPatch. Without a
    // stable block id it could succeed in the document and still be reported
    // as a failed write, leaving the caller with a dangerous partial result.
    if (['replace', 'delete', 'format'].includes(input.operation) && !located.target.id) return fail('invalid_range', `${input.operation} requires a stable light-document block id`)
    let inner = located.inner
    let expectedText = markdown
    if (input.operation === 'replace') {
      if (!markdown.trim()) return fail('invalid_range', 'replace requires bounded markdown or text')
      const replacement = `<p id="${escapeXml(located.target.id || '')}">${escapeXml(markdown)}</p>`
      inner = `${inner.slice(0, located.target.start)}${replacement}${inner.slice(located.target.end)}`
    } else if (input.operation === 'delete') {
      inner = `${inner.slice(0, located.target.start)}${inner.slice(located.target.end)}`; expectedText = located.target.text
    } else if (input.operation === 'format') {
      const formatted = formattedBlock(located.target, input.payload?.style)
      if (!formatted) return fail('invalid_range', 'format requires supported bold, italic, or blockType fields')
      inner = `${inner.slice(0, located.target.start)}${formatted.xml}${inner.slice(located.target.end)}`; expectedText = located.target.text
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
    } else if (input.operation === 'title') {
      const actualTitle = afterBlocks.all.find((block) => block.tag.toLowerCase() === 'outlinetitle')
      if (!actualTitle || actualTitle.text !== expectedText) return fail('readback_mismatch', 'WebEdit title readback differs from the requested edit')
    } else {
      const actual = afterBlocks.list.find((block) => block.id === located.target.id)
      if (!actual || actual.text !== expectedText) return fail('readback_mismatch', 'WebEdit light-document structural readback differs from the requested edit')
    }
    if (input.operation === 'format') {
      const formatted = formattedBlock(located.target, input.payload?.style); const actual = afterBlocks.list.find((block) => block.id === located.target.id)
      if (!formatted || !actual || actual.tag.toLowerCase() !== formatted.tag.toLowerCase() || actual.body !== formatted.body) return fail('readback_mismatch', 'WebEdit did not apply the requested light-document format without changing inline content')
    }
    return { ok: true, result: {
      status: 'verified_write', resource: await documentResource(patched.xml, current),
      requested: { operation: input.operation, payload: input.payload }, observed: { verified: true },
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
