import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function runtimeWith(presentation, options = {}) {
  const source = await readFile(new URL('../apps/chrome-extension/public/office-presentation-runtime.js', import.meta.url), 'utf8')
  const context = vm.createContext({
    APP: options.wps ? undefined : { openApi: { editor: { presentation } } },
    WPSOpenApi: options.wps ? options.wps : undefined,
    location: { origin: 'https://webedit.midea.com', pathname: '/weboffice/office/p/398087216480256' },
    globalThis: null, window: null, console, setTimeout, clearTimeout, CustomEvent,
  })
  context.globalThis = context; context.window = context
  vm.runInContext(source, context)
  return context.__deepseekHarnessOfficePresentation.run
}

function fakePublicWps({ ignoreText = false, ignoreRotation = false } = {}) {
  let text = '旧标题'
  const range = { Font: { Name: 'Arial' } }
  Object.defineProperty(range, 'Text', { configurable: true, get: () => text, set: (value) => { if (!ignoreText) text = value } })
  let rotation = 0
  const shape = { Id: 7, Type: 'textBox', Left: 10, Top: 20, Width: 300, Height: 80, HasTextFrame: true, TextFrame: Promise.resolve({ TextRange: Promise.resolve(range) }), Delete() { this.deleted = true } }
  Object.defineProperty(shape, 'Rotation', { configurable: true, enumerable: true, get: () => rotation, set: (value) => { if (!ignoreRotation) rotation = value } })
  const shapes = { Count: 1, Item: async (index) => index === 1 ? shape : null }
  const slide = { Id: 11, Shapes: Promise.resolve(shapes), Delete() { this.deleted = true } }
  const slides = { Count: 1, Item: async (index) => index === 1 ? slide : null }
  const view = { Slide: Promise.resolve(slide), SlideIndex: Promise.resolve(1) }
  const presentation = { Name: '真实探测.pptx', Slides: Promise.resolve(slides), SlideShowWindow: Promise.resolve({ View: Promise.resolve(view) }), getSelection: () => shape, getSlideCount: () => 1 }
  const api = { save: async () => ({ saved: true }) }
  Object.defineProperty(api, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  api.__shape = shape
  api.__view = view
  return { Application: api, save: api.save, __shape: shape }
}

function fakeMultiSlidePublicWps({ wrongAppend = false } = {}) {
  const slides = []
  let currentIndex = 1
  let nextSlideId = 400
  const makeSlide = (identityName, identity) => {
    const shapes = []
    const comments = []
    const shapeCollection = { get Count() { return shapes.length }, Item: (index) => shapes[index - 1] }
    const commentCollection = {
      get Count() { return comments.length },
      Item: (index) => comments[index - 1],
      Add(options) { comments.push({ Id: `comment-${comments.length + 1}`, Text: options.Text, Author: options.Replyer ?? '默认作者' }); commentCollection.lastAdd = options },
    }
    const slide = {
      Shapes: Promise.resolve(shapeCollection), Comments: Promise.resolve(commentCollection),
      Select() { currentIndex = slides.indexOf(slide) },
      Delete() {
        const active = slides[currentIndex]; const index = slides.indexOf(slide)
        slides.splice(index, 1)
        currentIndex = active === slide ? Math.min(index, slides.length - 1) : slides.indexOf(active)
      },
      MoveTo(position) {
        const active = slides[currentIndex]
        const from = slides.indexOf(slide); slides.splice(from, 1); slides.splice(position - 1, 0, slide)
        currentIndex = slides.indexOf(active)
      },
      _comments: commentCollection,
    }
    Object.defineProperty(slide, identityName, { enumerable: true, value: identity })
    return slide
  }
  slides.push(makeSlide('SlideID', 101), makeSlide('SlideID2', 202), makeSlide('Id', 303))
  const collection = {
    get Count() { return slides.length },
    Item: (index) => slides[index - 1],
    AddSlide(index) {
      const slide = makeSlide('SlideID', ++nextSlideId)
      const insertion = index === undefined || index < 0 ? (wrongAppend ? currentIndex + 1 : slides.length) : index
      slides.splice(insertion, 0, slide)
      return slide
    },
  }
  const view = {}
  Object.defineProperty(view, 'Slide', { get: () => Promise.resolve(slides[currentIndex]) })
  Object.defineProperty(view, 'SlideIndex', { get: () => Promise.resolve(currentIndex + 1) })
  const presentation = { Name: '三页公开代理.pptx', Slides: Promise.resolve(collection), SlideShowWindow: Promise.resolve({ View: Promise.resolve(view) }) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  return { wps: { Application: application }, slides, setCurrent: (index) => { currentIndex = index }, get currentIndex() { return currentIndex } }
}

function fakeEmptyPublicWps() {
  const slides = []
  const collection = {
    get Count() { return slides.length },
    Item: (index) => slides[index - 1],
    AddSlide(index) {
      const slide = { SlideID: `empty-slide-${slides.length + 1}`, Shapes: Promise.resolve({ Count: 0, Item: () => null }) }
      const insertion = index === undefined || index < 0 ? slides.length : index
      slides.splice(insertion, 0, slide)
      return slide
    },
  }
  const presentation = { Name: '首张幻灯片.pptx', Slides: Promise.resolve(collection) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  return { wps: { Application: application }, slides }
}

function thenableProperty(value) {
  const proxy = () => { throw new Error('awaitable WPS property must not be invoked') }
  proxy.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject)
  return proxy
}

function fakePresentation({ methods = {} } = {}) {
  const objects = [{ Id: 'shape-1', Type: 'textBox', Text: '标题', Bounds: { x: 10, y: 20, width: 300, height: 80 } }]
  const slide = { Id: 'slide-1', getObjects: () => objects }
  const presentation = {
    Id: 'doc-1', Name: 'demo.pptx', getSlides: () => [slide], getCurrentSlide: () => slide,
    getFingerprint: () => 'fp-1', ...methods,
  }
  return presentation
}

test('PPT runtime reports capabilities without claiming absent APIs', async () => {
  const run = await runtimeWith(fakePresentation())
  const result = await run({ action: 'inspect_capabilities' })
  assert.equal(result.ok, true)
  assert.equal(result.result.ready, true)
  assert.equal(result.result.capabilities.context, true)
  assert.equal(result.result.capabilities.save, false)
  assert.equal(result.result.capabilities.charts, false)
  assert.equal(result.result.resource.kind, 'webedit_presentation')
})

test('PPT discovers Slides.AddSlide from an otherwise empty public WPS ActivePresentation', async () => {
  const slides = {
    Count: 0,
    Item: () => null,
    AddSlide() { return { SlideID: 1, Shapes: Promise.resolve({ Count: 0, Item: () => null }) } },
  }
  const presentation = { Name: '空白演示.pptx', Slides: Promise.resolve(slides) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  const run = await runtimeWith(null, { wps: { Application: application } })
  const capabilities = await run({ action: 'inspect_capabilities' })
  assert.equal(capabilities.ok, true)
  assert.equal(capabilities.result.ready, true)
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_slides.actions)), ['add'])
  const preview = await run({ action: 'inspect_write', operation: 'manage_slides', payload: { action: 'add', index: -1 } })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.result.resource.slideCount, 0)
  const rejected = await run({ action: 'inspect_write', operation: 'manage_objects', payload: { action: 'delete', slideIndex: 0, objectIndex: 0 } })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'invalid_request')
})

