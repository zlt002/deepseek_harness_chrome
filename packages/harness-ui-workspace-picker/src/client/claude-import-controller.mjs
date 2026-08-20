/** Resolve the product controller from compact Workspace picker props. */
export function claudeImportControllerOf(props) {
  const candidates = [props?.matched, props?.matched?.claudeImport, props?.claudeImport]
  return candidates.find(candidate => candidate !== null && typeof candidate === 'object' && typeof candidate.importSession === 'function')
}
