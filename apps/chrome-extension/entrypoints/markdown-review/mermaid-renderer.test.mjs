import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  DOMParser: dom.window.DOMParser,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.CSSStyleSheet = class CSSStyleSheet {
  cssRules = []
  insertRule(rule) { this.cssRules.push(rule); return this.cssRules.length - 1 }
  replaceSync() {}
}
dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 40 })
dom.window.SVGElement.prototype.getComputedTextLength = () => 80
const { normalizeMermaidSource, renderMermaidSvg, sanitizeMermaidSvg } = await import('./mermaid-renderer.mjs')

test('renders a Mermaid code block into non-empty safe SVG without network access', async () => {
  const svg = await renderMermaidSvg('graph TD\n  Start --> Done', 'markdown-review-test')

  assert.match(svg, /^<svg\b/)
  assert.match(svg, /<(?:path|rect|text|g)\b/)
  assert.doesNotMatch(svg, /<script\b/i)
  assert.doesNotMatch(svg, /(?:href|xlink:href)="https?:\/\//i)
})

test('removes executable and external content while keeping local label containers', () => {
  const svg = sanitizeMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div onclick="alert(1)"><img src="https://example.invalid/a"/>state label</div></foreignObject><path onclick="alert(1)"/><use href="https://example.invalid/a"/></svg>')

  assert.doesNotMatch(svg, /script|onclick|src=|example\.invalid/i)
  assert.match(svg, /foreignObject/)
  assert.match(svg, /state label/)
})

test('keeps stateDiagram labels inside their Mermaid foreignObject nodes', async () => {
  const source = 'stateDiagram-v2\n  [*] --> 审核\n  审核 --> 已发布: 自动\\n回读'
  const svg = await renderMermaidSvg(source, 'markdown-review-state-labels')
  const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const state = rendered.querySelector('g.statediagram-state')

  assert.ok(state, 'stateDiagram should contain a state node')
  assert.ok(state.querySelector('foreignObject'), 'the state label must remain inside its node')
  assert.match(state.textContent ?? '', /审核/)
  assert.match(rendered.documentElement.textContent ?? '', /自动 回读/)
  assert.doesNotMatch(rendered.documentElement.textContent ?? '', /\\n/)
})

test('normalizes pasted escaped line breaks for Mermaid labels without changing the stored Markdown', () => {
  const source = 'stateDiagram-v2\n  派送中 --> 待补签收: 快递轨迹 delivered\\n但系统未更新'

  assert.equal(normalizeMermaidSource(source), 'stateDiagram-v2\n  派送中 --> 待补签收: 快递轨迹 delivered 但系统未更新')
})
