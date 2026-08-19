export const NS = 'productSubagentCompact' as const

export const zh = {
  'activity.running': '正在运行',
  'activity.inactive': '当前未运行',
  'count.total.one': '{count} 个子代理',
  'count.total.other': '{count} 个子代理',
  'compact.menu.aria': '子代理',
  'compact.detail.trajectory': '查看轨迹',
  'compact.detail.copyLog': '复制子代理日志',
  'compact.trajectory.copyLog': '复制日志',
  'duration.seconds': '{seconds}秒',
  'duration.minutes': '{minutes}分{seconds}秒',
  'duration.hours': '{hours}小时{minutes}分{seconds}秒',
} as const

export type CompactSubagentKey = keyof typeof zh

export const en: Record<CompactSubagentKey, string> = {
  'activity.running': 'running',
  'activity.inactive': 'not running',
  'count.total.one': '{count} subagent',
  'count.total.other': '{count} subagents',
  'compact.menu.aria': 'Subagents',
  'compact.detail.trajectory': 'View trajectory',
  'compact.detail.copyLog': 'Copy subagent log',
  'compact.trajectory.copyLog': 'Copy log',
  'duration.seconds': '{seconds}s',
  'duration.minutes': '{minutes}m {seconds}s',
  'duration.hours': '{hours}h {minutes}m {seconds}s',
}
