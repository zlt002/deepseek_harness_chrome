import { useMemo, useRef } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserTargetCommand, BrowserTargetSnapshot, BrowserTargetTab } from './active-tab-bridge.ts'
import css from './ActiveTabDock.module.css'

export interface BrowserTargetInjected {
  hooks: {
    browserTarget: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<BrowserTargetSnapshot | undefined>
    browserTargetPanel: import('@deepseek-ai/dsh-client-runtime/client').SnapshotStore<boolean>
  }
  onBrowserTargetCommand: (command: BrowserTargetCommand) => void
  onBrowserTargetPanelChange: (open: boolean) => void
}

type ControlProps = PropsRuntime<'conversation.input.left'> & InjectFace<BrowserTargetInjected>
type PanelProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<BrowserTargetInjected>
const MODE_LABELS = { 'follow-active-tab': '跟随当前目标', 'pinned-tabs': '固定选中标签', none: '不绑定目标' } as const

function displayName(tab: BrowserTargetTab | undefined): string {
  return tab?.title.trim() || tab?.url || '未选择'
}

function selectedTabs(snapshot: BrowserTargetSnapshot): BrowserTargetTab[] {
  const byId = new Map(snapshot.tabs.map(tab => [tab.tabId, tab]))
  return snapshot.settings.pinnedTabs.map(pin => byId.get(pin.tabId) ?? { ...pin, title: pin.url })
}

function triggerTab(snapshot: BrowserTargetSnapshot): BrowserTargetTab | undefined {
  if (snapshot.settings.mode === 'follow-active-tab') return snapshot.activeTab
  if (snapshot.settings.mode === 'none') return undefined
  return snapshot.tabs.find(tab => tab.tabId === snapshot.settings.primaryTabId) ?? selectedTabs(snapshot)[0]
}

function selectionCount(snapshot: BrowserTargetSnapshot): number {
  if (snapshot.settings.mode === 'follow-active-tab') return snapshot.activeTab === undefined ? 0 : 1
  if (snapshot.settings.mode === 'none') return 0
  return snapshot.settings.pinnedTabs.length
}

function TabIcon({ tab }: { tab: BrowserTargetTab }) {
  if (tab.favIconUrl !== undefined) return <img className={css.favicon} src={tab.favIconUrl} alt="" />
  return <span className={css.faviconFallback} aria-hidden="true">{displayName(tab).slice(0, 1).toUpperCase()}</span>
}

/** Small action inside the composer tool row, matching the accepted e327 UI. */
export function BrowserTargetControl({ useBrowserTarget, useBrowserTargetPanel, onBrowserTargetPanelChange }: ControlProps) {
  const snapshot = useBrowserTarget(value => value)
  const legacyOpen = useBrowserTargetPanel(value => value)
  const overlay = useComposerOverlay('browser-target')
  const open = overlay.available ? overlay.open : legacyOpen
  const toggle = () => {
    if (overlay.available) overlay.toggle()
    else onBrowserTargetPanelChange(!legacyOpen)
  }
  if (snapshot === undefined) return <button className={css.trigger} type="button" aria-label="工作目标上下文：正在读取浏览器标签页" aria-expanded={open} title="正在读取浏览器标签页" data-browser-target-control data-composer-overlay-trigger onMouseDown={event => { event.preventDefault() }} onClick={toggle}>
    <span className={css.globe} aria-hidden="true">◎</span><span className={css.badge} aria-hidden="true">…</span>
  </button>
  const tab = triggerTab(snapshot)
  const count = selectionCount(snapshot)
  const label = snapshot.settings.mode === 'none' ? '工作目标上下文：不绑定目标' : `工作目标上下文：${MODE_LABELS[snapshot.settings.mode]}，当前绑定 ${displayName(tab)}，共 ${count} 个`
  return <button className={css.trigger} type="button" aria-label={label} aria-expanded={open} title={label} data-browser-target-control data-composer-overlay-trigger onMouseDown={event => { event.preventDefault() }} onClick={toggle}>
    {tab === undefined ? <span className={css.globe} aria-hidden="true">◎</span> : <TabIcon tab={tab} />}<span className={css.badge} aria-hidden="true">{count}</span>
  </button>
}

