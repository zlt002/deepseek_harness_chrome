import { canonicalJson, sha256Fingerprint, validatePrototypeBundle, type DesignSpecV1, type PrototypeDocumentV1, type ReferenceEvidenceV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { sandboxPreviewSrcDoc } from './sandbox-preview'

export interface PrototypeExportArtifacts { baseName: string; html: string; json: string; documentFingerprint: string; designSpecFingerprint: string }

function safeName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (normalized || '产品原型').slice(0, 64)
}

export async function createPrototypeExportArtifacts(input: { projectId: string; revisionId: string; document: PrototypeDocumentV1; designSpec: DesignSpecV1; evidence: ReferenceEvidenceV1[] }): Promise<PrototypeExportArtifacts> {
  if (!/^prototype-[a-z0-9-]{8,72}$/.test(input.projectId) || !/^rev-[a-z0-9-]{8,160}$/i.test(input.revisionId)) throw new Error('当前原型版本身份无效，无法导出。')
  const checked = validatePrototypeBundle({ document: input.document, designSpec: input.designSpec, evidence: input.evidence })
  if (!checked.ok) throw new Error(`当前原型未通过安全校验：${checked.errors[0] ?? '未知错误'}`)
  const documentFingerprint = await sha256Fingerprint(checked.value.document)
  const designSpecFingerprint = await sha256Fingerprint(checked.value.designSpec)
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const title = safeName(checked.value.document.title)
  const html = sandboxPreviewSrcDoc(checked.value.document, checked.value.designSpec, checked.value.evidence, nonce, 'interact')
    .replace('<head>', `<head><title>${title.replace(/[<&>]/g, '')}</title><meta name="generator" content="AI Prototype Studio trusted offline runtime"><meta name="prototype-revision" content="${input.revisionId}"><meta name="prototype-document-sha256" content="${documentFingerprint}">`)
  const payload = {
    v: 1,
    schema: 'prototype-export/v1',
    projectId: input.projectId,
    revisionId: input.revisionId,
    documentFingerprint,
    designSpecFingerprint,
    references: checked.value.evidence.map(item => ({ id: item.id, source: item.source, fingerprint: item.fingerprint })),
    designSpec: checked.value.designSpec,
    document: checked.value.document,
  }
  return { baseName: `${title}-${input.revisionId.slice(0, 12)}`, html, json: canonicalJson(payload), documentFingerprint, designSpecFingerprint }
}

export function downloadPrototypeArtifact(name: string, body: string, type: 'text/html' | 'application/json'): void {
  const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.hidden = true
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
