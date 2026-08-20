import { reviewFeedbackPrompt } from './review-feedback-format.js'

/** Compatibility adapter for callers that still provide assistant annotations without a source field. */
export function annotationsPrompt(text, annotations) {
  return reviewFeedbackPrompt(text, annotations.map(item => ({ ...item, source: 'assistant-message' })))
}
