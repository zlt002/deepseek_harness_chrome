import { loadHarnessClientBundle } from '../../scripts/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()

export default clientBundle('@accrui/harness-ui-settings-shell', ['src/index.ts'])
