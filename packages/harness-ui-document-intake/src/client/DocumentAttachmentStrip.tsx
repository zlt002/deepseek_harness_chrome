import { useSyncExternalStore } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseFill14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingDocuments } from './pending-documents.mjs'
import css from './DocumentAttachmentStrip.module.css'

export interface DocumentAttachmentInjected {
  readonly documents: PendingDocuments
}

type StripProps = PropsRuntime<'conversation.composer.above'> & InjectFace<DocumentAttachmentInjected>

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 1024) return `${String(bytes ?? 0)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extensionLabel(name: string, kind: string | undefined): string {
  const extension = /\.([^.]+)$/u.exec(name)?.[1]
  if (extension !== undefined) return extension.toUpperCase()
  return kind?.toUpperCase() ?? '文档'
}

function statusLabel(file: { name: string; size?: number; kind?: string; status: string; error?: string }): string {
  if (file.status === 'uploading') return '正在添加…'
  if (file.status === 'error') return file.error === undefined ? '添加失败' : `添加失败：${file.error}`
  return `${extensionLabel(file.name, file.kind)} · ${formatSize(file.size)}`
}

/** Visible, session-local document cards; only ready cards enter the submit transform. */
export function DocumentAttachmentStrip({ session, documents }: StripProps) {
  const sessionId = String(session.sessionId)
  const files = useSyncExternalStore(
    listener => documents.subscribe(listener),
    () => documents.snapshot(sessionId),
    () => documents.snapshot(sessionId),
  )
  if (files.length === 0) return null
  return <div className={css.strip} role="group" aria-label="待发送附件" data-document-attachment-strip>
    <div className={css.rail}>
      {files.map(file => <article key={file.id} className={css.card} data-status={file.status}>
        <span className={css.icon} aria-hidden="true"><IconDataOutline16 size={20} /></span>
        <span className={css.copy}>
          <strong title={file.name}>{file.name}</strong>
          <small title={file.status === 'error' ? file.error : undefined}>{statusLabel(file)}</small>
        </span>
        <button
          type="button"
          className={css.remove}
          aria-label={`移除附件 ${file.name}`}
          title="移除附件"
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { documents.remove(sessionId, file.id) }}
        ><IconCloseFill14 size={12} /></button>
      </article>)}
    </div>
  </div>
}
