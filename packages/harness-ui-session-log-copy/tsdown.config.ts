import { loadHarnessClientBundle } from '../../scripts/load-harness-client-bundle.mjs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientBundle = await loadHarnessClientBundle()
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const harnessRoot = resolve(process.env.DSH_ROOT?.trim() || resolve(projectRoot, '.generated/harness-product'))
const fflateBrowser = resolve(harnessRoot, 'node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/browser.js')
if (!existsSync(fflateBrowser)) throw new Error(`Harness fflate browser runtime is missing: ${fflateBrowser}`)
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
