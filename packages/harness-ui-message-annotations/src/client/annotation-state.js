export function addAnnotation(items, annotation) {
  return [...items, annotation]
}

/** Remove only the annotations that were included in one accepted send. */
export function removeAcceptedAnnotations(items, acceptedIds) {
  const accepted = new Set(acceptedIds)
  return items.filter(item => !accepted.has(item.id))
}

/** Workspace Markdown is delivered one annotation per click, never by the ordinary composer transform. */
export function assistantMessageFeedback(items) {
  return items.filter(item => item.source === 'assistant-message')
}
