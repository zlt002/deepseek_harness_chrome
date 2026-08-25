export interface ProductBriefV1 { v: 1; audience: string; coreTask: string; requiredPages: string[]; requiredModules?: string[]; requiredFlows: string[]; notes?: string }
export function productBrief(value: unknown): ProductBriefV1 | undefined
export function productBriefFromFields(fields: { audience: unknown; coreTask: unknown; pages: unknown; modules?: unknown; flows: unknown; notes?: unknown }): ProductBriefV1 | undefined
export function productBriefPrompt(value: unknown): string | undefined
