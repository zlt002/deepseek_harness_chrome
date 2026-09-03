import { useState } from 'react'
import type { ReactNode } from 'react'
import type { CompanyGatewayModel } from './types.ts'
import { formatCompanyGatewayCapacity, parseCompanyGatewayCapacity } from './company-gateway.ts'
import css from './AccountAccessSection.module.css'

export interface CompanyGatewayModelCatalogProps {
  models: readonly CompanyGatewayModel[]
  disabled: boolean
  onChange: (models: CompanyGatewayModel[]) => void
  selectedModel?: string
  onSelectedModelChange?: (modelId: string) => void
}

type CapacityField = 'contextWindow' | 'maxTokens'

function textOf(model: CompanyGatewayModel, key: 'id' | 'name'): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

function numberOf(model: CompanyGatewayModel, key: CapacityField): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

function acceptsImage(model: CompanyGatewayModel): boolean {
  return Array.isArray(model.input) && model.input.includes('image')
}

function Chevron({ open }: { open: boolean }): ReactNode {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}>
    <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function Trash(): ReactNode {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/**
 * The company catalog is loaded from the gateway, then edited like a custom
 * provider catalog. Capacity edits stay local as text while the row stores
 * plain token counts; unknown row fields are copied through unchanged.
 */
export function CompanyGatewayModelCatalog({ models, disabled, onChange, selectedModel, onSelectedModelChange }: CompanyGatewayModelCatalogProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(() => new Map())

  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const patch = (index: number, next: Record<string, unknown>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return { ...model }
      const updated: Record<string, unknown> = { ...model, ...next }
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete updated[key]
      return updated as CompanyGatewayModel
    }))
  }

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCompanyGatewayCapacity(text) })
  }

  const capacityText = (model: CompanyGatewayModel, index: number, field: CapacityField): string => {
    const typed = editing.get(bufferKey(index, field))
    if (typed !== undefined) return typed
    const value = numberOf(model, field)
    return value === undefined ? '' : formatCompanyGatewayCapacity(value)
  }

  const settleCapacity = (index: number, field: CapacityField): void => {
    const key = bufferKey(index, field)
    const typed = editing.get(key)
    if (typed === undefined) return
    const parsed = parseCompanyGatewayCapacity(typed)
    if (parsed !== undefined && Number.isNaN(parsed)) return
    setEditing(current => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }

  const toggleExpanded = (index: number): void => {
    setExpanded(current => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const remove = (index: number): void => {
    const nextEditing = new Map<string, string>()
    for (const [key, value] of editing) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      nextEditing.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    setEditing(nextEditing)
    setExpanded(current => {
      const next = new Set<number>()
      for (const at of current) {
        if (at === index) continue
        next.add(at > index ? at - 1 : at)
      }
      return next
    })
    onChange(models.filter((_model, at) => at !== index).map(model => ({ ...model })))
  }

  const add = (): void => {
    const index = models.length
    onChange([...models.map(model => ({ ...model })), { id: '' }])
    setExpanded(current => new Set(current).add(index))
  }

  const capacityField = (model: CompanyGatewayModel, index: number, field: CapacityField, label: string): ReactNode => (
    <label className={css.modelField}>
      <span className={css.modelFieldLabel}>{label}</span>
      <input
        className={css.modelInput}
        type="text"
        inputMode="numeric"
        value={capacityText(model, index, field)}
        placeholder={field === 'contextWindow' ? '如 131072 或 128K' : '如 98304 或 96K'}
        aria-label={`${label} ${index + 1}`}
        disabled={disabled}
        onChange={event => { editCapacity(index, field, event.target.value) }}
        onBlur={() => { settleCapacity(index, field) }}
      />
    </label>
  )

  return <section className={css.modelCatalog} aria-label="公司网关模型目录">
    <div className={css.modelCatalogHeading}>
      <strong>模型目录</strong>
      <span>已加载 {models.length} 个模型</span>
    </div>
    {onSelectedModelChange === undefined ? null : <label className={css.gatewayField}>
      <span>默认模型</span>
      <select value={selectedModel ?? ''} disabled={disabled || models.length === 0} onChange={event => { onSelectedModelChange(event.target.value) }}>
        {models.map(model => <option key={model.id} value={model.id}>{typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id}</option>)}
      </select>
    </label>}
    {models.length === 0 ? <p className={css.notice}>没有可编辑的模型。</p> : null}
    {models.map((model, index) => {
      const open = expanded.has(index)
      return <div key={index} className={css.modelCatalogEntry}>
        <div className={css.modelCatalogRow}>
          <input
            className={css.modelInput}
            type="text"
            value={textOf(model, 'id')}
            placeholder="模型 ID"
            aria-label={`模型 ID ${index + 1}`}
            disabled={disabled}
            onChange={event => { patch(index, { id: event.target.value }) }}
            onBlur={event => { const trimmed = event.target.value.trim(); if (trimmed !== event.target.value) patch(index, { id: trimmed }) }}
          />
          <input
            className={css.modelInput}
            type="text"
            value={textOf(model, 'name')}
            placeholder="显示名称（留空使用模型 ID）"
            aria-label={`显示名称 ${index + 1}`}
            disabled={disabled}
            onChange={event => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
          />
          <label className={css.modelCheckInline} title="允许该模型接收图片">
            <input type="checkbox" checked={acceptsImage(model)} aria-label={`支持多模态图片 ${index + 1}`} disabled={disabled} onChange={event => { patch(index, { input: event.target.checked ? ['text', 'image'] : undefined }) }} />
            <span>多模态</span>
          </label>
          <button type="button" className={css.modelDetailsButton} aria-label={`模型详情 ${index + 1}`} aria-expanded={open} title="模型详情" disabled={disabled} onClick={() => { toggleExpanded(index) }}>
            <Chevron open={open} />
          </button>
          <button type="button" className={`${css.modelDetailsButton} ${css.modelRemoveButton}`} aria-label={`删除模型 ${index + 1}`} title="删除模型" disabled={disabled} onClick={() => { remove(index) }}>
            <Trash />
          </button>
        </div>
        {open ? <div className={css.modelAdvanced}>
          {capacityField(model, index, 'contextWindow', '上下文窗口')}
          {capacityField(model, index, 'maxTokens', '最大输出 token')}
        </div> : null}
      </div>
    })}
    <button type="button" className={css.addModelButton} disabled={disabled} onClick={add}>添加模型</button>
  </section>
}
