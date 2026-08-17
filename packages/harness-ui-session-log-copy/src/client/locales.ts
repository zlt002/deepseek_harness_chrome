export const NS = 'productSessionLogCopy' as const

export const zh = {
  copyingTitle: '正在复制 Session 日志',
  copyingDescription: '正在读取当前 Session 的原始日志。',
  copiedTitle: 'Session 日志已复制',
  copiedDescription: '当前 Session 的原始日志已复制到剪贴板。',
  errorTitle: 'Session 导出失败',
  close: '关闭',
  commandFailed: '无法复制 Session 日志。',
}

export const en: Record<keyof typeof zh, string> = {
  copyingTitle: 'Copying Session log',
  copyingDescription: 'Reading the current Session raw log.',
  copiedTitle: 'Session log copied',
  copiedDescription: 'The current Session raw log is on your clipboard.',
  errorTitle: 'Session export failed',
  close: 'Close',
  commandFailed: 'Could not copy the Session log.',
}

export type CopySessionLogKey = keyof typeof zh
