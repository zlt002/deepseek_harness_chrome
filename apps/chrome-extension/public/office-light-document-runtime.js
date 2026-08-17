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
  // Instant readiness check for the background frame probe: no polling, no waiting.
  const readyNow = () => {
    const candidate = globalThis.APP
    return !!(candidate && candidate.openApi && candidate.openApi.editor && candidate.openApi.editor.canvas && typeof candidate.openApi.editor.canvas.getDocXml === 'function')
  }
  const documentResource = async (xml, current) => {
    let title = document.title || ''
    try { const value = await documentApi(current)?.getTitleContent?.(); title = String(value?.text ?? value ?? title) } catch {}
    return { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: document.title || null, fingerprint: await fingerprint(xml, title) }
  }
  const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const escapeCdata = (value) => String(value || '').replace(/]]>/g, ']]]]><![CDATA[>')
  const topLevelNodes = (inner) => {
    const scan = String(inner || '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (match) => ' '.repeat(match.length))
    const nodes = []; const stack = []; const tagPattern = /<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*)?\/?>/g
    let startIndex = null; let startTag = null; let match
    while ((match = tagPattern.exec(scan))) {
      const fullTag = match[0]; const tagName = match[1].toLowerCase(); const isClosing = fullTag.startsWith('</'); const isSelfClosing = /\/>$/.test(fullTag)
      if (isClosing) {
        if (stack.length) stack.pop()
        if (stack.length === 0 && startIndex !== null) {
          nodes.push({ type: startTag, start: startIndex, end: tagPattern.lastIndex, xml: inner.slice(startIndex, tagPattern.lastIndex) })
          startIndex = null; startTag = null
        }
        continue
      }
      if (stack.length === 0) {
        startIndex = match.index; startTag = tagName
        if (isSelfClosing) { nodes.push({ type: tagName, start: match.index, end: tagPattern.lastIndex, xml: fullTag }); startIndex = null; startTag = null }
        else stack.push(tagName)
      } else if (!isSelfClosing) stack.push(tagName)
    }
    return nodes
  }
  const nodeRecord = (node) => {
    const opening = /^<([A-Za-z][\w:-]*)\b([^>]*)>([\s\S]*)<\/\1>$/i.exec(node.xml) || /^<([A-Za-z][\w:-]*)\b([^>]*)\/>$/i.exec(node.xml)
    const tag = opening?.[1] || node.type
    const attrs = opening?.[2] || ''
    const body = opening?.[3] ?? ''
    return { start: node.start, end: node.end, xml: node.xml, tag, attrs, body, id: /\bid=["']([^"']*)/i.exec(attrs)?.[1] || null, language: /\blang=["']([^"']*)/i.exec(attrs)?.[1] || null, text: decode(tag.toLowerCase() === 'codeblock' ? body.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1') : body) }
  }
  const blocks = (xml, offset, limit) => {
    const inner = /^<apcanvas>([\s\S]*)<\/apcanvas>$/i.exec(xml)?.[1]
    if (inner === undefined) return null
    const all = topLevelNodes(inner).map(nodeRecord).filter((block) => block.tag.toLowerCase() !== 'outlinetitle')
      .map((block, index) => ({ index, id: block.id, type: block.tag.toLowerCase(), language: block.language, text: block.text.slice(0, 120), textLength: block.text.length, truncated: block.text.length > 120 }))
    const page = all.slice(offset, offset + limit)
    return { blockCount: all.length, offset, limit, hasMore: offset + page.length < all.length, blocks: page }
  }
  const editableBlocks = (xml) => {
    const inner = /^<apcanvas>([\s\S]*)<\/apcanvas>$/i.exec(xml)?.[1]
    if (inner === undefined) return null
    const all = topLevelNodes(inner).map(nodeRecord)
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
  const normalizedSelectionText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  const selectionHash = (value) => {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) }
    return `selection-v3-${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const runtimeSelection = (current) => {
    const raw = current?.OTL?.state?.selection
    const canvas = current?.openApi?.editor?.canvas?.canvas
    let info
    try { info = canvas?.getSelectionInfo?.() } catch {}
    const range = raw && Number.isFinite(raw.from) && Number.isFinite(raw.to) && Number.isFinite(raw.anchor) && Number.isFinite(raw.head)
      ? { from: Number(raw.from), to: Number(raw.to), anchor: Number(raw.anchor), head: Number(raw.head) }
      : null
    const ids = Array.isArray(info?.selected_tag_ids) ? info.selected_tag_ids.filter((id) => typeof id === 'string' && id.length > 0).slice(0, 50) : []
    return { range, selectedTagIds: ids, isCollapsed: raw?.empty === true || (range !== null && range.from === range.to) }
  }
  const stableSelectionAnchor = (value) => {
    if (!value || typeof value !== 'object') return null
    const blockId = typeof value.blockId === 'string' && value.blockId ? value.blockId : null
    const anchorId = typeof value.anchorId === 'string' && value.anchorId ? value.anchorId : null
    const start = Number.isInteger(value.start) ? value.start : null
    const end = Number.isInteger(value.end) ? value.end : null
    if ((!blockId && !anchorId) || start === null || end === null) return null
    return { blockId, anchorId, start, end }
  }
  const readSelection = async (current, maxChars = 20_000) => {
    const selection = selectionApi(current)
    if (!selection || typeof selection.getSelectionContent !== 'function') return { supported: false, reason: 'selection_content_api_not_detected' }
    const value = await selection.getSelectionContent()
    const source = value && typeof value === 'object' ? value : { text: value }
    const limit = Math.min(Math.max(1, maxChars), 20_000); const content = {}; const truncated = {}
    for (const key of ['html', 'text', 'markdown']) if (typeof source[key] === 'string') { content[key] = source[key].slice(0, limit); truncated[key] = source[key].length > limit }
    const runtime = runtimeSelection(current)
    let publicAnchor = null
    try { if (typeof selection.getSelectionAnchor === 'function') publicAnchor = stableSelectionAnchor(await selection.getSelectionAnchor()) } catch {}
    const range = runtime.range
    const stableRange = range ?? null
    const anchor = publicAnchor ?? (stableRange ? { blockId: runtime.selectedTagIds[0] ?? 'runtime_selection', anchorId: null, start: stableRange.from, end: stableRange.to } : null)
    const hasContent = Object.values(content).some((item) => String(item).length > 0)
    const isCollapsed = runtime.isCollapsed === true || (anchor !== null && anchor.start !== null && anchor.end !== null && anchor.start === anchor.end)
    const stable = !!anchor
    const serialized = JSON.stringify({ anchor, range: stableRange, selectedTagIds: runtime.selectedTagIds, isCollapsed, content })
    return { supported: true, content, anchor, range: stableRange, selectedTagIds: runtime.selectedTagIds, hasSelection: hasContent || stableRange !== null, isCollapsed, stable, selectionFingerprint: selectionHash(serialized), truncated: Object.values(truncated).some(Boolean), truncatedFields: Object.keys(truncated).filter((key) => truncated[key]) }
  }
  const selectionPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const kinds = ['markdown', 'html', 'text'].filter((key) => typeof payload[key] === 'string')
    if (kinds.length !== 1) return null
    const kind = kinds[0]; const value = payload[kind]
    if (!value.trim() || value.length > 20_000 || typeof payload.expectedSelectionFingerprint !== 'string' || !/^selection-v3-[0-9a-f]{8}$/.test(payload.expectedSelectionFingerprint)) return null
    if (!Object.keys(payload).every((key) => ['markdown', 'html', 'text', 'insertBelow', 'expectedSelectionFingerprint'].includes(key)) || (payload.insertBelow !== undefined && typeof payload.insertBelow !== 'boolean')) return null
    return { kind, value, expectedSelectionFingerprint: payload.expectedSelectionFingerprint, insertBelow: payload.insertBelow === true }
  }
  const distinctiveFragments = (value) => {
    const plain = String(value ?? '').replace(/```[\w-]*\n?/g, ' ').replace(/\[[ xX]\]/g, ' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, ' ').replace(/[`*_#>~\-|:]/g, ' ')
    return [...new Set(normalizedSelectionText(plain).split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 2))].slice(0, 100)
  }
  const verificationFragments = (kind, value) => distinctiveFragments(kind === 'html' ? decode(value) : value)
  const verifyInsertedFragments = (beforeXml, afterXml, fragments) => {
    if (typeof afterXml !== 'string' || afterXml === beforeXml || !fragments.length) return null
    const parsed = editableBlocks(afterXml)
    if (!parsed) return null
    const matchesFor = (fragment) => parsed.list.map((block, index) => ({ block, index })).filter(({ block }) => normalizedSelectionText(block.text).includes(fragment))
    const evidence = fragments.map((fragment) => ({ fragment, blockIds: matchesFor(fragment).map(({ block, index }) => block.id || `index:${index}`) }))
    if (evidence.some((item) => item.blockIds.length === 0)) return null
    const observedIndexes = new Set(evidence.flatMap((item) => item.blockIds.map((id) => (id.startsWith('index:') ? Number(id.slice(6)) : parsed.list.findIndex((block) => block.id === id)))))
    return { verifiedFragments: fragments, fragmentEvidence: evidence, observedBlocks: parsed.list.map((block, index) => ({ block, index })).filter(({ index }) => observedIndexes.has(index)).map(({ block, index }) => ({ id: block.id || `index:${index}`, type: block.tag.toLowerCase(), language: block.language, text: block.text.slice(0, 500) })) }
  }
  const verifySelectionInsert = (beforeXml, afterXml, requested) => verifyInsertedFragments(beforeXml, afterXml, verificationFragments(requested.kind, requested.value))
  const structuredBlockXml = (item, preserveId = null) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const type = String(item.type ?? item.blockType ?? 'p').toLowerCase()
    const text = typeof item.text === 'string' ? item.text : typeof item.markdown === 'string' ? item.markdown : ''
    const html = typeof item.html === 'string' ? item.html : ''
    const id = preserveId ? ` id="${escapeXml(preserveId)}"` : ' id=""'
    if (/^(h[1-6]|p|blockquote)$/.test(type)) {
      const content = html.trim() ? html.replace(/<\/?(script|iframe|object|embed)\b[^>]*>/gi, '') : escapeXml(text)
      if (!decode(content).trim() || content.length > 20_000) return null
      return `<${type}${id}><span>${content}</span></${type}>`
    }
    if (type === 'ul' || type === 'ol') {
      const items = Array.isArray(item.items) ? item.items : text ? text.split('\n') : []
      if (items.length < 1 || items.length > 50 || !items.every((line) => typeof line === 'string' && line.trim() && line.length <= 20_000)) return null
      return items.map((line, index) => `<p id="" paddingLeft="2"><span>${escapeXml(type === 'ol' ? `${index + 1}. ` : '- ')}</span><span>${escapeXml(line.trim())}</span></p>`).join('')
    }
    if (type === 'table') {
      const rows = Array.isArray(item.rows) ? item.rows : text ? text.split('\n').map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean)) : []
      if (rows.length < 1 || rows.length > 30 || !rows.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 12 && row.every((cell) => typeof cell === 'string' && cell.length <= 2_000))) return null
      return `<table${id} borderStyle="solid">${rows.map((row, rowIndex) => `<tr>${row.map((cell) => `<td><p id="">${rowIndex === 0 ? `<strong>${escapeXml(cell)}</strong>` : escapeXml(cell)}</p></td>`).join('')}</tr>`).join('')}</table>`
    }
    if (type === 'codeblock' || type === 'codeBlock' || type === 'pre') {
      const language = String(item.language || (/\b(flowchart|sequenceDiagram|pie|graph|mindmap|gantt|classDiagram|erDiagram)\b/.test(text) ? 'mermaid' : 'plaintext')).toLowerCase()
      if (!text.trim() || text.length > 20_000 || !/^[a-z0-9_+#.-]+$/.test(language)) return null
      return `<codeBlock${id} lang="${escapeXml(language)}"><![CDATA[${escapeCdata(text.replace(/^\n+|\n+$/g, ''))}]]></codeBlock>`
    }
    return null
  }
  const blockXml = (payload, preserveId = null) => {
    if (typeof payload?.mermaid === 'string' && payload.mermaid.trim()) return structuredBlockXml({ type: 'codeblock', language: 'mermaid', text: payload.mermaid }, preserveId)
    const items = Array.isArray(payload?.blocks) ? payload.blocks : [payload]
    if (items.length < 1 || items.length > 50) return null
    const source = items.map((item, index) => structuredBlockXml(item, index === 0 ? preserveId : null))
    return source.every(Boolean) ? source.join('') : null
  }
  const insertPosition = (parsed, payload) => {
    const position = payload?.position ?? 'end'
    if (!['start', 'end', 'before', 'after'].includes(position)) return null
    if (position === 'end') return parsed.inner.length
    if (position === 'start') {
      const title = parsed.all.find((block) => block.tag.toLowerCase() === 'outlinetitle')
      return title ? title.end : 0
    }
    const target = Number.isInteger(payload?.index) ? parsed.list[payload.index] : parsed.list.find((block) => block.id && block.id === payload?.id)
    if (!target) return null
    return position === 'before' ? target.start : target.end
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
    if (input.action === 'probe') return { ok: true, result: { status: 'probe', ready: readyNow(), identity: { path: location.pathname } } }
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
        wordCount: !!(document && typeof document.getWordCount === 'function'), exactBlockRead: true, blockEdits: typeof current?.openApi?.editor?.canvas?.patch === 'function', blockRichHtml: true,
        selectionRichInsert: !!(selection && typeof selection.getSelectionContent === 'function' && typeof selection.getSelectionAnchor === 'function' && typeof selection.insertContent === 'function'),
        selectionRichReplace: !!(selection && typeof selection.getSelectionContent === 'function' && typeof selection.getSelectionAnchor === 'function' && typeof selection.replaceContent === 'function'),
        // Export URLs are signed, browser-session-only values. No safe artifact
        // delivery handle exists in this MCP surface, so keep exports unavailable.
        exportPdf: false, exportDocx: false, images: false, pasteImage: false, drawings: typeof current?.openApi?.editor?.canvas?.patch === 'function', selectionHighlight: false,
      }
      const detectedButUnsupported = [
        ...['images', 'exportPdf', 'exportDocx'].filter((name) => (name === 'images' && typeof selection?.insertImage === 'function') || (name === 'exportPdf' && typeof editor?.exportAsPdf === 'function') || (name === 'exportDocx' && typeof editor?.exportAsDocx === 'function')),
      ]
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, capabilities: { ...detected, detectedButUnsupported } } } }
    }
    if (readKind === 'title') {
      const document = documentApi(current)
      if (!document || typeof document.getTitleContent !== 'function') return { ok: true, result: { status: 'ok', resource, document: { title: { supported: false, reason: 'title_api_not_detected' } } } }
      try {
        const value = await document.getTitleContent()
        const title = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : null
        if (title === null) return { ok: true, result: { status: 'ok', resource, document: { title: { supported: false, reason: 'title_api_unreadable' } } } }
        return { ok: true, result: { status: 'ok', resource, document: { title: { supported: true, text: title.slice(0, 500), textLength: title.length, truncated: title.length > 500 } } } }
      } catch { return { ok: true, result: { status: 'ok', resource, document: { title: { supported: false, reason: 'title_api_unreadable' } } } } }
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
      const indexed = editableBlocks(xml); const all = blocks(xml, 0, 100_000)
      const matches = (indexed?.list ?? []).filter((block) => block.text.toLocaleLowerCase().includes(query)).map((block) => ({ index: indexed.list.indexOf(block), id: block.id, type: block.tag.toLowerCase(), text: block.text.slice(0, 120), textLength: block.text.length, truncated: block.text.length > 120 }))
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
    if (typeof beforeXml !== 'string' || JSON.stringify(expected) !== JSON.stringify(await documentResource(beforeXml, current))) return fail('fingerprint_mismatch', 'The light document changed before mutation')
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
    if (input.operation === 'selection_insert' || input.operation === 'selection_replace') {
      const requested = selectionPayload(input.payload)
      const selection = selectionApi(current)
      const mutate = input.operation === 'selection_replace' ? 'replaceContent' : 'insertContent'
      if (!requested || !selection || typeof selection[mutate] !== 'function') return fail('unsupported', `Light-document ${input.operation} requires one bounded content format, a stable selection fingerprint, and the public ${mutate} API`)
      const snapshot = await readSelection(current, 20_000)
      if (!snapshot.supported || snapshot.truncated || !snapshot.stable || !snapshot.anchor) return fail('invalid_range', `Light-document ${input.operation} requires a complete, stable selection or cursor snapshot`)
      if (input.operation === 'selection_replace' && snapshot.isCollapsed) return fail('invalid_range', 'selection_replace requires a non-collapsed selection; use selection_insert at a caret')
      if (snapshot.selectionFingerprint !== requested.expectedSelectionFingerprint) return fail('fingerprint_mismatch', 'The light-document selection changed since inspect_write')
      const content = { [requested.kind]: requested.value, ...(requested.insertBelow ? { insertBlow: true } : {}) }
      try { await selection[mutate](content) } catch { return fail('runtime_error', `WebEdit rejected the light-document ${input.operation}`) }
      let afterXml = await current.openApi.editor.canvas.getDocXml(); const deadline = Date.now() + 3_000
      while (afterXml === beforeXml && Date.now() < deadline) { await sleep(50); afterXml = await current.openApi.editor.canvas.getDocXml() }
      const observed = verifySelectionInsert(beforeXml, afterXml, requested)
      if (!observed) return fail('readback_mismatch', `WebEdit ${input.operation} did not produce matching XML content and structural evidence`)
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(afterXml, current), requested: { operation: input.operation, payload: input.payload }, observed: { ...observed, verified: true } } }
    }
    if (input.operation === 'blocks_insert' || input.operation === 'insert_drawing') {
      const parsed = editableBlocks(beforeXml)
      if (!parsed) return fail('unsupported', 'WebEdit did not expose editable light-document blocks')
      const xml = input.operation === 'insert_drawing' ? structuredBlockXml({ type: 'codeblock', language: 'mermaid', text: input.payload?.mermaid }, null) : blockXml(input.payload)
      const offset = insertPosition(parsed, input.payload)
      if (!xml || offset === null) return fail('invalid_range', input.operation === 'insert_drawing'
        ? 'insert_drawing requires mermaid source and a start/end/before/after position'
        : 'blocks_insert requires bounded h1-h6/p/blockquote/ul/ol/table/codeblock items and a start/end/before/after position')
      const fragments = distinctiveFragments(input.operation === 'insert_drawing' ? input.payload?.mermaid : (input.payload?.blocks ?? []).map((item) => Array.isArray(item?.items) ? item.items.join('\n') : Array.isArray(item?.rows) ? item.rows.flat().join('\n') : item?.text ?? item?.markdown ?? item?.html ?? '').join('\n'))
      if (!fragments.length) return fail('invalid_range', `${input.operation} requires distinctive readable content for XML readback`)
      const patched = await patchXml(current, beforeXml, `${parsed.inner.slice(0, offset)}${xml}${parsed.inner.slice(offset)}`)
      if (!patched.ok) return patched
      const observed = verifyInsertedFragments(beforeXml, patched.xml, fragments)
      if (!observed) return fail('readback_mismatch', `WebEdit ${input.operation} did not produce matching XML content and structural evidence`)
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload }, observed: { ...observed, verified: true } } }
    }
    if (input.operation === 'insert' || input.operation === 'selection_rich_replace' || input.operation === 'insert_image' || input.operation === 'paste_image' || input.operation === 'highlight_selection' || input.operation === 'export_pdf' || input.operation === 'export_docx') return fail('unsupported', `Light-document ${String(input.operation)} has no safe public readback and delivery contract`)
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
        if (mode !== 'insert' && !located) return fail('invalid_range', parsed.list.length === 0
          ? 'This light document has no public replaceable block. Use selection_insert with expectedSelectionFingerprint from a selection read.'
          : 'light-document block target was not found')
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
    if (input.operation === 'insert_image' || input.operation === 'highlight_selection') return fail('unsupported', `WebEdit ${input.operation} is detected only when its operation-specific public API and readback contract are available`)
    const located = input.operation === 'title' ? editableBlocks(beforeXml) : targetBlock(beforeXml, input.payload)
    if (!located) return fail('invalid_range', editableBlocks(beforeXml)?.list.length === 0 && input.operation !== 'title'
      ? 'This light document has no public replaceable block. Use selection_insert with expectedSelectionFingerprint from a selection read.'
      : 'light-document target block was not found')
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
