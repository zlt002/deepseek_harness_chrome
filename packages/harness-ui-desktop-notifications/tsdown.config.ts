import { loadHarnessClientBundle } from '../../scripts/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()

export default clientBundle('@accrui/harness-ui-desktop-notifications', ['src/index.ts'])
