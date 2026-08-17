import { loadHarnessClientBundle } from '../../scripts/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()

export default clientBundle('@accrui/harness-ui-conversation-shell', ['src/index.ts'])
