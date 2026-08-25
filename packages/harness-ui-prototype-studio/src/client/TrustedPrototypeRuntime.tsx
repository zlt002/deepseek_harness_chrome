import { Fragment, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { DesignSpecV1, PrototypeActionV1, PrototypeDocumentV1, PrototypeIconName, PrototypeInputNodeV1, PrototypeNodeV1, PrototypeTableRowV1 } from '../prototype-document'
import { canonicalJson, PROTOTYPE_ICON_PATHS, prototypeDesignTokens, validatePrototypeBundle } from '../prototype-document'
import { initialRuntimeState, prototypeInputHasValidationError, reducePrototypeRuntime } from './runtime-state'
import css from './TrustedPrototypeRuntime.module.css'

export type PrototypeSelectableType = PrototypeNodeV1['type'] | 'table-row' | 'list-item' | 'tab' | 'navigation-item' | 'breadcrumb-item'
export interface PrototypeSelection { elementId: string; type: PrototypeSelectableType; label: string }
export type PrototypeRuntimeMode = 'interact' | 'select'
export interface TrustedPrototypeRuntimeProps { document: unknown; designSpec: unknown; evidence: readonly unknown[]; revisionId?: string; selectedElementId?: string; mode?: PrototypeRuntimeMode; onSelection?: (selection: PrototypeSelection) => void }

function labelFor(node: PrototypeNodeV1): string {
  if (node.type === 'text' || node.type === 'badge') return node.text
  if (node.type === 'icon') return node.label ?? node.name
  if (node.type === 'modal' || node.type === 'alert' || node.type === 'empty-state') return node.title
  return node.label ?? node.id
}

/** The icon node exposes only a name; all SVG geometry stays in this trusted renderer. */
function BuiltInIcon({ name, label }: { name: PrototypeIconName; label?: string }): React.JSX.Element {
  return <svg className={css.iconGraphic} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role={label === undefined ? undefined : 'img'} aria-label={label} aria-hidden={label === undefined ? true : undefined} focusable="false"><path d={PROTOTYPE_ICON_PATHS[name]} /></svg>
}
function isVisible(node: PrototypeNodeV1, state: ReturnType<typeof initialRuntimeState>): boolean {
  return node.visibleWhen === undefined || state.stateValues[node.visibleWhen.stateId] === node.visibleWhen.equals
}
function modalNodes(nodes: PrototypeNodeV1[], state: ReturnType<typeof initialRuntimeState>): PrototypeNodeV1[] {
  return nodes.flatMap(node => !isVisible(node, state) ? [] : node.type === 'modal' ? [node] : node.type === 'card' || node.type === 'group' ? modalNodes(node.children, state) : node.type === 'tabs' ? node.tabs.flatMap(tab => modalNodes(tab.children, state)) : [])
}
function actionOpensModal(action: PrototypeActionV1 | undefined): boolean {
  return action?.type === 'open-modal' || (action?.type === 'sequence' && (action.actions ?? []).some(actionOpensModal))
}
function actionSubmits(action: PrototypeActionV1 | undefined): boolean {
  return action?.type === 'submit-success' || (action?.type === 'sequence' && (action.actions ?? []).some(actionSubmits))
}
function requiredInputs(nodes: PrototypeNodeV1[], state: ReturnType<typeof initialRuntimeState>): PrototypeInputNodeV1[] {
  return nodes.flatMap(node => {
    if (!isVisible(node, state)) return []
    if (node.type === 'input') return node.required === true || node.inputType === 'email' || node.inputType === 'number' ? [node] : []
    if (node.type === 'modal') return state.openModalIds.includes(node.id) ? requiredInputs(node.children, state) : []
    if (node.type === 'card' || node.type === 'group') return requiredInputs(node.children, state)
    if (node.type === 'tabs') { const active = state.tabs[node.id] ?? node.tabs[0]?.id; return requiredInputs(node.tabs.find(tab => tab.id === active)?.children ?? [], state) }
    return []
  })
}

type TableRuntimeState = Record<string, { page: number; sortDirection: 'asc' | 'desc' }>

function tableRows(node: Extract<PrototypeNodeV1, { type: 'table' }>, rows: PrototypeTableRowV1[], inputValue: (inputId: string) => string, page: number, sortDirection: 'asc' | 'desc') {
  const filtered = rows.filter(row => (node.filters ?? []).every(filter => {
    const expected = inputValue(filter.inputId).trim().toLocaleLowerCase()
    if (expected === '') return true
    const actual = row.values[node.columns.findIndex(column => column.key === filter.columnKey)]!.toLocaleLowerCase()
    return filter.operator === 'equals' ? actual === expected : actual.includes(expected)
  }))
  const sorted = node.sort === undefined ? filtered : [...filtered].sort((left, right) => {
    const columnIndex = node.columns.findIndex(column => column.key === node.sort!.columnKey)
    const comparison = left.values[columnIndex]!.localeCompare(right.values[columnIndex]!, undefined, { sensitivity: 'base' })
    return sortDirection === 'asc' ? comparison : -comparison
  })
  const pageSize = node.pagination?.pageSize
  const pageCount = pageSize === undefined ? 1 : Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(Math.max(1, page), pageCount)
  return { rows: pageSize === undefined ? sorted : sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize), pageCount, currentPage }
}

