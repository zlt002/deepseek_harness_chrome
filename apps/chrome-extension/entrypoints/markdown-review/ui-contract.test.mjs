import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const main = await readFile(new URL('./main.tsx', root), 'utf8')
const style = await readFile(new URL('./style.css', root), 'utf8')

test('review workspace uses one visual Milkdown canvas rather than source and preview panes', () => {
  assert.match(main, /<VisualMarkdownEditor/)
  assert.match(main, /在排版后的正文中直接编辑/)
  assert.doesNotMatch(main, /SourceEditor|SafeMarkdownPreview|ReactMarkdown/)
  assert.match(style, /\.visual-markdown-editor/)
})

test('visual surface states the safe HTML and Mermaid downgrade', () => {
  assert.match(main, /HTML 和 Mermaid 保留为安全文本\/代码块，不执行。/)
  assert.doesNotMatch(main, /data-source-start|data-source-end/)
})

test('active AI diffs have visible accept and reject controls', () => {
  assert.match(main, /candidateReviewActive/)
  assert.match(main, /拒绝修改/)
  assert.match(main, /接受修改/)
  assert.match(main, /acceptCandidate/)
  assert.match(main, /rejectCandidate/)
  assert.match(style, /\.candidate-actions/)
})

test('dirty visual drafts use a captured selection and explicit verified-write confirmation', () => {
  assert.match(main, /annotationSelectionsRef/)
  assert.match(main, /reviewSelectionReplacement\(saved, proposal\.replacementMarkdown\)/)
  assert.match(main, /编辑版本、范围或选中文本已变化/)
  assert.match(main, /markdown-review-prepare-write-request/)
  assert.match(main, /确认写入/)
  assert.match(main, /markdown-review-commit-write-request/)
  assert.match(main, /同一资源回读验证/)
  assert.match(main, /不会自动重试/)
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
