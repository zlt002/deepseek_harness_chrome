import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { DesignSpecV1, PrototypeActionV1, PrototypeDocumentV1, PrototypeNodeV1 } from '../prototype-document'
import { canonicalJson, prototypeDesignTokens, validatePrototypeBundle } from '../prototype-document'
import { initialRuntimeState, reducePrototypeRuntime } from './runtime-state'
import css from './TrustedPrototypeRuntime.module.css'

export interface PrototypeSelection { elementId: string; type: PrototypeNodeV1['type']; label: string }
export interface TrustedPrototypeRuntimeProps { document: unknown; designSpec: unknown; evidence: readonly unknown[]; revisionId?: string; onSelection?: (selection: PrototypeSelection) => void }

function labelFor(node: PrototypeNodeV1): string { return node.type === 'text' ? node.text : node.type === 'modal' ? node.title : node.label ?? node.id }
function modalNodes(nodes: PrototypeNodeV1[]): PrototypeNodeV1[] { return nodes.flatMap(node => node.type === 'modal' ? [node] : node.type === 'card' ? modalNodes(node.children) : node.type === 'tabs' ? node.tabs.flatMap(tab => modalNodes(tab.children)) : []) }

/** React is trusted application code. It renders only a validated JSON AST. */
function designVariables(spec: DesignSpecV1): React.CSSProperties {
  const tokens = prototypeDesignTokens(spec)
  return {
    '--prototype-primary': tokens.primary,
    '--prototype-surface': tokens.surface,
    '--prototype-radius': tokens.radius,
    '--prototype-font': tokens.font,
    '--prototype-body-size': tokens.bodySize,
    '--prototype-heading-weight': tokens.headingWeight,
  } as React.CSSProperties
}

export function TrustedPrototypeRuntime({ document: rawDocument, designSpec: rawDesignSpec, evidence, revisionId, onSelection }: TrustedPrototypeRuntimeProps) {
  const parsed = useMemo(() => validatePrototypeBundle({ document: rawDocument, designSpec: rawDesignSpec, evidence: [...evidence] }), [rawDocument, rawDesignSpec, evidence])
  if (!parsed.ok) return <section className={css.invalid} role="alert">原型内容未通过安全校验：{parsed.errors[0]}</section>
  const resetKey = revisionId ?? `${canonicalJson(parsed.value.document)}:${canonicalJson(parsed.value.designSpec)}`
  return <Runtime key={resetKey} document={parsed.value.document} designSpec={parsed.value.designSpec} onSelection={onSelection} />
}

function Runtime({ document, designSpec, onSelection }: { document: PrototypeDocumentV1; designSpec: DesignSpecV1; onSelection?: (selection: PrototypeSelection) => void }) {
  const [state, dispatch] = useReducer(reducePrototypeRuntime, document, initialRuntimeState)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { dispatch({ type: 'reset', document }) }, [document])
  useEffect(() => {
    if (state.openModalIds.length === 0) return
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dispatch({ type: 'action', action: { type: 'close-modal', targetId: state.openModalIds.at(-1)! } }) }
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape)
  }, [state.openModalIds])
  const screen = document.screens.find(item => item.id === state.screenId) ?? document.screens[0]
  const select = (node: PrototypeNodeV1) => onSelection?.({ elementId: node.id, type: node.type, label: labelFor(node) })
  const act = (action: PrototypeActionV1 | undefined) => { if (action !== undefined) dispatch({ type: 'action', action }) }
  const render = (node: PrototypeNodeV1): React.JSX.Element | null => {
    // Stop bubbling so a click on a leaf keeps its own stable selection rather
    // than silently selecting the surrounding card or modal.
    const common = { key: node.id, 'data-prototype-element-id': node.id, onClick: (event: React.MouseEvent) => { event.stopPropagation(); select(node) } }
    if (node.type === 'modal') return null
    if (node.type === 'text') return <p {...common} className={`${css.text} ${css[node.tone ?? 'body']}`}>{node.text}</p>
    if (node.type === 'button') return <button {...common} type="button" className={`${css.button} ${css[node.variant ?? 'primary']}`} onClick={() => { select(node); act(node.action) }}>{node.label}</button>
    if (node.type === 'input') return <label {...common} className={css.input}><span>{node.label}</span><input type={node.inputType ?? 'text'} checked={node.inputType === 'checkbox' ? Boolean(state.values[node.id]) : undefined} value={node.inputType === 'checkbox' ? undefined : String(state.values[node.id] ?? node.value ?? '')} placeholder={node.placeholder} onClick={event => { event.stopPropagation(); select(node) }} onChange={event => dispatch({ type: 'input', elementId: node.id, value: node.inputType === 'checkbox' ? event.target.checked : event.target.value })} /></label>
    if (node.type === 'card') return <section {...common} className={css.card}>{node.label !== undefined && <h3>{node.label}</h3>}{node.children.map(render)}</section>
    if (node.type === 'list') return <section {...common} className={css.list}>{node.label !== undefined && <h3>{node.label}</h3>}{node.items.map(item => <button type="button" key={item.id} className={css.listItem} onClick={() => act(item.action)}><b>{item.title}</b>{item.detail !== undefined && <small>{item.detail}</small>}</button>)}</section>
    const active = state.tabs[node.id] ?? node.tabs[0]?.id
    const activeTab = node.tabs.find(tab => tab.id === active)
    return <section {...common} className={css.tabs}>{node.label !== undefined && <h3>{node.label}</h3>}<div role="tablist">{node.tabs.map(tab => <button type="button" role="tab" id={`${node.id}-tab-${tab.id}`} aria-controls={`${node.id}-panel-${tab.id}`} aria-selected={tab.id === active} key={tab.id} onClick={() => dispatch({ type: 'action', action: tab.action ?? { type: 'set-tab', targetId: node.id, value: tab.id } })}>{tab.label}</button>)}</div>{activeTab !== undefined && <div role="tabpanel" id={`${node.id}-panel-${activeTab.id}`} aria-labelledby={`${node.id}-tab-${activeTab.id}`}>{activeTab.children.map(render)}</div>}</section>
  }
  const openModals = modalNodes(screen.nodes).filter(node => node.type === 'modal' && state.openModalIds.includes(node.id))
  return <main className={css.runtime} style={designVariables(designSpec)} aria-label={`${document.title} 交互原型`}><header className={css.header}><span>原型</span><strong>{screen.title}</strong>{state.submitted && <em>已模拟提交</em>}</header><section className={css.canvas}>{screen.nodes.map(render)}</section>{openModals.map(modal => modal.type === 'modal' && <div className={css.backdrop} key={modal.id} role="presentation"><section className={css.modal} role="dialog" aria-modal="true" aria-label={modal.title} data-prototype-element-id={modal.id} onClick={() => select(modal)}><header><strong>{modal.title}</strong><button ref={closeRef} type="button" aria-label="关闭" onClick={() => dispatch({ type: 'action', action: { type: 'close-modal', targetId: modal.id } })}>×</button></header>{modal.children.map(render)}</section></div>)}</main>
}