function findInput(nodes: PrototypeNodeV1[], inputId: string): PrototypeInputNodeV1 | undefined {
  for (const node of nodes) {
    if (node.type === 'input' && node.id === inputId) return node
    const children = node.type === 'card' || node.type === 'group' || node.type === 'modal' ? node.children : node.type === 'tabs' ? node.tabs.flatMap(tab => tab.children) : []
    const input = findInput(children, inputId)
    if (input !== undefined) return input
  }
  return undefined
}

function findTable(nodes: PrototypeNodeV1[], tableId: string): Extract<PrototypeNodeV1, { type: 'table' }> | undefined {
  for (const node of nodes) {
    if (node.type === 'table' && node.id === tableId) return node
    const children = node.type === 'card' || node.type === 'group' || node.type === 'modal' ? node.children : node.type === 'tabs' ? node.tabs.flatMap(tab => tab.children) : []
    const table = findTable(children, tableId)
    if (table !== undefined) return table
  }
  return undefined
}

function isCrudAction(action: PrototypeActionV1): boolean { return action.type === 'add-row' || action.type === 'edit-row' || action.type === 'delete-row' }
function isCrudText(value: string): boolean { return value.length <= 500 && !/[<>;{}]/.test(value) && !/\b(?:javascript|data|vbscript):|https?:\/\/|url\s*\(/i.test(value) }

type FieldRuntimeEffects = Map<string, { visible?: boolean; disabled?: boolean; options?: PrototypeInputNodeV1['options'] }>

function resolveFieldEffects(document: PrototypeDocumentV1, state: ReturnType<typeof initialRuntimeState>): FieldRuntimeEffects {
  const effects: FieldRuntimeEffects = new Map()
  const inputValue = (inputId: string): string => {
    const input = document.screens.map(screen => findInput(screen.nodes, inputId)).find((item): item is PrototypeInputNodeV1 => item !== undefined)
    if (input === undefined) return ''
    return String(input.bindStateId === undefined ? state.values[inputId] ?? input.value ?? '' : state.stateValues[input.bindStateId] ?? input.value ?? '')
  }
  for (const rule of document.fieldRules ?? []) {
    const applies = rule.conditions.every(condition => {
      const value = inputValue(condition.fieldId).trim()
      return condition.operator === 'equals' ? value === condition.value : condition.operator === 'not-equals' ? value !== condition.value : condition.operator === 'empty' ? value === '' : value !== ''
    })
    if (!applies) continue
    const current = effects.get(rule.targetId) ?? {}
    if (rule.effect.type === 'show') current.visible = true
    if (rule.effect.type === 'hide') current.visible = false
    if (rule.effect.type === 'enable') current.disabled = false
    if (rule.effect.type === 'disable') current.disabled = true
    if (rule.effect.type === 'set-options') current.options = rule.effect.options
    effects.set(rule.targetId, current)
  }
  return effects
}

/** React is trusted application code. It renders only a validated JSON AST. */
function designVariables(spec: DesignSpecV1): React.CSSProperties {
  const tokens = prototypeDesignTokens(spec)
  return {
    '--prototype-primary': tokens.primary,
    '--prototype-on-primary': tokens.onPrimary,
    '--prototype-info': tokens.info,
    '--prototype-on-info': tokens.onInfo,
    '--prototype-positive': tokens.positive,
    '--prototype-on-positive': tokens.onPositive,
    '--prototype-warning': tokens.warning,
    '--prototype-on-warning': tokens.onWarning,
    '--prototype-danger': tokens.danger,
    '--prototype-on-danger': tokens.onDanger,
    '--prototype-page': tokens.page,
    '--prototype-surface': tokens.surface,
    '--prototype-elevated': tokens.elevated,
    '--prototype-text': tokens.text,
    '--prototype-text-muted': tokens.textMuted,
    '--prototype-border': tokens.border,
    '--prototype-border-width': tokens.borderWidth,
    '--prototype-border-style': tokens.borderStyle,
    '--prototype-radius': tokens.radius,
    '--prototype-radius-small': tokens.radiusSmall,
    '--prototype-radius-large': tokens.radiusLarge,
    '--prototype-control-radius': tokens.controlRadius,
    '--prototype-font': tokens.font,
    '--prototype-body-size': tokens.bodySize,
    '--prototype-body-weight': tokens.bodyWeight,
    '--prototype-body-line-height': tokens.bodyLineHeight,
    '--prototype-heading-size': tokens.headingSize,
    '--prototype-heading-line-height': tokens.headingLineHeight,
    '--prototype-heading-weight': tokens.headingWeight,
    '--prototype-caption-size': tokens.captionSize,
    '--prototype-letter-spacing': tokens.letterSpacing,
    '--prototype-space-small': tokens.spaceSmall,
    '--prototype-space-medium': tokens.spaceMedium,
    '--prototype-space-large': tokens.spaceLarge,
    '--prototype-section-gap': tokens.sectionGap,
    '--prototype-content-width': tokens.contentWidth,
    '--prototype-shadow': tokens.surfaceShadow,
    '--prototype-gradient': tokens.primaryControlGradient,
    '--prototype-surface-shadow': tokens.surfaceShadow,
    '--prototype-elevated-shadow': tokens.elevatedShadow,
    '--prototype-disabled-opacity': tokens.disabledOpacity,
    '--prototype-control-height': tokens.controlHeight,
    '--prototype-input-height': tokens.inputHeight,
    '--prototype-icon-size': tokens.iconSize,
    '--prototype-motion-duration': tokens.motionDuration,
    '--prototype-motion-easing': tokens.motionEasing,
    '--prototype-focus-width': tokens.focusWidth,
    '--prototype-focus-style': tokens.focusStyle,
    '--prototype-focus-color': tokens.focusColor,
    '--prototype-focus-offset': tokens.focusOffset,
  } as React.CSSProperties
}

export function TrustedPrototypeRuntime({ document: rawDocument, designSpec: rawDesignSpec, evidence, revisionId, selectedElementId, mode = 'interact', onSelection }: TrustedPrototypeRuntimeProps) {
  const parsed = useMemo(() => validatePrototypeBundle({ document: rawDocument, designSpec: rawDesignSpec, evidence: [...evidence] }), [rawDocument, rawDesignSpec, evidence])
  if (!parsed.ok) return <section className={css.invalid} role="alert">原型内容未通过安全校验：{parsed.errors[0]}</section>
  const resetKey = revisionId ?? `${canonicalJson(parsed.value.document)}:${canonicalJson(parsed.value.designSpec)}`
  return <Runtime key={resetKey} document={parsed.value.document} designSpec={parsed.value.designSpec} selectedElementId={selectedElementId} mode={mode} onSelection={onSelection} />
}

function Runtime({ document, designSpec, selectedElementId, mode, onSelection }: { document: PrototypeDocumentV1; designSpec: DesignSpecV1; selectedElementId?: string; mode: PrototypeRuntimeMode; onSelection?: (selection: PrototypeSelection) => void }) {
  const [state, dispatch] = useReducer(reducePrototypeRuntime, document, initialRuntimeState)
  const [tableState, setTableState] = useState<TableRuntimeState>({})
  const [tableData, setTableData] = useState<Record<string, PrototypeTableRowV1[]>>({})
  const [pendingDelete, setPendingDelete] = useState<{ tableId: string; rowId: string; businessName: string }>()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const runtimeRef = useRef<HTMLElement>(null)
  const focusOriginRef = useRef<HTMLElement | null>(null)
  const previousModalCountRef = useRef(0)
  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime === null) return
    const breakpoint = prototypeDesignTokens(designSpec).compactBreakpoint
    const updateCompactLayout = (): void => { runtime.dataset.prototypeCompact = String(runtime.clientWidth <= breakpoint) }
    updateCompactLayout()
    const observer = new ResizeObserver(updateCompactLayout)
    observer.observe(runtime)
    return () => observer.disconnect()
  }, [designSpec])
  useEffect(() => { dispatch({ type: 'reset', document }) }, [document])
  useEffect(() => { setTableState({}) }, [document])
  useEffect(() => { setTableData({}); setPendingDelete(undefined) }, [document])
  useEffect(() => {
    const firstInvalidId = state.validationErrorIds[0]
    if (mode !== 'interact' || firstInvalidId === undefined) return
    window.requestAnimationFrame(() => runtimeRef.current?.querySelector<HTMLElement>(`[data-prototype-element-id="${firstInvalidId}"] input, [data-prototype-element-id="${firstInvalidId}"] textarea, [data-prototype-element-id="${firstInvalidId}"] select`)?.focus())
  }, [mode, state.validationErrorIds])
  useEffect(() => {
    const count = state.openModalIds.length
    if (count > previousModalCountRef.current) closeRef.current?.focus()
    if (count === 0 && previousModalCountRef.current > 0) { focusOriginRef.current?.focus(); focusOriginRef.current = null }
    previousModalCountRef.current = count
    if (count === 0) return
    const handleDialogKey = (event: KeyboardEvent) => {
      if (mode === 'interact' && event.key === 'Escape') { event.preventDefault(); dispatch({ type: 'action', action: { type: 'close-modal', targetId: state.openModalIds.at(-1)! } }); return }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) { event.preventDefault(); return }
      const first = focusable[0]!; const last = focusable.at(-1)!
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleDialogKey); return () => window.removeEventListener('keydown', handleDialogKey)
  }, [mode, state.openModalIds])
  const screen = document.screens.find(item => item.id === state.screenId) ?? document.screens[0]
  const fieldEffects = resolveFieldEffects(document, state)
  const isRenderable = (node: PrototypeNodeV1): boolean => isVisible(node, state) && fieldEffects.get(node.id)?.visible !== false
  const select = (node: PrototypeNodeV1) => onSelection?.({ elementId: node.id, type: node.type, label: labelFor(node) })
  const selectPart = (elementId: string, type: 'table-row' | 'list-item' | 'tab' | 'navigation-item' | 'breadcrumb-item', label: string) => onSelection?.({ elementId, type, label })
  const selectOnKey = (event: React.KeyboardEvent, selectItem: () => void): void => {
    if (mode === 'select' && event.key === 'Escape') {
      event.preventDefault()
      runtimeRef.current?.querySelectorAll<HTMLElement>('[data-prototype-selected="true"]').forEach(item => { delete item.dataset.prototypeSelected })
      return
    }
    if (mode !== 'select' || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    event.stopPropagation()
    selectItem()
  }
  const crudRows = (tableId: string): PrototypeTableRowV1[] => tableData[tableId] ?? findTable(screen.nodes, tableId)?.rows ?? []
  const runCrud = (action: PrototypeActionV1, rowId?: string): void => {
    const table = action.tableId === undefined ? undefined : findTable(screen.nodes, action.tableId)
    if (table === undefined) return
    const fields = (action.fieldMap ?? []).map(mapping => ({ mapping, input: findInput(screen.nodes, mapping.fieldId) }))
    const invalid = fields.filter(({ input }) => input === undefined || !isRenderable(input) || fieldEffects.get(input.id)?.disabled === true || prototypeInputHasValidationError(input, state) || !isCrudText(inputValue(input.id))).map(({ mapping }) => mapping.fieldId)
    if (invalid.length > 0) { dispatch({ type: 'validate', missingInputIds: invalid }); return }
    const values = (row?: PrototypeTableRowV1): string[] => table.columns.map(column => {
      const mapped = fields.find(item => item.mapping.columnKey === column.key)
      return mapped === undefined ? row?.values[table.columns.findIndex(item => item.key === column.key)] ?? '' : inputValue(mapped.mapping.fieldId)
    })
    if (action.type === 'delete-row') { if (rowId !== undefined && crudRows(table.id).some(row => row.id === rowId)) setPendingDelete({ tableId: table.id, rowId, businessName: action.businessName ?? '记录' }); return }
    if (action.type === 'add-row') setTableData(current => { const rows = [...(current[table.id] ?? table.rows)]; if (rows.length >= 50) return current; let index = rows.length + 1; let id = `runtime-${index}`; while (rows.some(row => row.id === id)) { index += 1; id = `runtime-${index}` }; return { ...current, [table.id]: [...rows, { id, values: values() }] } })
    if (action.type === 'edit-row' && rowId !== undefined) setTableData(current => ({ ...current, [table.id]: (current[table.id] ?? table.rows).map(row => row.id === rowId ? { ...row, values: values(row) } : row) }))
    setTableState(current => ({ ...current, [table.id]: { page: 1, sortDirection: current[table.id]?.sortDirection ?? table.sort?.direction ?? 'asc' } }))
  }
  const confirmDelete = (): void => { if (pendingDelete === undefined) return; setTableData(current => ({ ...current, [pendingDelete.tableId]: (current[pendingDelete.tableId] ?? findTable(screen.nodes, pendingDelete.tableId)?.rows ?? []).filter(row => row.id !== pendingDelete.rowId) })); setTableState(current => ({ ...current, [pendingDelete.tableId]: { page: 1, sortDirection: current[pendingDelete.tableId]?.sortDirection ?? 'asc' } })); setPendingDelete(undefined) }
  const act = (action: PrototypeActionV1 | undefined, rowId?: string) => { if (mode === 'interact' && action !== undefined) { if (isCrudAction(action)) { runCrud(action, rowId); return } if (actionOpensModal(action) && window.document.activeElement instanceof HTMLElement) focusOriginRef.current = window.document.activeElement; if (actionSubmits(action)) { dispatch({ type: 'submit', action, missingInputIds: requiredInputs(screen.nodes, state).filter(node => isRenderable(node) && fieldEffects.get(node.id)?.disabled !== true && prototypeInputHasValidationError(node, state)).map(node => node.id) }) } else dispatch({ type: 'action', action }) } }
  const inputValue = (inputId: string): string => {
    const input = document.screens.map(screen => findInput(screen.nodes, inputId)).find((item): item is PrototypeInputNodeV1 => item !== undefined)
    if (input === undefined) return ''
    return String(input.bindStateId === undefined ? state.values[inputId] ?? input.value ?? '' : state.stateValues[input.bindStateId] ?? input.value ?? '')
  }
  const resetTablePagesForInput = (inputId: string): void => setTableState(current => Object.fromEntries(Object.entries(current).map(([tableId, value]) => {
    const table = document.screens.map(screen => findTable(screen.nodes, tableId)).find((item): item is Extract<PrototypeNodeV1, { type: 'table' }> => item !== undefined)
    return [tableId, table?.filters?.some(filter => filter.inputId === inputId) ? { ...value, page: 1 } : value]
  })))
  const render = (node: PrototypeNodeV1): React.JSX.Element | null => {
    if (!isRenderable(node)) return null
    // Stop bubbling so a click on a leaf keeps its own stable selection rather
    // than silently selecting the surrounding card or modal.
    const common = { key: node.id, 'data-prototype-element-id': node.id, 'data-prototype-selected': selectedElementId === node.id ? 'true' : undefined, tabIndex: mode === 'select' ? 0 : undefined, onClick: (event: React.MouseEvent) => { event.stopPropagation(); select(node) }, onKeyDown: (event: React.KeyboardEvent) => selectOnKey(event, () => select(node)) }
    if (node.type === 'modal') return null
    if (node.type === 'text') return <p {...common} className={`${css.text} ${css[node.tone ?? 'body']}`}>{node.text.replace(/\$\{([^}]+)\}/g, (_, inputId: string) => inputValue(inputId))}</p>
    if (node.type === 'icon') return <span {...common} className={css.iconNode}><BuiltInIcon name={node.name} label={node.label} /></span>
    if (node.type === 'button') { const disabled = node.disabled === true || fieldEffects.get(node.id)?.disabled === true; return <button {...common} type="button" disabled={disabled && mode !== 'select'} aria-disabled={disabled || undefined} className={`${css.button} ${css[node.variant ?? 'primary']}`} onClick={event => { event.stopPropagation(); select(node); act(node.action) }}>{node.label}</button> }
    if (node.type === 'input') { const value = String(node.bindStateId === undefined ? state.values[node.id] ?? node.value ?? '' : state.stateValues[node.bindStateId] ?? node.value ?? ''); const invalid = state.validationErrorIds.includes(node.id); const disabled = fieldEffects.get(node.id)?.disabled === true; const options = fieldEffects.get(node.id)?.options ?? node.options; const selectInput = (event: React.MouseEvent) => { event.stopPropagation(); select(node) }; const preventEdit = (event: React.SyntheticEvent) => { if (mode === 'select') event.preventDefault() }; const update = (value: string | boolean) => { if (mode === 'interact' && !disabled) { dispatch({ type: 'input', elementId: node.id, value, ...(node.bindStateId === undefined ? {} : { bindStateId: node.bindStateId }) }); resetTablePagesForInput(node.id) } }; const fieldProps = { disabled: disabled && mode !== 'select', 'aria-disabled': disabled || undefined, 'aria-invalid': invalid || undefined, 'aria-required': node.required || undefined, 'aria-describedby': invalid ? `${node.id}-error` : undefined }; const validationMessage = node.errorText ?? (node.inputType === 'email' ? `请输入有效的${node.label}` : node.inputType === 'number' ? `请输入有效数字` : `请填写${node.label}`); return <label {...common} className={`${css.input} ${invalid ? css.inputInvalid : ''}`}><span>{node.label}{node.required && <em aria-hidden="true">*</em>}</span>{node.inputType === 'textarea' ? <textarea {...fieldProps} value={value} placeholder={node.placeholder} onMouseDown={preventEdit} onKeyDown={preventEdit} onClick={selectInput} onChange={event => update(event.target.value)} /> : node.inputType === 'select' ? <select {...fieldProps} value={value} onMouseDown={preventEdit} onKeyDown={preventEdit} onClick={selectInput} onChange={event => update(event.target.value)}><option value="">{node.placeholder ?? '请选择'}</option>{options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input {...fieldProps} type={node.inputType ?? 'text'} checked={node.inputType === 'checkbox' ? Boolean(state.values[node.id]) : undefined} value={node.inputType === 'checkbox' ? undefined : value} placeholder={node.placeholder} onMouseDown={preventEdit} onKeyDown={preventEdit} onClick={selectInput} onChange={event => update(node.inputType === 'checkbox' ? event.target.checked : event.target.value)} />}{invalid && <small id={`${node.id}-error`} className={css.inputError} role="alert">{validationMessage}</small>}</label> }
    if (node.type === 'card') return <section {...common} className={css.card}>{node.label !== undefined && <h3>{node.label}</h3>}{node.children.map(render)}</section>
    if (node.type === 'group') return <section {...common} className={`${css.group} ${css[node.layout]}`}>{node.label !== undefined && <h3>{node.label}</h3>}{node.children.map(render)}</section>
    if (node.type === 'metric') return <article {...common} className={`${css.metric} ${css[node.tone ?? 'neutral']}`}><small>{node.label}</small><strong>{node.value}</strong>{node.detail !== undefined && <span>{node.detail}</span>}</article>
    if (node.type === 'badge') return <span {...common} className={`${css.badge} ${css[node.tone ?? 'neutral']}`}>{node.text}</span>
    if (node.type === 'alert') return <aside {...common} className={`${css.alert} ${css[node.tone ?? 'info']}`} role="status"><b>{node.title}</b>{node.detail !== undefined && <span>{node.detail}</span>}</aside>
    if (node.type === 'progress') return <section {...common} className={css.progress}><header><b>{node.label}</b><span>{node.detail ?? `${node.value}%`}</span></header><div role="progressbar" aria-label={node.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={node.value}><i className={css[node.tone ?? 'primary']} style={{ width: `${node.value}%` }} /></div></section>
    if (node.type === 'chart') { const maximum = Math.max(...node.bars.map(bar => bar.value), 1); return <figure {...common} className={css.chart}><figcaption>{node.label}</figcaption><div>{node.bars.map((bar, index) => <span key={`${node.id}-${index}`}><small>{bar.label}</small><i style={{ height: `${Math.max(4, Math.round(bar.value / maximum * 100))}%` }} /><b>{bar.value}</b></span>)}</div></figure> }
    if (node.type === 'table') { const rows = crudRows(node.id); const hasActions = rows.some(row => row.action !== undefined); const tableLabel = node.label ?? '表格'; const table = tableState[node.id] ?? { page: 1, sortDirection: node.sort?.direction ?? 'asc' as const }; const view = tableRows(node, rows, inputValue, table.page, table.sortDirection); const setTable = (next: Partial<typeof table>) => { if (mode === 'interact') setTableState(current => ({ ...current, [node.id]: { ...table, ...next } })) }; return <section {...common} className={css.table}>{node.label !== undefined && <h3>{node.label}</h3>}<div><table><thead><tr>{node.columns.map(column => <th scope="col" key={column.key}>{node.sort?.columnKey === column.key ? <button type="button" className={css.tableSort} aria-label={`按${column.label}排序（${table.sortDirection === 'asc' ? '升序' : '降序'}）`} onClick={event => { event.stopPropagation(); if (mode === 'select') select(node); else setTable({ page: 1, sortDirection: table.sortDirection === 'asc' ? 'desc' : 'asc' }) }}>{column.label} {table.sortDirection === 'asc' ? '↑' : '↓'}</button> : column.label}</th>)}{hasActions && <th scope="col">操作</th>}</tr></thead><tbody>{view.rows.map(row => <tr key={row.id} data-prototype-element-id={row.id} data-prototype-selected={selectedElementId === row.id ? 'true' : undefined} tabIndex={mode === 'select' ? 0 : undefined} onClick={event => { event.stopPropagation(); if (mode === 'select') selectPart(row.id, 'table-row', row.values[0] ?? row.id) }} onKeyDown={event => selectOnKey(event, () => selectPart(row.id, 'table-row', row.values[0] ?? row.id))}>{row.values.map((value, index) => <td key={`${row.id}-${node.columns[index]!.key}`}>{value}</td>)}{hasActions && <td>{row.action !== undefined && <button type="button" aria-label={`${tableLabel}：打开 ${row.values[0] ?? row.id}`} onClick={event => { event.stopPropagation(); selectPart(row.id, 'table-row', row.values[0] ?? row.id); act(row.action, row.id) }}>打开详情</button>}</td>}</tr>)}</tbody></table></div>{node.pagination !== undefined && <nav className={css.tablePagination} aria-label={`${tableLabel}分页`}><span>{view.rows.length === 0 ? '暂无结果' : `第 ${view.currentPage} / ${view.pageCount} 页`}</span><button type="button" disabled={view.currentPage === 1 && mode !== 'select'} onClick={event => { event.stopPropagation(); if (mode === 'select') select(node); else setTable({ page: view.currentPage - 1 }) }}>上一页</button><button type="button" disabled={view.currentPage === view.pageCount && mode !== 'select'} onClick={event => { event.stopPropagation(); if (mode === 'select') select(node); else setTable({ page: view.currentPage + 1 }) }}>下一页</button></nav>}</section> }
    if (node.type === 'list') return <section {...common} className={css.list}>{node.label !== undefined && <h3>{node.label}</h3>}{node.items.map(item => item.action === undefined ? <div key={item.id} className={css.listItem} data-prototype-element-id={item.id} data-prototype-selected={selectedElementId === item.id ? 'true' : undefined} tabIndex={mode === 'select' ? 0 : undefined} onClick={event => { event.stopPropagation(); if (mode === 'select') selectPart(item.id, 'list-item', item.title) }} onKeyDown={event => selectOnKey(event, () => selectPart(item.id, 'list-item', item.title))}><b>{item.title}</b>{item.detail !== undefined && <small>{item.detail}</small>}</div> : <button type="button" key={item.id} className={css.listItem} data-prototype-element-id={item.id} data-prototype-selected={selectedElementId === item.id ? 'true' : undefined} onClick={event => { event.stopPropagation(); selectPart(item.id, 'list-item', item.title); act(item.action) }}><b>{item.title}</b>{item.detail !== undefined && <small>{item.detail}</small>}</button>)}</section>
    if (node.type === 'tabs') { const active = state.tabs[node.id] ?? node.tabs[0]?.id; const activeTab = node.tabs.find(tab => tab.id === active); const activateTab = (tab: typeof node.tabs[number]) => { selectPart(tab.id, 'tab', tab.label); act(tab.action ?? { type: 'set-tab', targetId: node.id, value: tab.id }) }; const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, tab: typeof node.tabs[number]) => { if (mode === 'select') { selectOnKey(event, () => selectPart(tab.id, 'tab', tab.label)); return } const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']; if (!keys.includes(event.key)) return; event.preventDefault(); const current = node.tabs.findIndex(item => item.id === tab.id); const next = event.key === 'Home' ? 0 : event.key === 'End' ? node.tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + node.tabs.length) % node.tabs.length; const target = node.tabs[next]!; activateTab(target); window.requestAnimationFrame(() => (event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${node.id}-tab-${target.id}`)}`))?.focus()) }; return <section {...common} className={css.tabs}>{node.label !== undefined && <h3>{node.label}</h3>}<div role="tablist">{node.tabs.map(tab => <button type="button" role="tab" id={`${node.id}-tab-${tab.id}`} aria-controls={`${node.id}-panel-${tab.id}`} aria-selected={tab.id === active} tabIndex={tab.id === active ? 0 : -1} data-prototype-element-id={tab.id} data-prototype-selected={selectedElementId === tab.id ? 'true' : undefined} key={tab.id} onClick={event => { event.stopPropagation(); activateTab(tab) }} onKeyDown={event => moveTab(event, tab)}>{tab.label}</button>)}</div>{activeTab !== undefined && <div role="tabpanel" id={`${node.id}-panel-${activeTab.id}`} aria-labelledby={`${node.id}-tab-${activeTab.id}`}>{activeTab.children.map(render)}</div>}</section> }
    if (node.type === 'breadcrumb') return <nav {...common} className={css.breadcrumb} aria-label="面包屑">{node.items.map((item, index) => <Fragment key={item.id}>{index > 0 && <span aria-hidden="true">/</span>}{item.targetScreenId === undefined ? <b data-prototype-element-id={item.id} data-prototype-selected={selectedElementId === item.id ? 'true' : undefined} tabIndex={mode === 'select' ? 0 : undefined} onClick={event => { event.stopPropagation(); if (mode === 'select') selectPart(item.id, 'breadcrumb-item', item.label) }} onKeyDown={event => selectOnKey(event, () => selectPart(item.id, 'breadcrumb-item', item.label))}>{item.label}</b> : <button type="button" data-prototype-element-id={item.id} data-prototype-selected={selectedElementId === item.id ? 'true' : undefined} onClick={event => { event.stopPropagation(); selectPart(item.id, 'breadcrumb-item', item.label); act({ type: 'navigate', targetScreenId: item.targetScreenId }) }}>{item.label}</button>}</Fragment>)}</nav>
    if (node.type === 'empty-state') return <section {...common} className={css.emptyState}><i aria-hidden="true" /><h3>{node.title}</h3>{node.detail !== undefined && <p>{node.detail}</p>}{node.action !== undefined && <button type="button" className={`${css.button} ${css.secondary}`} onClick={event => { event.stopPropagation(); select(node); act(node.action) }}>{node.actionLabel}</button>}</section>
    if (node.type === 'pagination') { const current = state.stateValues[node.bindStateId] ?? '1'; return <nav {...common} className={css.pagination} aria-label={node.label ?? '分页'}><button type="button" disabled={current === '1'} onClick={event => { event.stopPropagation(); dispatch({ type: 'input', elementId: node.id, bindStateId: node.bindStateId, value: String(Math.max(1, Number(current) - 1)) }) }}>上一页</button>{Array.from({ length: node.pageCount }, (_, index) => String(index + 1)).map(page => <button type="button" key={page} aria-current={page === current ? 'page' : undefined} onClick={event => { event.stopPropagation(); dispatch({ type: 'input', elementId: node.id, bindStateId: node.bindStateId, value: page }) }}>{page}</button>)}<button type="button" disabled={current === String(node.pageCount)} onClick={event => { event.stopPropagation(); dispatch({ type: 'input', elementId: node.id, bindStateId: node.bindStateId, value: String(Math.min(node.pageCount, Number(current) + 1)) }) }}>下一页</button></nav> }
    return null
  }
  const openModals = modalNodes(screen.nodes, state).filter(node => node.type === 'modal' && state.openModalIds.includes(node.id) && isRenderable(node))
  const shell = document.shell
  const navigation = shell === undefined ? null : <nav className={css.navigation} aria-label="产品导航"><strong>{shell.productName}</strong><div>{shell.items.map(item => <button type="button" key={item.id} aria-current={item.targetScreenId === state.screenId ? 'page' : undefined} data-prototype-element-id={item.id} data-prototype-selected={selectedElementId === item.id ? 'true' : undefined} onClick={event => { event.stopPropagation(); selectPart(item.id, 'navigation-item', item.label); act({ type: 'navigate', targetScreenId: item.targetScreenId }) }}>{item.label}</button>)}</div></nav>
  return <main ref={runtimeRef} className={`${css.runtime} ${shell === undefined ? '' : css.shellFrame} ${shell?.placement === 'sidebar' ? css.sidebarShell : css.topShell}`} style={designVariables(designSpec)} aria-label={`${document.title} 交互原型`} data-prototype-mode={mode}>{navigation}<p className={css.screenAnnouncement} role="status" aria-live="polite">当前页面：{screen.title}</p><section className={css.canvas} aria-label={screen.title}>{screen.nodes.map(render)}</section>{openModals.map(modal => modal.type === 'modal' && <div className={`${css.backdrop} ${css[modal.placement ?? 'dialog']}`} key={modal.id} role="presentation" onMouseDown={event => { if (mode === 'interact' && event.target === event.currentTarget) act({ type: 'close-modal', targetId: modal.id }) }}><section ref={dialogRef} className={css.modal} role="dialog" aria-modal="true" aria-label={modal.title} data-prototype-element-id={modal.id} onClick={() => select(modal)}><header><strong>{modal.title}</strong><button ref={closeRef} type="button" aria-label="关闭" onClick={event => { event.stopPropagation(); act({ type: 'close-modal', targetId: modal.id }) }}>×</button></header>{modal.children.map(render)}</section></div>)}{pendingDelete !== undefined && <div className={css.backdrop} role="presentation"><section className={css.modal} role="dialog" aria-modal="true" aria-label="确认删除"><header><strong>确认删除</strong></header><p>确认删除{pendingDelete.businessName}？此操作会从原型表格中移除当前记录。</p><div><button type="button" onClick={() => setPendingDelete(undefined)}>取消</button><button type="button" className={`${css.button} ${css.danger}`} onClick={confirmDelete}>确认删除</button></div></section></div>}</main>
}
