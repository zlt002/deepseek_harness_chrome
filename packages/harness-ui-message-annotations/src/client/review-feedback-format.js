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
    next = appendSection(next, '以下是用户从工作区 Markdown 审阅页送入的待处理批注。请先按相对路径重读真实文件，再结合指纹和选区证据优化', 'workspace_markdown_annotations', {
      annotations: markdown.map(item => ({
        resource_id: item.resourceId,
        display_path: item.displayPath,
        revision: item.revision,
        fingerprint: item.fingerprint,
        range_utf16: [item.anchor.startUtf16, item.anchor.endUtf16],
        quote: item.anchor.quote,
        prefix: item.anchor.prefix,
        suffix: item.anchor.suffix,
        comment: item.comment,
      })),
    })
  }
  return next
}
