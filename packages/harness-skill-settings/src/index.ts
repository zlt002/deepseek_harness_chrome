/** Product-owned Host plugin for durable Skill invocation modes. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import type { SkillInvocationPolicy, SkillSummary } from '@deepseek-ai/dsh-skill'

export const name = 'accrui-skill-settings'
export const inject = ['skills']
export const SETTINGS_NAMESPACE = 'skill-settings' as SettingsNamespace
export type SkillSettingMode = 'enabled' | 'manual-only' | 'disabled'
export interface SkillSettingsConfig { readonly modes: Record<string, SkillSettingMode> }

export function invocationForMode(mode: SkillSettingMode): SkillInvocationPolicy {
  switch (mode) {
    case 'enabled': return { modelInvocable: true, userInvocable: true }
    case 'manual-only': return { modelInvocable: false, userInvocable: true }
    case 'disabled': return { modelInvocable: false, userInvocable: false }
  }
}

export function modeFor(config: SkillSettingsConfig, skill: Pick<SkillSummary, 'name'>): SkillSettingMode {
  return config.modes[skill.name] ?? 'enabled'
}

/** Register one durable local policy; Registry always intersects author policy. */
export async function apply(ctx: Context): Promise<void> {
  const schemastery = process.env.DSH_PRODUCT_SCHEMATERY_URL
  if (schemastery === undefined) throw new Error('DSH_PRODUCT_SCHEMATERY_URL is required for @accrui/harness-skill-settings')
  const z = (await import(schemastery)).default
  const Config = z.object({ modes: z.dict(z.union(['enabled', 'manual-only', 'disabled'])).default({}) })
  let settings: SkillSettingsConfig = { modes: {} }
  ctx.effect(() => ctx.skills.registerInvocationPolicy({
    resolve(skill) { return invocationForMode(modeFor(settings, skill)) },
  }), 'accrui skill invocation policy')
  ctx.inject(['settings'], (settingsCtx) => {
    const scope: SettingsScope<SkillSettingsConfig> = settingsCtx.settings.register(SETTINGS_NAMESPACE, Config, {
      configurationExposed: true,
    })
    const publish = (next: SkillSettingsConfig): void => {
      settings = next
      ctx.skills.invalidateInvocationPolicy()
    }
    publish(scope.get())
    scope.watch(publish)
  })
}