test('PPT verifies creation of the first slide without requiring a current slide', async () => {
  const empty = fakeEmptyPublicWps()
  const run = await runtimeWith(null, { wps: empty.wps })
  const preview = await run({ action: 'inspect_write', operation: 'manage_slides', payload: { action: 'add', index: -1 } })
  assert.equal(preview.ok, true)
  assert.equal(preview.result.resource.slideCount, 0)
  const committed = await run({ action: 'write', operation: 'manage_slides', payload: { action: 'add', index: -1 }, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(committed.ok, true)
  assert.equal(committed.result.status, 'verified_write')
  assert.equal(committed.result.resource.slideCount, 1)
  assert.equal(committed.result.observed.currentSlide, 0)
  assert.equal(empty.slides.length, 1)
})

test('PPT runtime returns structured context, objects, bounds, and text boxes', async () => {
  const run = await runtimeWith(fakePresentation())
  const context = await run({ action: 'get_context' })
  assert.equal(context.ok, true)
  assert.equal(context.result.objectCount, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(context.result.objects[0])), {
    index: 0, id: 'shape-1', type: 'textBox', text: '标题', hasTextFrame: null,
    bounds: { x: 10, y: 20, width: 300, height: 80 },
  })
  const boxes = await run({ action: 'get_text_boxes' })
  assert.equal(boxes.result.textBoxes.length, 1)
})

test('PPT writes fail closed when API is absent or fingerprint precondition is missing', async () => {
  const run = await runtimeWith(fakePresentation())
  const absentPreview = await run({ action: 'inspect_write', operation: 'manage_charts', payload: { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 1, width: 2, height: 2 } })
  assert.equal(absentPreview.ok, false); assert.equal(absentPreview.error.code, 'unsupported')
  const unknownPreview = await run({ action: 'inspect_write', operation: 'invented_ppt_operation', payload: {} })
  assert.equal(unknownPreview.ok, false); assert.equal(unknownPreview.error.code, 'unsupported')
  const absent = await run({ action: 'write', operation: 'manage_charts', payload: { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 1, width: 2, height: 2 }, precondition: { resourceFingerprint: 'fp-1', slideCount: 1, currentSlide: 0 } })
  assert.equal(absent.ok, false); assert.equal(absent.error.code, 'unsupported')
  const missing = await run({ action: 'write', operation: 'save', payload: { action: 'save' } })
  assert.equal(missing.ok, false); assert.equal(missing.error.code, 'precondition_required')
})

function fakeAdvancedPresentation({ ignore = {} } = {}) {
  const property = { Value: '初始标题' }
  let sequence = 0
  const textShape = (text, type = 'textBox') => {
    const range = {}
    Object.defineProperty(range, 'Text', { enumerable: true, get: () => text.value, set: (value) => { if (!ignore.text) text.value = text.appendTrailingCarriageReturn ? `${value}\r` : value } })
    return { Id: `shape-${++sequence}`, Type: type, Left: 1, Top: 2, Width: 300, Height: 80, HasTextFrame: true, TextFrame: Promise.resolve({ TextRange: Promise.resolve(range) }), Delete() { this.deleted = true } }
  }
  const makeSlide = (id) => {
    const shapes = []
    const attachDuplicate = (shape) => {
      shape.Duplicate = () => {
        const duplicate = {
          ...shape, Id: `${shape.Id}-backup-${++sequence}`, deleted: false,
          Delete() {
            if (typeof ignore.backupDelete === 'function') return ignore.backupDelete(this, shapes)
            this.deleted = true
          },
        }
        attachDuplicate(duplicate); shapes.push(duplicate); return duplicate
      }
      return shape
    }
    const comments = []
    const collection = {
      get Count() { return shapes.filter((shape) => !shape.deleted).length },
      Item(index) { return shapes.filter((shape) => !shape.deleted)[index - 1] },
      AddTextbox(options) { collection.lastTextBoxOptions = options; if (ignore.textbox) return false; const shape = textShape({ value: '' }); Object.assign(shape, { Left: options.Left, Top: options.Top, Width: options.Width, Height: options.Height }); shapes.push(attachDuplicate(shape)); return shape },
      InsertTable(options) { collection.lastTableOptions = options; if (ignore.table) return undefined; shapes.push(attachDuplicate({ Id: `table-${++sequence}`, Type: 'table', HasTableFrame: true, Left: options.Left + (ignore.tableGeometry ? 1 : 0), Top: options.Top, Width: options.Width, Height: options.Height, rows: options.Row + (ignore.tableRows ? 1 : 0), columns: options.Col, Delete() { this.deleted = true } })) },
      InsertChart(options) { collection.lastChartOptions = options; if (ignore.chart) return undefined; shapes.push(attachDuplicate({ Id: `chart-${++sequence}`, Type: 'chart', Chart: { chartType: ignore.chartType ? 5 : options.ChartType }, Left: options.Left + (ignore.chartGeometry ? 1 : 0), Top: options.Top, Width: options.Width, Height: options.Height, Delete() { this.deleted = true } })) },
      AddPicture(options) { collection.lastPictureOptions = options; if (ignore.image) return false; const shape = attachDuplicate({ Id: `image-${++sequence}`, Type: 'image', FileName: ignore.imageFile ? '/wrong/image.png' : options.FileName, Left: options.Left + (ignore.imageGeometry ? 1 : 0), Top: options.Top, Width: options.Width, Height: options.Height, Delete() { this.deleted = true } }); shapes.push(shape); return shape },
    }
    const notes = textShape({ value: '原备注', appendTrailingCarriageReturn: ignore.notesTrailingCarriageReturn === true })
    const commentsCollection = {
      get Count() { return comments.length },
      Item(index) { return comments[index - 1] },
      Add(options) { if (ignore.comment) return undefined; comments.push({ Id: `comment-${comments.length + 1}`, Text: options.Text, Author: options.Replyer ?? '默认作者' }) },
    }
    return { Id: id, Shapes: collection, getObjects: () => shapes.filter((shape) => !shape.deleted), NotesPage: Promise.resolve({ TextShape: Promise.resolve(notes) }), Comments: commentsCollection, _shapes: shapes, _comments: comments, _collection: collection, _attachDuplicate: attachDuplicate }
  }
  const first = makeSlide('slide-1'); const second = makeSlide('slide-2'); const slides = [first, second]
  const sections = [{ Id: 'section-1', Name: '第一节' }, { Id: 'section-2', Name: '第二节' }]
  for (const slide of slides) slide.MoveTo = (position) => { if (ignore.move) return false; const from = slides.indexOf(slide); slides.splice(from, 1); slides.splice(position - 1, 0, slide) }
  const presentation = {
    Id: 'advanced-doc', Name: 'advanced.pptx', getSlides: () => slides, getCurrentSlide: () => slides[0],
    BuiltinDocumentProperties: (name) => name === 'Title' ? property : null,
    Sections: Promise.resolve({ GetAllSections: () => sections, Move({ SectionIndex, ToPos }) { const [section] = sections.splice(SectionIndex, 1); sections.splice(ToPos, 0, section) } }),
  }
  return { presentation, slides, property, sections }
}

async function previewAndCommit(run, operation, payload) {
  const preview = await run({ action: 'inspect_write', operation, payload })
  assert.equal(preview.ok, true, `${operation} preview: ${JSON.stringify(preview)}`)
  const result = await run({ action: 'write', operation, payload, resource: preview.result.resource, precondition: preview.result.precondition })
  return { preview, result }
}

test('PPT advanced operations expose action-level capabilities and previews are read-only', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const capabilities = await run({ action: 'inspect_capabilities' })
  for (const operation of ['manage_tables', 'manage_charts', 'manage_notes', 'manage_comments', 'manage_metadata', 'manage_structure', 'render_scene']) assert.ok(capabilities.result.operations[operation].actions.length, operation)
  const before = advanced.slides[0]._shapes.length
  const preview = await run({ action: 'inspect_write', operation: 'manage_tables', payload: { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 1, top: 2, width: 3, height: 4 } })
  assert.equal(preview.ok, true)
  assert.equal(advanced.slides[0]._shapes.length, before)
})

