import { collectPrototypeElementIds, validatePrototypeBundle, type DesignSpecV1, type PrototypeDocumentV1, type ReferenceEvidenceV1 } from '../../../../packages/harness-ui-prototype-studio/src/prototype-document'
import { productBrief, type ProductBriefV1 } from '../../../../packages/harness-ui-prototype-studio/src/product-brief.mjs'
import { productRequirementCoverage, productRequirementCoverageValue, type ProductRequirementCoverageV1 } from '../../../../packages/harness-ui-prototype-studio/src/requirement-coverage.mjs'

export interface RevisionComparison {
  screenCountBefore: number
  screenCountAfter: number
  componentCountBefore: number
  componentCountAfter: number
  details: string[]
}

export interface RevisionPreview {
  revisionId: string
  current: boolean
  createdAt: string
  changeSummary: string
  document: PrototypeDocumentV1
  designSpec: DesignSpecV1
  comparison: RevisionComparison
  comparedToRevisionId?: string
  productBriefKnown: boolean
  productBrief?: ProductBriefV1
  requirementCoverage?: ProductRequirementCoverageV1
}

export interface VisualRevisionDiff {
  structure: string[]
  coverage: string[]
}

export type RevisionPreviewResult = { ok: true; value: RevisionPreview } | { ok: false; error: string }

const REVISION_ID = /^rev-[a-z0-9-]{1,156}$/i
const PROJECT_ID = /^prototype-[a-z0-9-]{8,72}$/
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const count = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum

const limited = (values: readonly string[], limit = 8): string[] => values.slice(0, limit)

const namedScreens = (document: PrototypeDocumentV1): Map<string, string> => new Map(document.screens.map(screen => [screen.id, screen.title]))

const changedNames = (current: Map<string, string>, historical: Map<string, string>, prefix: string): string[] => limited([...current.entries()].filter(([id]) => !historical.has(id)).map(([, title]) => `${prefix}${title}`))

const coverageByRequirement = (coverage: ProductRequirementCoverageV1 | undefined): Map<string, ProductRequirementCoverageV1['items'][number]> => new Map((coverage?.items ?? []).map(item => [`${item.kind}:${item.requirement}`, item]))

/** A compact, deterministic comparison used only for the read-only visual history view. */
export function visualRevisionDiff(currentDocument: PrototypeDocumentV1, historicalDocument: PrototypeDocumentV1, currentCoverage?: ProductRequirementCoverageV1, historicalCoverage?: ProductRequirementCoverageV1): VisualRevisionDiff {
  const currentScreens = namedScreens(currentDocument)
  const historicalScreens = namedScreens(historicalDocument)
  const currentElements = collectPrototypeElementIds(currentDocument)
  const historicalElements = collectPrototypeElementIds(historicalDocument)
  const structure = [
    ...changedNames(currentScreens, historicalScreens, '当前新增页面：'),
    ...changedNames(historicalScreens, currentScreens, '历史独有页面：'),
    ...limited([...currentElements].filter(id => !historicalElements.has(id)).map(id => `当前新增组件：${id}`)),
    ...limited([...historicalElements].filter(id => !currentElements.has(id)).map(id => `历史独有组件：${id}`)),
  ]
  const currentItems = coverageByRequirement(currentCoverage)
  const historicalItems = coverageByRequirement(historicalCoverage)
  const currentSatisfied = [...currentItems.values()].filter(item => item.status === 'satisfied').length
  const historicalSatisfied = [...historicalItems.values()].filter(item => item.status === 'satisfied').length
  const coverage = currentCoverage === undefined && historicalCoverage === undefined ? [] : [
    `需求覆盖：当前 ${currentSatisfied}/${currentItems.size}，历史 ${historicalSatisfied}/${historicalItems.size}`,
    ...limited([...currentItems].filter(([key, item]) => item.status === 'satisfied' && historicalItems.get(key)?.status !== 'satisfied').map(([, item]) => `当前补齐：${item.requirement}`)),
    ...limited([...historicalItems].filter(([key, item]) => item.status === 'satisfied' && currentItems.get(key)?.status !== 'satisfied').map(([, item]) => `历史已覆盖：${item.requirement}`)),
  ]
  return { structure, coverage }
}

export function parseRevisionPreview(value: unknown, context: { projectId: string; targetRevisionId: string; currentRevisionId: string; evidence: readonly ReferenceEvidenceV1[] }): RevisionPreviewResult {
  if (!PROJECT_ID.test(context.projectId) || !REVISION_ID.test(context.targetRevisionId) || !REVISION_ID.test(context.currentRevisionId)) return { ok: false, error: '历史版本读取上下文无效。' }
  if (!object(value) || !exactKeys(value, ['v', 'projectId', 'revisionId', 'current', 'createdAt', 'changeSummary', 'document', 'designSpec', 'productBriefKnown', 'productBrief', 'requirementCoverage', 'comparison', 'comparedToRevisionId']) || value.v !== 1 || value.projectId !== context.projectId || value.revisionId !== context.targetRevisionId || value.comparedToRevisionId !== context.currentRevisionId || value.current !== (context.targetRevisionId === context.currentRevisionId) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.changeSummary !== 'string' || value.changeSummary.length > 600 || typeof value.productBriefKnown !== 'boolean') return { ok: false, error: '历史版本身份、时间或对比基准不匹配。' }
  const checkedBrief = value.productBrief === undefined ? undefined : productBrief(value.productBrief)
  if ((value.productBriefKnown && checkedBrief === undefined) || (!value.productBriefKnown && value.productBrief !== undefined)) return { ok: false, error: '历史版本的产品需求记录无效。' }
  const checked = validatePrototypeBundle({ evidence: [...context.evidence], designSpec: value.designSpec, document: value.document })
  if (!checked.ok) return { ok: false, error: `历史版本内容未通过安全校验：${checked.errors[0] ?? '未知错误'}` }
  const expectedCoverage = checkedBrief === undefined ? undefined : productRequirementCoverage(checked.value.document, checkedBrief)
  const coverage = value.requirementCoverage === undefined ? expectedCoverage : productRequirementCoverageValue(value.requirementCoverage)
  if ((expectedCoverage === undefined) !== (coverage === undefined) || (coverage !== undefined && JSON.stringify(coverage) !== JSON.stringify(expectedCoverage))) return { ok: false, error: '历史版本的需求验收结果未通过确定性校验。' }
  const comparison = value.comparison
  if (!object(comparison) || !exactKeys(comparison, ['screenCountBefore', 'screenCountAfter', 'componentCountBefore', 'componentCountAfter', 'details']) || !count(comparison.screenCountBefore, 12) || !count(comparison.screenCountAfter, 12) || !count(comparison.componentCountBefore, 240) || !count(comparison.componentCountAfter, 240) || !Array.isArray(comparison.details) || comparison.details.length > 40 || !comparison.details.every(item => typeof item === 'string' && item.length > 0 && item.length <= 600)) return { ok: false, error: '历史版本差异摘要无效。' }
  return { ok: true, value: { revisionId: value.revisionId as string, current: value.current as boolean, createdAt: value.createdAt, changeSummary: value.changeSummary, document: checked.value.document, designSpec: checked.value.designSpec, productBriefKnown: value.productBriefKnown, ...(checkedBrief === undefined ? {} : { productBrief: checkedBrief }), ...(coverage === undefined ? {} : { requirementCoverage: coverage }), comparison: comparison as unknown as RevisionComparison, comparedToRevisionId: value.comparedToRevisionId as string } }
}
