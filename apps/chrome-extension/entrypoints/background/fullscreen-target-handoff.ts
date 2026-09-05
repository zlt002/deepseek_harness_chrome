import type { BrowserTarget } from '../../../native-server/src/transport/connector-protocol.mjs'
import type { BrowserTargetSettings } from './browser-target-state'

/** Preserve the pre-fullscreen Browser Target before Chrome activates the extension Tab. */
export async function preserveFullscreenBrowserTarget(
  windowId: number,
  resolveActiveTarget: (windowId: number) => Promise<BrowserTarget>,
  updateSettings: (mutator: (settings: BrowserTargetSettings) => BrowserTargetSettings) => Promise<BrowserTargetSettings>,
): Promise<BrowserTarget> {
  const target = await resolveActiveTarget(windowId)
  await updateSettings((settings) => ({ ...settings, candidate: target }))
  return target
}