test('PPT manages tables, charts, notes, comments, metadata, and scene with exact readback', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const cases = [
    ['manage_tables', { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 1, top: 2, width: 30, height: 40 }],
    ['manage_charts', { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 30, height: 40 }],
    ['manage_notes', { action: 'replace', slideIndex: 0, text: '新备注' }],
    ['manage_comments', { action: 'add', slideIndex: 0, text: '新批注' }],
    ['manage_metadata', { action: 'set_builtin', name: 'Title', value: '新标题' }],
    ['render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '场景标题', left: 1, top: 2, width: 30, height: 40 }, { type: 'table', rows: 2, columns: 2, left: 1, top: 44, width: 30, height: 40 }, { type: 'chart', chartType: 5, left: 35, top: 2, width: 30, height: 40 }, { type: 'image', fileName: '/tmp/scene.png', left: 35, top: 44, width: 30, height: 40 }] }],
  ]
  for (const [operation, payload] of cases) { const { result } = await previewAndCommit(run, operation, payload); assert.equal(result.ok, true, operation); assert.equal(result.result.status, 'verified_write') }
  assert.equal(advanced.property.Value, '新标题')
  assert.equal(advanced.slides[0]._comments[0].Text, '新批注')
})

test('PPT renders one bounded SVG visual as the only full-slide image and reads it back', async () => {
  const advanced = fakeAdvancedPresentation()
  const existing = advanced.slides[0]._collection.AddTextbox({ Left: 1, Top: 2, Width: 30, Height: 40 })
  let typeReads = 0
  Object.defineProperty(existing, 'Type', { configurable: true, get: () => { typeReads += 1; return 'textBox' } })
  const run = await runtimeWith(advanced.presentation)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#13213c"/><text x="72" y="120" fill="white">AI 赋能团队</text></svg>'
  const capabilities = await run({ action: 'inspect_capabilities' })
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.render_slide_visual.actions)), ['replace_visual'])
  const preview = await run({ action: 'inspect_write', operation: 'render_slide_visual', payload: { action: 'replace_visual', slideIndex: 0, svg, left: 0, top: 0, width: 960, height: 540 } })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(typeReads, 2, 'whole-slide visual preview must snapshot each existing shape only once')
  assert.deepEqual(Object.keys(preview.result.summary.effect.visual).sort(), ['byteLength', 'format', 'hash', 'height', 'left', 'top', 'width'])
  assert.equal(JSON.stringify(preview.result.summary).includes(svg), false)
  const committed = await run({ action: 'write', operation: 'render_slide_visual', payload: { action: 'replace_visual', slideIndex: 0, svg, left: 0, top: 0, width: 960, height: 540 }, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(committed.result.status, 'verified_write')
  assert.equal(committed.result.observed.objectCount, 1)
  assert.equal(advanced.slides[0]._collection.lastPictureOptions.Left, 0)
  assert.match(committed.result.observed.objects[0].fileName, /^data:image\/svg\+xml;base64,/)
  for (const unsafeSvg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/asset.png"/></svg>',
  ]) {
    const rejected = await run({ action: 'inspect_write', operation: 'render_slide_visual', payload: { action: 'replace_visual', slideIndex: 0, svg: unsafeSvg, left: 0, top: 0, width: 960, height: 540 } })
    assert.equal(rejected.error.code, 'invalid_request')
  }
})

test('PPT manage_structure moves the requested slide and reads back order', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'manage_structure', { action: 'move_slide', slideIndex: 0, toIndex: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(advanced.slides.map((slide) => slide.Id), ['slide-2', 'slide-1'])
})

test('PPT manage_structure uses the WPS Sections.Move object contract', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'manage_structure', { action: 'move_section', sectionIndex: 0, toPos: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(advanced.sections.map((section) => section.Id), ['section-2', 'section-1'])
})

test('PPT advanced writes block drift, API absence, and failed readback', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const payload = { action: 'set_builtin', name: 'Title', value: '应阻断' }
  const preview = await run({ action: 'inspect_write', operation: 'manage_metadata', payload })
  advanced.property.Value = '外部修改'
  const stale = await run({ action: 'write', operation: 'manage_metadata', payload, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(stale.error.code, 'fingerprint_mismatch')
  const withoutChartApi = fakeAdvancedPresentation(); delete withoutChartApi.slides[0].Shapes.InsertChart
  const missing = await runtimeWith(withoutChartApi.presentation)
  const absent = await missing({ action: 'inspect_write', operation: 'manage_charts', payload: { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 3, height: 4 } })
  assert.equal(absent.ok, false)
  assert.equal(absent.error.code, 'unsupported')
  const failing = await runtimeWith(fakeAdvancedPresentation({ ignore: { text: true } }).presentation)
  const result = await previewAndCommit(failing, 'manage_notes', { action: 'replace', slideIndex: 0, text: '不会写入' })
  assert.equal(result.result.ok, false)
  assert.equal(result.result.error.code, 'readback_mismatch')
})

test('PPT writes reject resource fingerprint drift before invoking the API', async () => {
  let called = false
  const run = await runtimeWith(fakePresentation({ methods: { save: () => { called = true } } }))
  const result = await run({ action: 'write', operation: 'save', payload: { action: 'save' }, precondition: { resourceFingerprint: 'stale-fingerprint', slideCount: 1, currentSlide: 0 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'fingerprint_mismatch')
  assert.equal(called, false)
})

test('PPT save uses the discovered adapter and returns same-target structural readback', async () => {
  let called = false
  const presentation = fakePresentation({ methods: { save: () => ({ saved: (called = true) }) } })
  const run = await runtimeWith(presentation)
  const preview = await run({ action: 'inspect_write', operation: 'save', payload: { action: 'save' } })
  const result = await run({ action: 'write', operation: 'save', payload: { action: 'save' }, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(result.ok, true)
  assert.equal(result.result.status, 'verified_write')
  assert.equal(result.result.observed.objectCount, 1)
  assert.equal(called, true)
})

test('PPT selection reports unsupported instead of fabricating a selection', async () => {
  const run = await runtimeWith(fakePresentation())
  const result = await run({ action: 'selection' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unsupported')
})

test('PPT probe is false-ready when no presentation object exists', async () => {
  const run = await runtimeWith({})
  const result = await run({ action: 'probe' })
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { status: 'probe', ready: false, capabilities: {}, methods: [] })
})

test('PPT runtime uses the probed WPS public proxy and never calls ActivePresentation as a function', async () => {
  const run = await runtimeWith(null, { wps: fakePublicWps() })
  const inspected = await run({ action: 'inspect_write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' } })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.result.status, 'ok')
  assert.equal(inspected.result.resource.presentationName, '真实探测.pptx')
  assert.equal(inspected.result.resource.slideCount, 1)
  assert.equal(typeof inspected.result.precondition.resourceFingerprint, 'string')
  const context = await run({ action: 'get_context' })
  assert.equal(context.ok, true)
  assert.equal(context.result.objects[0].text, '旧标题')
  const selection = await run({ action: 'selection' })
  assert.equal(selection.ok, true)
  assert.equal(selection.result.resource.kind, 'webedit_presentation')
  assert.equal(selection.result.resource.slideCount, 1)
  const changed = await run({ action: 'write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' }, resource: inspected.result.resource, precondition: inspected.result.precondition })
  assert.equal(changed.ok, true)
  assert.equal(changed.result.status, 'verified_write')
  assert.equal(changed.result.observed.verified, true)
  assert.equal(changed.result.observed.resource.fingerprint, changed.result.resource.fingerprint)
})

test('PPT write rejects target snapshot drift before mutating the target', async () => {
  const wps = fakePublicWps(); const run = await runtimeWith(null, { wps })
  const preview = await run({ action: 'inspect_write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' } })
  const range = await wps.__shape.TextFrame.then((frame) => frame.TextRange)
  range.Text = '外部变化'
  const result = await run({ action: 'write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' }, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'fingerprint_mismatch')
  assert.equal(range.Text, '外部变化')
})

test('PPT write refuses to claim verification when TextRange ignores the requested text', async () => {
  const wps = fakePublicWps({ ignoreText: true }); const run = await runtimeWith(null, { wps })
  const preview = await run({ action: 'inspect_write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' } })
  const result = await run({ action: 'write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: '新标题' }, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'readback_mismatch')
})

test('PPT edit_selection consumes the real payload envelope and verifies selected-object bounds', async () => {
  const wps = fakePublicWps(); const run = await runtimeWith(null, { wps })
  const payload = { action: 'update', slideIndex: 0, edit: { x: 42 } }
  const preview = await run({ action: 'inspect_write', operation: 'edit_selection', payload })
  const result = await run({ action: 'write', operation: 'edit_selection', payload, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(result.ok, true)
  assert.equal(result.result.observed.verified, true)
  assert.equal(result.result.observed.objects[0].bounds.x, 42)
})

test('PPT treats WPS awaitable function properties as properties, never methods', async () => {
  const wps = fakePublicWps(); const presentation = await wps.Application.ActivePresentation; const slides = await presentation.Slides; const slide = await slides.Item(1); const frame = await wps.__shape.TextFrame; const range = await frame.TextRange
  wps.__shape.TextFrame = thenableProperty({ TextRange: thenableProperty(range) })
  slide.NotesPage = thenableProperty({ TextShape: thenableProperty(wps.__shape) })
  slide.Comments = thenableProperty({ Count: 0, Item: () => null, Add: () => undefined })
  slide.SlideID = thenableProperty(11)
  presentation.Slides = thenableProperty(slides)
  presentation.SlideShowWindow = thenableProperty({ View: thenableProperty({ Slide: thenableProperty(slide), SlideIndex: thenableProperty(1) }) })
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => thenableProperty(presentation) }); wps.Application = application
  const run = await runtimeWith(null, { wps })
  const context = await run({ action: 'get_context' })
  assert.equal(context.ok, true)
  const notes = await run({ action: 'inspect_write', operation: 'manage_notes', payload: { action: 'replace', slideIndex: 0, text: '代理备注' } })
  assert.equal(notes.ok, true)
  const comments = await run({ action: 'inspect_write', operation: 'manage_comments', payload: { action: 'add', slideIndex: 0, text: '代理批注' } })
  assert.equal(comments.ok, true)
})

test('PPT does not advertise unavailable write actions', async () => {
  const run = await runtimeWith(fakePresentation())
  const result = await run({ action: 'inspect_capabilities' })
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.operations.edit_selection.actions)), [])
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.operations.manage_objects.actions)), [])
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.operations.manage_slides.actions)), [])
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.operations.save.actions)), [])
})

