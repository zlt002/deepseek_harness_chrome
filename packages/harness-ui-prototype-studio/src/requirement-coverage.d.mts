export type ProductRequirementCoverageKind = 'page' | 'module' | 'flow'
export type ProductRequirementCoverageStatus = 'satisfied' | 'missing'
export interface ProductRequirementCoverageVerificationV1 { status: 'replayed'; steps: string[]; final: string }
export interface ProductRequirementCoverageMatchV1 { label: string; screenId?: string; nodeId?: string; nodeType?: string; verification?: ProductRequirementCoverageVerificationV1 }
export interface ProductRequirementCoverageItemV1 { id: string; kind: ProductRequirementCoverageKind; requirement: string; status: ProductRequirementCoverageStatus; matches: ProductRequirementCoverageMatchV1[] }
export interface ProductRequirementCoverageV1 { v: 1; items: ProductRequirementCoverageItemV1[] }
export function directRequirementMatch(requirement: unknown, candidate: unknown): boolean
export function meaningfulRequirementMatch(requirement: unknown, candidate: unknown): boolean
export function assignedRequirementMatches<T extends { label: string }>(requirements: readonly string[], candidates: readonly T[], matches: (requirement: string, candidate: string) => boolean): Array<T | undefined>
export function unmatchedRequirements(requirements: readonly string[], candidates: readonly string[], matches: (requirement: string, candidate: string) => boolean): string[]
export function productRequirementCoverage(document: unknown, brief: unknown): ProductRequirementCoverageV1 | undefined
export function productRequirementCoverageValue(value: unknown): ProductRequirementCoverageV1 | undefined
