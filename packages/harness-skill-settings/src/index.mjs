/**
 * Product-owned, Harness-agnostic Skill invocation policy.
 *
 * This module deliberately has no Cordis or Harness source import.  A Host
 * adapter supplies the two seams it needs: durable settings and a registry
 * policy hook.  That keeps storage and registry cache invalidation out of
 * callers, and lets the policy be tested without a Harness fork.
 */

export const SETTINGS_NAMESPACE = 'skill-settings'
export const SKILL_MODES = Object.freeze(['enabled', 'manual-only', 'disabled'])

/** @typedef {'enabled' | 'manual-only' | 'disabled'} SkillMode */
/** @typedef {{ modelInvocable: boolean, userInvocable: boolean }} Invocation */
/** @typedef {{ name: string, invocation: Invocation, [key: string]: unknown }} Skill */

/** Return whether a value is one of the durable Skill modes. */
export function isSkillMode(value) {
  return SKILL_MODES.includes(value)
}

/**
 * Normalize persisted JSON. Unknown modes are ignored instead of accidentally
 * broadening a skill's permissions; absent entries inherit enabled.
 */
export function normalizeSkillSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { modes: {} }
  const rawModes = value.modes
  if (rawModes === null || typeof rawModes !== 'object' || Array.isArray(rawModes)) return { modes: {} }
  const modes = {}
  for (const [name, mode] of Object.entries(rawModes)) {
    if (isSkillMode(mode)) modes[name] = mode
  }
  return { modes }
}

/** Resolve one skill's local mode. */
export function modeFor(settings, skillName) {
  return normalizeSkillSettings(settings).modes[skillName] ?? 'enabled'
}

/** Map a local mode to the maximum permissions it may grant. */
export function invocationForMode(mode) {
  switch (mode) {
    case 'enabled': return { modelInvocable: true, userInvocable: true }
    case 'manual-only': return { modelInvocable: false, userInvocable: true }
    case 'disabled': return { modelInvocable: false, userInvocable: false }
    default: throw new TypeError(`Unknown Skill mode: ${String(mode)}`)
  }
}

/**
 * Intersect author-owned frontmatter controls with the local setting.
 * Local settings can only reduce permissions, never re-enable an author denial.
 */
export function resolveInvocation(authored, mode) {
  const requested = invocationForMode(mode)
  return {
    modelInvocable: Boolean(authored.modelInvocable) && requested.modelInvocable,
    userInvocable: Boolean(authored.userInvocable) && requested.userInvocable,
  }
}

/** Project source skills to their effective policy without mutating registry rows. */
export function projectSkillCatalog(sourceSkills, settings) {
  return sourceSkills.map((skill) => ({
    ...skill,
    mode: modeFor(settings, skill.name),
    invocation: resolveInvocation(skill.invocation, modeFor(settings, skill.name)),
  }))
}

/** Return a new durable settings document after changing one named skill. */
export function withSkillMode(settings, skillName, mode) {
  if (typeof skillName !== 'string' || skillName.length === 0) throw new TypeError('Skill name must be non-empty')
  if (!isSkillMode(mode)) throw new TypeError(`Unknown Skill mode: ${String(mode)}`)
  const normalized = normalizeSkillSettings(settings)
  return { modes: { ...normalized.modes, [skillName]: mode } }
}

/**
 * Return the Claude-compatible directory as an ordinary filesystem-provider
 * customSkillDirs item.  The official provider already supports custom roots;
 * no special filesystem fork is needed.
 */
export function claudeSkillRoots(homeDirectory) {
  if (typeof homeDirectory !== 'string' || homeDirectory.length === 0) throw new TypeError('Home directory must be non-empty')
  return [`${homeDirectory.replace(/[\\/]+$/, '')}/.claude/skills`]
}

/**
 * A small stateful facade for settings UI or future Host composition. Callers
 * only learn refresh/setMode/project; storage format and serial writes stay in
 * this deep module.
 */
export class SkillSettingsController {
  #settings = { modes: {} }
  #writeChain = Promise.resolve()

  /** @param {{ read: () => Promise<unknown>, write: (value: { modes: Record<string, SkillMode> }) => Promise<void> }} store */
  constructor(store) {
    if (store === null || typeof store?.read !== 'function' || typeof store?.write !== 'function') {
      throw new TypeError('Skill settings store must provide read() and write()')
    }
    this.store = store
  }

  async refresh() {
    this.#settings = normalizeSkillSettings(await this.store.read())
    return this.#settings
  }

  snapshot() {
    return { modes: { ...this.#settings.modes } }
  }

  project(sourceSkills) {
    return projectSkillCatalog(sourceSkills, this.#settings)
  }

  async setMode(skillName, mode) {
    const work = async () => {
      const next = withSkillMode(this.#settings, skillName, mode)
      await this.store.write(next)
      this.#settings = next
      return this.snapshot()
    }
    const pending = this.#writeChain.then(work, work)
    this.#writeChain = pending.then(() => undefined, () => undefined)
    return await pending
  }
}

/**
 * Mount policy against an explicit future Host seam. Current official Harness
 * does not expose this seam yet; see README for the upstream contribution.
 * @param {{ registerSettings: (namespace: string, defaults: { modes: Record<string, SkillMode> }, onChange: (value: unknown) => void) => (() => void), registerInvocationPolicy: (resolve: (skill: Skill) => Invocation) => (() => void) }} host
 */
export function mountHostSkillSettings(host) {
  if (host === null || typeof host?.registerSettings !== 'function' || typeof host?.registerInvocationPolicy !== 'function') {
    throw new TypeError('Host must expose registerSettings() and registerInvocationPolicy()')
  }
  let settings = { modes: {} }
  const stopPolicy = host.registerInvocationPolicy((skill) => resolveInvocation(skill.invocation, modeFor(settings, skill.name)))
  const stopSettings = host.registerSettings(SETTINGS_NAMESPACE, settings, (next) => { settings = normalizeSkillSettings(next) })
  return () => { stopSettings(); stopPolicy() }
}
