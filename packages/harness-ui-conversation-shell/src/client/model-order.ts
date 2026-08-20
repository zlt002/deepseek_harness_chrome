/** Product-owned route identifier; Host catalog data stays otherwise opaque. */
export const COMPANY_GATEWAY_PROVIDER = 'annto-company-gateway'

/**
 * Prefer the Company Gateway in the chat model picker without changing the
 * relative order supplied for any other provider.
 */
export function companyGatewayFirst<T extends { id: string }>(groups: readonly T[]): readonly T[] {
  const index = groups.findIndex(group => group.id === COMPANY_GATEWAY_PROVIDER)
  if (index <= 0) return groups
  return [groups[index]!, ...groups.slice(0, index), ...groups.slice(index + 1)]
}
