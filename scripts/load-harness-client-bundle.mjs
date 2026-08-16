import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function loadHarnessClientBundle() {
  const harnessRoot = resolve(
    process.env.DSH_ROOT?.trim() || join(projectRoot, 'upstream', 'deepseek-harness'),
  )
  const config = join(harnessRoot, 'packages', 'client', 'tsdown.client.ts')
  return (await import(pathToFileURL(config).href)).clientBundle
}
