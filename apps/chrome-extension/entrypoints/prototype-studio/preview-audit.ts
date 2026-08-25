import type { SandboxPreviewAuditMessage } from './sandbox-preview'

export type PreviewAudit = SandboxPreviewAuditMessage['audit']
export type PreviewAuditTone = 'checking' | 'pass' | 'warning'

export interface PreviewAuditSummary { tone: PreviewAuditTone; label: string; detail: string }
export type PreviewViewportAuditMap = Partial<Record<'desktop' | 'tablet' | 'mobile', PreviewAudit>>

export function summarizePreviewAudit(audit: PreviewAudit | undefined): PreviewAuditSummary {
  if (audit === undefined) return { tone: 'checking', label: '正在进行基础布局检查', detail: '正在检查横向溢出、过小操作区和被裁切弹窗；不替代内容、键盘或无障碍验收。' }
  const issues: string[] = []
  if (audit.horizontalOverflow) issues.push('页面出现横向溢出')
  if (audit.clippedDialogCount > 0) issues.push(`${audit.clippedDialogCount} 个弹窗超出可见区域`)
  if (audit.smallTargetCount > 0) issues.push(`${audit.smallTargetCount} 个操作区小于 32px`)
  return issues.length === 0
    ? { tone: 'pass', label: '当前尺寸基础布局检查通过', detail: `${audit.viewportWidth}px 宽度未发现横向溢出、过小操作区或弹窗裁切；仍需人工确认长内容、键盘和无障碍体验。` }
    : { tone: 'warning', label: `基础布局检查发现 ${issues.length} 类问题`, detail: `${audit.viewportWidth}px 宽度：${issues.join('；')}。可让 AI 针对当前尺寸调整；长内容、键盘和无障碍仍需人工确认。` }
}

export function summarizeAllPreviewAudits(audits: PreviewViewportAuditMap): PreviewAuditSummary {
  const labels = { desktop: '桌面', tablet: '平板', mobile: '手机' } as const
  const pending = (Object.keys(labels) as Array<keyof typeof labels>).filter(viewport => audits[viewport] === undefined)
  if (pending.length > 0) return { tone: 'checking', label: `还有 ${pending.length} 个尺寸待检查`, detail: `待检查：${pending.map(viewport => labels[viewport]).join('、')}。` }
  const warnings = (Object.keys(labels) as Array<keyof typeof labels>).filter(viewport => summarizePreviewAudit(audits[viewport]).tone === 'warning')
  return warnings.length === 0
    ? { tone: 'pass', label: '三个尺寸基础布局检查通过', detail: '三个常用尺寸均未发现横向溢出、过小操作区或弹窗裁切；不代表完整可访问性或长内容验收通过。' }
    : { tone: 'warning', label: `${warnings.length} 个尺寸需要修复`, detail: `基础布局存在问题：${warnings.map(viewport => labels[viewport]).join('、')}。切换到对应尺寸查看并让 AI 修复；再人工验收长内容、键盘和无障碍。` }
}
