function appendSection(text, heading, tag, payload) {
  const prefix = text === '' ? '' : '\n\n'
  return `${text}${prefix}${heading}:\n<${tag}>\n${JSON.stringify(payload, null, 2)}\n</${tag}>`
}

/** Format the two review adapters through one ordered composer transform. */
export function reviewFeedbackPrompt(text, feedback) {
  const messages = feedback.filter(item => item.source === 'assistant-message')
  const markdown = feedback.filter(item => item.source === 'workspace-markdown')
  let next = text
  if (messages.length > 0) {
    next = appendSection(next, '以下是用户针对先前 assistant 回复的批注，请结合处理', 'message_annotations', {
      annotations: messages.map(({ selectedText, comment }) => ({ selected_text: selectedText, comment })),
    })
  }
  if (markdown.length > 0) {
    next = appendSection(next, '以下是用户从工作区 Markdown 可视化编辑页送入的待处理批注。请根据批注生成替换当前选区的 Markdown 片段，并调用 propose_workspace_markdown_edit；该工具只把可接受或拒绝的候选修改送回编辑页，不直接写文件。若 annotation 带 table，必须选择完整表格，并返回一张含表头、分隔行且列数严格一致的完整 Markdown 表格；不要返回单独的一行表格。', 'workspace_markdown_annotations', {
      annotations: markdown.map(item => ({
        review_id: item.reviewId,
        selection_id: item.selectionId,
        resource_id: item.resourceId,
        display_path: item.displayPath,
        revision: item.revision,
        fingerprint: item.fingerprint,
        anchor_kind: item.anchor.version === 2 ? 'visual' : 'source',
        quote: item.anchor.quote,
        ...(item.anchor.version === 2
          ? {
              editor_revision: item.anchor.editorRevision,
              prose_mirror_range: [item.anchor.from, item.anchor.to],
              blocks: item.anchor.blocks,
              ...(item.anchor.table === undefined ? {} : { table: item.anchor.table }),
            }
          : {
              range_utf16: [item.anchor.startUtf16, item.anchor.endUtf16],
              prefix: item.anchor.prefix,
              suffix: item.anchor.suffix,
            }),
        comment: item.comment,
      })),
    })
  }
  return next
}
