import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const main = await readFile(new URL('./main.tsx', root), 'utf8')
const mermaid = await readFile(new URL('./mermaid-diagram.tsx', root), 'utf8')
const style = await readFile(new URL('./style.css', root), 'utf8')

test('review workspace keeps one canvas and supports source and preview selection anchoring', () => {
  assert.match(main, /useState<'preview' \| 'source'>\('preview'\)/)
  assert.match(main, /view === 'source' \? <SourceEditor/)
  assert.match(main, /: <SafeMarkdownPreview content=\{draft\}/)
  assert.match(main, /onPreviewSelection/)
  assert.match(main, /browserSelection\.rangeCount !== 1 \|\| browserSelection\.isCollapsed/)
  assert.match(main, /选择预览文本后即可添加批注/)
})

test('preview uses a sanitized GFM renderer and isolated Mermaid fallback', () => {
  assert.match(main, /from 'react-markdown'/)
  assert.match(main, /from 'remark-gfm'/)
  assert.match(main, /from 'rehype-sanitize'/)
  assert.match(main, /<MermaidDiagram/)
  assert.match(mermaid, /securityLevel: 'strict'/)
  assert.match(mermaid, /Mermaid 图表无法安全渲染，已显示源码。/)
  assert.match(mermaid, /sandbox=""/)
  assert.match(main, /data-source-start/)
  assert.match(main, /data-source-end/)
  assert.match(style, /\.preview table/)
  assert.match(style, /\.mermaid-diagram/)
})

test('review panel is collapsible and stacks below the canvas on narrow widths', () => {
  assert.match(main, /setReviewPanelOpen/)
  assert.match(main, /aria-expanded=\{reviewPanelOpen\}/)
  assert.match(main, /review-main review-panel-collapsed/)
  assert.match(main, /已绑定会话/)
  assert.match(style, /\.annotation-panel\.collapsed \{ width: 56px;/)
  assert.match(style, /\.review-main\.review-panel-collapsed \{ grid-template-columns: minmax\(0, 1fr\) 56px;/)
  assert.match(style, /@media \(max-width: 840px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
})
