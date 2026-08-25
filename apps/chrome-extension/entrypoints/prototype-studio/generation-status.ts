import type { ProductBriefV1 } from '../../../../packages/harness-ui-prototype-studio/src/product-brief.mjs'

export interface StudioAttempt { status: 'error'; message: string; at: string; requestId?: string }
export interface StudioGenerationAttempt {
  status: 'pending' | 'error'
  requestId: string
  expectedRevisionId?: string
  prompt?: string
  localEditScope?: { selection: { elementId: string; type: string; label: string }; baselineDocumentFingerprint: string }
  productBrief?: ProductBriefV1
  allowRevisionEviction?: true
  message?: string
  at: string
}
export type GenerationOutcome = { status: 'pending' } | { status: 'saved' } | { status: 'repairing'; message: string } | { status: 'failed'; message: string } | { status: 'stopped'; message: string }

/** A cancellation is confirmed only after the Host readback has cleared the active attempt. */
export function hasStoppedGeneration(requestId: string | undefined, attempt: StudioGenerationAttempt | undefined): boolean {
  return requestId !== undefined && attempt === undefined
}

/** Resolves one accepted AI request from trusted Host state, never chat wording. */
export function generationOutcome(requestId: string | undefined, baselineRevisionId: string | undefined, nextRevisionId: string | undefined, attempt: StudioGenerationAttempt | undefined, lastAttempt: StudioAttempt | undefined, now = Date.now(), repairGraceMs = 90_000): GenerationOutcome {
  if (typeof nextRevisionId === 'string' && nextRevisionId !== baselineRevisionId) return { status: 'saved' }
  if (requestId === undefined || (attempt !== undefined && attempt.requestId !== requestId)) return { status: 'pending' }
  if (attempt?.status === 'error') {
    const failedAt = Date.parse(attempt.at)
    const message = attempt.message ?? '原型保存未通过安全校验。'
    return Number.isFinite(failedAt) && now - failedAt < repairGraceMs ? { status: 'repairing', message } : { status: 'failed', message }
  }
  if (attempt === undefined && lastAttempt?.requestId === requestId) return { status: 'stopped', message: lastAttempt.message }
  return { status: 'pending' }
}
