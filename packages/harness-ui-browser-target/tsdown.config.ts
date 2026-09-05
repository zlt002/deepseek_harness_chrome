import { loadHarnessClientBundle } from '../../scripts/build/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()

export default clientBundle('@accrui/harness-ui-browser-target', ['src/index.ts'])
