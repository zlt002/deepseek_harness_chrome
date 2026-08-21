import { loadHarnessClientBundle } from '../../scripts/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()
export default clientBundle('@accrui/harness-skill-settings', ['src/index.ts'], {
  // Native Host registration copies this product package without node_modules.
  // Keep frontmatter validation self-contained in the emitted Host plugin.
  lib: { deps: { alwaysBundle: ['js-yaml'], onlyBundle: ['js-yaml'] } },
})
