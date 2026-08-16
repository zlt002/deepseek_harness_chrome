import { useMemo } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BrowserTargetCommand, BrowserTargetSnapshot, BrowserTargetTab } from './bridge.ts'
import css from './BrowserTargetControl.module.css'

export interface BrowserTargetInjected {
  hooks: {
    browserTarget: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<BrowserTargetSnapshot | undefined>
    browserTargetPanel: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<boolean>
  }
  send: (command: BrowserTargetCommand) => void
  setPanelOpen: (open: boolean) => void
  reconnect: () => void
}

type ControlProps = PropsRuntime<'conversation.input.left'> & InjectFace<BrowserTargetInjected>
type PanelProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<BrowserTargetInjected>
type ReconnectProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<BrowserTargetInjected>

const modeLabels = { 'follow-active-tab': '跟随当前目标', 'pinned-tabs': '固定选中标签', none: '不绑定目标' } as const
const nameOf = (tab: BrowserTargetTab | undefined): string => tab?.title.trim() || tab?.url || '未选择'

function chosen(snapshot: BrowserTargetSnapshot): BrowserTargetTab[] {
  const ids = new Set(snapshot.settings.pinnedTabs.map(tab => tab.tabId))
  return snapshot.tabs.filter(tab => ids.has(tab.tabId))
}

function current(snapshot: BrowserTargetSnapshot): BrowserTargetTab | undefined {
  if (snapshot.settings.mode === 'follow-active-tab') return snapshot.activeTab
  if (snapshot.settings.mode === 'none') return undefined
  return snapshot.tabs.find(tab => tab.tabId === snapshot.settings.primaryTabId) ?? chosen(snapshot)[0]
}

function TargetIcon({ tab }: { tab?: BrowserTargetTab }) {
  if (tab?.favIconUrl !== undefined) return <img className={css.icon} src={tab.favIconUrl} alt="" />
  return <span className={css.fallback} aria-hidden>{nameOf(tab).slice(0, 1).toUpperCase()}</span>
}

/** Public-slot control: the extension owns selection; this plugin only renders and requests actions. */
export function BrowserTargetControl({ useBrowserTarget, useBrowserTargetPanel, setPanelOpen }: ControlProps) {
  const snapshot = useBrowserTarget(value => value)
  const open = useBrowserTargetPanel(value => value)
  const count = snapshot === undefined ? 0 : snapshot.settings.mode === 'follow-active-tab' ? Number(snapshot.activeTab !== undefined) : snapshot.settings.mode === 'none' ? 0 : chosen(snapshot).length
  const label = snapshot === undefined ? '工作目标上下文：正在读取浏览器标签页' : snapshot.settings.mode === 'none'
    ? '工作目标上下文：不绑定目标'
    : `工作目标上下文：${modeLabels[snapshot.settings.mode]}，当前绑定 ${nameOf(current(snapshot))}，共 ${count} 个`
  return <button className={css.trigger} type="button" aria-label={label} aria-expanded={open} title={label} data-browser-target-control onMouseDown={event => event.preventDefault()} onClick={() => setPanelOpen(!open)}>
    <TargetIcon tab={snapshot === undefined ? undefined : current(snapshot)} /><span className={css.badge} aria-hidden>{snapshot === undefined ? '…' : count}</span>
  </button>
}

/** Small footer action available only inside the trusted extension bridge. */
export function HarnessReconnectAction({ reconnect }: ReconnectProps) {
  return <button className={css.reconnect} type="button" aria-label="重新连接 Harness" title="重新连接 Harness" data-harness-reconnect onClick={reconnect}>↻</button>
}

/** Overlay contributed through the official `conversation.input.overlay` slot. */
export function BrowserTargetPanel({ useBrowserTarget, useBrowserTargetPanel, send }: PanelProps) {
  const snapshot = useBrowserTarget(value => value)
  const open = useBrowserTargetPanel(value => value)
  const selectedIds = useMemo(() => new Set(snapshot?.settings.pinnedTabs.map(tab => tab.tabId) ?? []), [snapshot])
  if (!open) return null
  if (snapshot === undefined) return <section className={css.panel} role="dialog" aria-label="工作目标上下文"><header className={css.header}><strong>工作目标上下文</strong><button className={css.refresh} type="button" onClick={() => send({ command: 'refresh' })}>刷新</button></header><p className={css.empty}>正在读取当前窗口标签页…</p></section>
  const pinned = snapshot.settings.mode === 'pinned-tabs'
  return <section className={css.panel} role="dialog" aria-label="工作目标上下文">
    <header className={css.header}><strong>工作目标上下文</strong><button className={css.refresh} type="button" onClick={() => send({ command: 'refresh' })}>刷新</button></header>
    <div className={css.modes} role="radiogroup" aria-label="工作目标模式">{(Object.entries(modeLabels) as Array<[BrowserTargetSnapshot['settings']['mode'], string]>).map(([mode, label]) => <button key={mode} className={snapshot.settings.mode === mode ? css.modeActive : css.mode} type="button" role="radio" aria-checked={snapshot.settings.mode === mode} onClick={() => send({ command: 'set-mode', mode })}>{label}</button>)}</div>
    <div className={css.subhead}><span>当前窗口标签页</span><span>{pinned ? `已选 ${selectedIds.size} 个` : modeLabels[snapshot.settings.mode]}</span></div>
    <div className={css.tabList}>{snapshot.tabs.map(tab => {
      const selected = selectedIds.has(tab.tabId); const primary = snapshot.settings.primaryTabId === tab.tabId
      return <div className={css.tabRow} key={tab.tabId}><input id={`browser-target-${tab.tabId}`} type="checkbox" checked={selected} disabled={!pinned} onChange={event => send({ command: 'toggle-pinned-tab', tabId: tab.tabId, checked: event.target.checked })} /><label className={css.tabLabel} htmlFor={`browser-target-${tab.tabId}`}><TargetIcon tab={tab} /><span className={css.tabCopy}><b>{nameOf(tab)}</b><small>{tab.url}</small></span></label>{selected && !primary && <button type="button" className={css.primary} onClick={() => send({ command: 'set-primary', tabId: tab.tabId })}>设为主目标</button>}{primary && <span className={css.primary}>主目标</span>}</div>
    })}{snapshot.tabs.length === 0 && <p className={css.empty}>没有可选择的标签页。</p>}</div>
    <p className={css.note}>{pinned ? '固定模式会在下一次浏览器读取中提供全部勾选标签页。' : snapshot.settings.mode === 'none' ? '下一次浏览器工具调用会明确提示已关闭浏览器能力。' : '跟随模式会在下一次浏览器读取时使用当前标签页。'}</p>
    {snapshot.error !== undefined && <p className={css.error} role="alert">{snapshot.error}</p>}
  </section>
}
