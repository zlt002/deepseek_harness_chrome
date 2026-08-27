import { useEffect, useState } from 'react'
import css from './ReleaseUpdateSection.module.css'

export type ReleaseUpdateStatus = { state: 'pending' | 'succeeded' | 'failed', version: string, updatedAt: string, error?: string, logPath?: string }
export type ReleaseUpdate = { available: boolean, version?: string, sha256?: string, error?: string, lastUpdate?: ReleaseUpdateStatus }
export function ReleaseUpdateSection({ request }: { request: (action: 'check' | 'prepare') => Promise<ReleaseUpdate> }) {
  const [update, setUpdate] = useState<ReleaseUpdate>()
  const [pending, setPending] = useState<'check' | 'prepare'>()
  const [prepared, setPrepared] = useState(false)
  const run = (action: 'check' | 'prepare'): void => {
    if (pending !== undefined) return
    setPending(action)
    setPrepared(false)
    void request(action).then(result => {
      setUpdate(result)
      if (action === 'prepare') setPrepared(true)
    }, error => setUpdate({ available: false, error: error instanceof Error ? error.message : String(error) })).finally(() => setPending(undefined))
  }
  useEffect(() => { run('check') }, [])
  return <section className={css.section} data-testid="release-update-settings"><h2>在线更新</h2><p>当前安装会从已发布的 Windows Lite 更新源检查新版本。</p>
    <dl><div><dt>状态</dt><dd>{pending === 'check' ? '正在检查…' : update?.lastUpdate?.state === 'failed' ? '最近一次更新失败' : update?.lastUpdate?.state === 'succeeded' ? '最近一次更新成功' : update?.lastUpdate?.state === 'pending' ? '更新程序正在等待侧边栏关闭' : update?.error ?? (prepared ? '更新程序已启动' : update?.available ? '发现可更新版本' : '暂无可用更新')}</dd></div>
      {update?.version !== undefined && <div><dt>新版本</dt><dd>{update.version}</dd></div>}
      {update?.sha256 !== undefined && <div><dt>SHA256</dt><dd title={update.sha256}>{update.sha256.slice(0, 16)}…</dd></div>}</dl>
    {update?.lastUpdate !== undefined && <p role="status">目标版本 {update.lastUpdate.version}：{update.lastUpdate.state === 'failed' ? update.lastUpdate.error ?? '安装失败；请查看安装日志后重试。' : update.lastUpdate.state === 'succeeded' ? '安装完成。' : '等待旧 Harness UI 进程释放。'}</p>}
    <div className={css.actions}><button type="button" disabled={pending !== undefined} onClick={() => run('check')}>检查更新</button><button type="button" className={css.primary} disabled={pending !== undefined || update?.available !== true} onClick={() => run('prepare')}>{pending === 'prepare' ? '正在下载并校验…' : '下载并开始更新'}</button></div>
    {pending === 'prepare' && <p role="status">正在下载并校验更新包。更新程序启动后，只需关闭当前侧边栏，几秒后重新打开；无需退出 Chrome 或 Edge。</p>}
    {prepared && <p role="status">更新程序已启动。现在关闭当前侧边栏，几秒后重新打开即可；无需退出 Chrome 或 Edge。workspace、logs、profile 和用户插件都会保留。</p>}
  </section>
}
