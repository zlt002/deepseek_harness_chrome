import { loadHarnessClientBundle } from '../../scripts/build/load-harness-client-bundle.mjs'

const clientBundle = await loadHarnessClientBundle()
export default clientBundle('@accrui/harness-skill-settings', ['src/index.ts'], {
  // Native Host registration copies this product package without node_modules.
  // Keep frontmatter validation self-contained in the emitted Host plugin.
  // `clientBundle()` forwards this to the Host lib config. `noExternal` is
  // the compatible tsdown spelling used by the static Windows build too.
  lib: { noExternal: ['js-yaml'] },
})
