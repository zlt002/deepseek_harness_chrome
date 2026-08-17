import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { SettingsPresentationOwnerProps, SettingsSectionRow } from '@deepseek-ai/dsh-client-ui-settings-general/client'

/** Chain component props: the official shell passes its public presentation contract as `matched`. */
export type SettingsRootComponentProps = PropsRuntime<'settings.presentation'> & {
  matched: SettingsPresentationOwnerProps
}

export type { SettingsPresentationOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-general/client'
export type { SettingsSectionRow } from '@deepseek-ai/dsh-client-ui-settings-general/client'
