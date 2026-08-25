import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const root = new URL('.', import.meta.url)
const editorSource = await readFile(new URL('./visual-markdown-editor.tsx', root), 'utf8')

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

const annotationsKey = new PluginKey('test-annotations')
const annotationPlugin = new Plugin({
  key: annotationsKey,
  state: {
    init: (_, state) => DecorationSet.create(state.doc, [Decoration.inline(8, 14, {}, { id: 'unrelated' })]),
    apply: (tr, decorations) => decorations.map(tr.mapping, tr.doc),
  },
  props: { decorations: (state) => annotationsKey.getState(state) },
})

function stateFor(doc) {
  return EditorState.create({ doc, plugins: [annotationPlugin] })
}

function rangeApply(state, changes, newDoc) {
  let tr = state.tr
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]
    tr = tr.replace(change.fromA, change.toA, newDoc.slice(change.fromB, change.toB))
  }
  return state.apply(tr)
}

test('a range diff transaction keeps an unrelated inline annotation while whole-document replace loses it', () => {
  const original = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('first')),
    schema.node('paragraph', null, schema.text('second')),
  ])
  const candidate = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('FIRST')),
    schema.node('paragraph', null, schema.text('second')),
  ])
  const changes = [{ fromA: 1, toA: 6, fromB: 1, toB: 6 }]

  const wholeDoc = stateFor(original).apply(
    stateFor(original).tr.replaceWith(0, original.content.size, candidate.content),
  )
  const rangeDoc = rangeApply(stateFor(original), changes, candidate)

  assert.equal(annotationsKey.getState(wholeDoc).find().length, 0)
  assert.equal(annotationsKey.getState(rangeDoc).find().length, 1)
  assert.equal(rangeDoc.doc.textContent, 'FIRSTsecond')
})

test('an empty replacement has a real deletion candidate rather than a no-op stream', () => {
  const original = schema.node('doc', null, [schema.node('paragraph', null, schema.text('delete me'))])
  const candidate = original.type.createAndFill(undefined, original.content.cut(0, 1).append(original.content.cut(10)))
  const directDelete = EditorState.create({ doc: original }).tr.delete(1, 10).doc

  assert.ok(candidate)
  assert.equal(directDelete.textContent, '')
  assert.notDeepEqual(directDelete.toJSON(), original.toJSON())
})

test('the visual editor starts deletion review from a candidate document and accepts by mapped change ranges', () => {
  assert.match(editorSource, /startDiffReviewFromDocCmd/)
  assert.match(editorSource, /replacementMarkdown === ''/)
  assert.match(editorSource, /getPendingChanges\(diffState\)/)
  assert.match(editorSource, /tr = tr\.replace\(change\.fromA, change\.toA, newContent\)/)
  assert.doesNotMatch(editorSource, /commands\.call\(acceptAllDiffsCmd/)
})
