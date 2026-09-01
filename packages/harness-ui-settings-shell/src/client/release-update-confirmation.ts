export const RELEASE_UPDATE_CONFIRMATION = '更新会暂时断开当前对话。请先等正在执行的任务结束；确认现在开始更新吗？'

export function confirmReleaseUpdate(confirm: (message: string) => boolean = message => window.confirm(message)): boolean {
  return confirm(RELEASE_UPDATE_CONFIRMATION)
}
