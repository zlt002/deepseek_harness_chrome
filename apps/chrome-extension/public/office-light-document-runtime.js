(() => {
  'use strict'
  const REQUEST = 'deepseek-harness-office-document-request/v1'
  const RESPONSE = 'deepseek-harness-office-document-response/v1'
  // This is a correlation guard between the isolated-world content script and
  // this main-world adapter. It rejects stale/crossed CustomEvent replies; it
  // is not a security boundary against a script that controls the page world.
  const bridgeChannel = document.currentScript?.dataset?.deepseekHarnessChannel
  const runtimeKey = '__deepseekHarnessLightDocumentRuntime'
  const existingRuntime = globalThis[runtimeKey]
  // Content-script healing may inject again while the main-world runtime is
  // still alive. Rebind the new isolated-world channel to that same adapter
  // instead of leaving every healed request waiting on the old channel.
  if (existingRuntime && typeof existingRuntime.registerChannel === 'function') {
    existingRuntime.registerChannel(bridgeChannel)
    return
  }

  const fail = (code, message) => ({ ok: false, error: { code, message } })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const decode = (value) => {
    // Block-level closing tags separate lines; inline closing tags must not,
    // or `<strong>多级标题</strong>：…` reads back with a fake newline inside
    // one paragraph and poisons every text comparison built on decode().
    const box = document.createElement('textarea')
    box.innerHTML = String(value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|h[1-6]|li|ul|ol|tr|table|blockquote|pre|codeblock|outlinetitle|td|th|div)\s*>/gi, '\n')
      .replace(/<\/[^>]+>/g, '')
      .replace(/<[^>]+>/g, '')
    return box.value.replace(/[ \t]*\n+[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim()
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
  const documentTitle = async (current) => {
    let title = document.title || ''
    try {
      const value = await documentApi(current)?.getTitleContent?.()
      const readable = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : null
      if (readable !== null) title = readable
    } catch {}
    return title
  }
  const documentResource = async (xml, current) => {
    const title = await documentTitle(current)
    return { kind: 'webedit_light_document', origin: 'https://webedit.midea.com', documentName: title || null, fingerprint: await fingerprint(xml, title) }
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
  const singleTableMatrix = (value) => {
    const source = String(value ?? '')
    if ((source.match(/<table\b/gi) ?? []).length !== 1) return null
    const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(source)
    if (!table) return null
    const rows = []; const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let row
    while ((row = rowPattern.exec(table[1]))) {
      const cells = []; const cellPattern = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi; let cell
      while ((cell = cellPattern.exec(row[1]))) {
        const colspan = Number(/\bcolspan=["']?(\d+)/i.exec(cell[2])?.[1] ?? 1)
        const rowspan = Number(/\browspan=["']?(\d+)/i.exec(cell[2])?.[1] ?? 1)
        if (colspan !== 1 || rowspan !== 1) return null
        cells.push(normalizedSelectionText(decode(cell[3])))
      }
      if (!cells.length) return null
      rows.push(cells)
    }
    if (!rows.length || rows.some((cells) => cells.length !== rows[0].length)) return null
    return rows
  }
  const selectedContainingTable = (xml, snapshot) => {
    const selected = singleTableMatrix(snapshot?.content?.html)
    const parsed = editableBlocks(xml)
    if (!selected || !parsed) return null
    const selectedColumns = selected[0].length
    const nonEmptyCells = selected.flat().filter(Boolean).length
    if (selected.length * selectedColumns < 4 || nonEmptyCells < 3) return null
    const matches = []
    for (let blockIndex = 0; blockIndex < parsed.list.length; blockIndex += 1) {
      const target = parsed.list[blockIndex]
      if (target.tag.toLowerCase() !== 'table' || !target.id) continue
      const matrix = singleTableMatrix(target.xml)
      if (!matrix || matrix.length < selected.length || matrix[0].length < selectedColumns) continue
      for (let rowOffset = 0; rowOffset <= matrix.length - selected.length; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset <= matrix[0].length - selectedColumns; columnOffset += 1) {
          const exact = selected.every((rowCells, rowIndex) => rowCells.every((text, columnIndex) => matrix[rowOffset + rowIndex][columnOffset + columnIndex] === text))
          if (exact) matches.push({ parsed, target, blockIndex, matrix, selected, rowOffset, columnOffset })
        }
      }
    }
    return matches.length === 1 ? matches[0] : null
  }
  const selectionFingerprint = async (value) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    // v4 retains 128 bits of SHA-256. The version prefix makes old short FNV
    // values fail closed rather than silently weakening a write precondition.
    return `selection-v4-${[...new Uint8Array(hash)].slice(0, 16).map((item) => item.toString(16).padStart(2, '0')).join('')}`
  }
  const validSelectionFingerprint = (value) => typeof value === 'string' && /^selection-v4-[0-9a-f]{32}$/.test(value)
  const normalizeSelectionBlockId = (value) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) return null
    // WebEdit currently returns either the public ID itself or the narrow
    // XPath-shaped selector p[@id='ID']. Treat neither form as executable
    // XPath: parse only this exact grammar and return the literal safe ID.
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) return value
    const xpath = /^(?:p|h[1-6]|blockquote|table|codeBlock)\[@id=(?:'([^']+)'|"([^"]+)")\]$/.exec(value)
    const id = xpath?.[1] ?? xpath?.[2]
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id) ? id : null
  }
  const runtimeSelection = (current) => {
    const raw = current?.OTL?.state?.selection
    const canvas = current?.openApi?.editor?.canvas?.canvas
    let info
    try { info = canvas?.getSelectionInfo?.() } catch {}
    const range = raw && Number.isFinite(raw.from) && Number.isFinite(raw.to) && Number.isFinite(raw.anchor) && Number.isFinite(raw.head)
      ? { from: Number(raw.from), to: Number(raw.to), anchor: Number(raw.anchor), head: Number(raw.head) }
      : null
    const rawIds = info?.selected_tag_ids
    const normalizedIds = Array.isArray(rawIds) && rawIds.length <= 50 ? rawIds.map(normalizeSelectionBlockId) : []
    const selectionIdsValid = Array.isArray(rawIds)
      ? rawIds.length <= 50 && normalizedIds.length === rawIds.length && normalizedIds.every(Boolean) && new Set(normalizedIds).size === normalizedIds.length
      : true
    const ids = selectionIdsValid ? normalizedIds : []
    return { range, selectedTagIds: ids, selectionIdsValid, isCollapsed: raw?.empty === true || (range !== null && range.from === range.to) }
  }
  const stableSelectionAnchor = (value) => {
    if (!value || typeof value !== 'object') return null
    const blockId = normalizeSelectionBlockId(value.blockId)
    const anchorId = normalizeSelectionBlockId(value.anchorId)
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
    const hasCaret = isCollapsed && (stableRange !== null || anchor !== null)
    const hasSelection = !isCollapsed && (hasContent || stableRange !== null)
    const stable = !!anchor
    const serialized = JSON.stringify({ anchor, range: stableRange, selectedTagIds: runtime.selectedTagIds, selectionIdsValid: runtime.selectionIdsValid, isCollapsed, content })
    return { supported: true, content, anchor, range: stableRange, selectedTagIds: runtime.selectedTagIds, selectionIdsValid: runtime.selectionIdsValid, hasSelection, hasCaret, isCollapsed, stable, selectionFingerprint: await selectionFingerprint(serialized), truncated: Object.values(truncated).some(Boolean), truncatedFields: Object.keys(truncated).filter((key) => truncated[key]) }
  }
  const selectionPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const kinds = ['markdown', 'html', 'text'].filter((key) => typeof payload[key] === 'string')
    if (kinds.length !== 1) return null
    const kind = kinds[0]; const value = payload[kind]
    if (!value.trim() || value.length > 20_000 || !validSelectionFingerprint(payload.expectedSelectionFingerprint)) return null
    if (!Object.keys(payload).every((key) => ['markdown', 'html', 'text', 'insertBelow', 'expectedSelectionFingerprint'].includes(key)) || (payload.insertBelow !== undefined && typeof payload.insertBelow !== 'boolean')) return null
    return { kind, value, expectedSelectionFingerprint: payload.expectedSelectionFingerprint, insertBelow: payload.insertBelow === true }
  }
  const selectionBlocksPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.blocks)
      || payload.blocks.length < 1 || payload.blocks.length > 50
      || !validSelectionFingerprint(payload.expectedSelectionFingerprint)
      || !Object.keys(payload).every((key) => ['blocks', 'expectedSelectionFingerprint'].includes(key))) return null
    if (!payload.blocks.every((item) => structuredBlockXml(item) !== null)) return null
    const fragments = distinctiveFragments(payload.blocks.map((item) => Array.isArray(item.items) ? item.items.join('\n') : Array.isArray(item.rows) ? item.rows.flat().join('\n') : item.text ?? item.markdown ?? item.html ?? '').join('\n'))
    return fragments.length ? { blocks: payload.blocks, expectedSelectionFingerprint: payload.expectedSelectionFingerprint, fragments } : null
  }
  const selectionDeletePayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !validSelectionFingerprint(payload.expectedSelectionFingerprint)
      || !Object.keys(payload).every((key) => key === 'expectedSelectionFingerprint')) return null
    return { expectedSelectionFingerprint: payload.expectedSelectionFingerprint }
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
  const plainSelectionText = (value, kind = 'text') => {
    let source = kind === 'html' ? decode(value) : String(value ?? '')
    source = source.replace(/```[\w-]*\n?/g, '').replace(/`([^`]+)`/g, '$1').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    return normalizedSelectionText(source.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*+•◦▪]|\d+[.)])\s+/, '')).join('\n').replace(/[*_~]/g, ''))
  }
  const documentPlainText = (xml) => {
    const parsed = editableBlocks(xml)
    return parsed ? normalizedSelectionText(parsed.list.map((block) => block.text).join('\n')) : ''
  }
  const verifySelectionReplacement = (beforeXml, afterXml, snapshot, requested) => {
    const inserted = verifySelectionInsert(beforeXml, afterXml, requested)
    if (!inserted) return null
    const selectedSource = snapshot?.content?.text ?? snapshot?.content?.markdown ?? snapshot?.content?.html
    const selectedKind = typeof snapshot?.content?.text === 'string' ? 'text' : typeof snapshot?.content?.markdown === 'string' ? 'markdown' : 'html'
    const selectedText = plainSelectionText(selectedSource, selectedKind)
    const replacementText = plainSelectionText(requested.value, requested.kind)
    const beforeText = documentPlainText(beforeXml); const afterText = documentPlainText(afterXml)
    if (!selectedText || !replacementText || !beforeText || !afterText) return null
    let offset = beforeText.indexOf(selectedText); let matches = false
    while (offset >= 0) {
      const expected = normalizedSelectionText(`${beforeText.slice(0, offset)}${replacementText}${beforeText.slice(offset + selectedText.length)}`)
      if (expected === afterText) { matches = true; break }
      offset = beforeText.indexOf(selectedText, offset + 1)
    }
    return matches ? { ...inserted, replacedSelectionText: selectedText, verifiedTextAfter: afterText } : null
  }
  const verifySelectionDeletion = (beforeXml, afterXml, snapshot) => {
    const selectedSource = snapshot?.content?.text ?? snapshot?.content?.markdown ?? snapshot?.content?.html
    const selectedKind = typeof snapshot?.content?.text === 'string' ? 'text' : typeof snapshot?.content?.markdown === 'string' ? 'markdown' : 'html'
    const selectedText = plainSelectionText(selectedSource, selectedKind)
    const beforeText = documentPlainText(beforeXml); const afterText = documentPlainText(afterXml)
    if (!selectedText || !beforeText || afterXml === beforeXml) return null
    let offset = beforeText.indexOf(selectedText)
    while (offset >= 0) {
      const expected = normalizedSelectionText(`${beforeText.slice(0, offset)}${beforeText.slice(offset + selectedText.length)}`)
      if (expected === afterText) return { deletedSelectionText: selectedText, verifiedTextAfter: afterText }
      offset = beforeText.indexOf(selectedText, offset + 1)
    }
    return null
  }
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
      // Items are plain strings from the model surface. `{ html }` item
      // objects are accepted only for blocks derived internally from
      // markdown (markdownDerivedBlocks); native payload validation rejects
      // non-string items, so the model surface cannot smuggle raw HTML here.
      const itemBody = (line) => typeof line === 'string' ? escapeXml(line.trim())
        : line && typeof line === 'object' && !Array.isArray(line) && typeof line.html === 'string' && line.html.trim() && line.html.length <= 20_000 ? line.html : null
      if (items.length < 1 || items.length > 50 || !items.every((line) => itemBody(line) !== null)) return null
      // Preserve the target's stable id on the first generated paragraph so a
      // list replacement stays addressable for later blocks_delete/format and
      // does not strand id="" blocks after a verified write.
      return items.map((line, index) => `<p${index === 0 && preserveId ? ` id="${escapeXml(preserveId)}"` : ' id=""'} paddingLeft="2"><span>${escapeXml(type === 'ol' ? `${index + 1}. ` : '- ')}</span><span>${itemBody(line)}</span></p>`).join('')
    }
    if (type === 'table') {
      const rows = Array.isArray(item.rows) ? item.rows : text ? text.split('\n').map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean)) : []
      if (rows.length < 1 || rows.length > 30 || !rows.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 12 && row.every((cell) => typeof cell === 'string' && cell.length <= 2_000))) return null
      return `<table${id} borderStyle="solid">${rows.map((row, rowIndex) => `<tr>${row.map((cell) => `<td><p id="">${rowIndex === 0 ? `<strong>${escapeXml(cell)}</strong>` : escapeXml(cell)}</p></td>`).join('')}</tr>`).join('')}</table>`
    }
    if (type === 'codeblock' || type === 'codeBlock' || type === 'pre') {
      const language = String(item.language || (/\b(flowchart|sequenceDiagram|pie|graph|mindmap|gantt|classDiagram|erDiagram)\b/.test(text) ? 'mermaid' : 'plaintext')).toLowerCase()
      if (!text.trim() || text.length > 20_000 || !/^[a-z0-9_+#.-]+$/.test(language)) return null
      if (language === 'mermaid' && unsupportedMermaidDiagram(text)) return null
      return `<codeBlock${id} lang="${escapeXml(language)}"><![CDATA[${escapeCdata(text.replace(/^\n+|\n+$/g, ''))}]]></codeBlock>`
    }
    return null
  }
  const mermaidDirective = (source) => typeof source === 'string'
    ? source.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('%%'))?.split(/\s+/)[0] ?? 'this Mermaid diagram'
    : 'this Mermaid diagram'
  const unsupportedMermaidDiagram = (source) => mermaidDirective(source).toLowerCase() === 'xychart-beta'
  const blockXml = (payload, preserveId = null) => {
    if (typeof payload?.mermaid === 'string' && payload.mermaid.trim()) return structuredBlockXml({ type: 'codeblock', language: 'mermaid', text: payload.mermaid }, preserveId)
    const items = Array.isArray(payload?.blocks) ? payload.blocks : [payload]
    if (items.length < 1 || items.length > 50) return null
    const source = items.map((item, index) => structuredBlockXml(item, index === 0 ? preserveId : null))
    return source.every(Boolean) ? source.join('') : null
  }
  const inlineMarkdownHtml = (text) => escapeXml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
  // Minimal, conservative markdown block parser for the `replace` operation.
  // Only forms that map 1:1 onto structuredBlockXml are recognized; anything
  // else stays a plain paragraph. A raw-markdown <p> dump is never acceptable:
  // it lands `##`/`**` as literal document text and still reports verified.
  const markdownBlocks = (markdown) => {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
    const isBlockStart = (line) => /^(#{1,6}\s|>\s?|\||[-*+]\s|\d+[.)]\s|```|~~~)/.test(line)
    const blocks = []
    let index = 0
    while (index < lines.length) {
      const trimmed = lines[index].trim()
      if (!trimmed) { index += 1; continue }
      if (/^(```|~~~)/.test(trimmed)) {
        const language = trimmed.replace(/^[`~]{3,}/, '').trim().replace(/[^a-z0-9_+#.-]/gi, '') || 'plaintext'
        const content = []
        index += 1
        while (index < lines.length && !/^[`~]{3,}\s*$/.test(lines[index].trim())) { content.push(lines[index]); index += 1 }
        index += 1
        blocks.push({ type: 'codeblock', language, text: content.join('\n') })
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (heading) { blocks.push({ type: `h${heading[1].length}`, html: inlineMarkdownHtml(heading[2]) }); index += 1; continue }
      if (/^>\s?/.test(trimmed)) {
        const quote = []
        while (index < lines.length && /^>\s?/.test(lines[index].trim())) { quote.push(lines[index].trim().replace(/^>\s?/, '')); index += 1 }
        blocks.push({ type: 'blockquote', html: inlineMarkdownHtml(quote.join(' ')) })
        continue
      }
      if (/^\|.*\|$/.test(trimmed)) {
        const rows = []
        while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
          const cells = lines[index].trim().slice(1, -1).split('|').map((cell) => cell.trim())
          if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) rows.push(cells)
          index += 1
        }
        blocks.push({ type: 'table', rows })
        continue
      }
      if (/^[-*+]\s+/.test(trimmed)) {
        const items = []
        while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) { items.push({ html: inlineMarkdownHtml(lines[index].trim().replace(/^[-*+]\s+/, '')) }); index += 1 }
        blocks.push({ type: 'ul', items })
        continue
      }
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const items = []
        while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) { items.push({ html: inlineMarkdownHtml(lines[index].trim().replace(/^\d+[.)]\s+/, '')) }); index += 1 }
        blocks.push({ type: 'ol', items })
        continue
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { index += 1; continue }
      const paragraph = []
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index].trim())) { paragraph.push(lines[index].trim()); index += 1 }
      blocks.push({ type: 'p', html: inlineMarkdownHtml(paragraph.join(' ')) })
    }
    return blocks
  }
  const markdownDerivedBlocks = (item) => {
    if (typeof item?.markdown !== 'string' || !item.markdown.trim()) return null
    if (item.type !== undefined || item.blockType !== undefined || item.html !== undefined || Array.isArray(item.items) || Array.isArray(item.rows) || Array.isArray(item.blocks)) return null
    const blocks = markdownBlocks(item.markdown)
    return blocks.length ? blocks : null
  }
  const TEAM_KNOWLEDGE_BATCH_REPLACE_MAX_MARKDOWN_CHARS = 500_000
  const TEAM_KNOWLEDGE_BATCH_REPLACE_MAX_BLOCKS = 300
  const teamKnowledgeBatchReplacement = (xml, markdown) => {
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > TEAM_KNOWLEDGE_BATCH_REPLACE_MAX_MARKDOWN_CHARS) return null
    const parsed = editableBlocks(xml)
    if (!parsed) return null
    // A Team Knowledge child starts with a company template. Keep its title
    // node (and therefore the document identity) but replace every editable
    // block in one CanvasPatch transaction. Never emulate this with a clear
    // followed by an insert: a mid-operation failure would leave a broken PRD.
    const titles = parsed.all.filter((block) => block.tag.toLowerCase() === 'outlinetitle')
    // Freshly created Team Knowledge documents can be entirely blank rather
    // than carrying the usual title/template scaffold. That is the only
    // title-less shape we can initialize safely: emit the same minimal title
    // node used by the public title operation, then replace the full canvas in
    // this single transaction. Any non-empty title-less document remains
    // ambiguous and must fail closed.
    if (titles.length !== 1 && !(titles.length === 0 && parsed.list.length === 0)) return null
    const requested = markdownBlocks(markdown)
    if (requested.length < 1 || requested.length > TEAM_KNOWLEDGE_BATCH_REPLACE_MAX_BLOCKS) return null
    const replacement = requested.map((block) => structuredBlockXml(block)).join('')
    const expected = fragmentBlocks(replacement)
    if (!replacement || !expected || expected.length !== requested.length) return null
    const title = titles[0] ?? { xml: '<outlineTitle id=""></outlineTitle>', text: '' }
    return { parsed, title, replacement, expected, inner: `${title.xml}${replacement}` }
  }
  const verifyTeamKnowledgeBatchReplacement = (xml, expectedTitle, expectedBlocks) => {
    const parsed = editableBlocks(xml)
    if (!parsed) return null
    const titles = parsed.all.filter((block) => block.tag.toLowerCase() === 'outlinetitle')
    if (titles.length !== 1 || titles[0].text !== expectedTitle.text || parsed.list.length !== expectedBlocks.length) return null
    for (let index = 0; index < expectedBlocks.length; index += 1) {
      const actual = parsed.list[index]; const wanted = expectedBlocks[index]
      if (!actual || actual.tag.toLowerCase() !== wanted.type || normalizedSelectionText(actual.text) !== normalizedSelectionText(wanted.text)) return null
    }
    return { blockCount: parsed.list.length, observedBody: decode(xml) }
  }
  const teamKnowledgeBatchReplace = async (markdown) => {
    const current = await app()
    if (!current) return fail('unsupported', 'WebEdit light-document runtime is not ready')
    const beforeXml = await current.openApi.editor.canvas.getDocXml()
    const plan = teamKnowledgeBatchReplacement(beforeXml, markdown)
    if (!plan) return fail('invalid_range', 'Team Knowledge document replacement requires one bounded Markdown body and either one existing title or a completely blank document')
    const patched = await patchXml(current, beforeXml, plan.inner)
    if (!patched.ok) return patched
    const observed = verifyTeamKnowledgeBatchReplacement(patched.xml, plan.title, plan.expected)
    if (!observed) return fail('readback_mismatch', 'WebEdit did not atomically replace the prefilled Team Knowledge document body')
    return { ok: true, xml: patched.xml, observed }
  }
  const teamKnowledgeBatchVerify = async (markdown) => {
    const current = await app()
    if (!current) return fail('unsupported', 'WebEdit light-document runtime is not ready')
    const xml = await current.openApi.editor.canvas.getDocXml()
    const plan = teamKnowledgeBatchReplacement(xml, markdown)
    if (!plan) return fail('readback_mismatch', 'WebEdit did not expose a readable Team Knowledge document body')
    const observed = verifyTeamKnowledgeBatchReplacement(xml, plan.title, plan.expected)
    return observed ? { ok: true, xml, observed } : fail('readback_mismatch', 'WebEdit persisted body differs from the generated Team Knowledge document')
  }
  const fragmentBlocks = (xml) => {
    const parsed = editableBlocks(`<apcanvas>${xml}</apcanvas>`)
    return parsed ? parsed.list.map((block) => ({ type: block.tag.toLowerCase(), text: block.text })) : null
  }
  // Positional, content-based readback for block-range edits. Id-based lookup
  // cannot verify a replacement whose generated XML legitimately expands into
  // several blocks (ul/ol become padded paragraphs) or whose ids WebEdit
  // regenerates, so expectations are derived from the exact fragment written.
  const verifyBlocksEdit = (beforeParsed, afterXml, changes) => {
    const after = editableBlocks(afterXml)
    if (!after) return null
    const expected = []
    for (const block of beforeParsed.all) {
      if (block.tag.toLowerCase() === 'outlinetitle') continue
      const change = changes.find((candidate) => block.start >= candidate.start && block.end <= candidate.end)
      if (change) expected.push(...change.expectedBlocks)
      else expected.push(blockInvariant(block))
    }
    if (after.list.length !== expected.length) return null
    for (let position = 0; position < expected.length; position += 1) {
      const want = expected[position]
      const got = after.list[position]
      if (!got || got.tag.toLowerCase() !== want.type || normalizedSelectionText(got.text) !== normalizedSelectionText(want.text)) return null
    }
    return { verified: true, observedBlocks: after.list.map((block, index) => ({ index, id: block.id || null, type: block.tag.toLowerCase(), text: block.text.slice(0, 500) })) }
  }
  const pureListSelectionItems = (html) => {
    if (typeof html !== 'string') return null
    let source = html.trim()
    const htmlRoot = /^<html\b[^>]*>([\s\S]*)<\/html>$/i.exec(source)
    if (htmlRoot) {
      const documentParts = /^\s*<head\b[^>]*>([\s\S]*?)<\/head>\s*<body\b[^>]*>([\s\S]*)<\/body>\s*$/i.exec(htmlRoot[1])
      if (!documentParts) return null
      // Meta is the only tolerated head child. It is metadata, never selected
      // content, so text or structural siblings fail closed.
      if (documentParts[1].replace(/<meta\b[^>]*>(?:\s*<\/meta>)?/gi, '').trim() !== '') return null
      source = documentParts[2].trim()
    } else if (/<\/?(?:html|head|body|meta)\b/i.test(source)) return null
    // WebEdit may wrap a selected list in presentation-only divs. Require
    // each div to contain exactly its child wrapper/list and no sibling text.
    for (;;) {
      const wrapper = /^<div\b[^>]*>([\s\S]*)<\/div>$/i.exec(source)
      if (!wrapper) break
      source = wrapper[1].trim()
    }
    // WebEdit serializes a selection at list level N as N nested list
    // envelopes even when the selected content itself is one complete list.
    // Peel only wrappers whose sole child is another list; text or siblings
    // remain rejected.
    for (;;) {
      const envelope = /^<(ul|ol)\b[^>]*>\s*(<(?:ul|ol)\b[^>]*>[\s\S]*<\/(?:ul|ol)>)\s*<\/\1>$/i.exec(source)
      if (!envelope) break
      source = envelope[2].trim()
    }
    const root = /^<(ul|ol)\b[^>]*>([\s\S]*)<\/\1>$/i.exec(source)
    if (!root) return null
    const items = []; const pattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi; let match
    while ((match = pattern.exec(root[2]))) {
      // Nested lists make a flattened text comparison ambiguous; require the
      // exact, single-level ul/ol -> li structure observed on the real page.
      if (/<\/?(?:ul|ol|li)\b/i.test(match[1])) return null
      const text = normalizedSelectionText(decode(match[1]))
      if (!text) return null
      items.push(text)
    }
    return items.length > 0 && root[2].replace(pattern, '').trim() === '' ? items : null
  }
  const selectionMatchesWholeBlocks = (snapshot, ordered) => {
    // selected_tag_ids says which blocks intersect the selection, not that its
    // endpoints cover every character.  Replacing based on IDs alone can erase
    // unselected first/last text.  The public selection snapshot is our second
    // independent proof that the selected text is exactly these whole blocks.
    const selected = snapshot?.content?.text ?? snapshot?.content?.markdown ?? snapshot?.content?.html
    const selectedText = normalizedSelectionText(selected)
    const blockText = normalizedSelectionText(ordered.map((block) => block.text).join('\n'))
    if (!selectedText) return false
    if (selectedText === blockText) return true
    const listItems = pureListSelectionItems(snapshot?.content?.html)
    return listItems !== null && listItems.length === ordered.length
      && listItems.every((text, index) => text === normalizedSelectionText(ordered[index].text))
  }
  const wholeBlockReplaceable = (xml, snapshot) => {
    if (!snapshot?.supported || snapshot.truncated || snapshot.stable !== true || snapshot.hasSelection !== true || snapshot.isCollapsed || snapshot.selectionIdsValid !== true) return false
    const parsed = editableBlocks(xml)
    const selectedIds = Array.isArray(snapshot.selectedTagIds) ? snapshot.selectedTagIds : []
    const selected = selectedIds.map((id) => parsed?.list.find((block) => block.id === id)).filter(Boolean)
    if (!parsed || selectedIds.length === 0 || selected.length !== selectedIds.length) return false
    const ordered = selected.slice().sort((left, right) => parsed.list.indexOf(left) - parsed.list.indexOf(right))
    const indexes = ordered.map((block) => parsed.list.indexOf(block))
    return !indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1)
      && selectionMatchesWholeBlocks(snapshot, ordered)
  }
  const selectionReplacementExpectations = (blocks) => {
    const expected = []
    for (const item of blocks) {
      const type = String(item.type ?? item.blockType ?? '').toLowerCase()
      if (type === 'ul' || type === 'ol') {
        const items = Array.isArray(item.items) ? item.items : String(item.text ?? '').split('\n')
        expected.push(...items.map((text) => ({ type: 'p', text: normalizedSelectionText(text) })))
      } else if (type === 'table') expected.push({ type: 'table', text: normalizedSelectionText((item.rows ?? []).flat().join('\n')) })
      else expected.push({ type, text: normalizedSelectionText(item.text ?? item.markdown ?? item.html ?? '') })
    }
    return expected
  }
  const blockInvariant = (block) => ({ type: block.tag.toLowerCase(), language: block.language ?? null, text: block.text })
  const sameBlockInvariant = (left, right) => left.type === right.type && left.language === right.language && left.text === right.text
  const selectionReplaceInvariant = (parsed, ordered) => {
    const firstIndex = parsed.list.indexOf(ordered[0]); const lastIndex = parsed.list.indexOf(ordered[ordered.length - 1])
    return {
      firstIndex,
      selectedTagIds: ordered.map((block) => block.id),
      outsideBefore: parsed.list.slice(0, firstIndex).map(blockInvariant),
      outsideAfter: parsed.list.slice(lastIndex + 1).map(blockInvariant),
      allBeforeIds: parsed.list.map((block) => block.id).filter(Boolean),
    }
  }
  const verifySelectionBlocksReplace = (afterXml, invariant, expected, fragments) => {
    const after = editableBlocks(afterXml)
    if (!after) return null
    const minimumLength = invariant.outsideBefore.length + expected.length + invariant.outsideAfter.length
    if (after.list.length !== minimumLength) return null
    const observedOutsideBefore = after.list.slice(0, invariant.outsideBefore.length).map(blockInvariant)
    const targetStart = invariant.outsideBefore.length
    const observed = after.list.slice(targetStart, targetStart + expected.length)
    const observedOutsideAfter = after.list.slice(targetStart + expected.length).map(blockInvariant)
    if (!invariant.outsideBefore.every((block, index) => sameBlockInvariant(block, observedOutsideBefore[index]))
      || !invariant.outsideAfter.every((block, index) => sameBlockInvariant(block, observedOutsideAfter[index]))
      || observed.length !== expected.length
      || !expected.every((item, index) => observed[index].tag.toLowerCase() === item.type && (!item.text || normalizedSelectionText(observed[index].text).includes(item.text)))) return null
    const fragmentEvidence = fragments.map((fragment) => ({ fragment, blockIds: observed.filter((block) => normalizedSelectionText(block.text).includes(fragment)).map((block, index) => block.id || `index:${targetStart + index}`) }))
    if (fragmentEvidence.some((item) => item.blockIds.length === 0)) return null
    const allAfterIds = after.list.map((block) => block.id).filter(Boolean)
    const idsRegenerated = invariant.allBeforeIds.length > 0 && invariant.allBeforeIds.every((id) => !allAfterIds.includes(id))
    return {
      verifiedFragments: fragments, fragmentEvidence,
      observedBlocks: observed.map((block, index) => ({ id: block.id || `index:${targetStart + index}`, type: block.tag.toLowerCase(), language: block.language, text: block.text.slice(0, 500) })),
      outsideSelectionBlocks: [...observedOutsideBefore, ...observedOutsideAfter].map((block, index) => ({ index: index < observedOutsideBefore.length ? index : targetStart + expected.length + index - observedOutsideBefore.length, type: block.type, language: block.language, text: block.text.slice(0, 500) })),
      replacedTagIds: invariant.selectedTagIds, writeStrategy: 'full_canvas_patch', idsRegenerated, verified: true,
    }
  }
  const verifySelectionBlocksDelete = (afterXml, invariant) => {
    const after = editableBlocks(afterXml)
    if (!after || after.list.length !== invariant.outsideBefore.length + invariant.outsideAfter.length) return null
    const observedBefore = after.list.slice(0, invariant.outsideBefore.length).map(blockInvariant)
    const observedAfter = after.list.slice(invariant.outsideBefore.length).map(blockInvariant)
    if (!invariant.outsideBefore.every((block, index) => sameBlockInvariant(block, observedBefore[index]))
      || !invariant.outsideAfter.every((block, index) => sameBlockInvariant(block, observedAfter[index]))) return null
    const remainingIds = after.list.map((block) => block.id).filter(Boolean)
    if (invariant.selectedTagIds.some((id) => remainingIds.includes(id))) return null
    return {
      deletedTagIds: invariant.selectedTagIds,
      outsideSelectionBlocks: [...observedBefore, ...observedAfter].map((block, index) => ({ index, type: block.type, language: block.language, text: block.text.slice(0, 500) })),
      writeStrategy: 'full_canvas_patch', verified: true,
    }
  }
  const insertPosition = (parsed, payload, selection) => {
    const position = payload?.position ?? 'end'
    if (!['start', 'end', 'before', 'after', 'after_selection'].includes(position)) return null
    if (position === 'end') return parsed.inner.length
    if (position === 'start') {
      const title = parsed.all.find((block) => block.tag.toLowerCase() === 'outlinetitle')
      return title ? title.end : 0
    }
    if (position === 'after_selection') {
      if (!selection || selection.stable !== true || selection.hasSelection !== true || selection.isCollapsed || selection.selectionIdsValid !== true || selection.selectionFingerprint !== payload?.expectedSelectionFingerprint) return null
      const selected = selection.selectedTagIds.map((id) => parsed.list.find((block) => block.id === id)).filter(Boolean)
      if (selected.length !== selection.selectedTagIds.length || selected.length === 0) return null
      return selected.slice().sort((left, right) => parsed.list.indexOf(left) - parsed.list.indexOf(right)).at(-1).end
    }
    const target = Number.isInteger(payload?.index) ? parsed.list[payload.index] : parsed.list.find((block) => block.id && block.id === payload?.id)
    if (!target) return null
    return position === 'before' ? target.start : target.end
  }
  const verifyDrawingAfterSelection = (beforeXml, afterXml, selection, fragments) => {
    const before = editableBlocks(beforeXml); const after = editableBlocks(afterXml)
    if (!before || !after || !selection || selection.selectionIdsValid !== true) return null
    const selected = selection.selectedTagIds.map((id) => before.list.find((block) => block.id === id)).filter(Boolean)
    if (selected.length !== selection.selectedTagIds.length || selected.length === 0 || after.list.length !== before.list.length + 1) return null
    const selectedLastIndex = Math.max(...selected.map((block) => before.list.indexOf(block)))
    const inserted = after.list[selectedLastIndex + 1]
    if (!inserted || inserted.tag.toLowerCase() !== 'codeblock' || inserted.language !== 'mermaid' || !fragments.every((fragment) => normalizedSelectionText(inserted.text).includes(normalizedSelectionText(fragment)))) return null
    const beforePart = after.list.slice(0, selectedLastIndex + 1).map(blockInvariant)
    const afterPart = after.list.slice(selectedLastIndex + 2).map(blockInvariant)
    if (!before.list.slice(0, selectedLastIndex + 1).map(blockInvariant).every((block, index) => sameBlockInvariant(block, beforePart[index]))
      || !before.list.slice(selectedLastIndex + 1).map(blockInvariant).every((block, index) => sameBlockInvariant(block, afterPart[index]))) return null
    return { position: 'after_selection', selectedTagIds: selected.map((block) => block.id), insertedBlock: { id: inserted.id || `index:${selectedLastIndex + 1}`, type: 'codeblock', language: 'mermaid', text: inserted.text.slice(0, 500) } }
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
      const runtime = runtimeSelection(current)
      const canvas = current?.openApi?.editor?.canvas
      let selectionSnapshot = { supported: false }
      try { selectionSnapshot = await readSelection(current, 20_000) } catch { /* capability probing remains fail-closed */ }
      const selectionStrategies = {
        // These are independently observed strategies, not a claim that every
        // WebEdit build implements getSelectionAnchor.
        content: !!(selection && typeof selection.getSelectionContent === 'function'),
        coordinates: runtime.range !== null,
        wholeBlock: typeof canvas?.canvas?.getSelectionInfo === 'function',
        insert: typeof selection?.insertContent === 'function' ? 'public_insert_content' : 'unavailable',
        replace: typeof selection?.replaceContent === 'function'
          ? 'public_replace_content'
          : typeof canvas?.patch === 'function' ? 'full_canvas_patch_for_verified_whole_blocks' : 'unavailable',
      }
      const selectionReadable = selectionStrategies.content
        && (runtime.range !== null || typeof selection?.getSelectionAnchor === 'function')
      const currentWholeBlockReplaceable = wholeBlockReplaceable(xml, selectionSnapshot)
        && selectionStrategies.replace !== 'unavailable'
      const verifiedSelectionInsert = selectionReadable && selectionSnapshot.supported === true && selectionSnapshot.stable === true
        && (selectionSnapshot.hasSelection === true || selectionSnapshot.hasCaret === true)
        && selectionStrategies.insert === 'public_insert_content'
      const detected = {
        // Legacy `selection` answers whether this adapter can read the current
        // selection. Preview eligibility remains snapshot-specific below.
        selection: selectionReadable, currentWholeBlockReplaceable,
        verifiedSelectionInsert, selectionStrategies,
        comments: !!(comments && (typeof comments.getComments === 'function' || typeof comments.getAllComments === 'function')),
        wordCount: !!(document && typeof document.getWordCount === 'function'), exactBlockRead: true, blockEdits: typeof current?.openApi?.editor?.canvas?.patch === 'function', blockRichHtml: true,
        selectionRichInsert: verifiedSelectionInsert,
        selectionRichReplace: currentWholeBlockReplaceable && selectionStrategies.replace === 'public_replace_content',
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
      const selection = await readSelection(current, Math.max(1, bounded(input.payload?.maxChars, 20_000, 20_000)))
      const whole = wholeBlockReplaceable(xml, selection)
      const containingTable = selectedContainingTable(xml, selection)
      const selectedTable = singleTableMatrix(selection?.content?.html) !== null
      const api = selectionApi(current)
      const replaceStrategy = whole && typeof current?.openApi?.editor?.canvas?.patch === 'function' ? 'full_canvas_patch'
        : containingTable && typeof current?.openApi?.editor?.canvas?.patch === 'function' ? 'full_canvas_patch_selected_table'
        : typeof api?.replaceContent === 'function' ? 'public_replace_content'
          : !selectedTable && typeof api?.insertContent === 'function' ? 'public_insert_content' : 'unavailable'
      const containingTableScope = containingTable ? {
        id: containingTable.target.id,
        index: containingTable.blockIndex,
        rowCount: containingTable.matrix.length,
        columnCount: containingTable.matrix[0].length,
        selectedRowCount: containingTable.selected.length,
        selectedColumnCount: containingTable.selected[0].length,
      } : null
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, selection: { ...selection, wholeBlockReplaceable: whole, replaceStrategy, containingTable: containingTableScope } } } }
    }
    if (input.action === 'inspect_write') {
      const parsed = editableBlocks(xml)
      if (input.operation === 'insert_drawing' && unsupportedMermaidDiagram(input.payload?.mermaid)) return fail('invalid_range', `${mermaidDirective(input.payload?.mermaid)} Mermaid diagrams are not supported by this WebEdit target. Use flowchart or pie instead.`)
      if (['insert_drawing', 'blocks_insert'].includes(input.operation) && ['before', 'after'].includes(input.payload?.position) && !insertPosition(parsed, input.payload, null)) return fail('invalid_range', 'The light-document insertion target is no longer present. Call light_document_read and use an id or index from that latest read.')
      if (input.operation === 'blocks_delete') {
        const items = batchBlockItems('blocks_delete', input.payload)
        if (!items || !parsed || items.some((item) => !parsed.list.some((block) => block.id === item.id))) return fail('invalid_range', 'blocks_delete requires current stable block ids. Call light_document_read and use payload { blocks: [{ id }] }, never index.')
      }
    }
    if (input.action === 'inspect_write' && input.operation === 'insert_drawing' && input.payload?.position === 'after_selection') {
      const selection = await readSelection(current, 20_000)
      const parsed = editableBlocks(xml)
      const selected = selection.selectedTagIds.map((id) => parsed?.list.find((block) => block.id === id)).filter(Boolean)
      if (!selection.supported || selection.truncated || selection.stable !== true || selection.hasSelection !== true || selection.isCollapsed || selection.selectionIdsValid !== true || selection.selectionFingerprint !== input.payload.expectedSelectionFingerprint || !parsed || selected.length !== selection.selectedTagIds.length || selected.length === 0) return fail('invalid_range', 'insert_drawing after_selection requires the unchanged stable block selection returned by light_document_selection_read')
      return { ok: true, result: { status: 'ok', resource, document: { ...documentResult, selection } } }
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
    if (input.operation === 'team_knowledge_batch_replace') {
      // Internal batch-delivery operation. It is intentionally absent from the
      // model-facing tool catalog; the background invokes it only for a newly
      // created or recovered Team Knowledge child document.
      if (input.payload?.replaceScope !== 'team_knowledge_batch_document') return fail('invalid_range', 'Team Knowledge batch replacement requires its internal delivery scope')
      const plan = teamKnowledgeBatchReplacement(beforeXml, input.payload?.markdown)
      if (!plan) return fail('invalid_range', 'Team Knowledge document replacement requires one bounded Markdown body and either one existing title or a completely blank document')
      const patched = await patchXml(current, beforeXml, plan.inner)
      if (!patched.ok) return patched
      const observed = verifyTeamKnowledgeBatchReplacement(patched.xml, plan.title, plan.expected)
      if (!observed) return fail('readback_mismatch', 'WebEdit did not atomically replace the prefilled Team Knowledge document body')
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, count: plan.expected.length }, observed: { ...observed, verified: true } } }
    }
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
    if (input.operation === 'selection_insert' || input.operation === 'selection_replace' || input.operation === 'selection_content_replace' || input.operation === 'selection_blocks_replace' || input.operation === 'selection_delete') {
      const requested = input.operation === 'selection_blocks_replace' ? selectionBlocksPayload(input.payload)
        : input.operation === 'selection_delete' ? selectionDeletePayload(input.payload) : selectionPayload(input.payload)
      const selection = selectionApi(current)
      const mutate = input.operation === 'selection_delete' || input.operation === 'selection_replace' || input.operation === 'selection_content_replace' && typeof selection?.replaceContent === 'function' ? 'replaceContent' : 'insertContent'
      if (!requested || !selection) return fail('unsupported', `Light-document ${input.operation} requires one bounded content format and a stable selection fingerprint`)
      const snapshot = await readSelection(current, 20_000)
      if (!snapshot.supported || snapshot.truncated || !snapshot.stable || !snapshot.anchor) return fail('invalid_range', `Light-document ${input.operation} requires a complete, stable selection or cursor snapshot`)
      if ((input.operation === 'selection_replace' || input.operation === 'selection_content_replace' || input.operation === 'selection_blocks_replace' || input.operation === 'selection_delete') && snapshot.isCollapsed) return fail('invalid_range', `${input.operation} requires a non-collapsed selection; use selection_insert at a caret`)
      if (snapshot.selectionFingerprint !== requested.expectedSelectionFingerprint) return fail('fingerprint_mismatch', 'The light-document selection changed since inspect_write')
      if (input.operation === 'selection_delete' && singleTableMatrix(snapshot?.content?.html) !== null) return fail('unsupported', 'Selected table cells cannot be deleted as a partial selection. Select the whole stable table block, or delete it by stable block id')
      if (input.operation === 'selection_content_replace' && singleTableMatrix(snapshot?.content?.html) !== null) {
        const scope = selectedContainingTable(beforeXml, snapshot)
        const replacementBlocks = requested.kind === 'markdown' ? markdownBlocks(requested.value) : null
        if (!scope || !replacementBlocks || replacementBlocks.length !== 1 || String(replacementBlocks[0]?.type).toLowerCase() !== 'table') {
          return fail('unsupported', 'Selected table cells require one uniquely matched containing table and one table replacement; no insert fallback is allowed')
        }
        const replacement = blockXml({ blocks: replacementBlocks }, scope.target.id)
        if (!replacement) return fail('invalid_range', 'Selected table replacement requires one bounded table')
        const invariant = selectionReplaceInvariant(scope.parsed, [scope.target])
        const inner = `${scope.parsed.inner.slice(0, scope.target.start)}${replacement}${scope.parsed.inner.slice(scope.target.end)}`
        const patched = await patchXml(current, beforeXml, inner)
        if (!patched.ok) return patched
        const fragments = distinctiveFragments(replacementBlocks[0].rows.flat().join('\n'))
        const observed = verifySelectionBlocksReplace(patched.xml, invariant, selectionReplacementExpectations(replacementBlocks), fragments)
        if (!observed) return fail('readback_mismatch', 'WebEdit selected-table replacement did not return one matching table and unchanged surrounding blocks')
        return { ok: true, result: {
          status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload },
          observed: { ...observed, replacementScope: 'containing_table', verified: true },
        } }
      }
      if (input.operation === 'selection_blocks_replace') {
        const parsed = editableBlocks(beforeXml)
        const selectedIds = Array.isArray(snapshot.selectedTagIds) ? snapshot.selectedTagIds : []
        const selected = selectedIds.map((id) => parsed?.list.find((block) => block.id === id)).filter(Boolean)
        if (!snapshot.selectionIdsValid || !parsed || selected.length !== selectedIds.length || selected.length === 0) return fail('unsupported', 'selection_blocks_replace requires valid unique selectedTagIds for whole public blocks')
        const ordered = selected.slice().sort((left, right) => parsed.list.indexOf(left) - parsed.list.indexOf(right))
        const indexes = ordered.map((block) => parsed.list.indexOf(block))
        if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1) || !selectionMatchesWholeBlocks(snapshot, ordered)) return fail('unsupported', 'selection_blocks_replace requires one contiguous complete whole-block selection')
        const invariant = selectionReplaceInvariant(parsed, ordered)
        const first = ordered[0]; const last = ordered[ordered.length - 1]
        const replacement = blockXml({ blocks: requested.blocks }, first.id)
        if (!replacement) return fail('invalid_range', 'selection_blocks_replace requires bounded structured blocks')
        const patched = await patchXml(current, beforeXml, `${parsed.inner.slice(0, first.start)}${replacement}${parsed.inner.slice(last.end)}`)
        if (!patched.ok) return patched
        const observed = verifySelectionBlocksReplace(patched.xml, invariant, selectionReplacementExpectations(requested.blocks), requested.fragments)
        if (!observed) return fail('readback_mismatch', 'WebEdit selection_blocks_replace did not return matching block structure and fragments')
        return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload }, observed } }
      }
      if (input.operation === 'selection_delete' && wholeBlockReplaceable(beforeXml, snapshot)) {
        const parsed = editableBlocks(beforeXml)
        const selectedIds = Array.isArray(snapshot.selectedTagIds) ? snapshot.selectedTagIds : []
        const selected = selectedIds.map((id) => parsed?.list.find((block) => block.id === id)).filter(Boolean)
        if (!snapshot.selectionIdsValid || !parsed || selected.length !== selectedIds.length || selected.length === 0) return fail('unsupported', 'selection_delete requires valid unique selectedTagIds for whole public blocks')
        const ordered = selected.slice().sort((left, right) => parsed.list.indexOf(left) - parsed.list.indexOf(right))
        const indexes = ordered.map((block) => parsed.list.indexOf(block))
        if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1) || !selectionMatchesWholeBlocks(snapshot, ordered)) return fail('unsupported', 'selection_delete requires one contiguous complete whole-block selection')
        const invariant = selectionReplaceInvariant(parsed, ordered)
        const first = ordered[0]; const last = ordered[ordered.length - 1]
        const patched = await patchXml(current, beforeXml, `${parsed.inner.slice(0, first.start)}${parsed.inner.slice(last.end)}`)
        if (!patched.ok) return patched
        const observed = verifySelectionBlocksDelete(patched.xml, invariant)
        if (!observed) return fail('readback_mismatch', 'WebEdit selection_delete did not remove exactly the selected blocks and preserve surrounding blocks')
        return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload }, observed } }
      }
      if (typeof selection[mutate] !== 'function') {
        // Some WebEdit builds expose a stable whole-block selection but omit
        // selection.replaceContent. Patch all selected blocks in one Canvas
        // transaction; never emulate this with delete followed by insert.
        if (input.operation !== 'selection_replace' || requested.kind !== 'text') return fail('unsupported', `Light-document ${input.operation} requires the public ${mutate} API for this content format`)
        const parsed = editableBlocks(beforeXml)
        const selectedIds = Array.isArray(snapshot.selectedTagIds) ? snapshot.selectedTagIds : []
        const selected = selectedIds.map((id) => parsed?.list.find((block) => block.id === id)).filter(Boolean)
        if (!snapshot.selectionIdsValid || !parsed || selected.length !== selectedIds.length || selected.length === 0) return fail('unsupported', 'selection_replace fallback requires valid unique selectedTagIds for whole public blocks')
        const ordered = selected.slice().sort((left, right) => parsed.list.indexOf(left) - parsed.list.indexOf(right))
        const indexes = ordered.map((block) => parsed.list.indexOf(block))
        if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1) || !selectionMatchesWholeBlocks(snapshot, ordered)) return fail('unsupported', 'selection_replace fallback requires one contiguous complete whole-block selection')
        const first = ordered[0]
        const last = ordered[ordered.length - 1]
        const replacement = structuredBlockXml({ type: 'p', text: requested.value }, first.id)
        if (!replacement) return fail('invalid_range', 'selection_replace fallback requires bounded non-empty text')
        const patched = await patchXml(current, beforeXml, `${parsed.inner.slice(0, first.start)}${replacement}${parsed.inner.slice(last.end)}`)
        if (!patched.ok) return patched
        const after = editableBlocks(patched.xml)
        const observed = verifySelectionInsert(beforeXml, patched.xml, requested)
        if (!after || !observed || selectedIds.slice(1).some((id) => after.list.some((block) => block.id === id)) || !after.list.some((block) => block.id === first.id)) return fail('readback_mismatch', 'WebEdit selection_replace fallback did not atomically replace the selected blocks')
        return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload }, observed: { ...observed, replacedTagIds: selectedIds, verified: true } } }
      }
      const content = {
        ...(input.operation === 'selection_delete' ? { text: '' } : { [requested.kind]: requested.value }),
        // WebEdit builds have only ever been observed accepting `insertBlow`
        // (sic). Send both spellings until the public API contract is
        // confirmed against a live editor target; an ignored extra key is
        // harmless, a wrong single spelling silently drops the option.
        ...(requested.insertBelow ? { insertBlow: true, insertBelow: true } : {}),
      }
      try { await selection[mutate](content) } catch { return fail('runtime_error', `WebEdit rejected the light-document ${input.operation}`) }
      let afterXml = await current.openApi.editor.canvas.getDocXml(); const deadline = Date.now() + 3_000
      while (afterXml === beforeXml && Date.now() < deadline) { await sleep(50); afterXml = await current.openApi.editor.canvas.getDocXml() }
      const observed = input.operation === 'selection_insert' ? verifySelectionInsert(beforeXml, afterXml, requested)
        : input.operation === 'selection_delete' ? verifySelectionDeletion(beforeXml, afterXml, snapshot)
          : verifySelectionReplacement(beforeXml, afterXml, snapshot, requested)
      if (!observed) return fail('readback_mismatch', `WebEdit ${input.operation} did not produce matching XML content and structural evidence`)
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(afterXml, current), requested: { operation: input.operation, payload: input.payload }, observed: { ...observed, verified: true } } }
    }
    if (input.operation === 'blocks_insert' || input.operation === 'insert_drawing') {
      const parsed = editableBlocks(beforeXml)
      if (!parsed) return fail('unsupported', 'WebEdit did not expose editable light-document blocks')
      const xml = input.operation === 'insert_drawing' ? structuredBlockXml({ type: 'codeblock', language: 'mermaid', text: input.payload?.mermaid }, null) : blockXml(input.payload)
      const selection = input.payload?.position === 'after_selection' ? await readSelection(current, 20_000) : null
      const offset = insertPosition(parsed, input.payload, selection)
      if (!xml || offset === null) return fail('invalid_range', input.operation === 'insert_drawing'
        ? 'insert_drawing requires Mermaid source and a start/end/before/after position, or after_selection with a matching stable selection fingerprint'
        : 'blocks_insert requires bounded h1-h6/p/blockquote/ul/ol/table/codeblock items and a start/end/before/after position')
      const fragments = distinctiveFragments(input.operation === 'insert_drawing' ? input.payload?.mermaid : (input.payload?.blocks ?? []).map((item) => Array.isArray(item?.items) ? item.items.join('\n') : Array.isArray(item?.rows) ? item.rows.flat().join('\n') : item?.text ?? item?.markdown ?? item?.html ?? '').join('\n'))
      if (!fragments.length) return fail('invalid_range', `${input.operation} requires distinctive readable content for XML readback`)
      const patched = await patchXml(current, beforeXml, `${parsed.inner.slice(0, offset)}${xml}${parsed.inner.slice(offset)}`)
      if (!patched.ok) return patched
      const observed = verifyInsertedFragments(beforeXml, patched.xml, fragments)
      if (!observed) return fail('readback_mismatch', `WebEdit ${input.operation} did not produce matching XML content and structural evidence`)
      const insertion = input.operation === 'insert_drawing' && input.payload?.position === 'after_selection' ? verifyDrawingAfterSelection(beforeXml, patched.xml, selection, fragments) : null
      if (input.operation === 'insert_drawing' && input.payload?.position === 'after_selection' && !insertion) return fail('readback_mismatch', 'WebEdit insert_drawing did not remain immediately after the selected blocks')
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload }, observed: { ...observed, ...(insertion ? { insertion } : {}), verified: true } } }
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
    if (['replace', 'blocks_replace', 'blocks_batch_replace', 'blocks_batch_edit'].includes(input.operation)) {
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
        const derived = markdownDerivedBlocks(item)
        const replacement = mode === 'delete' ? '' : blockXml(derived ? { ...item, blocks: derived } : item, located?.target?.id ?? null)
        if (mode !== 'delete' && !replacement) return fail('invalid_range', 'block content must be bounded text/markdown blocks')
        const expectedBlocks = fragmentBlocks(replacement)
        if (!expectedBlocks) return fail('invalid_range', 'block content must be bounded text/markdown blocks')
        changes.push({ start: located.target.start, end: located.target.end, xml: replacement, expectedBlocks })
      }
      const duplicate = new Set(); if (changes.some((change) => { const key = `${change.start}:${change.end}`; if (duplicate.has(key)) return true; duplicate.add(key); return false })) return fail('invalid_range', 'block edit targets must be distinct')
      let inner = parsed.inner; for (const change of changes.slice().sort((left, right) => right.start - left.start)) inner = `${inner.slice(0, change.start)}${change.xml}${inner.slice(change.end)}`
      const deletedIds = requested.filter((item) => item?.mode === 'delete').map((item) => targetBlock(beforeXml, item)?.target?.id).filter(Boolean)
      const patched = await patchXml(current, beforeXml, inner)
      if (!patched.ok) return patched
      const observed = verifyBlocksEdit(parsed, patched.xml, changes)
      if (!observed) return fail('readback_mismatch', `WebEdit ${input.operation} did not produce the exact requested block sequence`)
      const afterBlocks = editableBlocks(await current.openApi.editor.canvas.getDocXml())
      if (!afterBlocks || deletedIds.some((id) => afterBlocks.all.some((block) => block.id === id))) return fail('readback_mismatch', 'WebEdit did not remove every requested light-document block')
      return { ok: true, result: { status: 'verified_write', resource: await documentResource(patched.xml, current), requested: { operation: input.operation, payload: input.payload, count: changes.length }, observed: { ...observed, verified: true } } }
    }
    if (input.operation === 'insert_image' || input.operation === 'highlight_selection') return fail('unsupported', `WebEdit ${input.operation} is detected only when its operation-specific public API and readback contract are available`)
    const located = input.operation === 'title' ? editableBlocks(beforeXml) : targetBlock(beforeXml, input.payload)
    if (!located) return fail('invalid_range', editableBlocks(beforeXml)?.list.length === 0 && input.operation !== 'title'
      ? 'This light document has no public replaceable block. Use selection_insert with expectedSelectionFingerprint from a selection read.'
      : 'light-document target block was not found')
    // A delete must be independently verifiable after CanvasPatch. Without a
    // stable block id it could succeed in the document and still be reported
    // as a failed write, leaving the caller with a dangerous partial result.
    if (['delete', 'format'].includes(input.operation) && !located.target.id) return fail('invalid_range', `${input.operation} requires a stable light-document block id`)
    let inner = located.inner
    let expectedText = markdown
    if (input.operation === 'delete') {
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
  const registeredChannels = new Map()
  const registerChannel = (channel) => {
    if (typeof channel !== 'string' || channel.length < 16 || channel.length > 256) return false
    registeredChannels.delete(channel)
    registeredChannels.set(channel, Date.now())
    // A response already in flight retains its captured channel, but new
    // requests on the replaced channel are revoked immediately. This keeps
    // healing deterministic and bounds page-lifetime registration state.
    while (registeredChannels.size > 1) registeredChannels.delete(registeredChannels.keys().next().value)
    return true
  }
  registerChannel(bridgeChannel)
  // These two methods are intentionally not part of the model-facing office
  // operation catalog. They are used only by the Team Knowledge batch-create
  // recovery path to replace a newly created, prefilled document as one
  // verified transaction and to attest the same exact body after reopening.
  globalThis[runtimeKey] = { registerChannel, teamKnowledgeBatchReplace, teamKnowledgeBatchVerify }
  const consumedRequestIds = new Set()
  const validRequestEnvelope = (value) => value && typeof value === 'object'
    && Object.keys(value).length === 4 && value.type === 'request'
    && typeof value.channel === 'string' && registeredChannels.has(value.channel)
    && typeof value.id === 'string' && value.id.length > 0
    && value.request && typeof value.request === 'object' && !Array.isArray(value.request)
  const respond = (channel, id, payload) => {
    const detail = payload.ok === true
      ? { type: 'response', channel, id, ok: true, result: payload.result }
      : { type: 'response', channel, id, ok: false, error: payload.error }
    window.dispatchEvent(new CustomEvent(RESPONSE, { detail }))
  }
  window.addEventListener(REQUEST, (event) => {
    const envelope = event.detail
    const requestKey = validRequestEnvelope(envelope) ? `${envelope.channel}\u0000${envelope.id}` : null
    if (requestKey === null || consumedRequestIds.has(requestKey)) return
    consumedRequestIds.add(requestKey)
    while (consumedRequestIds.size > 256) consumedRequestIds.delete(consumedRequestIds.values().next().value)
    const input = envelope.request
    const action = input.action
    const task = action === 'write' ? write(input) : read(input)
    void task.then((payload) => respond(envelope.channel, envelope.id, payload))
      .catch(() => respond(envelope.channel, envelope.id, fail('runtime_error', 'WebEdit light-document operation failed')))
  })
})()
