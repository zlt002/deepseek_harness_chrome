/** Keep annotation text data, not executable prompt syntax. */
export function annotationsPrompt(text, annotations) {
  if (annotations.length === 0) return text
  return `${text}${text === '' ? '' : '\n\n'}以下是用户针对先前 assistant 回复的批注，请结合处理：\n<message_annotations>\n${JSON.stringify({ annotations: annotations.map(({ selectedText, comment }) => ({ selected_text: selectedText, comment })) }, null, 2)}\n</message_annotations>`
}
