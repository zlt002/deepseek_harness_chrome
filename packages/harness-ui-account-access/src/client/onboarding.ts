/** A minimal, settings-wire-only projection of whether a model route is usable. */
export interface OnboardingProvider {
  active: boolean
  settingsNs: string
  settingsPath: readonly string[]
}

export interface OnboardingNamespace { ns: string; value: unknown }
export interface OnboardingCredential { configured?: boolean }

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * A configured active route with no key reference is provider-native; one with
 * a reference is usable only after the credentials service confirms it.
 */
export function hasUsableModelProvider(
  providers: readonly OnboardingProvider[],
  namespaces: readonly OnboardingNamespace[],
  credentials: Readonly<Record<string, OnboardingCredential>>,
): boolean {
  for (const provider of providers) {
    if (!provider.active) continue
    const namespace = namespaces.find(candidate => candidate.ns === provider.settingsNs)
    const profile = namespace === undefined ? undefined : atPath(namespace.value, provider.settingsPath)
    if (profile === undefined) continue
    if (profile === null || typeof profile !== 'object') continue
    const apiKeyEnv = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) return true
    if (credentials[apiKeyEnv]?.configured === true) return true
  }
  return false
}
