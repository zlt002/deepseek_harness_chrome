import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { fitMermaidPreview, wireMermaidViewer, wireMermaidViewToggle } from './mermaid-view.mjs'

const root = new URL('.', import.meta.url)
const style = await readFile(new URL('./style.css', root), 'utf8')

function fixture() {
  const dom = new JSDOM(`<!doctype html><style>${style}</style><div class="visual-markdown-editor"><div class="milkdown"><div class="ProseMirror"><section class="mermaid-block" data-mermaid-source="one"><div class="mermaid-toolbar"><div class="mermaid-view-toggle"><button>可视化</button><button>源码</button></div><div class="mermaid-viewer-controls"><button>缩小</button><button>放大</button><button>适应</button></div></div><div class="mermaid-preview"><div class="mermaid-canvas"><svg></svg></div></div></section><div class="milkdown-code-block" data-mermaid-source="one"><pre><code>graph TD</code></pre></div></div></div></div>`)
  const document = dom.window.document
  return {
    dom,
    source: document.querySelector('.milkdown-code-block[data-mermaid-source]'),
    block: document.querySelector('.mermaid-block'),
    preview: document.querySelector('.mermaid-preview'),
    canvas: document.querySelector('.mermaid-canvas'),
  }
}

test('visual Mermaid view hides the decorated Crepe source node despite the editor pre rule', () => {
  const { dom, source, block, preview } = fixture()
  const [visual, code] = block.querySelectorAll('.mermaid-view-toggle button')
  wireMermaidViewToggle(block, 'one', visual, code)('visual')
  assert.equal(dom.window.getComputedStyle(source).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(preview).display, 'none')
})

test('source Mermaid view removes the preview widget box rather than retaining its margins', () => {
  const { dom, source, block, preview } = fixture()
  const [visual, code] = block.querySelectorAll('.mermaid-view-toggle button')
  wireMermaidViewToggle(block, 'one', visual, code)('source')
  assert.notEqual(dom.window.getComputedStyle(source).display, 'none')
  assert.equal(dom.window.getComputedStyle(preview).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(block).display, 'contents')
})

test('Mermaid toolbar stays before both the visual canvas and the revealed source', () => {
  const { dom, source, block } = fixture()
  const toolbar = block.querySelector('.mermaid-toolbar')

  assert.equal(Boolean(toolbar.compareDocumentPosition(source) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING), true)
  assert.equal(Boolean(toolbar.compareDocumentPosition(block.querySelector('.mermaid-preview')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING), true)
})

test('Mermaid preview fills the document card and its source switch does not leave a floating control behind', () => {
  const { dom, block, preview } = fixture()
  const controls = block.querySelector('.mermaid-view-toggle')

  assert.equal(dom.window.getComputedStyle(preview).width, '100%')
  assert.equal(dom.window.getComputedStyle(preview).maxWidth, '')
  assert.equal(dom.window.getComputedStyle(preview.querySelector('svg')).maxHeight, '560px')
  assert.equal(dom.window.getComputedStyle(controls).position, 'static')
})

test('Mermaid card and its source switch use the full document width instead of viewBox-derived limits', () => {
  const dom = new JSDOM('<section class="mermaid-block"><div class="mermaid-preview"><svg viewBox="0 0 220 400"></svg></div></section><section class="mermaid-block"><div class="mermaid-preview"><svg viewBox="0 0 1400 400"></svg></div></section>')
  const previews = dom.window.document.querySelectorAll('.mermaid-preview')
  fitMermaidPreview(previews[0])
  fitMermaidPreview(previews[1])
  assert.equal(previews[0].style.width, '100%')
  assert.equal(previews[0].style.maxWidth, '')
  assert.equal(previews[0].parentElement.style.width, '100%')
  assert.equal(previews[0].parentElement.style.maxWidth, '')
  assert.equal(previews[1].style.width, '100%')
  assert.equal(previews[1].style.maxWidth, '')
})

test('two Mermaid switches independently control their decorated source without changing Markdown', () => {
  const dom = new JSDOM(`<!doctype html><style>${style}</style><div class="visual-markdown-editor"><div class="milkdown"><div class="ProseMirror"><pre class="mermaid-source-hidden" data-mermaid-source="one"><code>graph TD</code></pre><section class="mermaid-block" data-mermaid-widget="one"><button>可视化</button><button>源码</button><div class="mermaid-preview"><svg></svg></div></section><pre class="mermaid-source-hidden" data-mermaid-source="two"><code>flowchart LR</code></pre><section class="mermaid-block" data-mermaid-widget="two"><button>可视化</button><button>源码</button><div class="mermaid-preview"><svg></svg></div></section></div></div></div>`)
  const { document, Event } = dom.window
  const widgets = [...document.querySelectorAll('[data-mermaid-widget]')]
  const markdownBefore = [...document.querySelectorAll('pre')].map((node) => node.textContent)
  for (const widget of widgets) {
    wireMermaidViewToggle(widget, widget.dataset.mermaidWidget, widget.querySelector('button'), widget.querySelectorAll('button')[1])('visual')
  }

  widgets[0].querySelectorAll('button')[1].dispatchEvent(new Event('click'))
  const [firstSource, secondSource] = document.querySelectorAll('pre')
  const [firstPreview, secondPreview] = document.querySelectorAll('.mermaid-preview')
  assert.equal(dom.window.getComputedStyle(firstSource).display, 'block')
  assert.equal(dom.window.getComputedStyle(firstPreview).display, 'none')
  assert.equal(dom.window.getComputedStyle(widgets[0]).display, 'flow-root')
  assert.equal(dom.window.getComputedStyle(secondSource).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(secondPreview).display, 'none')

  widgets[0].querySelector('button').dispatchEvent(new Event('click'))
  assert.equal(dom.window.getComputedStyle(firstSource).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(firstPreview).display, 'none')
  assert.deepEqual([...document.querySelectorAll('pre')].map((node) => node.textContent), markdownBefore)
})

test('Mermaid viewer zooms, resets, and pans the canvas without touching the SVG source', () => {
  const { dom, block, preview, canvas } = fixture()
  const [visual, source] = block.querySelectorAll('.mermaid-view-toggle button')
  const [zoomOut, zoomIn, reset] = block.querySelectorAll('.mermaid-viewer-controls button')
  const markdownBefore = dom.window.document.querySelector('pre').textContent
  wireMermaidViewToggle(block, 'one', visual, source)('visual')
  wireMermaidViewer(block, preview, canvas, zoomIn, zoomOut, reset)

  preview.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 20 }))
  preview.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 42, clientY: 56 }))
  preview.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }))
  assert.equal(canvas.style.transform, 'translate(0px, 0px) scale(1)')
  zoomIn.click()
  assert.equal(canvas.style.transform, 'translate(0px, 0px) scale(1.2)')
  preview.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 20 }))
  preview.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 42, clientY: 56 }))
  preview.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }))
  assert.equal(canvas.style.transform, 'translate(30px, 36px) scale(1.2)')
  reset.click()
  assert.equal(canvas.style.transform, 'translate(0px, 0px) scale(1)')
  assert.equal(dom.window.document.querySelector('pre').textContent, markdownBefore)
})
