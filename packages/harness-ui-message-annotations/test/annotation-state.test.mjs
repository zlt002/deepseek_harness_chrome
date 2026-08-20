import assert from 'node:assert/strict'
import test from 'node:test'
import { annotationsPrompt } from '../src/client/annotation-format.js'
import { addAnnotation, removeAcceptedAnnotations } from '../src/client/annotation-state.js'
import { assistantMessageIdForRange, popoverPosition } from '../src/client/selection-geometry.js'

const first = { id: 'a', selectedText: '原句', comment: '改成更明确的说法' }
const second = { id: 'b', selectedText: '另一句', comment: '补充来源' }

test('serializes every pending annotation as data alongside the next user message', () => {
  const prompt = annotationsPrompt('请继续', [first, second])
  assert.match(prompt, /请继续/)
  assert.match(prompt, /<message_annotations>/)
  assert.deepEqual(JSON.parse(prompt.match(/\{[\s\S]*\}/)?.[0] ?? ''), {
    annotations: [
      { selected_text: '原句', comment: '改成更明确的说法' },
      { selected_text: '另一句', comment: '补充来源' },
    ],
  })
})

test('successful delivery clears only the submitted snapshot and preserves annotations added during flight', () => {
  const pending = addAnnotation([first], second)
  assert.deepEqual(removeAcceptedAnnotations(pending, ['a']), [second])
})

test('accepts a range only when both boundaries are inside the same assistant message marker', () => {
  const marker = (id) => {
    const element = { dataset: { assistantMessageId: id }, closest: () => element }
    return element
  }
  const first = marker('message-1'); const second = marker('message-2')
  const text = (parent) => ({ nodeType: 3, parentElement: parent })
  assert.equal(assistantMessageIdForRange({ startContainer: text(first), endContainer: text(first) }), 'message-1')
  assert.equal(assistantMessageIdForRange({ startContainer: text(first), endContainer: text(second) }), undefined)
})

test('keeps the selection popover inside a narrow sidebar and flips above when below would overflow', () => {
  assert.deepEqual(
    popoverPosition({ left: 2, top: 170, width: 20, height: 14, bottom: 184 }, { width: 240, height: 96 }, { width: 260, height: 200 }),
    { left: 8, top: 66, placement: 'above' },
  )
})
