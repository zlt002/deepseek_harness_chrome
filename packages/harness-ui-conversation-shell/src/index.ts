/** Host half: register the durable product presentation preference. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE } from './presentation-settings.ts'

export async function apply(ctx: Context): Promise<void> {
  const schemastery = process.env.DSH_PRODUCT_SCHEMATERY_URL
  if (schemastery === undefined) throw new Error('DSH_PRODUCT_SCHEMATERY_URL is required for @accrui/harness-ui-conversation-shell')
  const z = (await import(schemastery)).default
  const Config = z.object({ showProcess: z.boolean().default(true) })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE as SettingsNamespace,
      Config,
      { configurationExposed: true },
    )
  })
}
