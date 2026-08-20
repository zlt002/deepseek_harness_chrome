import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('./preview-selection.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports })
const { uniquePreviewSelectionMatch } = module.exports

test('preview selection maps a unique quote only within the mdast source range', () => {
  const source = '| Owner | Status |\n| --- | --- |\n| Ada | ready |\n\nOutside: ready |'
  assert.deepEqual(
    JSON.parse(JSON.stringify(uniquePreviewSelectionMatch(source, 'ready', { start: 0, end: 58 }))),
    { start: 41, end: 46 },
  )
})

test('preview selection fails closed for ambiguous text while preserving exact styled text', () => {
  const source = 'repeat\n\nrepeat'
  assert.equal(uniquePreviewSelectionMatch(source, 'repeat', { start: 0, end: source.length }), undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(uniquePreviewSelectionMatch('**bold**', 'bold', { start: 0, end: 8 }))), { start: 2, end: 6 })
})
