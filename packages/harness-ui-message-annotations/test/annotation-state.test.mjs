import assert from 'node:assert/strict'
import test from 'node:test'
import { annotationsPrompt } from '../src/client/annotation-format.js'
import { reviewFeedbackPrompt } from '../src/client/review-feedback-format.js'
import { addAnnotation, removeAcceptedAnnotations } from '../src/client/annotation-state.js'
import { assistantMessageIdForRange, popoverPosition, selectionAnchor } from '../src/client/selection-geometry.js'
import { WorkspaceMarkdownSubmitter } from '../src/client/workspace-markdown-submission.js'

const first = { id: 'a', selectedText: '原句', comment: '改成更明确的说法' }
const second = { id: 'b', selectedText: '另一句', comment: '补充来源' }

function markdownFeedback(id = 'workspace-send-1') {
  return {
    id, selectionId: 'selection-1', source: 'workspace-markdown', reviewId: 'review-1', resourceId: 'resource-1',
    displayPath: 'docs/guide.md', revision: 'revision-1', fingerprint: 'fingerprint-1', quote: '原文', comment: '改得更清楚',
    anchorKind: 'source', startUtf16: 0, endUtf16: 2, prefix: '', suffix: '\n',
  }
}

function memoryStore() {
  const items = new Map()
  return {
    importWorkspaceMarkdown(sessionId, feedback) {
      const current = items.get(sessionId) ?? []
      if (!current.some(item => item.id === feedback.id)) {
        items.set(sessionId, [...current, {
          ...feedback,
          source: 'workspace-markdown',
          anchor: { version: 1, startUtf16: feedback.startUtf16, endUtf16: feedback.endUtf16, quote: feedback.quote, prefix: feedback.prefix, suffix: feedback.suffix, sourceFingerprint: feedback.fingerprint },
        }])
      }
      return true
    },
    feedback(sessionId) { return items.get(sessionId) ?? [] },
    accept(sessionId, ids) { items.set(sessionId, (items.get(sessionId) ?? []).filter(item => !ids.includes(item.id))) },
  }
}

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

test('serializes workspace Markdown evidence through the shared review transform without embedding the document', () => {
  const prompt = reviewFeedbackPrompt('请继续优化', [{
    id: 'workspace-1', selectionId: 'selection-1', source: 'workspace-markdown', reviewId: 'review-1', resourceId: 'resource-1',
    displayPath: 'docs/guide.md', revision: 'revision-1', fingerprint: 'fingerprint-1', comment: '这里需要补充依据',
    anchor: { version: 1, startUtf16: 4, endUtf16: 8, quote: '原文', prefix: '# ', suffix: '\n下一段', sourceFingerprint: 'fingerprint-1' },
  }])
  assert.match(prompt, /<workspace_markdown_annotations>/)
  assert.match(prompt, /docs\/guide\.md/)
  assert.match(prompt, /propose_workspace_markdown_edit/)
  assert.match(prompt, /"review_id": "review-1"/)
  assert.match(prompt, /"selection_id": "selection-1"/)
  assert.doesNotMatch(prompt, /完整文档内容/)
})

test('serializes a dirty visual cross-block selection without inventing UTF-16 source positions', () => {
  const prompt = reviewFeedbackPrompt('', [{
    id: 'workspace-2', selectionId: 'selection-2', source: 'workspace-markdown', reviewId: 'review-2', resourceId: 'resource-2',
    displayPath: 'docs/table.md', revision: 'revision-2', fingerprint: 'fingerprint-2', comment: '合并这两处',
    anchor: { version: 2, editorRevision: 7, from: 12, to: 46, quote: '段落\n单元格', blocks: [{ kind: 'paragraph', text: '段落' }, { kind: 'table_cell', text: '单元格' }], sourceFingerprint: 'fingerprint-2' },
  }])
  const payload = JSON.parse(prompt.match(/<workspace_markdown_annotations>\n([\s\S]*?)\n<\/workspace_markdown_annotations>/)?.[1] ?? '')
  assert.deepEqual(payload.annotations[0].anchor_kind, 'visual')
  assert.deepEqual(payload.annotations[0].prose_mirror_range, [12, 46])
  assert.deepEqual(payload.annotations[0].blocks.map(block => block.kind), ['paragraph', 'table_cell'])
  assert.equal('range_utf16' in payload.annotations[0], false)
})

