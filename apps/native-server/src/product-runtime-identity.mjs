/**
 * The immutable runtime identity for this product checkout.
 *
 * Keep this module free of Node-only imports: the browser extension consumes
 * the Native Messaging name too, while launchers use the directory segments
 * to construct platform-specific paths.
 */
export const ACCRUI_NATIVE_HOST_NAME = 'com.accrui.harness.chrome'
export const ACCRUI_INSTALL_DIRECTORY = 'accr-ui-harness'
export const ACCRUI_PROFILE_DIRECTORY = 'profile'
export const ACCRUI_CONNECTOR_TMP_PREFIX = 'accrui-harness-connector-'
export const ACCRUI_CONNECTOR_STATE_DIRECTORY = 'connector-state'

export function nativeHostManifestFilename() {
  return `${ACCRUI_NATIVE_HOST_NAME}.json`
}

export function productProfileDirectory(installRoot) {
  return `${installRoot}/${ACCRUI_PROFILE_DIRECTORY}`
}

export function productConnectorStateDirectory(installRoot) {
  return `${installRoot}/${ACCRUI_CONNECTOR_STATE_DIRECTORY}`
}
