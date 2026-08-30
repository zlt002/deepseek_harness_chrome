#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HarnessWebProcess } from '../apps/native-server/src/harness-process.mjs'
import { PRODUCT_UI_PLUGIN_DIRECTORIES, PRODUCT_UI_PLUGIN_PACKAGE_NAMES } from '../apps/native-server/src/product-plugin-manifest.mjs'
import { createRuntimeIdentity } from './runtime-identity.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedHarness = join(projectRoot, '.generated', 'harness-product')
const explicitHarnessRoot = process.env.ACCRUI_HARNESS_ROOT?.trim()
const harnessRoot = resolve(explicitHarnessRoot || generatedHarness)
if (!explicitHarnessRoot && !existsSync(join(generatedHarness, '.harness-product.json'))) {
  throw new Error(`Generated product Harness is missing: ${generatedHarness}. Run pnpm build:harness-product first, or set ACCRUI_HARNESS_ROOT for this product checkout.`)
}
const distRoot = join(harnessRoot, 'apps/web/dist')
const distIndex = join(distRoot, 'index.html')
const outputRoot = join(projectRoot, 'apps', 'chrome-extension', 'public')

if (!existsSync(distIndex)) {
  throw new Error(`DeepSeek Harness Web dist is missing: ${distIndex}. Run "pnpm run build" in ${harnessRoot} first.`)
}

const syncHome = await mkdtemp(join(tmpdir(), 'deepseek-harness-sync-'))
const harness = new HarnessWebProcess({
  env: {
    ...process.env,
    DSH_HOME: syncHome,
    DSH_ROOT: harnessRoot,
  },
})
const harnessUrl = await harness.start()
let index
try {
  const response = await fetch(`${harnessUrl}/`)
  if (!response.ok) throw new Error(`Harness Web UI returned HTTP ${response.status} while syncing assets`)
  index = await response.text()
} finally {
  await harness.stop()
  await rm(syncHome, { recursive: true, force: true })
}
const manifestMatch = /<script>window\.__DSH_BOOT__\s*=\s*(\{.*?\})<\/script>/s.exec(index)
if (!manifestMatch) throw new Error(`Could not find window.__DSH_BOOT__ in ${distIndex}`)
const themeMatch = /<body><script>([\s\S]*?)<\/script>/.exec(index)
if (!themeMatch) throw new Error(`Could not find the Harness theme bootstrap script in ${distIndex}`)

/** @type {{ entries: Array<{ id: string, url: string }> }} */
const boot = JSON.parse(manifestMatch[1])
if (!Array.isArray(boot.entries) || boot.entries.some((entry) => typeof entry.id !== 'string')) {
  throw new Error('DeepSeek Harness boot manifest has no valid client entry list')
}

const packageJsonCache = new Map()
const findPackageJson = async (directory) => {
  const cached = packageJsonCache.get(directory)
  if (cached !== undefined) return cached
  const direct = join(directory, 'package.json')
  if (existsSync(direct)) {
    const manifest = JSON.parse(await readFile(direct, 'utf8'))
    packageJsonCache.set(directory, { path: direct, manifest })
    return { path: direct, manifest }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue
    const found = await findPackageJson(join(directory, entry.name))
    if (found !== undefined) return found
  }
  return undefined
}

const resolvePackageJson = async (packageName) => {
  const candidates = [
    join(projectRoot, 'packages'),
    join(harnessRoot, 'packages'),
    join(harnessRoot, 'apps'),
  ]
  for (const candidate of candidates) {
    const found = await findPackageJson(candidate)
    if (found?.manifest?.name === packageName) return found
    // The first walk is intentionally shallow in the common case; enumerate
    // package roots below when the package is not the directory root itself.
    const queue = [candidate]
    while (queue.length > 0) {
      const directory = queue.shift()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue
        const child = join(directory, entry.name)
        const manifestPath = join(child, 'package.json')
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          packageJsonCache.set(child, { path: manifestPath, manifest })
          if (manifest.name === packageName) return { path: manifestPath, manifest }
        } else {
          queue.push(child)
        }
      }
    }
  }
  throw new Error(`Cannot resolve Harness client package: ${packageName}`)
}

const resolveClientBundle = async (packageName) => {
  const resolved = await resolvePackageJson(packageName)
  const manifest = resolved.manifest
  const clientExport = manifest.exports?.['./client']
  const relative = typeof clientExport === 'string'
    ? clientExport
    : clientExport?.default
  if (typeof relative !== 'string') throw new Error(`${packageName} has no ./client export`)
  return join(dirname(resolved.path), relative)
}

await rm(join(outputRoot, 'assets'), { recursive: true, force: true })
await rm(join(outputRoot, 'plugins'), { recursive: true, force: true })
await rm(join(outputRoot, 'harness'), { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await cp(join(distRoot, 'assets'), join(outputRoot, 'assets'), { recursive: true })
for (const name of ['favicon.svg', 'manifest.webmanifest']) {
  if (existsSync(join(distRoot, name))) await cp(join(distRoot, name), join(outputRoot, name))
}

for (const entry of boot.entries) {
  const bundle = await resolveClientBundle(entry.id)
  const target = join(outputRoot, 'plugins', entry.id, 'client.js')
  await mkdir(dirname(target), { recursive: true })
  await cp(bundle, target)
  const map = `${bundle}.map`
  if (existsSync(map)) await cp(map, `${target}.map`)
}

// MV3 extension pages reject inline scripts. Keep the same boot order, but
// move the host-injected startup snippets into extension-local resources.
const extensionIndex = index
  .replace(manifestMatch[0], '<script src="/harness/boot.js"></script>')
  .replace(themeMatch[0], '<body><script src="/harness/theme.js"></script>')
  .replace(
    '<script type="module" crossorigin src="/assets/',
    '<script src="/native-bridge.js"></script>\n    <script type="module" crossorigin src="/assets/',
  )
await mkdir(join(outputRoot, 'harness'), { recursive: true })
await writeFile(join(outputRoot, 'harness/boot.js'), `window.__DSH_BOOT__ = ${manifestMatch[1]};\n`, 'utf8')
await writeFile(join(outputRoot, 'harness/theme.js'), `${themeMatch[1]}\n`, 'utf8')
await writeFile(join(outputRoot, 'harness/index.html'), extensionIndex, 'utf8')
const runtimeIdentity = await createRuntimeIdentity({
  harnessRoot,
  bootEntries: boot.entries,
  productBootEntries: PRODUCT_UI_PLUGIN_PACKAGE_NAMES,
  assetRoots: [join(outputRoot, 'assets'), join(outputRoot, 'plugins'), join(outputRoot, 'harness')],
  pluginRoots: PRODUCT_UI_PLUGIN_DIRECTORIES.map((directory) => join(projectRoot, 'packages', directory, 'lib')),
})
await writeFile(join(outputRoot, 'harness/runtime-manifest.json'), `${JSON.stringify(runtimeIdentity, null, 2)}\n`, 'utf8')

console.log(`Synced ${boot.entries.length} Harness client bundles into ${pathToFileURL(outputRoot).pathname} (${runtimeIdentity.assetHash.slice(0, 12)})`)