test('serializes whole-table bounds and tells AI not to return a single table row', () => {
  const prompt = reviewFeedbackPrompt('', [{
    id: 'workspace-table', selectionId: 'selection-table', source: 'workspace-markdown', reviewId: 'review-table', resourceId: 'resource-table',
    displayPath: 'docs/table.md', revision: 'revision-table', fingerprint: 'fingerprint-table', comment: '删除客户系，保留客户名称',
    anchor: {
      version: 2, editorRevision: 7, from: 12, to: 72, quote: '字段\n客户系\n客户名称(全称)', blocks: [{ kind: 'table_cell', text: '客户系' }],
      table: { from: 10, to: 80, rowCount: 3, columnCount: 2, selectedRowStart: 1, selectedRowEnd: 2, selectedColumnStart: 0, selectedColumnEnd: 1, isWholeTable: false, header: ['字段', '类型'], rows: [['客户系', '文本输入'], ['客户名称(全称)', '文本输入']] },
      sourceFingerprint: 'fingerprint-table',
    },
  }])
  const payload = JSON.parse(prompt.match(/<workspace_markdown_annotations>\n([\s\S]*?)\n<\/workspace_markdown_annotations>/)?.[1] ?? '')
  assert.deepEqual(payload.annotations[0].table, { from: 10, to: 80, rowCount: 3, columnCount: 2, selectedRowStart: 1, selectedRowEnd: 2, selectedColumnStart: 0, selectedColumnEnd: 1, isWholeTable: false, header: ['字段', '类型'], rows: [['客户系', '文本输入'], ['客户名称(全称)', '文本输入']] })
  assert.match(prompt, /不要返回单独的一行表格/)
})

test('submits one workspace annotation directly through its scoped conversation then clears it', async () => {
  const store = memoryStore(); const sent = []
  const submitter = new WorkspaceMarkdownSubmitter(store, { scope: () => ({ get: () => ({ send: async prompt => { sent.push(prompt) } }) }) })
  await submitter.submit('session-1', markdownFeedback())
  assert.equal(sent.length, 1)
  assert.match(sent[0], /<workspace_markdown_annotations>/)
  assert.equal(store.feedback('session-1').length, 0)
})

test('a retry after accepted delivery reuses the success tombstone instead of creating another AI turn', async () => {
  const store = memoryStore(); let sends = 0
  const submitter = new WorkspaceMarkdownSubmitter(store, { scope: () => ({ get: () => ({ send: async () => { sends += 1 } }) }) })
  const feedback = markdownFeedback()
  await submitter.submit('session-1', feedback)
  await submitter.submit('session-1', feedback)
  assert.equal(sends, 1)
  assert.equal(store.feedback('session-1').length, 0)
})

test('keeps the workspace annotation for retry when the direct conversation send fails', async () => {
  const store = memoryStore()
  const submitter = new WorkspaceMarkdownSubmitter(store, { scope: () => ({ get: () => ({ send: async () => { throw new Error('Harness queue unavailable') } }) }) })
  await assert.rejects(submitter.submit('session-1', markdownFeedback()), /Harness queue unavailable/)
  assert.equal(store.feedback('session-1').length, 1)
})

test('coalesces concurrent retries of one workspace feedback id into one AI turn', async () => {
  const store = memoryStore(); let sends = 0; let release
  const waiting = new Promise(resolve => { release = resolve })
  const submitter = new WorkspaceMarkdownSubmitter(store, { scope: () => ({ get: () => ({ send: async () => { sends += 1; await waiting } }) }) })
  const first = submitter.submit('session-1', markdownFeedback())
  const second = submitter.submit('session-1', markdownFeedback())
  assert.equal(first, second)
  release()
  await first
  assert.equal(sends, 1)
  assert.equal(store.feedback('session-1').length, 0)
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

test('uses the final visible selection line and places a compact entry beside it before covering later text', () => {
  const first = { left: 16, top: 20, right: 200, bottom: 36, width: 184, height: 16 }
  const last = { left: 24, top: 44, right: 110, bottom: 60, width: 86, height: 16 }
  assert.equal(selectionAnchor({ getClientRects: () => [first, { width: 0, height: 0 }, last] }), last)
  assert.deepEqual(
    popoverPosition(last, { width: 112, height: 34 }, { width: 320, height: 240 }, { preferInline: true }),
    { left: 118, top: 26, placement: 'right' },
  )
})
