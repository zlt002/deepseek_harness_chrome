export const NS = 'productResponsiveSidebar' as const

export const zh = {
  'detail.back.conversation': '返回对话',
  'detail.back.parent': '返回父会话',
} as const

export type ResponsiveSidebarKey = keyof typeof zh

export const en: Record<ResponsiveSidebarKey, string> = {
  'detail.back.conversation': 'Return to conversation',
  'detail.back.parent': 'Return to parent session',
}
