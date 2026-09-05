import { loadHarnessClientBundle } from '../../scripts/build/load-harness-client-bundle.mjs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientBundle = await loadHarnessClientBundle()
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const harnessRoot = resolve(process.env.DSH_ROOT?.trim() || resolve(projectRoot, '.generated/harness-product'))
// Resolve from the official Web app's declared dependency, then inline that
// third-party browser library. This keeps the product package self-contained
// and does not depend on pnpm's internal store layout or upstream source files.
const fflateBrowser = createRequire(pathToFileURL(resolve(harnessRoot, 'apps/web/package.json'))).resolve('fflate/browser')
const base = clientBundle('@accrui/harness-ui-session-log-copy', ['src/index.ts'])

export default (inline: { env?: Record<string, string | undefined> }) => base(inline).map(config => {
  if (config.name !== '@accrui/harness-ui-session-log-copy/client') return config
  return {
    ...config,
    plugins: [{
      name: 'product-session-log-copy-fflate',
      resolveId(source: string) { return source === 'fflate/browser' ? fflateBrowser : null },
    }, ...(config.plugins ?? [])],
  }
})
