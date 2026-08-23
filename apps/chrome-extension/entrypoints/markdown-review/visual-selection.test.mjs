import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const root = new URL('.', import.meta.url)
const source = await readFile(new URL('./visual-selection.ts', root), 'utf8')
const editor = await readFile(new URL('./visual-markdown-editor.tsx', root), 'utf8')

const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports })
const { canRestoreVisualSelection } = module.exports

test('visual selection carries structured block context and never claims Markdown source offsets', () => {
  for (const kind of ['heading', 'paragraph', 'list_item', 'table_cell', 'code_block']) assert.match(source, new RegExp(`'${kind}'`))
  assert.match(source, /editorRevision/)
  assert.match(source, /ProseMirror positions, intentionally not Markdown source offsets/)
  assert.doesNotMatch(source, /startUtf16|endUtf16|sourceFingerprint/)
})

test('candidate review is backed by Milkdown first-party diff and streaming commands', () => {
  assert.match(editor, /startDiffReviewCmd/)
  assert.match(editor, /acceptAllDiffsCmd/)
  assert.match(editor, /clearDiffReviewCmd/)
  assert.match(editor, /startStreamingCmd/)
  assert.match(editor, /endStreamingCmd/)
  assert.match(editor, /reviewCandidateMarkdown/)
  assert.match(editor, /reviewSelectionReplacement/)
})

test('selection replacement refuses a stale revision, invalid range, or changed quote', () => {
  const document = { content: { size: 11 }, textBetween: (from, to) => 'hello world'.slice(from, to) }
  const selection = { quote: 'world', editorRevision: 3, from: 6, to: 11, blocks: [] }
  assert.equal(canRestoreVisualSelection(document, selection, 3), true)
  assert.equal(canRestoreVisualSelection(document, selection, 4), false)
  assert.equal(canRestoreVisualSelection(document, { ...selection, to: 12 }, 3), false)
  assert.equal(canRestoreVisualSelection(document, { ...selection, quote: 'other' }, 3), false)
})
