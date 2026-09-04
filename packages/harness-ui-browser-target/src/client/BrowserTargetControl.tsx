import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useComposerOverlay } from '@deepseek-ai/dsh-client-ui-primitives'
import { browserTargetTriggerTab, type BrowserTargetCommand, type BrowserTargetSnapshot, type BrowserTargetTab } from './active-tab-bridge.ts'
import { browserTargetPanelCeiling, browserTargetPanelMaxHeightPx } from './panel-geometry.js'
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
  return browserTargetTriggerTab(snapshot)
}

function selectionCount(snapshot: BrowserTargetSnapshot): number {
  if (snapshot.lockedRunTarget !== undefined) return 1
  if (snapshot.settings.mode === 'follow-active-tab') return snapshot.activeTab === undefined ? 0 : 1
  if (snapshot.settings.mode === 'none') return 0
  return snapshot.settings.pinnedTabs.length
}

function TabIcon({ tab }: { tab: BrowserTargetTab }) {
  if (tab.favIconUrl !== undefined) return <img className={css.favicon} src={tab.favIconUrl} alt="" />
  return <span className={css.faviconFallback} aria-hidden="true">{displayName(tab).slice(0, 1).toUpperCase()}</span>
}

/** Grow the chooser up to the compact header while the sidebar layout changes. */
function useBrowserTargetPanelMaxHeight(panelRef: RefObject<HTMLElement>): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const fit = () => {
      const header = document.querySelector<HTMLElement>('[data-testid="compact-header"]')
      const presentation = panel.closest<HTMLElement>('[data-conversation-presentation]')
      const ceiling = browserTargetPanelCeiling(
        header?.getBoundingClientRect().bottom,
        presentation?.getBoundingClientRect().top,
      )
      setMaxHeight(browserTargetPanelMaxHeightPx(panel.getBoundingClientRect().bottom, ceiling))
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit)
    observer?.observe(panel)
    observer?.observe(document.documentElement)
    for (const target of [
      document.querySelector('[data-testid="compact-header"]'),
      panel.closest('[data-conversation-presentation]'),
      panel.closest('[data-composer-seat]'),
    ]) {
      if (target instanceof Element) observer?.observe(target)
    }
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [panelRef])
  return maxHeight
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
  const label = snapshot.lockedRunTarget !== undefined
    ? `工作目标上下文：本次运行已固定 ${displayName(tab)}；下一轮策略 ${MODE_LABELS[snapshot.settings.mode]}，共 ${count} 个`
    : snapshot.settings.mode === 'none' ? '工作目标上下文：不绑定目标' : `工作目标上下文：${MODE_LABELS[snapshot.settings.mode]}，当前绑定 ${displayName(tab)}，共 ${count} 个`
  return <button className={css.trigger} type="button" aria-label={label} aria-expanded={open} title={label} data-browser-target-control data-composer-overlay-trigger onMouseDown={event => { event.preventDefault() }} onClick={toggle}>
    {tab === undefined ? <span className={css.globe} aria-hidden="true">◎</span> : <TabIcon tab={tab} />}<span className={css.badge} aria-hidden="true">{count}</span>
  </button>
}

