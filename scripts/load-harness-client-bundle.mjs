import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function loadHarnessClientBundle() {
  const generatedHarness = join(projectRoot, '.generated', 'harness-product')
  const explicitHarnessRoot = process.env.ACCRUI_HARNESS_ROOT?.trim()
  const harnessRoot = resolve(explicitHarnessRoot || generatedHarness)
  if (!explicitHarnessRoot && !existsSync(join(generatedHarness, '.harness-product.json'))) {
    throw new Error(`Generated product Harness is missing: ${generatedHarness}. Run pnpm build:harness-product first, or set ACCRUI_HARNESS_ROOT for this product checkout.`)
  }
  const config = join(harnessRoot, 'packages', 'client', 'tsdown.client.ts')
  return (await import(pathToFileURL(config).href)).clientBundle
}