/** The e327 card-wide overlay surface, with a slot fallback for future upstreams. */
function BrowserTargetPanelBody({ useBrowserTarget, onBrowserTargetCommand }: PanelProps) {
  const snapshot = useBrowserTarget(value => value)
  const panelRef = useRef<HTMLDivElement>(null)
  const selectedIds = useMemo(() => new Set(snapshot?.settings.pinnedTabs.map(tab => tab.tabId) ?? []), [snapshot])
  if (snapshot === undefined) return <div ref={panelRef} className={css.panel} role="dialog" aria-label="工作目标上下文"><div className={css.panelHeader}><strong>工作目标上下文</strong><button type="button" className={css.refresh} onClick={() => onBrowserTargetCommand({ command: 'refresh' })}>刷新</button></div><p className={css.empty}>正在读取当前窗口标签页…</p></div>
  const pinned = snapshot.settings.mode === 'pinned-tabs'
  const count = selectionCount(snapshot)
  return <div ref={panelRef} className={css.panel} role="dialog" aria-label="工作目标上下文">
    <div className={css.panelHeader}><strong>工作目标上下文</strong><button type="button" className={css.refresh} onClick={() => onBrowserTargetCommand({ command: 'refresh' })}>刷新</button></div>
    <div className={css.modes} role="radiogroup" aria-label="工作目标模式">{(Object.entries(MODE_LABELS) as Array<[BrowserTargetSnapshot['settings']['mode'], string]>).map(([mode, label]) => <button key={mode} type="button" role="radio" aria-checked={snapshot.settings.mode === mode} className={snapshot.settings.mode === mode ? css.modeActive : css.mode} onClick={() => onBrowserTargetCommand({ command: 'set-mode', mode })}>{label}</button>)}</div>
    <div className={css.panelSubhead}><span>当前窗口标签页</span><span>{pinned ? `已选 ${count} 个` : MODE_LABELS[snapshot.settings.mode]}</span></div>
    <div className={css.tabList}>{(pinned ? [...snapshot.tabs, ...selectedTabs(snapshot).filter(tab => !snapshot.tabs.some(item => item.tabId === tab.tabId))] : snapshot.tabs).map(tab => {
      const selected = selectedIds.has(tab.tabId); const primary = snapshot.settings.primaryTabId === tab.tabId
      return <div className={`${css.tabRow} ${selected ? css.tabRowSelected : ''}`} key={tab.tabId}><input id={`browser-target-tab-${tab.tabId}`} type="checkbox" checked={selected} disabled={!pinned} onChange={event => onBrowserTargetCommand({ command: 'toggle-pinned-tab', tabId: tab.tabId, checked: event.target.checked })} /><label className={css.tabLabel} htmlFor={`browser-target-tab-${tab.tabId}`}><TabIcon tab={tab} /><span className={css.tabCopy}><b>{displayName(tab)}</b><small>{tab.url}</small></span></label><button type="button" className={css.reference} title="采集这个网页的配色、字体和布局" onClick={() => onBrowserTargetCommand({ command: 'capture-design-reference', tabId: tab.tabId })}>作为参考</button>{selected && <button type="button" className={primary ? css.primaryActive : css.primary} disabled={primary} onClick={() => onBrowserTargetCommand({ command: 'set-primary', tabId: tab.tabId })}>{primary ? '主目标' : '设为主目标'}</button>}</div>
    })}{snapshot.tabs.length === 0 && (!pinned || snapshot.settings.pinnedTabs.length === 0) && <p className={css.empty}>没有可选择的标签页。</p>}</div>
    <p className={css.note}>{pinned ? '固定的是勾选的浏览器标签，不是当时的网址。同一标签换了文档时，下一次读取会跟最新内容；关掉标签才失效。主目标用于默认页面和未来写操作。' : snapshot.settings.mode === 'none' ? '下一次浏览器工具调用会明确提示已关闭浏览器能力。' : '跟随模式会在下一次浏览器读取时使用当前标签页。'}</p>
    {snapshot.error !== undefined && <p className={css.error} role="alert">{snapshot.error}</p>}
  </div>
}

function BrowserTargetOverlayBody(props: PanelProps) { return <BrowserTargetPanelBody {...props} /> }

/** Register the existing picker in InputBar's card-wide overlay surface. */
export function BrowserTargetPanel(props: PanelProps) {
  const overlay = useComposerOverlay('browser-target', <BrowserTargetOverlayBody {...props} />)
  const legacyOpen = props.useBrowserTargetPanel(value => value)
  return overlay.available ? null : legacyOpen ? <BrowserTargetPanelBody {...props} /> : null
}
