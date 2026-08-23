/** Durable product preference for the compact conversation presentation. */
export const CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE = 'accrui-conversation-presentation'
export const SHOW_PROCESS_FIELD = 'showProcess'

export interface ConversationPresentationSettings {
  readonly showProcess: boolean
}

export const DEFAULT_CONVERSATION_PRESENTATION_SETTINGS: ConversationPresentationSettings = {
  showProcess: true,
}