test('PPT select must change the active slide before it is verified', async () => {
  const make = (noOp) => {
    let current
    const one = { Id: 'one', getObjects: () => [] }; const two = { Id: 'two', getObjects: () => [], Select() { if (!noOp) current = two } }
    current = one
    return { getSlides: () => [one, two], getCurrentSlide: () => current }
  }
  for (const [noOp, expected] of [[false, true], [true, false]]) {
    const run = await runtimeWith(make(noOp)); const payload = { action: 'select', slideIndex: 1 }; const { result } = await previewAndCommit(run, 'manage_slides', payload)
    assert.equal(result.ok, expected)
    if (!expected) assert.equal(result.error.code, 'readback_mismatch')
  }
})

test('PPT uses the documented positional Slides.AddSlide API and verifies the created slide', async () => {
  const slides = []; const make = (id) => ({ Id: id, Shapes: { Count: 0, Item: () => null } }); slides.push(make('slide-1'))
  const collection = { get Count() { return slides.length }, Item: (index) => slides[index - 1], AddSlide(index) { const slide = make(`slide-${slides.length + 1}`); if (index === undefined || index < 0) slides.splice(1, 0, slide); else slides.splice(index, 0, slide); return slide } }
  const presentation = { Id: 'add-doc', Name: 'add.pptx', Slides: Promise.resolve(collection), CurrentSlide: Promise.resolve(slides[0]) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  const run = await runtimeWith(null, { wps: { Application: application } })
  const capabilities = await run({ action: 'inspect_capabilities' })
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_slides.actions)), ['add'])
  const { result } = await previewAndCommit(run, 'manage_slides', { action: 'add', index: -1 })
  assert.equal(result.ok, true)
  assert.equal(result.result.requested.createdId, 'slide-2')
  assert.deepEqual(slides.map((slide) => slide.Id), ['slide-1', 'slide-2'])
})

test('PPT preserves legacy PowerPoint collection aliases for creating slides and shapes', async () => {
  const shapes = []
  let nextShapeId = 0
  const createdShape = (value) => ({ Id: `alias-shape-${++nextShapeId}`, Left: value.Left, Top: value.Top, Width: value.Width, Height: value.Height, Delete() { shapes.splice(shapes.indexOf(this), 1) }, ...value })
  const shapeCollection = {
    get Count() { return shapes.length },
    Item: (index) => shapes[index - 1],
    AddTextBox(options) {
      let text = ''
      const range = {}; Object.defineProperty(range, 'Text', { enumerable: true, get: () => text, set: (value) => { text = value } })
      const shape = createdShape({ Type: 'textBox', HasTextFrame: true, ...options, TextFrame: Promise.resolve({ TextRange: Promise.resolve(range) }) })
      shapes.push(shape); return shape
    },
    AddTable(options) { const shape = createdShape({ Type: 'table', HasTableFrame: true, ...options, rows: options.NumRows, columns: options.NumColumns }); shapes.push(shape); return shape },
    AddChart(options) { const shape = createdShape({ Type: 'chart', ...options, Chart: { chartType: options.ChartType } }); shapes.push(shape); return shape },
  }
  const slide = { Id: 'slide-1', Shapes: Promise.resolve(shapeCollection), Delete() {}, Select() {} }
  const slideItems = [slide]
  const slides = {
    get Count() { return slideItems.length },
    Item: (index) => slideItems[index - 1] ?? null,
    Add() { const added = { Id: `slide-${slideItems.length + 1}`, Shapes: Promise.resolve({ Count: 0, Item: () => null }) }; slideItems.push(added); return added },
  }
  const presentation = { Name: 'live-aliases.pptx', Slides: Promise.resolve(slides), CurrentSlide: Promise.resolve(slide) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  const run = await runtimeWith(null, { wps: { Application: application } })
  const capabilities = await run({ action: 'inspect_capabilities' })
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_slides.actions)), ['delete', 'select', 'add'])
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_tables.actions)), ['insert'])
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_charts.actions)), ['insert'])
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.render_scene.actions)), ['replace_scene'])
  assert.ok(capabilities.result.methods.includes('render_scene:Shapes.AddTextBox'))
  assert.ok(capabilities.result.methods.includes('tables:Shapes.AddTable'))
  assert.ok(capabilities.result.methods.includes('charts:Shapes.AddChart'))
  const table = await previewAndCommit(run, 'manage_tables', { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 10, top: 20, width: 300, height: 120 })
  assert.equal(table.result.ok, true)
  assert.equal(table.result.result.observed.verified, true)
  const chart = await previewAndCommit(run, 'manage_charts', { action: 'insert', slideIndex: 0, chartType: 'columnClustered', left: 20, top: 30, width: 320, height: 180 })
  assert.equal(chart.result.ok, true)
  assert.equal(chart.result.result.observed.verified, true)
  const added = await previewAndCommit(run, 'manage_slides', { action: 'add', index: -1 })
  assert.equal(added.result.ok, true)
  assert.equal(added.result.result.observed.verified, true)
  assert.equal(slideItems.length, 2)
})

