export const ACCRUI_NATIVE_HOST_NAME: 'com.accrui.harness.chrome'
export const ACCRUI_INSTALL_DIRECTORY: 'accr-ui-harness'
export const ACCRUI_PROFILE_DIRECTORY: 'profile'
export const ACCRUI_CONNECTOR_TMP_PREFIX: 'accrui-harness-connector-'
export const ACCRUI_CONNECTOR_STATE_DIRECTORY: 'connector-state'
export function nativeHostManifestFilename(): string
export function productProfileDirectory(installRoot: string): string
export function productConnectorStateDirectory(installRoot: string): string
