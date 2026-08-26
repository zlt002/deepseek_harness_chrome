import { useEffect, useState } from 'react'
import css from './ReleaseUpdateSection.module.css'

export type ReleaseUpdate = { available: boolean, version?: string, sha256?: string, error?: string }
export function ReleaseUpdateSection({ request }: { request: (action: 'check' | 'prepare') => Promise<ReleaseUpdate> }) {
  const [update, setUpdate] = useState<ReleaseUpdate>()
  const [pending, setPending] = useState<'check' | 'prepare'>()
  const run = (action: 'check' | 'prepare'): void => {
    if (pending !== undefined) return
    setPending(action)
    void request(action).then(setUpdate, error => setUpdate({ available: false, error: error instanceof Error ? error.message : String(error) })).finally(() => setPending(undefined))
  }
  useEffect(() => { run('check') }, [])
  return <section className={css.section} data-testid="release-update-settings"><h2>在线更新</h2><p>当前安装会从已发布的 Windows Lite 更新源检查新版本。</p>
    <dl><div><dt>状态</dt><dd>{pending === 'check' ? '正在检查…' : update?.error ?? (update?.available ? '发现可更新版本' : '暂无可用更新')}</dd></div>
      {update?.version !== undefined && <div><dt>新版本</dt><dd>{update.version}</dd></div>}
      {update?.sha256 !== undefined && <div><dt>SHA256</dt><dd title={update.sha256}>{update.sha256.slice(0, 16)}…</dd></div>}</dl>
    <div className={css.actions}><button type="button" disabled={pending !== undefined} onClick={() => run('check')}>检查更新</button><button type="button" className={css.primary} disabled={pending !== undefined || update?.available !== true} onClick={() => run('prepare')}>{pending === 'prepare' ? '正在下载并校验…' : '下载并开始更新'}</button></div>
    {pending === 'prepare' && <p role="status">下载完成后会正常退出 Native Host；安装器会保留 workspace、logs、profile 和用户插件。完成后请在扩展管理页重新加载扩展，再打开 Harness Workspace。</p>}
  </section>
}
