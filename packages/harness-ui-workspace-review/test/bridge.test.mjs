import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client/bridge.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, URL, URLSearchParams })
const { feedbackMessage } = module.exports
const parent = {}
const config = { nonce: 'nonce-1', parentOrigin: 'chrome-extension://test' }
const base = { id: 'annotation-1', selectionId: 'annotation-1', harnessSessionId: 'session-1', reviewId: 'review-1', resourceId: 'resource-1', displayPath: 'README.md', revision: 'revision-1', fingerprint: 'fingerprint-1', quote: 'text', comment: 'rewrite' }

test('accepts an exact source feedback envelope including source range keys', () => {
  const feedback = { ...base, anchorKind: 'source', startUtf16: 1, endUtf16: 5, prefix: '# ', suffix: '\n' }
  assert.deepEqual(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback }, source: parent, origin: config.parentOrigin }, parent, config), feedback)
})

test('accepts visual feedback and rejects an envelope with a hidden extra field', () => {
  const feedback = { ...base, anchorKind: 'visual', editorRevision: 2, from: 4, to: 11, blocks: [{ kind: 'code_block', text: 'text' }] }
  assert.deepEqual(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback }, source: parent, origin: config.parentOrigin }, parent, config), feedback)
  assert.equal(feedbackMessage({ data: { type: 'markdown-review-feedback/v1', nonce: 'nonce-1', feedback: { ...feedback, startUtf16: 0 } }, source: parent, origin: config.parentOrigin }, parent, config), undefined)
})