test('PPT keeps unverified thenable WebEdit shape commands fail-closed', async () => {
  const publicMethod = (fn = () => {}) => Object.assign(fn, { then() {} })
  const shapes = {
    Count: 0,
    Item: () => null,
    AddTextbox: publicMethod(),
    InsertTable: publicMethod(),
    InsertChart: publicMethod(),
  }
  const slide = { SlideID: 1, Shapes: Promise.resolve(shapes) }
  const slides = { Count: 1, Item: () => slide, AddSlide: publicMethod() }
  const presentation = { Slides: Promise.resolve(slides), CurrentSlide: Promise.resolve(slide) }
  const application = {}; Object.defineProperty(application, 'ActivePresentation', { get: () => Promise.resolve(presentation) })
  const run = await runtimeWith(null, { wps: { Application: application } })
  const capabilities = await run({ action: 'inspect_capabilities' })
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_slides.actions)), ['add'])
  assert.equal(capabilities.result.methods.includes('render_scene:Shapes.AddTextbox'), false)
  assert.equal(capabilities.result.methods.includes('tables:Shapes.InsertTable'), false)
  assert.equal(capabilities.result.methods.includes('charts:Shapes.InsertChart'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_tables.actions)), [])
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.manage_charts.actions)), [])
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities.result.operations.render_scene.actions)), [])
})

test('PPT verifies notes when WebEdit appends exactly one terminal carriage return', async () => {
  const advanced = fakeAdvancedPresentation({ ignore: { notesTrailingCarriageReturn: true } })
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'manage_notes', { action: 'replace', slideIndex: 0, text: '测试备注' })
  assert.equal(result.ok, true)
  assert.equal(result.result.status, 'verified_write')
})

test('PPT render_scene replaces old shapes and refuses a non-deletable old scene', async () => {
  const advanced = fakeAdvancedPresentation(); const old = { Id: 'old-shape', Type: 'textBox', Text: '旧对象', Left: 1, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } }
  advanced.slides[0]._shapes.push(advanced.slides[0]._attachDuplicate(old)); const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '新对象', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(result.ok, true)
  assert.equal(old.deleted, true)
  assert.equal(advanced.slides[0]._shapes.filter((shape) => !shape.deleted).length, 1)
  const blocked = fakeAdvancedPresentation(); blocked.slides[0]._shapes.push({ Id: 'cannot-delete', Type: 'textBox' })
  const blockedRun = await runtimeWith(blocked.presentation)
  const preview = await blockedRun({ action: 'inspect_write', operation: 'render_scene', payload: { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '不可写', left: 1, top: 2, width: 3, height: 4 }] } })
  assert.equal(preview.ok, false)
  assert.equal(preview.error.code, 'unsupported')
})

test('PPT reads the live public SlideShowWindow.View slide instead of defaulting to slide zero', async () => {
  const fixture = fakeMultiSlidePublicWps(); const run = await runtimeWith(null, { wps: fixture.wps })
  const second = await run({ action: 'get_context' })
  assert.equal(second.ok, true)
  assert.equal(second.result.currentSlide, 1)
  assert.equal(second.result.id, 202)
  fixture.setCurrent(2)
  const third = await run({ action: 'get_context' })
  assert.equal(third.ok, true)
  assert.equal(third.result.currentSlide, 2)
  assert.equal(third.result.id, 303)
  const missing = await run({ action: 'get_context', slideIndex: 99 })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'invalid_request')
})

test('PPT uses SlideID and SlideID2 for comments, selection, ordering, and created slide identity', async () => {
  const fixture = fakeMultiSlidePublicWps(); const run = await runtimeWith(null, { wps: fixture.wps })
  const comment = await previewAndCommit(run, 'manage_comments', { action: 'add', slideIndex: 0, text: 'SlideID 批注' })
  assert.equal(comment.result.ok, true)
  assert.equal(fixture.slides[0]._comments.lastAdd.SlideId, 101)

  const selected = await previewAndCommit(run, 'manage_slides', { action: 'select', slideIndex: 0 })
  assert.equal(selected.result.ok, true)
  assert.equal(selected.result.result.observed.id, 101)
  assert.equal(fixture.currentIndex, 0)

  const moved = await previewAndCommit(run, 'manage_structure', { action: 'move_slide', slideIndex: 0, toIndex: 2 })
  assert.equal(moved.result.ok, true)
  assert.deepEqual(fixture.slides.map((slide) => slide.SlideID ?? slide.SlideID2 ?? slide.Id), [202, 303, 101])

  const added = await previewAndCommit(run, 'manage_slides', { action: 'add', index: -1 })
  assert.equal(added.result.ok, true)
  assert.equal(added.result.result.requested.createdId, 401)
})

test('PPT verifies slide deletion by identity as well as collection count', async () => {
  const fixture = fakeMultiSlidePublicWps(); const run = await runtimeWith(null, { wps: fixture.wps })
  const { result } = await previewAndCommit(run, 'manage_slides', { action: 'delete', slideIndex: 0 })
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.slides.map((slide) => slide.SlideID ?? slide.SlideID2 ?? slide.Id), [202, 303])
  const identityless = { getObjects: () => [], Delete() {} }
  const identitylessRun = await runtimeWith({ getSlides: () => [identityless], getCurrentSlide: () => identityless })
  const unsupported = await identitylessRun({ action: 'inspect_write', operation: 'manage_slides', payload: { action: 'delete', slideIndex: 0 } })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'unsupported')
})

test('PPT requires explicit zero-based target indexes before any mutation', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const cases = [
    ['replace_text_box', { textBoxIndex: 0, text: 'x' }],
    ['replace_text_box', { slideIndex: 0, text: 'x' }],
    ['edit_selection', { edit: { x: 9 } }],
    ['manage_objects', { action: 'update', objectIndex: 0, object: { x: 9 } }],
    ['manage_objects', { action: 'delete', slideIndex: 0 }],
    ['manage_tables', { action: 'insert', rows: 1, columns: 1, left: 1, top: 1, width: 2, height: 2 }],
    ['manage_charts', { action: 'insert', chartType: 51, left: 1, top: 1, width: 2, height: 2 }],
    ['manage_notes', { action: 'replace', text: 'x' }],
    ['manage_comments', { action: 'add', text: 'x' }],
    ['render_scene', { action: 'replace_scene', elements: [{ type: 'text', text: 'x', left: 1, top: 1, width: 2, height: 2 }] }],
    ['manage_slides', { action: 'delete' }],
    ['manage_slides', { action: 'select' }],
    ['manage_structure', { action: 'move_slide', toIndex: 1 }],
  ]
  for (const [operation, payload] of cases) {
    const result = await run({ action: 'inspect_write', operation, payload })
    assert.equal(result.ok, false, operation)
    assert.equal(result.error.code, 'invalid_request', operation)
  }
  assert.equal(advanced.slides[0]._shapes.length, 0)
  assert.equal(advanced.slides[0]._comments.length, 0)
  assert.equal(advanced.property.Value, '初始标题')
})