/** The e327 card-wide overlay surface, with a slot fallback for future upstreams. */
function BrowserTargetPanelBody({ useBrowserTarget, onBrowserTargetCommand }: PanelProps) {
  const snapshot = useBrowserTarget(value => value)
  const panelRef = useRef<HTMLDivElement>(null)
  const maxHeight = useBrowserTargetPanelMaxHeight(panelRef)
  const [referenceTabIds, setReferenceTabIds] = useState<number[]>([])
  const selectedIds = useMemo(() => new Set(snapshot?.settings.pinnedTabs.map(tab => tab.tabId) ?? []), [snapshot])
  if (snapshot === undefined) return <div ref={panelRef} className={css.panel} role="dialog" aria-label="工作目标上下文" style={maxHeight === undefined ? undefined : { maxHeight }}><div className={css.panelHeader}><strong>工作目标上下文</strong><button type="button" className={css.refresh} onClick={() => onBrowserTargetCommand({ command: 'refresh' })}>刷新</button></div><p className={css.empty}>正在读取标签页…</p></div>
  const pinned = snapshot.settings.mode === 'pinned-tabs'
  const captureBusy = snapshot.capturingDesignReferenceTabId !== undefined
  const referenceTabs = referenceTabIds.filter(tabId => snapshot.tabs.some(tab => tab.tabId === tabId)).slice(0, 3)
  return <div ref={panelRef} className={css.panel} role="dialog" aria-label="工作目标上下文" style={maxHeight === undefined ? undefined : { maxHeight }}>
    <div className={css.panelHeader}><strong>工作目标上下文</strong><button type="button" className={css.refresh} onClick={() => onBrowserTargetCommand({ command: 'refresh' })}>刷新</button></div>
    <div className={css.modes} role="radiogroup" aria-label="工作目标模式">{(Object.entries(MODE_LABELS) as Array<[BrowserTargetSnapshot['settings']['mode'], string]>).map(([mode, label]) => <button key={mode} type="button" role="radio" aria-checked={snapshot.settings.mode === mode} className={snapshot.settings.mode === mode ? css.modeActive : css.mode} onClick={() => onBrowserTargetCommand({ command: 'set-mode', mode })}>{label}</button>)}</div>
    {referenceTabs.length >= 2 && <div className={css.listActions}><button className={css.referenceMerge} type="button" disabled={captureBusy} onClick={() => onBrowserTargetCommand({ command: 'capture-design-references', tabIds: referenceTabs })}>合并提取设计规范（{referenceTabs.length} 页）</button></div>}
    <div className={css.tabList}>{(pinned ? [...snapshot.tabs, ...selectedTabs(snapshot).filter(tab => !snapshot.tabs.some(item => item.tabId === tab.tabId))] : snapshot.tabs).map(tab => {
      const selected = selectedIds.has(tab.tabId); const primary = snapshot.settings.primaryTabId === tab.tabId
      const capturingThisTab = snapshot.capturingDesignReferenceTabId === tab.tabId
      const referenceSelected = referenceTabs.includes(tab.tabId)
      const captureTitle = capturingThisTab ? '正在提取这个网页的设计规范…' : '读取颜色、字体、间距、圆角、投影和组件样式，并打开原型页'
      return <div className={`${css.tabRow} ${selected ? css.tabRowSelected : ''}`} key={tab.tabId}><input id={`browser-target-tab-${tab.tabId}`} type="checkbox" checked={selected} disabled={!pinned} onChange={event => onBrowserTargetCommand({ command: 'toggle-pinned-tab', tabId: tab.tabId, checked: event.target.checked })} /><label className={css.tabLabel} htmlFor={`browser-target-tab-${tab.tabId}`}><TabIcon tab={tab} /><span className={css.tabCopy}><b>{displayName(tab)}</b><small>{tab.url}</small></span></label>{tab.url.startsWith('file:') && <button type="button" className={css.reference} title="点选 HTML 元素；Shift 多选，Alt 选择父级" onClick={() => onBrowserTargetCommand({ command: 'html-workbench-select', tabId: tab.tabId })}>编辑 HTML</button>}<label className={css.referencePick}><input type="checkbox" checked={referenceSelected} disabled={captureBusy || (!referenceSelected && referenceTabs.length >= 3)} onChange={event => setReferenceTabIds(current => event.target.checked ? [...current.filter(item => item !== tab.tabId), tab.tabId].slice(-3) : current.filter(item => item !== tab.tabId))} />合并参考</label><button type="button" className={css.reference} title={captureTitle} disabled={captureBusy} aria-busy={capturingThisTab} onClick={() => onBrowserTargetCommand({ command: 'capture-design-reference', tabId: tab.tabId })}>{capturingThisTab ? '正在提取…' : '单宽度'}</button><button type="button" className={css.reference} title="临时打开并自动关闭桌面、平板、手机测试窗口，实测同一网页的布局变化" disabled={captureBusy} onClick={() => onBrowserTargetCommand({ command: 'capture-responsive-design-reference', tabId: tab.tabId })}>多尺寸</button>{selected && <button type="button" className={primary ? css.primaryActive : css.primary} disabled={primary} onClick={() => onBrowserTargetCommand({ command: 'set-primary', tabId: tab.tabId })}>{primary ? '主目标' : '设为主目标'}</button>}</div>
    })}{snapshot.tabs.length === 0 && (!pinned || snapshot.settings.pinnedTabs.length === 0) && <p className={css.empty}>没有可选择的标签页。</p>}</div>
    <p className={css.note}>{snapshot.lockedRunTarget !== undefined ? `本次运行已固定为 ${displayName(snapshot.lockedRunTarget)}；下方策略仅影响下一轮。` : pinned ? '固定的是勾选的浏览器标签，不是当时的网址。同一标签换了文档时，下一次读取会跟最新内容；关掉标签才失效。主目标用于默认页面和未来写操作。' : snapshot.settings.mode === 'none' ? '下一次浏览器工具调用会明确提示已关闭浏览器能力。' : '发送后，本次运行会固定发送瞬间的 Browser Target；运行结束后恢复跟随。'}</p>
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
