(() => {
  'use strict'

  // This runtime is deliberately an adapter, not an implementation of a PPT
  // object model. Every capability below is advertised only after the public
  // WPSOpenApi surface exposes the required method/property in the bound frame.
  const fail = (code, message, details) => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
  const resolve = async (value) => value && typeof value.then === 'function' ? await value : value
  const call = async (target, name, args = []) => target && typeof target[name] === 'function' ? resolve(target[name](...args)) : undefined
  const prop = async (target, name) => { try { return await resolve(target?.[name]) } catch { return undefined } }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const normalizeLineEndings = (value) => typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value
  const notesTextMatches = (expected, actual) => {
    const normalizedExpected = normalizeLineEndings(expected); const normalizedActual = normalizeLineEndings(actual)
    return normalizedActual === normalizedExpected
      // WebEdit appends one terminal CR to a note that did not have a line
      // ending. Accept only that editor normalization; all other content and
      // line-break-count differences must still fail readback.
      || (typeof expected === 'string' && typeof actual === 'string' && !/[\r\n]$/.test(expected) && /\r$/.test(actual) && normalizedActual === `${normalizedExpected}\n`)
  }
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const app = () => globalThis.WPSOpenApi?.Application ?? globalThis.APP
  const editor = () => app()?.openApi?.editor ?? app()?.editor ?? app()
  const roots = () => {
    const e = editor(); const out = []
    for (const value of [e?.presentation, e?.Presentation, e?.slides, e?.Slides, e]) if (value && !out.includes(value)) out.push(value)
    return out
  }
  const methodName = (target, names) => names.find((name) => target && typeof target[name] === 'function' && typeof target[name]?.then !== 'function')
  // Public WPS command proxies are callable and thenable at the same time.
  // Keep read probing strict so awaitable properties are never invoked, but
  // accept thenable functions for explicit, allowlisted command names.
  const callableName = (target, names) => names.find((name) => target && typeof target[name] === 'function')
  // The live WebEdit proxies expose shape-creation commands as thenable
  // functions, but their public parameter/result contract does not produce a
  // Verified Write. Keep those commands fail-closed until a concrete shape API
  // can be read back exactly.
  const verifiedShapeMethodName = (target, names) => methodName(target, names)
  const addSlideMethods = ['AddSlide', 'Add']
  const addTextBoxMethods = ['AddTextbox', 'AddTextBox']
  const addTableMethods = ['InsertTable', 'AddTable']
  const addChartMethods = ['InsertChart', 'AddChart']
  const MAX_SLIDE_VISUAL_SVG_CHARS = 100000
  const propertyName = (target, names) => names.find((name) => {
    if (!target) return false
    try { return name in Object(target) }
    catch { return Object.prototype.hasOwnProperty.call(target, name) }
  })
  const method = (target, names) => { const name = methodName(target, names); return name ? { name, target } : null }
  const read = async (target, names) => { const m = method(target, names); return m ? call(m.target, m.name) : undefined }
  const readAny = async (target, names) => {
    const value = await read(target, names); if (value !== undefined) return value
    const name = propertyName(target, names); return name ? prop(target, name) : undefined
  }
  // WPS's public proxy intentionally exposes several awaitable properties as
  // functions.  Calling those functions throws; always read them as properties.
  const awaitableProperty = async (target, name) => prop(target, name)
  const readPropertyAny = async (target, names) => {
    for (const name of names) {
      if (propertyName(target, [name])) {
        const value = await awaitableProperty(target, name)
        if (value !== undefined) return value
      }
    }
    return undefined
  }
  const slideIdentity = async (slide) => await readPropertyAny(slide, ['SlideID', 'SlideID2', 'Id', 'id'])
    ?? await read(slide, ['GetSlideID', 'getSlideID', 'GetId', 'getId']) ?? null
  const locateSlideIndex = async (slides, slide, publicSlideIndex) => {
    if (slide) {
      const byReference = slides.indexOf(slide); if (byReference >= 0) return byReference
      const id = await slideIdentity(slide)
      if (id !== null) {
        for (let index = 0; index < slides.length; index += 1) if (await slideIdentity(slides[index]) === id) return index
      }
    }
    // PowerPoint SlideShowView.SlideIndex is one-based.
    if (Number.isInteger(publicSlideIndex) && publicSlideIndex >= 1 && publicSlideIndex <= slides.length) return publicSlideIndex - 1
    return undefined
  }
  const publicSlideShowState = async (presentation, slides) => {
    const slideShowWindow = await awaitableProperty(presentation, 'SlideShowWindow')
    const view = await awaitableProperty(slideShowWindow, 'View')
    if (!view) return null
    const slide = await awaitableProperty(view, 'Slide')
    const publicSlideIndex = Number(await awaitableProperty(view, 'SlideIndex'))
    const index = await locateSlideIndex(slides, slide, publicSlideIndex)
    const resolvedSlide = Number.isInteger(index) ? (slides[index] ?? slide) : slide
    return resolvedSlide && Number.isInteger(index) ? { slide: resolvedSlide, index, source: 'SlideShowWindow.View' } : null
  }
  const currentSlideStateFor = async (presentation, slides, isPublic) => {
    if (isPublic) {
      const slideShow = await publicSlideShowState(presentation, slides)
      if (slideShow) return slideShow
      const slide = await awaitableProperty(presentation, 'CurrentSlide') ?? await awaitableProperty(presentation, 'ActiveSlide')
      const index = await locateSlideIndex(slides, slide)
      return slide && Number.isInteger(index) ? { slide, index, source: 'presentation property' } : null
    }
    const slide = await readAny(presentation, ['getCurrentSlide', 'GetCurrentSlide', 'CurrentSlide', 'activeSlide', 'ActiveSlide'])
    const index = await locateSlideIndex(slides, slide)
    return slide && Number.isInteger(index) ? { slide, index, source: 'legacy current slide' } : null
  }
  const typeOf = (value) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  const serial = (value, depth = 0, seen = new Set()) => {
    if (depth > 3 || value === null || ['string', 'number', 'boolean'].includes(typeOf(value))) return value
    if (typeof value === 'undefined') return undefined
    if (seen.has(value)) return '[Circular]'; seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => serial(item, depth + 1, seen))
    const out = {}; for (const key of Object.keys(value).slice(0, 80)) { try { const v = value[key]; if (typeof v !== 'function') out[key] = serial(v, depth + 1, seen) } catch {} }
    return out
  }
  const list = async (target, names) => {
    const value = await readAny(target, names)
    if (Array.isArray(value)) return value
    if (value && typeof value[Symbol.iterator] === 'function') return [...value]
    const count = Number(await readAny(value, ['getCount', 'GetCount', 'Count']))
    if (Number.isInteger(count) && count >= 0 && count < 10000) {
      const out = []; for (let index = 0; index < count; index += 1) out.push(await call(value, 'getItem', [index]) ?? await call(value, 'GetItem', [index]) ?? await call(value, 'Item', [index + 1]))
      return out.filter(Boolean)
    }
    return value ? [value] : []
  }
  const listProperty = async (target, name) => {
    const value = await awaitableProperty(target, name)
    if (Array.isArray(value)) return value
    if (value && typeof value[Symbol.iterator] === 'function') return [...value]
    const count = Number(await readAny(value, ['getCount', 'GetCount', 'Count']))
    if (Number.isInteger(count) && count >= 0 && count < 10000) {
      const out = []; for (let index = 0; index < count; index += 1) out.push(await call(value, 'getItem', [index]) ?? await call(value, 'GetItem', [index]) ?? await call(value, 'Item', [index + 1]))
      return out.filter(Boolean)
    }
    return value ? [value] : []
  }
  const publicPresentation = async () => {
    const api = globalThis.WPSOpenApi?.Application
    // ActivePresentation is an awaitable property in the real WPS proxy. It
    // must never be invoked as ActivePresentation(), which throws in WebEdit.
    return api ? await awaitableProperty(api, 'ActivePresentation') : undefined
  }
  const root = async () => {
    const publicRoot = await publicPresentation()
    if (publicRoot) {
      const slides = await listProperty(publicRoot, 'Slides')
      const currentState = await currentSlideStateFor(publicRoot, slides, true)
      // A brand-new public WPS presentation legitimately has no slide yet.
      // Its Slides collection can still expose AddSlide, so treating it as an
      // unavailable document prevents the first Verified Write.
      return { root: publicRoot, slides, current: currentState?.slide, currentIndex: currentState?.index, public: true }
    }
    for (const candidate of roots()) {
      const slides = await list(candidate, ['getSlides', 'GetSlides', 'slides', 'Slides', 'getSlideCollection'])
      const currentState = await currentSlideStateFor(candidate, slides, false)
      if (slides.length || currentState) return { root: candidate, slides, current: currentState?.slide, currentIndex: currentState?.index }
    }
    return null
  }
  const identity = async (r) => {
    const name = await readAny(r?.root ?? app(), ['getName', 'Name', 'getDocumentName', 'DocumentName']) ?? await readAny(app(), ['getName', 'Name', 'getDocumentName', 'DocumentName'])
    const id = await readAny(r?.root, ['getId', 'GetId', 'Id', 'getDocumentId', 'DocumentId'])
    const presentationName = typeof name === 'string' ? name : null
    return { kind: 'webedit_presentation', origin: location.origin, presentationName, documentName: presentationName, path: location.pathname, documentId: id ?? null }
  }
  const fingerprint = async (r) => {
    const explicit = await readAny(r?.root, ['getFingerprint', 'GetFingerprint', 'fingerprint', 'Fingerprint'])
    if (typeof explicit === 'string' && explicit) return explicit
    const i = await identity(r); const count = r?.slides?.length ?? 0; const currentState = r ? await currentSlideStateFor(r.root, r.slides, r.public === true) : null
    const current = await slideIdentity(currentState?.slide)
    return `webedit:${i.origin}${i.path}|${i.documentId ?? i.documentName ?? ''}|${count}|${current ?? ''}`
  }
  const resource = async (r) => ({ ...(await identity(r)), slideCount: r?.slides?.length || (r?.current ? 1 : 0), fingerprint: await fingerprint(r) })
  const bounds = async (item) => {
    const value = await readAny(item, ['getBounds', 'GetBounds', 'bounds', 'Bounds'])
    const rotation = await readAny(item, ['getRotation', 'GetRotation', 'rotation', 'Rotation'])
    if (value) {
      const result = serial(value)
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const observedRotation = rotation ?? result.rotation ?? result.Rotation
        const normalized = {}
        for (const [key, aliases] of Object.entries({ x: ['x', 'X', 'left', 'Left'], y: ['y', 'Y', 'top', 'Top'], width: ['width', 'Width'], height: ['height', 'Height'] })) {
          const alias = aliases.find((name) => result[name] !== undefined)
          if (alias) normalized[key] = result[alias]
        }
        return { ...result, ...normalized, ...(observedRotation === undefined ? {} : { rotation: observedRotation }) }
      }
      return result
    }
    const out = {}; for (const [key, names] of Object.entries({ x: ['getX', 'GetX', 'x', 'X', 'Left'], y: ['getY', 'GetY', 'y', 'Y', 'Top'], width: ['getWidth', 'GetWidth', 'width', 'Width'], height: ['getHeight', 'GetHeight', 'height', 'Height'], rotation: ['getRotation', 'GetRotation', 'rotation', 'Rotation'] })) { const v = await readAny(item, names); if (v !== undefined) out[key] = v }
    return Object.keys(out).length ? out : null
  }
  const objectText = async (item) => {
    const direct = await readAny(item, ['getText', 'GetText', 'text', 'Text', 'getTextContent', 'TextContent'])
    if (direct !== undefined) return typeof direct === 'string' ? direct : serial(direct)
    const frame = await awaitableProperty(item, 'TextFrame') ?? await readAny(item, ['getTextFrame', 'GetTextFrame'])
    const range = await awaitableProperty(frame, 'TextRange') ?? await readAny(frame, ['getTextRange', 'GetTextRange'])
    const value = await readAny(range, ['Text', 'getText', 'GetText'])
    return value === undefined ? null : value
  }
  const textRangeFor = async (shape) => {
    const frame = await awaitableProperty(shape, 'TextFrame') ?? await readAny(shape, ['getTextFrame', 'GetTextFrame'])
    return await awaitableProperty(frame, 'TextRange') ?? await readAny(frame, ['getTextRange', 'GetTextRange'])
  }
  // WPS object IDs are only safe identity keys when they are bounded strings
  // or positive safe integers.  In particular, empty strings and zero must
  // never turn into a permissive "truthy/falsy" delete verification branch.
  const stableObjectIdentity = (value) => (typeof value === 'string' && value.trim().length > 0 && value.length <= 512)
    || (Number.isSafeInteger(value) && value > 0)
  const objectIdentity = async (item) => {
    const value = await readAny(item, ['getId', 'GetId', 'Id', 'getObjectId', 'ObjectId'])
    return stableObjectIdentity(value) ? value : null
  }
  const sameObject = async (left, right) => {
    if (left === right) return true
    const leftId = await objectIdentity(left); const rightId = await objectIdentity(right)
    return leftId !== null && rightId !== null && leftId === rightId
  }
  const containsObject = async (items, target) => {
    for (const item of items) if (await sameObject(item, target)) return true
    return false
  }
  const newObjects = async (after, before) => {
    const out = []
    for (const item of after) if (!await containsObject(before, item)) out.push(item)
    return out
  }
  const countOf = async (value) => {
    const direct = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
    if (Number.isInteger(direct) && direct >= 0) return direct
    if (Array.isArray(value)) return value.length
    const count = Number(await readAny(value, ['Count', 'count', 'getCount', 'GetCount']))
    return Number.isInteger(count) && count >= 0 ? count : null
  }
  const tableDetails = async (item) => {
    const table = await awaitableProperty(item, 'Table') ?? await readAny(item, ['getTable', 'GetTable', 'table'])
    const directRows = await readAny(item, ['getRowCount', 'GetRowCount', 'RowCount', 'rowCount', 'rows'])
    const directColumns = await readAny(item, ['getColumnCount', 'GetColumnCount', 'ColumnCount', 'columnCount', 'columns'])
    const rows = await countOf(directRows) ?? await countOf(await readAny(table, ['Rows', 'rows', 'getRows', 'GetRows']))
    const columns = await countOf(directColumns) ?? await countOf(await readAny(table, ['Columns', 'columns', 'getColumns', 'GetColumns']))
    return rows === null && columns === null ? null : { rows, columns }
  }
  const chartTypeFor = async (item) => {
    const direct = await readAny(item, ['ChartType', 'chartType', 'getChartType', 'GetChartType'])
    if (direct !== undefined) return direct
    const chart = await awaitableProperty(item, 'Chart') ?? await readAny(item, ['getChart', 'GetChart'])
    return await readAny(chart, ['ChartType', 'chartType', 'Type', 'type', 'getChartType', 'GetChartType'])
  }
  const chartStyleFor = async (item) => {
    const direct = await readAny(item, ['ChartStyle', 'chartStyle', 'getChartStyle', 'GetChartStyle'])
    if (direct !== undefined) return direct
    const chart = await awaitableProperty(item, 'Chart') ?? await readAny(item, ['getChart', 'GetChart'])
    return await readAny(chart, ['ChartStyle', 'chartStyle', 'Style', 'style', 'getChartStyle', 'GetChartStyle'])
  }
  const imageFileFor = async (item) => {
    const direct = await readAny(item, ['FileName', 'fileName', 'SourceFullName', 'sourceFullName'])
    if (typeof direct === 'string' && direct) return direct
    const link = await awaitableProperty(item, 'LinkFormat') ?? await readAny(item, ['getLinkFormat', 'GetLinkFormat'])
    const linked = await readAny(link, ['SourceFullName', 'sourceFullName', 'FileName', 'fileName'])
    return typeof linked === 'string' && linked ? linked : null
  }
  const objectSummary = async (item, index) => {
    const table = await tableDetails(item); const chartType = await chartTypeFor(item); const chartStyle = await chartStyleFor(item); const fileName = await imageFileFor(item)
    return {
      index,
      id: await objectIdentity(item),
      type: await readAny(item, ['getType', 'GetType', 'type', 'Type', 'getClassType', 'ClassType']) ?? null,
      text: await objectText(item),
      bounds: await bounds(item),
      hasTextFrame: await readAny(item, ['HasTextFrame', 'hasTextFrame']) ?? null,
      ...(table === null ? {} : { table }),
      ...(chartType === undefined ? {} : { chartType }),
      ...(chartStyle === undefined ? {} : { chartStyle }),
      ...(fileName === null ? {} : { fileName }),
    }
  }
  const slideSummary = async (slide, index) => {
    const items = await list(slide, ['getObjects', 'GetObjects', 'objects', 'Objects', 'getShapes', 'Shapes', 'getDrawings'])
    return { index, id: await slideIdentity(slide), objectCount: items.length, objects: await Promise.all(items.map(objectSummary)) }
  }
  const shapeCollection = async (slide) => {
    const publicShapes = await awaitableProperty(slide, 'Shapes')
    return publicShapes ?? await readAny(slide, ['getShapes', 'getObjects', 'Objects'])
  }
  const shapesOn = async (slide) => {
    const value = await shapeCollection(slide)
    if (Array.isArray(value)) return value
    if (value && typeof value[Symbol.iterator] === 'function') return [...value]
    const count = Number(await readAny(value, ['Count', 'getCount', 'GetCount']))
    if (!Number.isInteger(count) || count < 0 || count >= 10000) return value ? [value] : []
    const out = []; for (let index = 0; index < count; index += 1) out.push(await call(value, 'Item', [index + 1]) ?? await call(value, 'getItem', [index]) ?? await call(value, 'GetItem', [index]))
    return out.filter(Boolean)
  }
  const tableSummary = async (slide) => {
    const shapes = await shapesOn(slide); const tables = []
    for (let index = 0; index < shapes.length; index += 1) {
      const shape = shapes[index]; const summary = await objectSummary(shape, index)
      if (await readAny(shape, ['HasTableFrame', 'hasTableFrame']) || summary.table !== undefined || String(summary.type ?? '').toLowerCase().includes('table')) tables.push(summary)
    }
    return tables
  }
  const chartSummary = async (slide) => {
    const shapes = await shapesOn(slide); const charts = []
    for (let index = 0; index < shapes.length; index += 1) {
      const summary = await objectSummary(shapes[index], index)
      const type = String(summary.type ?? '').toLowerCase()
      if (type.includes('chart') || await readAny(shapes[index], ['Chart', 'HasChart', 'hasChart'])) charts.push(summary)
    }
    return charts
  }
  const notesPage = async (slide) => await awaitableProperty(slide, 'NotesPage') ?? await readAny(slide, ['getNotesPage', 'GetNotesPage'])
  const notesTextShape = async (slide) => {
    const page = await notesPage(slide)
    return await awaitableProperty(page, 'TextShape') ?? await readAny(page, ['textShape'])
  }
  const notesSnapshot = async (slide) => {
    const shape = await notesTextShape(slide)
    return shape ? { text: await objectText(shape), shape: await objectSummary(shape, 0) } : null
  }
  const commentsOn = async (slide) => await awaitableProperty(slide, 'Comments') ?? await readAny(slide, ['getComments', 'GetComments'])
  const commentSummary = async (slide) => {
    const comments = await commentsOn(slide); const items = await list({ Comments: comments }, ['Comments'])
    const slideId = await slideIdentity(slide)
    return Promise.all(items.map(async (item, index) => ({
      index, slideId, id: await readAny(item, ['Id', 'id']) ?? null,
      text: await readAny(item, ['Text', 'text', 'Content', 'content']) ?? null,
      author: await readAny(item, ['Author', 'author', 'Replyer', 'replyer']) ?? null,
    })))
  }
  const documentProperty = async (r, name) => {
    if (typeof name !== 'string' || !name) return null
    const props = method(r.root, ['BuiltinDocumentProperties'])
    return props ? call(props.target, props.name, [name]) : null
  }
  const metadataSnapshot = async (r, payload) => {
    const property = await documentProperty(r, payload.name)
    return property ? { name: payload.name, value: await readAny(property, ['Value', 'value']) } : null
  }
  const structureSnapshot = async (r) => Promise.all(r.slides.map(async (slide, index) => ({ index, id: await slideIdentity(slide) })))
  const sectionsOn = async (r) => await prop(r.root, 'Sections')
  const sectionsSnapshot = async (r) => {
    const sections = await sectionsOn(r); const all = await readAny(sections, ['GetAllSections', 'getAllSections'])
    const items = Array.isArray(all) ? all : await list({ Sections: all ?? sections }, ['Sections'])
    return Promise.all(items.map(async (item, index) => ({ index, id: await readAny(item, ['Id', 'id', 'SectionId']) ?? null, name: await readAny(item, ['Name', 'name', 'SectionName']) ?? null })))
  }
  const operationSnapshot = async (r, operation, payload) => {
    if (operation === 'manage_metadata') return metadataSnapshot(r, payload)
    if (operation === 'manage_structure' || operation === 'manage_slides') return operation === 'manage_structure' && payload.action === 'move_section' ? sectionsSnapshot(r) : structureSnapshot(r)
    if (operation === 'save') return null
    const index = slideIndexOf(payload); const slide = slideAt(r, index)
    if (!slide) return null
    if (operation === 'manage_tables') return tableSummary(slide)
    if (operation === 'manage_charts') return chartSummary(slide)
    if (operation === 'manage_notes') return notesSnapshot(slide)
    if (operation === 'manage_comments') return commentSummary(slide)
    if (operation === 'render_scene' || operation === 'render_slide_visual') return slideSummary(slide, index)
    return null
  }
  const context = async (r, requestedIndex) => {
    if (requestedIndex !== undefined && (!Number.isInteger(requestedIndex) || requestedIndex < 0)) return fail('invalid_request', 'slideIndex must be a non-negative integer')
    const currentState = requestedIndex === undefined ? await currentSlideStateFor(r.root, r.slides, r.public === true) : null
    const index = requestedIndex === undefined ? currentState?.index : requestedIndex
    const slide = requestedIndex === undefined ? currentState?.slide : r.slides[requestedIndex]
    if (!slide || !Number.isInteger(index)) return requestedIndex === undefined
      ? fail('unsupported', 'WebEdit presentation does not expose the current slide through SlideShowWindow.View or a compatible current-slide API')
      : fail('invalid_request', 'slideIndex does not identify an existing slide')
    const all = await slideSummary(slide, index)
    return { currentSlide: index, slideCount: r.slides.length || (r.current ? 1 : 0), ...all, resource: await resource(r) }
  }
  const capabilities = async () => {
    const r = await root(); if (!r) return { ready: false, capabilities: {}, methods: [] }
    const checks = {
      slides: ['getSlides', 'GetSlides', 'addSlide', 'AddSlide', 'deleteSlide', 'DeleteSlide'],
      context: ['getCurrentSlide', 'GetCurrentSlide'], objects: ['getObjects', 'GetObjects', 'getShapes', 'Shapes'],
      selection: ['getSelection', 'GetSelection', 'getSelectedObjects'], text: ['getText', 'GetText', 'setText', 'SetText'],
      save: ['save', 'Save', 'saveAs', 'SaveAs'],
      tables: ['getTables', 'GetTables', 'addTable', 'AddTable'], charts: ['getCharts', 'GetCharts', 'addChart', 'AddChart'],
      notes: ['getNotes', 'GetNotes', 'setNotes', 'SetNotes'], comments: ['getComments', 'GetComments', 'addComment', 'AddComment'],
      metadata: ['getMetadata', 'GetMetadata', 'setMetadata', 'SetMetadata'], structure: ['getMasters', 'GetMasters', 'getLayouts', 'GetLayouts'],
    }
    const methods = []; const result = {}
    for (const [name, candidates] of Object.entries(checks)) { const found = [r.root, ...roots()].flatMap((x) => candidates.filter((candidate) => typeof x?.[candidate] === 'function')); result[name] = found.length > 0; methods.push(...found.map((method) => `${name}:${method}`)) }
    const currentSlide = slideAt(r, 0); const shapes = currentSlide ? await shapeCollection(currentSlide) : null
    const notes = currentSlide ? await notesTextShape(currentSlide) : null; const comments = currentSlide ? await commentsOn(currentSlide) : null; const sections = await sectionsOn(r)
    const addMethod = (capability, target, candidates, prefix, resolver = callableName) => { const name = resolver(target, candidates); if (name) { result[capability] = true; methods.push(`${capability}:${prefix}.${name}`) } }
    addMethod('tables', shapes, addTableMethods, 'Shapes', verifiedShapeMethodName)
    addMethod('charts', shapes, addChartMethods, 'Shapes', verifiedShapeMethodName)
    if (notes && await awaitableProperty(notes, 'TextFrame')) { result.notes = true; methods.push('notes:NotesPage.TextShape.TextFrame') }
    addMethod('comments', comments, ['Add'], 'Comments')
    addMethod('metadata', r.root, ['BuiltinDocumentProperties'], 'Presentation')
    addMethod('structure', sections, ['Move'], 'Sections')
    addMethod('render_scene', shapes, [...addTextBoxMethods, 'AddPicture', ...addTableMethods, ...addChartMethods], 'Shapes', verifiedShapeMethodName)
    result.selection = result.selection || Boolean(await readAny(r.root, ['getSelection', 'Selection', 'GetSelection']))
    result.text = result.text || Boolean(r.slides.some((slide) => slide && (slide.Shapes || slide.getShapes)))
    result.save = result.save || typeof globalThis.WPSOpenApi?.save === 'function'
    // The raw API may expose an Export/Download-looking function, but it has
    // no discovered artifact identity/readback contract.  Do not advertise a
    // model capability until a real WPS export can be verified end-to-end.
    result.export = false
    const operations = await writeCapabilities(r)
    return { ready: true, capabilities: result, methods, operations, resource: await resource(r) }
  }
  const selectionRoot = (r) => globalThis.APP?._pres ?? r.root
  const selectionValue = async (r) => await readAny(selectionRoot(r), ['getSelection', 'Selection', 'GetSelection', 'getSelectedObjects'])
  const selectionShape = (value) => Array.isArray(value) ? value[0] : value?.shape ?? value?.Shape ?? value
  const slideIndexOf = (payload = {}) => Number.isInteger(payload.slideIndex) ? payload.slideIndex : Number.isInteger(payload.target?.slideIndex) ? payload.target.slideIndex : undefined
  const objectIndexOf = (payload = {}) => Number.isInteger(payload.objectIndex) ? payload.objectIndex : Number.isInteger(payload.target?.objectIndex) ? payload.target.objectIndex : undefined
  const textBoxIndexOf = (payload = {}) => Number.isInteger(payload.textBoxIndex) ? payload.textBoxIndex : Number.isInteger(payload.target?.textBoxIndex) ? payload.target.textBoxIndex : undefined
  const activeSlideState = async (r) => currentSlideStateFor(r.root, r.slides, r.public === true)
  const activeSlide = async (r) => (await activeSlideState(r))?.slide
  const activeSlideSnapshot = async (r) => {
    const state = await activeSlideState(r)
    return state ? { index: state.index, id: await slideIdentity(state.slide) } : null
  }
  const slidesCollection = async (r) => await awaitableProperty(r.root, 'Slides')
  const targetSnapshot = async (r, payload = {}) => {
    const target = await shapeAt(r, payload)
    if (!target?.shape) return null
    return await objectSummary(target.shape, target.index)
  }
  const selectionSnapshot = async (r) => {
    const selected = await selectionValue(r); const shape = selectionShape(selected)
    return { selection: serial(selected), selectedShape: shape ? await objectSummary(shape, 0) : null, selectionFingerprint: await readAny(selectionRoot(r), ['getSelectionFingerprint', 'SelectionFingerprint']) ?? null }
  }
  const targetSnapshotFor = async (r, operation, payload) => operation === 'edit_selection' ? (await selectionSnapshot(r)).selectedShape : await targetSnapshot(r, payload)
  const precondition = async (r, operation, payload = {}) => {
    const targetIndex = slideIndexOf(payload); const active = await activeSlideSnapshot(r)
    const slide = slideAt(r, targetIndex)
    // Scene replacement snapshots the whole target slide. Reuse that bounded
    // snapshot as operationState; reading every WPS shape twice can exceed the
    // preview deadline even though no mutation has started.
    const slideSnapshot = slide ? await slideSummary(slide, targetIndex) : null
    const replacesWholeSlide = operation === 'render_scene' || operation === 'render_slide_visual'
    return {
      resourceFingerprint: await fingerprint(r), slideCount: r.slides.length || (r.current ? 1 : 0),
      currentSlide: targetIndex ?? active?.index ?? null,
      activeSlide: active,
      slide: slideSnapshot,
      target: await targetSnapshotFor(r, operation, payload),
      selection: operation === 'edit_selection' ? await selectionSnapshot(r) : null,
      operationState: replacesWholeSlide ? slideSnapshot : await operationSnapshot(r, operation, payload),
      operation,
    }
  }
  const validRect = (value) => object(value) && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(value[key]))
  // Keep visual scenes self-contained: no executable SVG, remote URL, object
  // URL, or external asset reference can cross the Connector boundary.
  const safeSlideVisualSvg = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SLIDE_VISUAL_SVG_CHARS) return false
    const source = value.trim()
    if (!/^<svg(?:\s|>)/i.test(source) || !/<\/svg>\s*$/i.test(source)) return false
    return !/(?:<!|<\s*\/?\s*(?:script|foreignObject|iframe|object|embed|audio|video|image|animate(?:Motion|Transform)?|set)\b|\bon[a-z]+\s*=|\bjavascript\s*:|<\s*style\b|@import\b|\bhref\s*=|\burl\s*\(\s*['\"]?\s*(?!#))/i.test(source)
  }
  const utf8ByteLength = (value) => { try { return unescape(encodeURIComponent(value)).length } catch { return null } }
  const slideVisualHash = (value) => {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
    return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const base64Utf8 = (value) => {
    const bytes = unescape(encodeURIComponent(value)); const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let output = ''
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes.charCodeAt(index); const second = index + 1 < bytes.length ? bytes.charCodeAt(index + 1) : NaN; const third = index + 2 < bytes.length ? bytes.charCodeAt(index + 2) : NaN
      output += alphabet[first >> 2] + alphabet[((first & 3) << 4) | (Number.isNaN(second) ? 0 : second >> 4)] + (Number.isNaN(second) ? '=' : alphabet[((second & 15) << 2) | (Number.isNaN(third) ? 0 : third >> 6)]) + (Number.isNaN(third) ? '=' : alphabet[third & 63])
    }
    return output
  }
  const slideVisualData = (svg) => {
    if (!safeSlideVisualSvg(svg)) return null
    const byteLength = utf8ByteLength(svg); if (!Number.isInteger(byteLength) || byteLength <= 0) return null
    try { return { fileName: `data:image/svg+xml;base64,${base64Utf8(svg)}`, summary: { format: 'image/svg+xml', byteLength, hash: slideVisualHash(svg) } } } catch { return null }
  }
  const CHART_TYPE_BY_NAME = Object.freeze({ area: 1, barClustered: 57, columnClustered: 51, doughnut: -4120, line: 4, pie: 5, radar: -4151, scatter: -4169 })
  const CHART_TYPE_VALUES = new Set(Object.values(CHART_TYPE_BY_NAME))
  const normalizedChartType = (value) => {
    if (Number.isFinite(value)) return CHART_TYPE_VALUES.has(value) ? value : undefined
    if (typeof value !== 'string' || !value.trim()) return undefined
    const text = value.trim()
    if (Object.hasOwn(CHART_TYPE_BY_NAME, text)) return CHART_TYPE_BY_NAME[text]
    if (/^[+-]?\d+$/.test(text)) { const number = Number(text); return CHART_TYPE_VALUES.has(number) ? number : undefined }
    return undefined
  }
  const editFields = ['x', 'y', 'width', 'height', 'rotation']
  const presentationPayloadFields = {
    'manage_slides:add': ['action', 'index'], 'manage_slides:delete': ['action', 'slideIndex'], 'manage_slides:select': ['action', 'slideIndex'],
    'render_scene:replace_scene': ['action', 'slideIndex', 'elements'], 'render_slide_visual:replace_visual': ['action', 'slideIndex', 'svg', 'left', 'top', 'width', 'height'], 'edit_selection:update': ['action', 'slideIndex', 'edit'],
    'manage_objects:delete': ['action', 'slideIndex', 'objectIndex'], 'manage_objects:update': ['action', 'slideIndex', 'objectIndex', 'object'],
    'manage_tables:insert': ['action', 'slideIndex', 'rows', 'columns', 'left', 'top', 'width', 'height'],
    'manage_charts:insert': ['action', 'slideIndex', 'chartType', 'left', 'top', 'width', 'height'],
    'manage_notes:replace': ['action', 'slideIndex', 'text'], 'manage_comments:add': ['action', 'slideIndex', 'text', 'replyer', 'slideId'],
    'manage_metadata:set_builtin': ['action', 'name', 'value'], 'manage_structure:move_slide': ['action', 'slideIndex', 'toIndex'],
    'manage_structure:move_section': ['action', 'sectionIndex', 'toPos'], 'replace_text_box:replace': ['action', 'slideIndex', 'textBoxIndex', 'text'],
    'save:save': ['action'],
  }
  const hasOnlyPresentationPayloadFields = (operation, payload) => {
    const allowed = presentationPayloadFields[`${operation}:${payload?.action}`]
    return Array.isArray(allowed) && Object.keys(payload).every((key) => allowed.includes(key))
  }
  const hasOnlyNestedFields = (value, fields) => object(value) && Object.keys(value).every((key) => fields.includes(key))
  const hasEffect = (value, fields) => fields.some((key) => value[key] !== undefined)
  const validReplyer = (value) => value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 256) || (Number.isSafeInteger(value) && value >= 0)
  const sceneElementHasOnlyVerifiedFields = (element) => {
    const base = ['type', 'left', 'top', 'width', 'height']
    const allowed = element.type === 'text' ? [...base, 'text']
      : element.type === 'image' ? [...base, 'fileName']
        : element.type === 'table' ? [...base, 'rows', 'columns']
          : element.type === 'chart' ? [...base, 'chartType'] : []
    return allowed.length > 0 && Object.keys(element).every((key) => allowed.includes(key))
  }
  const supportsSceneElement = async (slide, element) => {
    const shapes = await shapeCollection(slide)
    if (!object(element) || !validRect(element)) return 'element with finite left/top/width/height'
    if (element.type === 'text') return typeof element.text === 'string' && verifiedShapeMethodName(shapes, addTextBoxMethods) ? null : 'verified Shapes.AddTextbox/AddTextBox(text)'
    if (element.type === 'table') return Number.isInteger(element.rows) && element.rows > 0 && Number.isInteger(element.columns) && element.columns > 0 && verifiedShapeMethodName(shapes, addTableMethods) ? null : 'verified Shapes.InsertTable/AddTable(rows, columns)'
    if (element.type === 'chart') return normalizedChartType(element.chartType) !== undefined && verifiedShapeMethodName(shapes, addChartMethods) ? null : 'verified Shapes.InsertChart/AddChart(chartType)'
    if (element.type === 'image') return typeof element.fileName === 'string' && element.fileName && callableName(shapes, ['AddPicture']) ? null : 'Shapes.AddPicture(fileName)'
    return `scene element ${String(element.type)}`
  }
  const writeCapabilities = async (r) => {
    const slide = slideAt(r, 0); const shapes = slide ? await shapeCollection(slide) : null
    const current = slide ? await notesTextShape(slide) : null
    const comments = slide ? await commentsOn(slide) : null
    const selected = selectionShape(await selectionValue(r)); const selectionEdit = selected && ['Left', 'Top', 'Width', 'Height', 'Rotation', 'left', 'top', 'width', 'height'].some((name) => propertyName(selected, [name]))
    const firstShape = (await shapesOn(slide))[0]; const slideActions = []
    if (typeof slide?.Delete === 'function') slideActions.push('delete')
    if (typeof slide?.Select === 'function') slideActions.push('select')
    if (callableName(await slidesCollection(r), addSlideMethods)) slideActions.push('add')
    return {
      replace_text_box: { actions: propertyName(await textRangeFor((await shapeAt(r, { slideIndex: 0, textBoxIndex: 0 }))?.shape), ['Text']) ? ['replace'] : [] },
      edit_selection: { actions: selectionEdit ? ['update'] : [] },
      manage_objects: { actions: [...(typeof firstShape?.Delete === 'function' ? ['delete'] : []), ...(['Left', 'Top', 'Width', 'Height', 'Rotation'].some((name) => propertyName(firstShape, [name])) ? ['update'] : [])] },
      manage_slides: { actions: slideActions },
      save: { actions: callableName(typeof globalThis.WPSOpenApi?.save === 'function' ? globalThis.WPSOpenApi : r.root, ['save', 'Save', 'saveAs', 'SaveAs']) ? ['save'] : [] },
      manage_tables: { actions: verifiedShapeMethodName(shapes, addTableMethods) ? ['insert'] : [] },
      manage_charts: { actions: verifiedShapeMethodName(shapes, addChartMethods) ? ['insert'] : [] },
      manage_notes: { actions: current ? ['replace'] : [] },
      manage_comments: { actions: callableName(comments, ['Add']) ? ['add'] : [] },
      manage_metadata: { actions: callableName(r.root, ['BuiltinDocumentProperties']) ? ['set_builtin'] : [] },
      manage_structure: { actions: [...(typeof slide?.MoveTo === 'function' ? ['move_slide'] : []), ...(callableName(await sectionsOn(r), ['Move']) ? ['move_section'] : [])] },
      render_scene: { actions: verifiedShapeMethodName(shapes, [...addTextBoxMethods, 'AddPicture', ...addTableMethods, ...addChartMethods]) ? ['replace_scene'] : [] },
      render_slide_visual: { actions: callableName(shapes, ['AddPicture']) ? ['replace_visual'] : [] },
    }
  }
  const supportedWrite = async (r, operation, payload = {}) => {
    if (!['replace_text_box', 'edit_selection', 'manage_objects', 'manage_slides', 'save'].includes(operation) && !['manage_tables', 'manage_charts', 'manage_notes', 'manage_comments', 'manage_metadata', 'manage_structure', 'render_scene', 'render_slide_visual'].includes(operation)) return unsupported(operation)
    if (!hasOnlyPresentationPayloadFields(operation, payload)) return fail('invalid_request', `${operation} payload contains unsupported fields for action ${String(payload.action)}`)
    const index = slideIndexOf(payload); const slide = slideAt(r, index)
    const requiresSlide = ['replace_text_box', 'edit_selection', 'manage_objects', 'manage_tables', 'manage_charts', 'manage_notes', 'manage_comments', 'render_scene', 'render_slide_visual'].includes(operation)
      || (operation === 'manage_slides' && payload.action !== 'add') || (operation === 'manage_structure' && payload.action === 'move_slide')
    if (requiresSlide && (!Number.isInteger(index) || index < 0)) return fail('invalid_request', `${operation} requires a non-negative slideIndex`)
    if (requiresSlide && !slide) return fail('invalid_request', `${operation} slideIndex does not identify an existing slide`)
    if (operation === 'replace_text_box' && (!Number.isInteger(textBoxIndexOf(payload)) || textBoxIndexOf(payload) < 0)) return fail('invalid_request', 'replace_text_box requires a non-negative textBoxIndex')
    if (operation === 'manage_objects' && (!Number.isInteger(objectIndexOf(payload)) || objectIndexOf(payload) < 0)) return fail('invalid_request', 'manage_objects requires a non-negative objectIndex')
    if (operation === 'manage_tables') {
      if (payload.action !== 'insert' || !Number.isInteger(payload.rows) || payload.rows < 1 || !Number.isInteger(payload.columns) || payload.columns < 1 || !validRect(payload)) return fail('invalid_request', 'manage_tables insert requires rows, columns, left, top, width, and height')
      if (payload.useScale !== undefined) return unsupported('readable table useScale verification')
      if (!verifiedShapeMethodName(await shapeCollection(slide), addTableMethods)) return unsupported('verified Shapes.InsertTable/AddTable')
    }
    if (operation === 'manage_charts') {
      if (payload.action !== 'insert' || normalizedChartType(payload.chartType) === undefined || !validRect(payload)) return fail('invalid_request', 'manage_charts insert requires chartType, left, top, width, and height')
      // WPS exposes ChartType reliably, but chart style is not uniformly
      // readable.  Never approve a style which cannot be Verified Write read
      // back as the requested value.
      if (payload.chartStyle !== undefined) return unsupported('readable chartStyle verification')
      if (!verifiedShapeMethodName(await shapeCollection(slide), addChartMethods)) return unsupported('verified Shapes.InsertChart/AddChart')
    }
    if (operation === 'manage_notes') {
      if (payload.action !== 'replace' || typeof payload.text !== 'string') return fail('invalid_request', 'manage_notes replace requires text')
      const shape = await notesTextShape(slide); const range = await textRangeFor(shape)
      if (!range || !propertyName(range, ['Text'])) return unsupported('NotesPage.TextShape.TextFrame.TextRange.Text')
    }
    if (operation === 'manage_comments') {
      if (payload.action !== 'add' || typeof payload.text !== 'string' || payload.text.length > 20000 || !validReplyer(payload.replyer)) return fail('invalid_request', 'manage_comments add requires bounded text and an optional string or non-negative integer replyer')
      if (!callableName(await commentsOn(slide), ['Add'])) return unsupported('slide.Comments.Add')
      if (payload.slideId === undefined && await slideIdentity(slide) === null) return unsupported('slide identity for Comments.Add')
    }
    if (operation === 'manage_metadata') {
      if (payload.action !== 'set_builtin' || typeof payload.name !== 'string' || !payload.name || payload.value === undefined) return fail('invalid_request', 'manage_metadata set_builtin requires name and value')
      const property = await documentProperty(r, payload.name); if (!property || !propertyName(property, ['Value'])) return unsupported('BuiltinDocumentProperties(name).Value')
    }
    if (operation === 'manage_structure') {
      if (payload.action === 'move_slide') {
        if (!Number.isInteger(slideIndexOf(payload)) || !Number.isInteger(payload.toIndex) || payload.toIndex < 0 || payload.toIndex >= r.slides.length) return fail('invalid_request', 'manage_structure move_slide requires slideIndex and toIndex')
        if (typeof slide.MoveTo !== 'function') return unsupported('slide.MoveTo')
        if (await slideIdentity(slide) === null) return unsupported('slide identity for move_slide verification')
      } else if (payload.action === 'move_section') {
        if (!Number.isInteger(payload.sectionIndex) || !Number.isInteger(payload.toPos)) return fail('invalid_request', 'manage_structure move_section requires sectionIndex and toPos')
        if (!callableName(await sectionsOn(r), ['Move'])) return unsupported('Sections.Move')
      } else return unsupported(`structure ${payload.action}`)
    }
    if (operation === 'render_scene') {
      if (payload.action !== 'replace_scene' || !Array.isArray(payload.elements) || !payload.elements.length || payload.elements.length > 50) return fail('invalid_request', 'render_scene replace_scene requires 1-50 elements')
      for (const shape of await shapesOn(slide)) if (typeof shape?.Delete !== 'function') return unsupported('shape.Delete required for replace_scene')
      for (const element of payload.elements) {
        if (!object(element) || !sceneElementHasOnlyVerifiedFields(element)) return fail('invalid_request', 'render_scene elements may contain only fields with a verified public readback contract')
        const unsupportedElement = await supportsSceneElement(slide, element); if (unsupportedElement) return unsupported(unsupportedElement)
      }
      // Rebuilding shapes from summaries loses table cells, chart series and
      // formatting.  Only an exact public Duplicate/Copy backup is eligible
      // for a destructive scene replacement.
      for (const shape of await shapesOn(slide)) if (!callableName(shape, ['Duplicate', 'duplicate', 'Copy', 'copy'])) return unsupported('exact shape Duplicate/Copy rollback for every existing shape')
    }
    if (operation === 'render_slide_visual') {
      if (payload.action !== 'replace_visual' || !validRect(payload) || !slideVisualData(payload.svg)) return fail('invalid_request', 'render_slide_visual requires one bounded self-contained SVG and finite left, top, width, and height')
      if (!callableName(await shapeCollection(slide), ['AddPicture'])) return unsupported('Shapes.AddPicture')
      for (const shape of await shapesOn(slide)) if (typeof shape?.Delete !== 'function' || !callableName(shape, ['Duplicate', 'duplicate', 'Copy', 'copy'])) return unsupported('exact shape Duplicate/Copy rollback for every existing shape')
    }
    if (operation === 'replace_text_box') {
      if (typeof payload.text !== 'string' || payload.text.length > 20000) return fail('invalid_request', 'replace_text_box requires bounded text')
      const target = await shapeAt(r, payload); const range = await textRangeFor(target?.shape)
      if (!range) return unsupported('TextFrame.TextRange')
      if (!propertyName(range, ['Text']) && !method(range, ['InsertAfter', 'insertAfter', 'Replace', 'replace'])) return unsupported('TextRange.Text setter/InsertAfter/Replace')
    }
    if (operation === 'edit_selection') {
      if (payload.action !== 'update') return fail('invalid_request', 'edit_selection requires action update')
      const edit = object(payload.edit)
      if (!hasOnlyNestedFields(edit, [...editFields, 'replaceText']) || !hasEffect(edit, [...editFields, 'replaceText'])) return fail('invalid_request', 'edit_selection update requires only supported edit fields')
      const current = await activeSlideState(r)
      if (!current || current.index !== index) return fail('fingerprint_mismatch', 'edit_selection slideIndex does not match the active slide', { field: 'activeSlide', expected: index, actual: current?.index ?? null })
      const selected = selectionShape(await selectionValue(r)); if (!selected) return unsupported('selection')
      if (editFields.some((key) => edit[key] !== undefined && !Number.isFinite(edit[key])) || (edit.replaceText !== undefined && (typeof edit.replaceText !== 'string' || edit.replaceText.length > 20000))) return fail('invalid_request', 'edit_selection fields are invalid')
      for (const [key, names] of [['x', ['Left', 'left']], ['y', ['Top', 'top']], ['width', ['Width', 'width']], ['height', ['Height', 'height']], ['rotation', ['Rotation', 'rotation']]]) if (edit[key] !== undefined && !propertyName(selected, names)) return unsupported(names[0])
      if (edit.replaceText !== undefined) { const range = await textRangeFor(selected); if (!range || (!propertyName(range, ['Text']) && !method(range, ['InsertAfter', 'insertAfter', 'Replace', 'replace']))) return unsupported('TextRange.Text setter/InsertAfter/Replace') }
    }
    if (operation === 'manage_objects') {
      if (payload.action === 'update' && (!hasOnlyNestedFields(payload.object, editFields) || !hasEffect(payload.object, editFields))) return fail('invalid_request', 'manage_objects update requires only supported geometry fields')
      const target = await shapeAt(r, payload); if (!target?.shape) return unsupported('shape')
      if (!['delete', 'update'].includes(payload.action)) return unsupported(`shape ${payload.action}`)
      if (payload.action === 'delete' && typeof target.shape.Delete !== 'function') return unsupported('shape.Delete')
      if (payload.action === 'delete' && await objectIdentity(target.shape) === null) return unsupported('stable shape identity for delete verification')
      if (payload.action === 'update') {
        const value = payload.object
        if (editFields.some((key) => value[key] !== undefined && !Number.isFinite(value[key]))) return fail('invalid_request', 'manage_objects geometry fields must be finite numbers')
        for (const [key, names] of [['x', ['Left']], ['y', ['Top']], ['width', ['Width']], ['height', ['Height']], ['rotation', ['Rotation']]]) if (value[key] !== undefined && !propertyName(target.shape, names)) return unsupported(names[0])
      }
    }
    if (operation === 'manage_slides') {
      if (payload.action === 'add') {
        if (payload.index !== undefined && (!Number.isInteger(payload.index) || payload.index < -1 || payload.index > r.slides.length)) return fail('invalid_request', 'manage_slides add index must be -1 or a zero-based insertion position')
        if (!callableName(await slidesCollection(r), addSlideMethods)) return unsupported('Slides.AddSlide/Add')
      } else {
        const targetSlide = slideAt(r, slideIndexOf(payload)); if (!targetSlide) return unsupported('slide')
        if (payload.action === 'delete' && typeof targetSlide.Delete !== 'function') return unsupported('slide.Delete')
        if (payload.action === 'select' && typeof targetSlide.Select !== 'function') return unsupported('slide.Select')
        if (!['delete', 'select'].includes(payload.action)) return unsupported(`slide ${payload.action}`)
        if (await slideIdentity(targetSlide) === null) return unsupported(`slide identity for ${payload.action} verification`)
      }
    }
    if (operation === 'save' && !callableName(typeof globalThis.WPSOpenApi?.save === 'function' ? globalThis.WPSOpenApi : r.root, ['save', 'Save', 'saveAs', 'SaveAs'])) return unsupported('save')
    return null
  }
  const bounded = (value) => {
    const serialized = serial(value); const text = JSON.stringify(serialized)
    if (text === undefined) return serialized
    return text.length <= 2000 ? serialized : { truncated: true, preview: text.slice(0, 2000) }
  }
  const inspectWrite = async (r, request) => {
    const payload = object(request.payload) ?? {}
    const unsupportedResult = await supportedWrite(r, request.operation, payload); if (unsupportedResult) return unsupportedResult
    const currentResource = await resource(r)
    const visual = request.operation === 'render_slide_visual' ? slideVisualData(payload.svg)?.summary : undefined
    return { status: 'ok', resource: currentResource, slideCount: currentResource.slideCount, precondition: await precondition(r, request.operation, payload), operation: request.operation, summary: { payloadKeys: Object.keys(payload).slice(0, 32), target: bounded(payload.target ?? { slideIndex: slideIndexOf(payload), objectIndex: payload.objectIndex, textBoxIndex: payload.textBoxIndex }), effect: bounded({ action: payload.action, text: payload.text, edit: payload.edit, object: payload.object, ...(visual === undefined ? {} : { visual: { ...visual, left: payload.left, top: payload.top, width: payload.width, height: payload.height } }) }) } }
  }
  const verify = async (request, r, payload) => {
    const expected = request.precondition
    if (!object(expected) || typeof expected.resourceFingerprint !== 'string' || !expected.resourceFingerprint) return fail('precondition_required', 'PPT writes require a precondition from inspect_write')
    if (expected.operation !== request.operation) return fail('fingerprint_mismatch', 'The write operation does not match its inspected precondition', { field: 'operation', expected: expected.operation, actual: request.operation })
    const actualResource = await resource(r); if (actualResource.fingerprint !== expected.resourceFingerprint) return fail('fingerprint_mismatch', 'The presentation changed since inspection', { field: 'resourceFingerprint', expected: expected.resourceFingerprint, actual: actualResource.fingerprint })
    const actualCount = r.slides.length || (r.current ? 1 : 0); if (actualCount !== expected.slideCount) return fail('fingerprint_mismatch', 'The slide count changed since inspection', { field: 'slideCount', expected: expected.slideCount, actual: actualCount })
    if (!object(request.resource) || request.resource.fingerprint !== expected.resourceFingerprint) return fail('fingerprint_mismatch', 'The write resource does not match its precondition', { field: 'resource.fingerprint', expected: expected.resourceFingerprint, actual: request.resource?.fingerprint })
    const actualActive = await activeSlideSnapshot(r)
    if (!same(expected.activeSlide, actualActive)) return fail('fingerprint_mismatch', 'The active slide changed since inspection', { field: 'activeSlide', expected: expected.activeSlide, actual: actualActive })
    const targetIndex = slideIndexOf(payload); const current = targetIndex ?? actualActive?.index ?? null
    if (current !== expected.currentSlide) return fail('fingerprint_mismatch', 'The target slide changed since inspection', { field: 'currentSlide', expected: expected.currentSlide, actual: current })
    const targetSlide = slideAt(r, targetIndex); const actualSlide = targetSlide ? await slideSummary(targetSlide, targetIndex) : null
    if (!same(expected.slide, actualSlide)) return fail('fingerprint_mismatch', 'The target slide structure changed since inspection', { field: 'slide' })
    if (expected.target && !same(expected.target, await targetSnapshotFor(r, request.operation, payload))) return fail('fingerprint_mismatch', 'The target presentation object changed since inspection', { field: 'target' })
    if (expected.selection && !same(expected.selection, await selectionSnapshot(r))) return fail('fingerprint_mismatch', 'The presentation selection changed since inspection', { field: 'selection' })
    if (expected.operationState !== undefined && !same(expected.operationState, await operationSnapshot(r, request.operation, payload))) return fail('fingerprint_mismatch', 'The operation target changed since inspection', { field: 'operationState' })
    return null
  }
  const unsupported = (operation) => fail('unsupported', `WebEdit presentation API does not expose ${operation}`)
  const assign = async (target, names, value) => { const name = propertyName(target, names); if (!name) return false; try { target[name] = value; return true } catch { return false } }
  // Shape proxies can reject a later property after accepting earlier writes.
  // Apply a multi-field update as a compensating transaction: every getter is
  // checked before changing anything, and any rejected/no-op setter restores
  // the already changed fields and proves that restoration by readback.
  const applyAtomicShapeEdit = async (shape, edit, includeText = false) => {
    const fields = [
      ['x', ['Left', 'left']], ['y', ['Top', 'top']], ['width', ['Width', 'width']], ['height', ['Height', 'height']], ['rotation', ['Rotation', 'rotation']],
    ].filter(([key]) => edit[key] !== undefined)
    const old = []
    for (const [key, names] of fields) {
      const value = await readAny(shape, names)
      if (value === undefined) return fail('unsupported', `WebEdit presentation API does not expose ${names[0]}`)
      old.push({ key, names, value })
    }
    let textRange; let oldText
    if (includeText && edit.replaceText !== undefined) {
      textRange = await textRangeFor(shape); oldText = await readAny(textRange, ['Text', 'getText', 'GetText'])
      if (!textRange || oldText === undefined) return fail('unsupported', 'WebEdit presentation API does not expose readable TextFrame.TextRange.Text')
    }
    const restore = async () => {
      let complete = true
      if (textRange) {
        if (!await assign(textRange, ['Text'], oldText) || await readAny(textRange, ['Text', 'getText', 'GetText']) !== oldText) complete = false
      }
      for (const item of [...old].reverse()) {
        if (!await assign(shape, item.names, item.value) || await readAny(shape, item.names) !== item.value) complete = false
      }
      return complete
    }
    for (const item of old) {
      if (!await assign(shape, item.names, edit[item.key]) || await readAny(shape, item.names) !== edit[item.key]) {
        const rollbackComplete = await restore()
        return fail(rollbackComplete ? 'write_rejected' : 'write_incomplete', `Presentation shape ${item.names[0]} update was rejected`, { field: item.key, rollbackComplete })
      }
    }
    if (textRange && (!await assign(textRange, ['Text'], edit.replaceText) || await readAny(textRange, ['Text', 'getText', 'GetText']) !== edit.replaceText)) {
      const rollbackComplete = await restore()
      return fail(rollbackComplete ? 'write_rejected' : 'write_incomplete', 'Presentation text update was rejected', { field: 'replaceText', rollbackComplete })
    }
    return { ok: true }
  }
  const slideAt = (r, index) => Number.isInteger(index) && index >= 0 ? r.slides[index] : undefined
  const shapeAt = async (r, request) => {
    const slide = slideAt(r, slideIndexOf(request)); if (!slide) return null
    const index = objectIndexOf(request) ?? textBoxIndexOf(request)
    if (!Number.isInteger(index) || index < 0) return null
    const shapes = await list(slide, ['Shapes', 'getShapes', 'getObjects', 'Objects'])
    return { slide, shape: shapes[index], index }
  }
  const replaceText = async (r, request) => {
    const target = request.targetObject ? { shape: request.targetObject } : await shapeAt(r, request)
    const range = await textRangeFor(target?.shape)
    if (!range) return unsupported('TextFrame.TextRange')
    const text = request.text ?? request.edit?.replaceText; if (typeof text !== 'string') return fail('invalid_request', 'replace_text_box requires text')
    if (!await assign(range, ['Text'], text)) { const m = method(range, ['InsertAfter', 'insertAfter', 'Replace', 'replace']); if (!m) return unsupported('TextRange.Text setter/InsertAfter/Replace'); await call(m.target, m.name, [text]) }
    return { requested: { text }, target: { textBoxIndex: textBoxIndexOf(request) } }
  }
  const insertTable = async (slide, payload) => {
    const shapes = await shapeCollection(slide); const name = verifiedShapeMethodName(shapes, addTableMethods)
    if (!name) return unsupported('verified Shapes.InsertTable/AddTable')
    const dimensions = name === 'AddTable' ? { NumRows: payload.rows, NumColumns: payload.columns } : { Row: payload.rows, Col: payload.columns }
    const result = await call(shapes, name, [{ ...dimensions, Left: payload.left, Top: payload.top, Width: payload.width, Height: payload.height }])
    return result === false ? fail('write_rejected', `Shapes.${name} rejected the requested table`) : { action: 'insert', rows: payload.rows, columns: payload.columns }
  }
  const insertChart = async (slide, payload) => {
    const shapes = await shapeCollection(slide); const name = verifiedShapeMethodName(shapes, addChartMethods)
    if (!name) return unsupported('verified Shapes.InsertChart/AddChart')
    const chartType = normalizedChartType(payload.chartType)
    const result = await call(shapes, name, [{ ChartType: chartType, Left: payload.left, Top: payload.top, Width: payload.width, Height: payload.height }])
    return result === false ? fail('write_rejected', `Shapes.${name} rejected the requested chart`) : { action: 'insert', chartType: payload.chartType }
  }
  const replaceNotes = async (slide, payload) => {
    const shape = await notesTextShape(slide)
    if (!shape) return unsupported('NotesPage.TextShape')
    const range = await textRangeFor(shape)
    if (!range || !await assign(range, ['Text'], payload.text)) return unsupported('NotesPage.TextShape.TextFrame.TextRange.Text')
    return { action: 'replace', text: payload.text }
  }
  const addComment = async (slide, payload) => {
    const comments = await commentsOn(slide); const name = callableName(comments, ['Add'])
    if (!name) return unsupported('slide.Comments.Add')
    const result = await call(comments, name, [{ SlideId: payload.slideId ?? await slideIdentity(slide), Text: payload.text, ...(payload.replyer === undefined ? {} : { Replyer: payload.replyer }) }])
    return result === false ? fail('write_rejected', 'slide.Comments.Add rejected the requested comment') : { action: 'add', text: payload.text }
  }
  const setMetadata = async (r, payload) => {
    const property = await documentProperty(r, payload.name)
    if (!property || !await assign(property, ['Value'], payload.value)) return unsupported('BuiltinDocumentProperties(name).Value')
    return { action: 'set_builtin', name: payload.name, value: payload.value }
  }
  const moveSlide = async (r, payload) => {
    const slide = slideAt(r, slideIndexOf(payload)); if (!slide || typeof slide.MoveTo !== 'function') return unsupported('slide.MoveTo')
    // WPS Slides.Item is one-based; MoveTo uses that public slide position.
    const result = await call(slide, 'MoveTo', [payload.toIndex + 1])
    return result === false ? fail('write_rejected', 'slide.MoveTo rejected the requested position') : { action: 'move_slide', fromIndex: payload.slideIndex, toIndex: payload.toIndex }
  }
  const moveSection = async (r, payload) => {
    const sections = await sectionsOn(r); const name = callableName(sections, ['Move'])
    if (!name) return unsupported('Sections.Move')
    const result = await call(sections, name, [{ SectionIndex: payload.sectionIndex, ToPos: payload.toPos }])
    return result === false ? fail('write_rejected', 'Sections.Move rejected the requested position') : { action: 'move_section', sectionIndex: payload.sectionIndex, toPos: payload.toPos }
  }
  const createSceneElement = async (slide, element) => {
    const shapes = await shapeCollection(slide)
    if (element.type === 'text') {
      const name = verifiedShapeMethodName(shapes, addTextBoxMethods)
      const made = name ? await call(shapes, name, [{ Left: element.left, Top: element.top, Width: element.width, Height: element.height }]) : undefined
      if (made === false) return fail('write_rejected', `Shapes.${name} rejected the requested text element`)
      const shape = made && typeof made === 'object' ? made : (await shapesOn(slide)).at(-1)
      if (!shape) return fail('readback_mismatch', `Shapes.${name ?? 'AddTextbox/AddTextBox'} did not expose a created text element`)
      const replaced = await replaceText(null, { targetObject: shape, text: element.text }); if (replaced?.ok === false) return replaced
      return shape
    }
    if (element.type === 'table') { const result = await insertTable(slide, element); return result?.ok === false ? result : (await shapesOn(slide)).at(-1) }
    if (element.type === 'chart') { const result = await insertChart(slide, element); return result?.ok === false ? result : (await shapesOn(slide)).at(-1) }
    if (element.type === 'image') {
      const result = await call(shapes, 'AddPicture', [{ FileName: element.fileName, Left: element.left, Top: element.top, Width: element.width, Height: element.height }])
      if (result === false) return fail('write_rejected', 'Shapes.AddPicture rejected the requested image element')
      return result && typeof result === 'object' ? result : (await shapesOn(slide)).at(-1)
    }
    return unsupported(`scene element ${String(element.type)}`)
  }
  const sceneTypeMatches = (item, type) => {
    const actual = String(item?.type ?? '').toLowerCase(); const numeric = Number(item?.type)
    if (type === 'text') return actual.includes('text') || numeric === 17 || item?.hasTextFrame === true
    if (type === 'table') return actual.includes('table') || numeric === 19 || item?.table !== undefined
    if (type === 'chart') return actual.includes('chart') || numeric === 3 || item?.chartType !== undefined
    if (type === 'image') return actual.includes('image') || actual.includes('picture') || numeric === 11 || numeric === 13 || item?.fileName !== undefined
    return false
  }
  const sceneElementErrors = (item, element) => {
    const errors = []
    if (!stableObjectIdentity(item?.id)) errors.push({ field: 'identity', expected: 'stable object identity', actual: item?.id ?? null })
    if (!sceneTypeMatches(item, element.type)) errors.push({ field: 'type', expected: element.type, actual: item?.type })
    for (const [requestKey, observedKey] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) if (item?.bounds?.[observedKey] !== element[requestKey]) errors.push({ field: `bounds.${observedKey}`, expected: element[requestKey], actual: item?.bounds?.[observedKey] })
    if (element.type === 'text' && item?.text !== element.text) errors.push({ field: 'text', expected: element.text, actual: item?.text })
    if (element.type === 'table') {
      if (item?.table?.rows !== element.rows) errors.push({ field: 'table.rows', expected: element.rows, actual: item?.table?.rows })
      if (item?.table?.columns !== element.columns) errors.push({ field: 'table.columns', expected: element.columns, actual: item?.table?.columns })
    }
    if (element.type === 'chart' && normalizedChartType(item?.chartType) !== normalizedChartType(element.chartType)) errors.push({ field: 'chartType', expected: normalizedChartType(element.chartType), actual: item?.chartType })
    // A picture cannot be safely verified by geometry alone: an arbitrary
    // image at the same bounds is a different document mutation.
    if (element.type === 'image' && item?.fileName !== element.fileName) errors.push({ field: 'fileName', expected: element.fileName, actual: item?.fileName ?? null })
    return errors
  }
  const renderScene = async (slide, payload) => {
    const before = await shapesOn(slide); const beforeSummaries = await Promise.all(before.map((shape, index) => objectSummary(shape, index))); const backups = []; const created = []; const createdRecords = []
    const survivorEvidence = async () => {
      try {
        const current = await shapesOn(slide)
        return Promise.all(current.slice(0, 64).map((shape, index) => objectSummary(shape, index)))
      } catch { return [] }
    }
    const remove = async (shape) => { try { return typeof shape?.Delete === 'function' && await call(shape, 'Delete') !== false } catch { return false } }
    const stableObjectMap = async (items) => {
      const out = new Map()
      for (const item of items) {
        const id = await objectIdentity(item)
        if (!stableObjectIdentity(id) || out.has(id)) return null
        out.set(id, item)
      }
      return out
    }
    const hasStableIdentity = async (items, id) => stableObjectIdentity(id) && (await stableObjectMap(items))?.has(id) === true
    const trackCreated = async (shape) => {
      if (await containsObject(created, shape)) return
      const id = await objectIdentity(shape)
      created.push(shape); createdRecords.push({ shape, id })
    }
    const makeBackups = async () => {
      const originalIds = beforeSummaries.map((summary) => summary.id)
      if (originalIds.some((id) => !stableObjectIdentity(id)) || new Set(originalIds).size !== originalIds.length) return false
      for (let index = 0; index < before.length; index += 1) {
        const original = before[index]; const name = callableName(original, ['Duplicate', 'duplicate', 'Copy', 'copy']); if (!name) return false
        const snapshot = await shapesOn(slide); let result
        try { result = await call(original, name) } catch { return false }
        const after = await shapesOn(slide); const additions = await newObjects(after, snapshot)
        const backup = result && typeof result === 'object' ? result : additions[0]
        const backupId = await objectIdentity(backup)
        if (additions.length !== 1 || !backup || !await containsObject(additions, backup) || backupId === null) return false
        backups.push({ original, backup, originalId: beforeSummaries[index].id, backupId, summary: beforeSummaries[index] })
      }
      return true
    }
    const backupsIntact = async (current) => {
      const identities = await stableObjectMap(current)
      return identities !== null && backups.every((pair) => identities.has(pair.backupId))
    }
    const rollbackCreated = async () => {
      let attempted = true
      for (const shape of [...created].reverse()) {
        if (typeof shape?.Delete !== 'function') { attempted = false; continue }
        try { if (await call(shape, 'Delete') === false) attempted = false } catch { attempted = false }
      }
      let remaining
      try { remaining = await shapesOn(slide) } catch { return false }
      for (const record of createdRecords) if (await hasStableIdentity(remaining, record.id)) attempted = false
      return attempted
    }
    const clearBackups = async (restoreDeleted) => {
      // Check this before removing a single replacement.  Once an original is
      // gone, its exact duplicate is the only rollback material; a missing
      // duplicate makes rollback destructive rather than restorative.
      if (restoreDeleted) {
        let current
        try { current = await shapesOn(slide) } catch { return false }
        for (const pair of backups) {
          const originalPresent = await hasStableIdentity(current, pair.originalId)
          if (!originalPresent && !await hasStableIdentity(current, pair.backupId)) return false
        }
      }
      let complete = await rollbackCreated()
      let remaining
      try { remaining = await shapesOn(slide) } catch { return false }
      for (const pair of backups) {
        const originalPresent = await hasStableIdentity(remaining, pair.originalId)
        // For an already deleted original, its exact Duplicate is the backup
        // to retain.  Otherwise remove the duplicate and keep the original.
        if (restoreDeleted && !originalPresent) continue
        if (!await remove(pair.backup)) complete = false
        try { remaining = await shapesOn(slide) } catch { return false }
      }
      try { remaining = await shapesOn(slide) } catch { return false }
      if (remaining.length !== before.length) return false
      for (const pair of backups) {
        const survivorId = await hasStableIdentity(remaining, pair.originalId) ? pair.originalId : pair.backupId
        if (!await hasStableIdentity(remaining, survivorId)) complete = false
      }
      return complete
    }
    const recoveryIncomplete = async (message, deletedCount) => fail('write_incomplete', message, {
      stage: 'pre_commit_recovery', deletedCount, totalOldShapes: before.length, createdCount: created.length,
      rollbackComplete: false, survivors: await survivorEvidence(),
    })
    const incomplete = async (message, deletedCount) => {
      let current
      try { current = await shapesOn(slide) } catch { return recoveryIncomplete('render_scene could not prove its backups still exist before recovery', deletedCount) }
      // A missing backup means that deleting the created scene would leave no
      // exact copy of at least one deleted original.  Do not make that loss
      // worse by attempting rollback; leave all current survivors visible.
      if (!await backupsIntact(current)) return recoveryIncomplete('render_scene lost an exact backup before commit cleanup and cannot safely roll back', deletedCount)
      const restored = await clearBackups(true)
      const unchanged = restored && deletedCount === 0
      return fail(unchanged ? 'write_rejected' : 'write_incomplete', unchanged ? message : 'render_scene could not restore the original scene with its original stable identities after a failed deletion', { deletedCount, totalOldShapes: before.length, createdCount: created.length, rollbackComplete: restored, survivors: await survivorEvidence() })
    }
    const recoverCreationFailure = async (failure, deletedCount) => {
      let current
      try { current = await shapesOn(slide) } catch { return recoveryIncomplete('render_scene could not prove its backups still exist after creation failure', deletedCount) }
      if (!await backupsIntact(current)) return recoveryIncomplete('render_scene lost an exact backup after creation failure and cannot safely roll back', deletedCount)
      const restored = await clearBackups(true)
      return restored ? failure : fail('write_incomplete', 'render_scene creation failed and the original scene could not be fully restored', { deletedCount, totalOldShapes: before.length, createdCount: created.length, rollbackComplete: restored, survivors: await survivorEvidence() })
    }
    if (!await makeBackups()) {
      const cleaned = await clearBackups(false)
      return fail(cleaned ? 'write_rejected' : 'write_incomplete', cleaned ? 'render_scene could not establish exact duplicate backups before deletion' : 'render_scene could not clean up a partial exact backup before deletion', { rollbackComplete: cleaned, survivors: await survivorEvidence() })
    }
    for (const element of payload.elements) {
      const known = [...before, ...backups.map((pair) => pair.backup), ...created]; let made; let creationFailure = null
      try { made = await createSceneElement(slide, element) } catch { creationFailure = fail('write_rejected', 'render_scene failed while creating a replacement element') }
      if (made && made.ok !== false && typeof made === 'object' && !await containsObject(known, made) && !await containsObject(created, made)) await trackCreated(made)
      let afterAttempt
      try { afterAttempt = await shapesOn(slide) } catch { await rollbackCreated(); return fail('write_incomplete', 'render_scene could not read back a partially created scene', { deletedCount: 0, totalOldShapes: before.length, createdCount: created.length, rollbackComplete: false }) }
      const additions = await newObjects(afterAttempt, known)
      for (const added of additions) if (!await containsObject(created, added)) await trackCreated(added)
      let deletedDuringCreation = 0
      for (const old of before) if (!await containsObject(afterAttempt, old)) deletedDuringCreation += 1
      if (creationFailure || made?.ok === false || !made) {
        const failure = creationFailure ?? (made?.ok === false ? made : fail('write_rejected', 'render_scene did not expose a created element'))
        return recoverCreationFailure(failure, deletedDuringCreation)
      }
      if (additions.length !== 1 || !await sameObject(additions[0], made) || deletedDuringCreation > 0) return recoverCreationFailure(fail('readback_mismatch', 'render_scene creation did not add exactly the requested distinct shape'), deletedDuringCreation)
      const createdSummary = await objectSummary(additions[0], created.length - 1); const creationErrors = sceneElementErrors(createdSummary, element)
      if (creationErrors.length > 0) return recoverCreationFailure(fail('readback_mismatch', 'render_scene created element did not match the request', { mismatches: creationErrors }), deletedDuringCreation)
    }
    let deletedCount = 0
    for (const old of before) {
      let result
      try { result = await call(old, 'Delete') } catch { return incomplete('render_scene failed while deleting the existing scene', deletedCount) }
      let remaining
      try { remaining = await shapesOn(slide) } catch { return incomplete('render_scene could not read back deletion of the existing scene', deletedCount) }
      const deleted = !await containsObject(remaining, old)
      if (deleted) deletedCount += 1
      if (result === false || !deleted) return incomplete('render_scene could not prove deletion of the complete existing scene', deletedCount)
    }
    // All originals are now gone, but every exact backup still exists.  This
    // is the final reversible point: prove the requested scene before any
    // backup is destroyed.
    const sceneMatches = async (current, requiredBackups, removedBackups = [], capture = false) => {
      const identities = await stableObjectMap(current)
      if (identities === null || createdRecords.length !== payload.elements.length) return false
      if (createdRecords.some((record) => !stableObjectIdentity(record.id)) || new Set(createdRecords.map((record) => record.id)).size !== createdRecords.length) return false
      if (beforeSummaries.some((summary) => !stableObjectIdentity(summary.id) || identities.has(summary.id))) return false
      if (requiredBackups.some((pair) => !identities.has(pair.backupId)) || removedBackups.some((pair) => identities.has(pair.backupId))) return false
      const backupIds = new Set(backups.map((pair) => pair.backupId))
      const nonBackups = [...identities.entries()].filter(([id]) => !backupIds.has(id))
      if (nonBackups.length !== createdRecords.length || nonBackups.some(([id]) => !createdRecords.some((record) => record.id === id))) return false
      const createdSummaries = []
      for (let index = 0; index < createdRecords.length; index += 1) {
        const actual = identities.get(createdRecords[index].id)
        if (!actual) return false
        const summary = await objectSummary(actual, index)
        if (sceneElementErrors(summary, payload.elements[index]).length > 0) return false
        if (capture) createdSummaries.push(summary)
      }
      return capture ? createdSummaries : true
    }
    let preCleanup
    try { preCleanup = await shapesOn(slide) } catch { return incomplete('render_scene could not read back the complete requested replacement scene before commit cleanup', deletedCount) }
    if (!await sceneMatches(preCleanup, backups)) return incomplete('render_scene could not prove the complete requested replacement scene before commit cleanup', deletedCount)
    // From this point cleanup is one-way.  Never call the rollback path after
    // deleting a backup: a partial cleanup preserves the created scene and
    // returns its surviving objects for manual recovery.
    const backupEvidence = async () => {
      let current
      try { current = await shapesOn(slide) } catch { return backups.map((pair, index) => ({ index, id: pair.backupId, present: null })) }
      const identities = await stableObjectMap(current)
      return backups.map((pair, index) => ({ index, id: pair.backupId, present: identities?.has(pair.backupId) ?? null }))
    }
    const commitIncomplete = async (message) => fail('write_incomplete', message, {
      stage: 'commit_cleanup', deletedCount, totalOldShapes: before.length, createdCount: created.length,
      created: await Promise.all(created.map((shape, index) => objectSummary(shape, index))),
      backups: await backupEvidence(),
      survivors: await survivorEvidence(),
    })
    for (let index = 0; index < backups.length; index += 1) {
      const pair = backups[index]
      let removed
      try { removed = await remove(pair.backup) } catch { return commitIncomplete('render_scene backup cleanup threw after commit began') }
      let current
      try { current = await shapesOn(slide) } catch { return commitIncomplete('render_scene could not read back backup cleanup after commit began') }
      if (!removed || !await sceneMatches(current, backups.slice(index + 1), backups.slice(0, index + 1))) return commitIncomplete('render_scene backup cleanup did not preserve the complete created scene')
    }
    let after
    try { after = await shapesOn(slide) } catch { return commitIncomplete('render_scene could not read back the final committed scene') }
    const committed = await sceneMatches(after, [], backups, true)
    if (!committed) return commitIncomplete('render_scene left a mixed or otherwise uncertain committed scene')
    return { action: 'replace_scene', created: committed, removed: beforeSummaries }
  }
  const readbackSlideIndex = async (r, operation, payload) => {
    if (operation === 'manage_structure' && payload.action === 'move_slide') return payload.toIndex
    if (operation === 'manage_slides' && payload.action === 'add') return payload.index === undefined || payload.index === -1 ? r.slides.length - 1 : payload.index
    if (operation === 'manage_slides' && ['delete', 'select'].includes(payload.action)) return (await activeSlideState(r))?.index
    return slideIndexOf(payload) ?? (await activeSlideState(r))?.index
  }
  const verifiedResult = async (beforeRoot, operation, requested, request, payload = {}) => {
    const afterRoot = await root(); if (!afterRoot) return fail('readback_mismatch', 'Presentation disappeared before write readback')
    const observed = await context(afterRoot, await readbackSlideIndex(afterRoot, operation, payload)); if (observed?.ok === false) return observed
    const afterResource = await resource(afterRoot); const expected = request.precondition ?? {}; const errors = []
    const beforeTarget = expected.target; const afterTarget = await targetSnapshotFor(afterRoot, operation, payload)
    const expectedText = operation === 'replace_text_box' ? payload.text : operation === 'edit_selection' ? (payload.edit?.replaceText ?? payload.replaceText) : undefined
    if (expectedText !== undefined && afterTarget?.text !== expectedText) errors.push({ field: 'text', expected: expectedText, actual: afterTarget?.text })
    if (operation === 'edit_selection' || (operation === 'manage_objects' && payload.action === 'update')) {
      const effect = operation === 'edit_selection' && object(payload.edit) ? payload.edit : object(payload.object) ?? payload
      const actualBounds = afterTarget?.bounds ?? {}
      for (const [key, boundKey] of [['x', 'x'], ['y', 'y'], ['width', 'width'], ['height', 'height'], ['rotation', 'rotation']]) if (effect[key] !== undefined && actualBounds[boundKey] !== effect[key]) errors.push({ field: `bounds.${boundKey}`, expected: effect[key], actual: actualBounds[boundKey] })
    }
    if (operation === 'manage_objects' && payload.action === 'delete') {
      const expectedCount = Number(expected.slide?.objectCount) - 1
      if (Number.isInteger(expectedCount) && observed.objectCount !== expectedCount) errors.push({ field: 'objectCount', expected: expectedCount, actual: observed.objectCount })
      if (!stableObjectIdentity(beforeTarget?.id)) errors.push({ field: 'deletedObject.identity', expected: 'stable object identity', actual: beforeTarget?.id ?? null })
      else if (observed.objects.some((item) => item.id === beforeTarget.id)) errors.push({ field: 'deletedObject', expected: 'absent', actual: beforeTarget.id })
    }
    if (operation === 'manage_slides' && payload.action === 'delete') {
      const expectedCount = Number(expected.slideCount) - 1
      if (Number.isInteger(expectedCount) && afterResource.slideCount !== expectedCount) errors.push({ field: 'slideCount', expected: expectedCount, actual: afterResource.slideCount })
      const deletedId = expected.slide?.id; const remaining = await structureSnapshot(afterRoot)
      if (deletedId == null || remaining.some((item) => item.id === deletedId)) errors.push({ field: 'deletedSlide', expected: deletedId == null ? 'identifiable target' : 'absent', actual: remaining })
    }
    if (operation === 'manage_slides' && payload.action === 'add') {
      const expectedCount = Number(expected.slideCount) + 1
      if (afterResource.slideCount !== expectedCount) errors.push({ field: 'slideCount', expected: expectedCount, actual: afterResource.slideCount })
      const beforeIds = new Set((expected.operationState ?? []).map((item) => item.id).filter((id) => id !== null)); const added = (await structureSnapshot(afterRoot)).filter((item) => !beforeIds.has(item.id))
      if (added.length !== 1 || added[0]?.id === null) errors.push({ field: 'createdSlide', expected: 'one identifiable new slide', actual: added })
      else if (requested && requested.createdId == null) requested.createdId = added[0].id
      else if (requested?.createdId !== added[0].id) errors.push({ field: 'createdSlide.identity', expected: requested?.createdId, actual: added[0].id })
      const expectedIndex = payload.index === undefined || payload.index === -1 ? afterResource.slideCount - 1 : payload.index
      if (added.length === 1 && added[0].index !== expectedIndex) errors.push({ field: 'createdSlide.order', expected: { index: expectedIndex, id: added[0].id }, actual: await structureSnapshot(afterRoot) })
    }
    if (operation === 'manage_slides' && payload.action === 'select') {
      const selected = await activeSlide(afterRoot); const selectedId = await slideIdentity(selected); const targetId = expected.slide?.id
      if (targetId == null || selectedId !== targetId) errors.push({ field: 'activeSlide', expected: targetId, actual: selectedId })
    }
    const operationState = await operationSnapshot(afterRoot, operation, payload)
    const addedOperationItems = () => {
      if (!Array.isArray(operationState)) return []
      const priorIds = new Set((Array.isArray(expected.operationState) ? expected.operationState : []).map((item) => item.id).filter((id) => id !== null))
      return operationState.filter((item) => item.id !== null && !priorIds.has(item.id))
    }
    const verifyBounds = (actual, value, prefix) => {
      for (const [requestKey, observedKey] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) if (actual?.[observedKey] !== value[requestKey]) errors.push({ field: `${prefix}.${observedKey}`, expected: value[requestKey], actual: actual?.[observedKey] })
    }
    if (operation === 'manage_tables' && payload.action === 'insert') {
      const prior = Array.isArray(expected.operationState) ? expected.operationState.length : 0
      if (!Array.isArray(operationState) || operationState.length !== prior + 1) errors.push({ field: 'tables.count', expected: prior + 1, actual: Array.isArray(operationState) ? operationState.length : null })
      const added = addedOperationItems()
      if (added.length !== 1) errors.push({ field: 'tables.created', expected: 'one identifiable table', actual: added })
      else {
        if (added[0].table?.rows !== payload.rows) errors.push({ field: 'tables.created.rows', expected: payload.rows, actual: added[0].table?.rows })
        if (added[0].table?.columns !== payload.columns) errors.push({ field: 'tables.created.columns', expected: payload.columns, actual: added[0].table?.columns })
        verifyBounds(added[0].bounds, payload, 'tables.created.bounds')
      }
    }
    if (operation === 'manage_charts' && payload.action === 'insert') {
      const prior = Array.isArray(expected.operationState) ? expected.operationState.length : 0
      if (!Array.isArray(operationState) || operationState.length !== prior + 1) errors.push({ field: 'charts.count', expected: prior + 1, actual: Array.isArray(operationState) ? operationState.length : null })
      const added = addedOperationItems()
      if (added.length !== 1) errors.push({ field: 'charts.created', expected: 'one identifiable chart', actual: added })
      else {
        const actualType = normalizedChartType(added[0].chartType); const expectedType = normalizedChartType(payload.chartType)
        if (actualType !== expectedType) errors.push({ field: 'charts.created.chartType', expected: expectedType, actual: added[0].chartType })
        verifyBounds(added[0].bounds, payload, 'charts.created.bounds')
      }
    }
    if (operation === 'manage_notes' && !notesTextMatches(payload.text, operationState?.text)) errors.push({ field: 'notes.text', expected: payload.text, actual: operationState?.text })
    if (operation === 'manage_comments') {
      const prior = Array.isArray(expected.operationState) ? expected.operationState.length : 0
      const priorIds = new Set((Array.isArray(expected.operationState) ? expected.operationState : []).map((item) => item.id).filter((id) => id !== null))
      const added = Array.isArray(operationState) ? operationState.filter((item) => item.id !== null && !priorIds.has(item.id)) : []
      const expectedSlideId = payload.slideId ?? expected.slide?.id
      if (!Array.isArray(operationState) || operationState.length !== prior + 1 || added.length !== 1
        || added[0].text !== payload.text || added[0].slideId !== expectedSlideId || added[0].author === null
        || (payload.replyer !== undefined && added[0].author !== payload.replyer)) {
        errors.push({ field: 'comments.created', expected: { count: prior + 1, text: payload.text, slideId: expectedSlideId, replyer: payload.replyer ?? 'runtime author', stableId: true }, actual: operationState })
      }
    }
    if (operation === 'manage_metadata' && operationState?.value !== payload.value) errors.push({ field: `metadata.${payload.name}`, expected: payload.value, actual: operationState?.value })
    if (operation === 'manage_structure' && payload.action === 'move_slide') {
      const moved = expected.operationState?.[payload.slideIndex]?.id
      if (moved == null || operationState?.[payload.toIndex]?.id !== moved) errors.push({ field: 'slides.order', expected: { index: payload.toIndex, id: moved }, actual: operationState })
    }
    if (operation === 'manage_structure' && payload.action === 'move_section') {
      const moved = expected.operationState?.[payload.sectionIndex]?.id ?? expected.operationState?.[payload.sectionIndex]?.name
      const actual = operationState?.[payload.toPos]?.id ?? operationState?.[payload.toPos]?.name
      if (!moved || actual !== moved) errors.push({ field: 'sections.order', expected: { index: payload.toPos, id: moved }, actual: operationState })
    }
    if (operation === 'render_scene') {
      const created = requested?.created ?? []
      if (observed.objectCount !== created.length) errors.push({ field: 'scene.objectCount', expected: created.length, actual: observed.objectCount })
      const oldIds = (expected.operationState?.objects ?? []).map((item) => item.id).filter(stableObjectIdentity)
      if (oldIds.some((id) => observed.objects.some((item) => item.id === id))) errors.push({ field: 'scene.oldObjects', expected: 'absent', actual: oldIds })
      const createdIds = created.map((item) => item.id)
      if (createdIds.some((id) => !stableObjectIdentity(id)) || new Set(createdIds).size !== createdIds.length) errors.push({ field: 'scene.created.identity', expected: 'unique stable identities', actual: createdIds })
      for (let index = 0; index < payload.elements.length; index += 1) {
        const element = payload.elements[index]; const createdItem = created[index]
        const actual = !stableObjectIdentity(createdItem?.id) ? null : observed.objects.find((item) => item.id === createdItem.id)
        if (!actual) { errors.push({ field: `scene.elements.${index}.identity`, expected: createdItem?.id ?? 'stable identity', actual: observed.objects.map((item) => item.id) }); continue }
        for (const mismatch of sceneElementErrors(actual, element)) errors.push({ ...mismatch, field: `scene.elements.${index}.${mismatch.field}` })
      }
    }
    if (errors.length > 0) return fail('readback_mismatch', 'Presentation write readback did not match the requested effect', { mismatches: errors, observed })
    return { ok: true, result: { status: 'verified_write', operation, requested, resource: afterResource, observed: { ...observed, verified: true, resource: afterResource } } }
  }
  const saveOutcome = (value) => {
    if (value === true) return 'success'
    if (value === false) return 'failure'
    if (typeof value === 'string') {
      const state = value.trim().toLowerCase()
      if (['success', 'succeed', 'succeeded', 'saved', 'ok', 'nochange'].includes(state)) return 'success'
      if (['fail', 'failed', 'failure', 'error', 'rejected', 'spacefull', 'quenefull', 'queuefull', 'savedemptyfile'].includes(state)) return 'failure'
      return 'ambiguous'
    }
    const result = object(value)
    if (!result) return 'ambiguous'
    const resultText = typeof result.result === 'string' ? result.result.trim().toLowerCase() : ''
    const statusText = typeof result.status === 'string' ? result.status.trim().toLowerCase() : ''
    const errorCode = result.errorCode ?? result.ErrorCode
    const hasErrorCode = ![undefined, null, '', 0, '0', false].includes(errorCode)
    const spaceFull = ![undefined, null, '', 0, '0', false].includes(result.SpaceFull ?? result.spaceFull)
    const queueFull = ![undefined, null, '', 0, '0', false].includes(result.QueneFull ?? result.queneFull ?? result.QueueFull ?? result.queueFull)
    const savedEmptyFile = ![undefined, null, '', 0, '0', false].includes(result.SavedEmptyFile ?? result.savedEmptyFile)
    const failureStates = ['fail', 'failed', 'failure', 'error', 'rejected', 'spacefull', 'quenefull', 'queuefull', 'savedemptyfile']
    if (spaceFull || queueFull || savedEmptyFile || failureStates.includes(resultText) || failureStates.includes(statusText) || hasErrorCode) return 'failure'
    if (result.saved === false || result.success === false || result.ok === false) return 'failure'
    const successStates = ['success', 'succeed', 'succeeded', 'saved', 'ok', 'nochange']
    if (result.saved === true || result.success === true || result.ok === true || successStates.includes(resultText) || successStates.includes(statusText)) return 'success'
    return 'ambiguous'
  }
  const write = async (request) => {
    const r = await root(); if (!r) return unsupported('presentation root')
    const op = request.operation
    const payload = object(request.payload) ?? {}
    if (!object(request.precondition)) return fail('precondition_required', 'PPT writes require the precondition returned by inspect_write')
    const unsupportedResult = await supportedWrite(r, op, payload); if (unsupportedResult) return unsupportedResult
    const stale = await verify(request, r, payload); if (stale) return stale
    if (op === 'replace_text_box') { const result = await replaceText(r, payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'edit_selection') {
      const selected = await selectionValue(r); const shape = selectionShape(selected)
      if (!shape) return unsupported('selected shape')
      const edit = payload.edit && object(payload.edit) ? payload.edit : payload
      const applied = await applyAtomicShapeEdit(shape, edit, true); if (applied.ok === false) return applied
      return verifiedResult(r, op, edit, request, payload)
    }
    if (op === 'manage_objects') {
      const target = await shapeAt(r, payload); const shape = target?.shape; if (!shape) return unsupported('shape')
      if (payload.action === 'delete' && typeof shape.Delete === 'function') await call(shape, 'Delete')
      else if (payload.action === 'update') { const value = payload.object; const applied = await applyAtomicShapeEdit(shape, value); if (applied.ok === false) return applied }
      else return unsupported('shape Delete/update')
      return verifiedResult(r, op, payload.object ?? { action: payload.action }, request, payload)
    }
    if (op === 'manage_slides') {
      if (payload.action === 'add') {
        const slides = await slidesCollection(r); const name = callableName(slides, addSlideMethods); if (!name) return unsupported('Slides.AddSlide/Add')
        const added = await call(slides, name, payload.index === undefined ? [] : [payload.index]); if (added === false) return fail('write_rejected', 'Slides.AddSlide rejected the requested slide')
        return verifiedResult(r, op, { action: 'add', createdId: await slideIdentity(added) }, request, payload)
      }
      const slide = slideAt(r, slideIndexOf(payload)); if (!slide) return unsupported('slide')
      if (payload.action === 'delete' && typeof slide.Delete === 'function') await call(slide, 'Delete')
      else if (payload.action === 'select' && typeof slide.Select === 'function') await call(slide, 'Select')
      else return unsupported(`slide ${payload.action}`)
      return verifiedResult(r, op, { action: payload.action, slideIndex: slideIndexOf(payload) }, request, payload)
    }
    if (op === 'manage_tables') { const result = await insertTable(slideAt(r, slideIndexOf(payload)), payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'manage_charts') { const result = await insertChart(slideAt(r, slideIndexOf(payload)), payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'manage_notes') { const result = await replaceNotes(slideAt(r, slideIndexOf(payload)), payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'manage_comments') { const result = await addComment(slideAt(r, slideIndexOf(payload)), payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'manage_metadata') { const result = await setMetadata(r, payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'manage_structure') { const result = payload.action === 'move_section' ? await moveSection(r, payload) : await moveSlide(r, payload); return result?.ok === false ? result : verifiedResult(r, op, result, request, payload) }
    if (op === 'render_scene') {
      const result = await renderScene(slideAt(r, slideIndexOf(payload)), payload)
      if (result?.ok === false) return result
      // renderScene's final cleanup snapshot already proved exact membership,
      // stable identities, and full semantic equality.  A second shapes read
      // here would turn a verified one-way commit into a new uncertain state.
      const observed = {
        currentSlide: slideIndexOf(payload), slideCount: request.resource.slideCount,
        index: slideIndexOf(payload), id: request.precondition?.slide?.id ?? null,
        objectCount: result.created.length, objects: result.created,
        verified: true, resource: request.resource,
      }
      return { ok: true, result: { status: 'verified_write', operation: op, requested: result, resource: request.resource, observed } }
    }
    if (op === 'render_slide_visual') {
      const visual = slideVisualData(payload.svg)
      if (!visual) return fail('invalid_request', 'render_slide_visual requires one bounded self-contained SVG')
      const result = await renderScene(slideAt(r, slideIndexOf(payload)), { action: 'replace_scene', slideIndex: payload.slideIndex, elements: [{ type: 'image', fileName: visual.fileName, left: payload.left, top: payload.top, width: payload.width, height: payload.height }] })
      if (result?.ok === false) return result
      const observed = {
        currentSlide: slideIndexOf(payload), slideCount: request.resource.slideCount,
        index: slideIndexOf(payload), id: request.precondition?.slide?.id ?? null,
        objectCount: result.created.length, objects: result.created,
        verified: true, resource: request.resource,
      }
      return { ok: true, result: { status: 'verified_write', operation: op, requested: { action: payload.action, visual: visual.summary, created: result.created, removed: result.removed }, resource: request.resource, observed } }
    }
    if (op === 'save') {
      const saveTarget = typeof globalThis.WPSOpenApi?.save === 'function' ? globalThis.WPSOpenApi : r.root; const saveName = callableName(saveTarget, ['save', 'Save', 'saveAs', 'SaveAs'])
      if (!saveName) return unsupported('save')
      const saveResult = await call(saveTarget, saveName); const outcome = saveOutcome(saveResult)
      if (outcome === 'failure') return fail('write_rejected', 'Save API reported a business failure', { saveResult: bounded(saveResult) })
      if (outcome !== 'success') return fail('readback_mismatch', 'Save API did not return an explicit success result', { saveResult: bounded(saveResult) })
      return verifiedResult(r, op, { action: 'save', saveResult: serial(saveResult) }, request, payload)
    }
    return unsupported(op)
  }
  async function run(request = {}) {
    if (request.action === 'probe') { const caps = await capabilities(); return { ok: true, result: { status: 'probe', ...caps } } }
    if (request.action === 'inspect_capabilities' || request.operation === 'inspect_capabilities') return { ok: true, result: await capabilities() }
    const r = await root(); if (!r) return unsupported('presentation runtime')
    if (request.action === 'inspect_write') { const result = await inspectWrite(r, request); return result?.ok === false ? result : { ok: true, result } }
    if (request.action === 'get_context' || request.operation === 'get_context') { const result = await context(r, request.slideIndex); return result?.ok === false ? result : { ok: true, result } }
    if (request.action === 'selection' || request.operation === 'selection') { const value = await selectionValue(r); return value === undefined ? unsupported('selection') : { ok: true, result: { resource: await resource(r), ...(await selectionSnapshot(r)) } } }
    if (request.action === 'get_text_boxes' || request.operation === 'get_text_boxes') { const result = await context(r, request.slideIndex); return result.ok === false ? result : { ok: true, result: { ...result, textBoxes: result.objects.filter((item) => item.type === 'text' || item.type === 'textBox' || item.text !== null) } } }
    if (request.action === 'write' || request.action === 'save' || request.operation) return write(request)
    return { ok: true, result: await capabilities() }
  }
  globalThis.__deepseekHarnessOfficePresentation = { run }
  const REQUEST = 'deepseek-harness-office-presentation-request/v1'; const RESPONSE = 'deepseek-harness-office-presentation-response/v1'
  window.addEventListener?.(REQUEST, (event) => { const detail = event.detail; if (!detail || typeof detail.id !== 'string') return; void run(detail).then((payload) => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...payload } }))).catch(() => window.dispatchEvent(new CustomEvent(RESPONSE, { detail: { id: detail.id, ...fail('runtime_error', 'WebEdit presentation operation failed') } }))) })
})()