test('PPT rejects an unknown top-level field before previewing every named write action', async () => {
  const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
  const cases = [
    ['manage_slides', { action: 'add' }], ['manage_slides', { action: 'delete', slideIndex: 0 }], ['manage_slides', { action: 'select', slideIndex: 0 }],
    ['render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'x', left: 1, top: 2, width: 3, height: 4 }] }],
    ['edit_selection', { action: 'update', slideIndex: 0, edit: { x: 1 } }],
    ['manage_objects', { action: 'delete', slideIndex: 0, objectIndex: 0 }], ['manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: { x: 1 } }],
    ['manage_tables', { action: 'insert', slideIndex: 0, rows: 1, columns: 1, left: 1, top: 2, width: 3, height: 4 }],
    ['manage_charts', { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 3, height: 4 }],
    ['manage_notes', { action: 'replace', slideIndex: 0, text: 'x' }], ['manage_comments', { action: 'add', slideIndex: 0, text: 'x' }],
    ['manage_metadata', { action: 'set_builtin', name: 'Title', value: 'x' }],
    ['manage_structure', { action: 'move_slide', slideIndex: 0, toIndex: 1 }], ['manage_structure', { action: 'move_section', sectionIndex: 0, toPos: 1 }],
    ['replace_text_box', { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: 'x' }], ['save', { action: 'save' }],
  ]
  const before = { shapes: advanced.slides[0]._shapes.length, comments: advanced.slides[0]._comments.length, title: advanced.property.Value, slides: advanced.slides.map((slide) => slide.Id) }
  for (const [operation, payload] of cases) {
    const result = await run({ action: 'inspect_write', operation, payload: { ...payload, unapproved: true } })
    assert.equal(result.ok, false, `${operation}:${payload.action}`)
    assert.equal(result.error.code, 'invalid_request', `${operation}:${payload.action}`)
  }
  for (const [operation, payload] of [
    ['edit_selection', { action: 'update', slideIndex: 0, edit: { x: 1, styleMode: true } }],
    ['manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: { x: 1, styleMode: true } }],
  ]) {
    const result = await run({ action: 'inspect_write', operation, payload })
    assert.equal(result.ok, false, operation)
    assert.equal(result.error.code, 'invalid_request', operation)
  }
  assert.deepEqual({ shapes: advanced.slides[0]._shapes.length, comments: advanced.slides[0]._comments.length, title: advanced.property.Value, slides: advanced.slides.map((slide) => slide.Id) }, before)
})

test('PPT rejects identityless object deletion and scene fields without a verified readback', async () => {
  const identitylessShape = { Type: 'textBox', Left: 1, Top: 2, Width: 3, Height: 4, Delete() { this.deleted = true } }
  const slide = { Id: 'slide-1', getObjects: () => [identitylessShape] }
  const run = await runtimeWith({ getSlides: () => [slide], getCurrentSlide: () => slide })
  const deletion = await run({ action: 'inspect_write', operation: 'manage_objects', payload: { action: 'delete', slideIndex: 0, objectIndex: 0 } })
  assert.equal(deletion.ok, false)
  assert.equal(deletion.error.code, 'unsupported')
  assert.equal(identitylessShape.deleted, undefined)

  const advanced = fakeAdvancedPresentation(); const sceneRun = await runtimeWith(advanced.presentation)
  for (const element of [
    { type: 'text', text: 'x', left: 1, top: 2, width: 3, height: 4, orientation: 1 },
    { type: 'image', fileName: '/tmp/x.png', left: 1, top: 2, width: 3, height: 4, scale: 1 },
    { type: 'table', rows: 1, columns: 1, left: 1, top: 2, width: 3, height: 4, useScale: true },
    { type: 'chart', chartType: 51, left: 1, top: 2, width: 3, height: 4, chartStyle: 240 },
  ]) {
    const preview = await sceneRun({ action: 'inspect_write', operation: 'render_scene', payload: { action: 'replace_scene', slideIndex: 0, elements: [element] } })
    assert.equal(preview.ok, false)
    assert.equal(preview.error.code, 'invalid_request')
  }
  const table = await sceneRun({ action: 'inspect_write', operation: 'manage_tables', payload: { action: 'insert', slideIndex: 0, rows: 1, columns: 1, left: 1, top: 2, width: 3, height: 4, useScale: true } })
  assert.equal(table.ok, false); assert.equal(table.error.code, 'invalid_request')
})

test('PPT omits unapproved WPS defaults from table and scene calls', async () => {
  const table = fakeAdvancedPresentation(); const tableRun = await runtimeWith(table.presentation)
  const tableWrite = await previewAndCommit(tableRun, 'manage_tables', { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 1, top: 2, width: 30, height: 40 })
  assert.equal(tableWrite.result.ok, true)
  assert.equal(Object.hasOwn(table.slides[0]._collection.lastTableOptions, 'UseScale'), false)

  const scene = fakeAdvancedPresentation(); const sceneRun = await runtimeWith(scene.presentation)
  const sceneWrite = await previewAndCommit(sceneRun, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [
    { type: 'text', text: '无默认方向', left: 1, top: 2, width: 30, height: 40 },
    { type: 'image', fileName: '/tmp/picture.png', left: 35, top: 2, width: 30, height: 40 },
  ] })
  assert.equal(sceneWrite.result.ok, true)
  assert.equal(Object.hasOwn(scene.slides[0]._collection.lastTextBoxOptions, 'Orientation'), false)
  assert.equal(Object.hasOwn(scene.slides[0]._collection.lastPictureOptions, 'LinkToFile'), false)
  assert.equal(Object.hasOwn(scene.slides[0]._collection.lastPictureOptions, 'SaveWithDocument'), false)
})

test('PPT rejects zero and empty-string object IDs before delete preview', async () => {
  for (const id of [0, '']) {
    const shape = { Id: id, Type: 'textBox', Left: 1, Top: 2, Width: 3, Height: 4, Delete() { this.deleted = true } }
    const slide = { Id: 'slide-1', getObjects: () => [shape] }
    const run = await runtimeWith({ getSlides: () => [slide], getCurrentSlide: () => slide })
    const preview = await run({ action: 'inspect_write', operation: 'manage_objects', payload: { action: 'delete', slideIndex: 0, objectIndex: 0 } })
    assert.equal(preview.ok, false, String(id))
    assert.equal(preview.error.code, 'unsupported', String(id))
    assert.equal(shape.deleted, undefined, String(id))
  }
})

test('PPT sends whitelisted numeric or named chart enums as numbers', async () => {
  for (const [input, expected] of [[51, 51], ['51', 51], ['barClustered', 57]]) {
    const advanced = fakeAdvancedPresentation(); const run = await runtimeWith(advanced.presentation)
    const { result } = await previewAndCommit(run, 'manage_charts', { action: 'insert', slideIndex: 0, chartType: input, left: 1, top: 2, width: 30, height: 40 })
    assert.equal(result.ok, true)
    assert.equal(advanced.slides[0]._collection.lastChartOptions.ChartType, expected)
  }
})

test('PPT save verifies only explicit business success and rejects known business failures', async () => {
  const failures = [false, { result: 'fail' }, { result: 'SpaceFull' }, { SpaceFull: true }, { errorCode: 7 }, { errorCode: 'E_SPACE' }, { saved: false }, { success: false }, { ok: false }]
  for (const saveResult of failures) {
    const run = await runtimeWith(fakePresentation({ methods: { save: () => saveResult } }))
    const { result } = await previewAndCommit(run, 'save', { action: 'save' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'write_rejected')
  }
  const ambiguous = [undefined, null, {}, { errorCode: 0 }, { message: 'done' }]
  for (const saveResult of ambiguous) {
    const run = await runtimeWith(fakePresentation({ methods: { save: () => saveResult } }))
    const { result } = await previewAndCommit(run, 'save', { action: 'save' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'readback_mismatch')
  }
  const successes = [true, { saved: true }, { success: true }, { ok: true }, { result: 'success' }]
  for (const saveResult of successes) {
    const run = await runtimeWith(fakePresentation({ methods: { save: () => saveResult } }))
    const { result } = await previewAndCommit(run, 'save', { action: 'save' })
    assert.equal(result.ok, true)
    assert.equal(result.result.status, 'verified_write')
  }
})

test('PPT render_scene reports write_incomplete when old-scene deletion is partial or a no-op', async () => {
  const partial = fakeAdvancedPresentation()
  const deleted = { Id: 'old-1', Type: 'textBox', Text: 'one', Left: 1, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } }
  const retained = { Id: 'old-2', Type: 'textBox', Text: 'two', Left: 35, Top: 2, Width: 30, Height: 40, Delete() { return false } }
  partial.slides[0]._shapes.push(partial.slides[0]._attachDuplicate(deleted), partial.slides[0]._attachDuplicate(retained))
  const partialRun = await runtimeWith(partial.presentation)
  const partialWrite = await previewAndCommit(partialRun, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'new', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(partialWrite.result.ok, false)
  assert.equal(partialWrite.result.error.code, 'write_incomplete')
  assert.deepEqual(JSON.parse(JSON.stringify(partialWrite.result.error.details)), { deletedCount: 1, totalOldShapes: 2, createdCount: 1, rollbackComplete: true, survivors: [{ index: 0, id: 'old-2', type: 'textBox', text: 'two', bounds: { x: 35, y: 2, width: 30, height: 40 }, hasTextFrame: null }, { index: 1, id: 'old-1-backup-3', type: 'textBox', text: 'one', bounds: { x: 1, y: 2, width: 30, height: 40 }, hasTextFrame: null }] })

  const noOp = fakeAdvancedPresentation(); noOp.slides[0]._shapes.push(noOp.slides[0]._attachDuplicate({ Id: 'old-no-op', Type: 'textBox', Text: 'old', Left: 1, Top: 2, Width: 30, Height: 40, Delete() {} }))
  const noOpRun = await runtimeWith(noOp.presentation)
  const noOpWrite = await previewAndCommit(noOpRun, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'new', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(noOpWrite.result.ok, false)
  assert.equal(noOpWrite.result.error.code, 'write_rejected')
  assert.equal(noOpWrite.result.error.details.deletedCount, 0)
  assert.equal(noOpWrite.result.error.details.rollbackComplete, true)
})

test('PPT render_scene restores exact Duplicate backups instead of recreating empty table/chart/text shells', async () => {
  const advanced = fakeAdvancedPresentation(); const slide = advanced.slides[0]
  const formattedText = slide._attachDuplicate({ Id: 'formatted-text', Type: 'textBox', Text: '保留格式的标题', Left: 1, Top: 2, Width: 30, Height: 10, TextStyle: { Font: 'Aptos', Bold: true, Color: '#f00' }, Delete() { this.deleted = true } })
  const populatedTable = slide._attachDuplicate({ Id: 'populated-table', Type: 'table', HasTableFrame: true, Left: 1, Top: 14, Width: 30, Height: 20, rows: 2, columns: 2, Cells: [['A', 'B'], ['C', 'D']], TableStyle: 'Accent1', Delete() { this.deleted = true } })
  const chartWithSeries = slide._attachDuplicate({ Id: 'series-chart', Type: 'chart', Chart: { chartType: 51, Series: [{ Name: '收入', Values: [1, 2] }] }, Left: 35, Top: 2, Width: 30, Height: 20, Delete() { return false } })
  slide._shapes.push(formattedText, populatedTable, chartWithSeries)
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: 'new', left: 1, top: 1, width: 2, height: 2 }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write_incomplete')
  const remaining = slide._shapes.filter((shape) => !shape.deleted)
  const restoredText = remaining.find((shape) => shape.Id === 'formatted-text' || String(shape.Id).startsWith('formatted-text-backup'))
  const restoredTable = remaining.find((shape) => shape.Id === 'populated-table' || String(shape.Id).startsWith('populated-table-backup'))
  const restoredChart = remaining.find((shape) => shape.Id === 'series-chart' || String(shape.Id).startsWith('series-chart-backup'))
  assert.deepEqual(restoredText.TextStyle, { Font: 'Aptos', Bold: true, Color: '#f00' })
  assert.deepEqual(restoredTable.Cells, [['A', 'B'], ['C', 'D']])
  assert.deepEqual(restoredChart.Chart.Series, [{ Name: '收入', Values: [1, 2] }])
})

test('PPT render_scene rejects replacement drift after originals are deleted, while exact backups still permit recovery', async () => {
  const advanced = fakeAdvancedPresentation(); const slide = advanced.slides[0]
  const old = slide._attachDuplicate({
    Id: 'old-drift', Type: 'textBox', Text: '旧标题', Left: 1, Top: 2, Width: 30, Height: 40,
    Delete() {
      this.deleted = true
      const replacement = slide._shapes.find((shape) => /^shape-/.test(String(shape.Id)) && !shape.deleted)
      replacement.Text = '已漂移'; replacement.Left = 999
    },
  })
  slide._shapes.push(old)
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '必须保持', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write_incomplete')
  assert.equal(result.error.details.rollbackComplete, true)
  const survivors = slide._shapes.filter((shape) => !shape.deleted)
  assert.equal(survivors.length, 1)
  assert.match(String(survivors[0].Id), /^old-drift-backup-/)
  assert.equal(survivors[0].Text, '旧标题')
})

test('PPT render_scene does not delete created objects when a pre-cleanup backup has disappeared', async () => {
  const advanced = fakeAdvancedPresentation(); const slide = advanced.slides[0]
  const old = slide._attachDuplicate({
    Id: 'old-lost-backup', Type: 'textBox', Text: '旧标题', Left: 1, Top: 2, Width: 30, Height: 40,
    Delete() {
      this.deleted = true
      const backup = slide._shapes.find((shape) => String(shape.Id).startsWith('old-lost-backup-backup-'))
      backup.deleted = true
    },
  })
  slide._shapes.push(old)
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '保留新对象', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write_incomplete')
  assert.equal(result.error.details.stage, 'pre_commit_recovery')
  assert.equal(result.error.details.rollbackComplete, false)
  const survivors = slide._shapes.filter((shape) => !shape.deleted)
  assert.equal(survivors.length, 1)
  assert.equal((await run({ action: 'get_context', slideIndex: 0 })).result.objects[0].text, '保留新对象')
})

test('PPT render_scene rechecks full created-scene semantics after every backup cleanup step', async () => {
  const advanced = fakeAdvancedPresentation({
    ignore: {
      backupDelete(backup, shapes) {
        backup.deleted = true
        const replacement = shapes.find((shape) => /^shape-/.test(String(shape.Id)) && !shape.deleted)
        replacement.Text = 'cleanup drift'
      },
    },
  })
  const slide = advanced.slides[0]
  const first = slide._attachDuplicate({ Id: 'old-cleanup-1', Type: 'textBox', Text: '一', Left: 1, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } })
  const second = slide._attachDuplicate({ Id: 'old-cleanup-2', Type: 'textBox', Text: '二', Left: 35, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } })
  slide._shapes.push(first, second)
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '稳定文本', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write_incomplete')
  assert.equal(result.error.details.stage, 'commit_cleanup')
  assert.notEqual(slide._shapes.find((shape) => /^shape-/.test(String(shape.Id))).deleted, true)
  assert.notEqual(slide._shapes.find((shape) => String(shape.Id).startsWith('old-cleanup-2-backup-')).deleted, true)
})

test('PPT verifies rotation writes and blocks no-op setters or post-preview rotation drift', async () => {
  const successWps = fakePublicWps(); const successRun = await runtimeWith(null, { wps: successWps })
  const success = await previewAndCommit(successRun, 'manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: { rotation: 45 } })
  assert.equal(success.result.ok, true)
  assert.equal(success.result.result.observed.objects[0].bounds.rotation, 45)

  const noOpWps = fakePublicWps({ ignoreRotation: true }); const noOpRun = await runtimeWith(null, { wps: noOpWps })
  const noOp = await previewAndCommit(noOpRun, 'manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: { rotation: 45 } })
  assert.equal(noOp.result.ok, false)
  assert.equal(noOp.result.error.code, 'write_rejected')

  const driftWps = fakePublicWps(); const driftRun = await runtimeWith(null, { wps: driftWps })
  const payload = { action: 'update', slideIndex: 0, edit: { rotation: 90 } }
  const preview = await driftRun({ action: 'inspect_write', operation: 'edit_selection', payload })
  driftWps.__shape.Rotation = 12
  const drift = await driftRun({ action: 'write', operation: 'edit_selection', payload, resource: preview.result.resource, precondition: preview.result.precondition })
  assert.equal(drift.ok, false)
  assert.equal(drift.error.code, 'fingerprint_mismatch')
  assert.equal(driftWps.__shape.Rotation, 12)
})

test('PPT treats Sections as an awaitable property during preview and write', async () => {
  const advanced = fakeAdvancedPresentation(); const sections = await advanced.presentation.Sections
  advanced.presentation.Sections = thenableProperty(sections)
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'manage_structure', { action: 'move_section', sectionIndex: 0, toPos: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(advanced.sections.map((section) => section.Id), ['section-2', 'section-1'])
})

test('PPT rejects empty or actionless object updates before mutation', async () => {
  const wps = fakePublicWps(); const run = await runtimeWith(null, { wps })
  const before = { left: wps.__shape.Left, rotation: wps.__shape.Rotation }
  const cases = [
    ['edit_selection', { slideIndex: 0, edit: { x: 42 } }],
    ['edit_selection', { action: 'update', slideIndex: 0, edit: {} }],
    ['manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0, object: {} }],
    ['manage_objects', { action: 'update', slideIndex: 0, objectIndex: 0 }],
  ]
  for (const [operation, payload] of cases) {
    const preview = await run({ action: 'inspect_write', operation, payload })
    assert.equal(preview.ok, false, operation)
    assert.equal(preview.error.code, 'invalid_request', operation)
  }
  assert.deepEqual({ left: wps.__shape.Left, rotation: wps.__shape.Rotation }, before)
})

test('PPT rejects arbitrary chart strings and accepts bounded scalar Replyer values', async () => {
  const advanced = fakeAdvancedPresentation(); const chartRun = await runtimeWith(advanced.presentation)
  for (const chartType of ['bar', 'totally-custom', 999, '999']) {
    const preview = await chartRun({ action: 'inspect_write', operation: 'manage_charts', payload: { action: 'insert', slideIndex: 0, chartType, left: 1, top: 2, width: 30, height: 40 } })
    assert.equal(preview.ok, false)
    assert.equal(preview.error.code, 'invalid_request')
  }
  const fixture = fakeMultiSlidePublicWps(); const commentRun = await runtimeWith(null, { wps: fixture.wps })
  const numeric = await previewAndCommit(commentRun, 'manage_comments', { action: 'add', slideIndex: 0, text: '数字回复人', replyer: 0 })
  assert.equal(numeric.result.ok, true)
  assert.equal(fixture.slides[0]._comments.lastAdd.Replyer, 0)
  for (const replyer of ['x'.repeat(257), -1, 1.5, {}, true]) {
    const preview = await commentRun({ action: 'inspect_write', operation: 'manage_comments', payload: { action: 'add', slideIndex: 0, text: '非法回复人', replyer } })
    assert.equal(preview.ok, false)
    assert.equal(preview.error.code, 'invalid_request')
  }
})

test('PPT refuses table and chart verification when created geometry or chart type is wrong', async () => {
  const cases = [
    ['manage_tables', { tableGeometry: true }, { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 1, top: 2, width: 30, height: 40 }],
    ['manage_tables', { tableRows: true }, { action: 'insert', slideIndex: 0, rows: 2, columns: 3, left: 1, top: 2, width: 30, height: 40 }],
    ['manage_charts', { chartGeometry: true }, { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 30, height: 40 }],
    ['manage_charts', { chartType: true }, { action: 'insert', slideIndex: 0, chartType: 51, left: 1, top: 2, width: 30, height: 40 }],
  ]
  for (const [operation, ignore, payload] of cases) {
    const advanced = fakeAdvancedPresentation({ ignore }); const run = await runtimeWith(advanced.presentation)
    const { result } = await previewAndCommit(run, operation, payload)
    assert.equal(result.ok, false, operation)
    assert.equal(result.error.code, 'readback_mismatch', operation)
  }
})

test('PPT render_scene cleans up a newly created text shape when its text readback fails', async () => {
  const advanced = fakeAdvancedPresentation({ ignore: { text: true } })
  const old = { Id: 'old-scene', Type: 'textBox', Text: '原对象', Left: 1, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } }
  advanced.slides[0]._shapes.push(advanced.slides[0]._attachDuplicate(old))
  const run = await runtimeWith(advanced.presentation)
  const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'text', text: '必须回读', left: 1, top: 2, width: 30, height: 40 }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'readback_mismatch')
  assert.equal(old.deleted, undefined)
  assert.deepEqual(advanced.slides[0]._shapes.filter((shape) => !shape.deleted).map((shape) => shape.Id), ['old-scene'])
})

test('PPT render_scene verifies image file identity and bounds before deleting the old scene', async () => {
  for (const ignore of [{ imageGeometry: true }, { imageFile: true }]) {
    const advanced = fakeAdvancedPresentation({ ignore })
    const old = { Id: 'old-image-scene', Type: 'textBox', Text: '原对象', Left: 1, Top: 2, Width: 30, Height: 40, Delete() { this.deleted = true } }
    advanced.slides[0]._shapes.push(advanced.slides[0]._attachDuplicate(old))
    const run = await runtimeWith(advanced.presentation)
    const { result } = await previewAndCommit(run, 'render_scene', { action: 'replace_scene', slideIndex: 0, elements: [{ type: 'image', fileName: '/tmp/expected.png', left: 1, top: 2, width: 30, height: 40 }] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'readback_mismatch')
    assert.equal(old.deleted, undefined)
    assert.deepEqual(advanced.slides[0]._shapes.filter((shape) => !shape.deleted).map((shape) => shape.Id), ['old-image-scene'])
  }
})

test('PPT AddSlide verifies append and explicit insertion positions', async () => {
  for (const payload of [{ action: 'add' }, { action: 'add', index: -1 }]) {
    const wrong = fakeMultiSlidePublicWps({ wrongAppend: true }); const wrongRun = await runtimeWith(null, { wps: wrong.wps })
    const { result } = await previewAndCommit(wrongRun, 'manage_slides', payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'readback_mismatch')
  }
  const positioned = fakeMultiSlidePublicWps(); const positionedRun = await runtimeWith(null, { wps: positioned.wps })
  const { result } = await previewAndCommit(positionedRun, 'manage_slides', { action: 'add', index: 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(positioned.slides.map((slide) => slide.SlideID ?? slide.SlideID2 ?? slide.Id), [101, 401, 202, 303])
})

test('PPT recognizes nochange save success and rejects documented capacity or empty-file states', async () => {
  for (const saveResult of ['nochange', { result: 'NoChange' }, { status: 'nochange' }]) {
    const run = await runtimeWith(fakePresentation({ methods: { save: () => saveResult } }))
    const { result } = await previewAndCommit(run, 'save', { action: 'save' })
    assert.equal(result.ok, true)
    assert.equal(result.result.status, 'verified_write')
  }
  for (const saveResult of ['QueneFull', 'SavedEmptyFile', { result: 'QueneFull' }, { status: 'SavedEmptyFile' }, { QueneFull: true }, { SavedEmptyFile: true }]) {
    const run = await runtimeWith(fakePresentation({ methods: { save: () => saveResult } }))
    const { result } = await previewAndCommit(run, 'save', { action: 'save' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'write_rejected')
  }
})

test('PPT runtime truncates preview strings to the connector 2000-character ceiling', async () => {
  const fixture = fakePublicWps(); const run = await runtimeWith(null, { wps: fixture })
  const preview = await run({ action: 'inspect_write', operation: 'replace_text_box', payload: { action: 'replace', slideIndex: 0, textBoxIndex: 0, text: 'x'.repeat(5000) } })
  assert.equal(preview.ok, true)
  assert.equal(preview.result.summary.effect.truncated, true)
  assert.equal(preview.result.summary.effect.preview.length, 2000)
})
