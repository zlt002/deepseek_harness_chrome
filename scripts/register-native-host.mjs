#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleHarnessDefaultWorkspacePlugin, bundleHarnessRuntimePlugin, bundleHarnessTrackingPlugin } from './bundle-harness-runtime-plugin.mjs'
import { PRODUCT_UI_PLUGIN_DIRECTORIES, PRODUCT_UI_PLUGIN_PACKAGE_NAMES } from '../apps/native-server/src/product-plugin-manifest.mjs'
import {
  ACCRUI_INSTALL_DIRECTORY,
  ACCRUI_NATIVE_HOST_NAME,
  nativeHostManifestFilename,
} from '../apps/native-server/src/product-runtime-identity.mjs'
import { createRuntimeIdentity } from './runtime-identity.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionIds = [...new Set(
  (process.env.DEEPSEEK_HARNESS_EXTENSION_ID ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)]
const nativeServerSource = resolve(projectRoot, 'apps', 'native-server')
const skillsSource = resolve(projectRoot, 'skills')
const productPluginsSource = resolve(projectRoot, 'packages')
// Generic DSH_* variables may belong to another Harness checkout.  Only this
// product's names are accepted at the registration boundary, then the
// generated launcher exports the DSH_* variables it owns.
const explicitHarnessRoot = process.env.ACCRUI_HARNESS_ROOT?.trim() || undefined
const explicitHarnessCli = process.env.ACCRUI_HARNESS_CLI_PATH?.trim() || undefined
const generatedHarnessRoot = resolve(projectRoot, '.generated/harness-product')
const inferredHarnessRoot = !explicitHarnessRoot && !explicitHarnessCli
  && existsSync(join(generatedHarnessRoot, '.harness-product.json'))
  && existsSync(join(generatedHarnessRoot, 'apps/cli/lib/bin.js'))
  ? generatedHarnessRoot
  : undefined
const activeHarnessRoot = explicitHarnessRoot ?? inferredHarnessRoot
if (extensionIds.length === 0) {
  console.error('Set DEEPSEEK_HARNESS_EXTENSION_ID to one or more comma-separated Chrome extension ids.')
  process.exit(2)
}
const invalidExtensionId = extensionIds.find((value) => !/^[a-p]{32}$/.test(value))
if (invalidExtensionId !== undefined) {
  console.error(`Invalid Chrome extension id: ${invalidExtensionId}`)
  process.exit(2)
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const targets = platform() === 'darwin'
  ? [
      join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      join(homedir(), 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
    ]
  : platform() === 'win32'
    ? [join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Google/Chrome/NativeMessagingHosts')]
    : [join(homedir(), '.config/google-chrome/NativeMessagingHosts')]
const installRoot = platform() === 'darwin'
  ? join(homedir(), 'Library/Application Support', ACCRUI_INSTALL_DIRECTORY)
  : platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), ACCRUI_INSTALL_DIRECTORY)
    : join(homedir(), '.local/share', ACCRUI_INSTALL_DIRECTORY)
const nativeServer = join(installRoot, 'native-server')
const skills = join(installRoot, 'skills')
const launcher = join(installRoot, ACCRUI_NATIVE_HOST_NAME)
const profile = join(installRoot, 'profile')

if (process.argv.includes('--check')) {
  const expectedOrigins = extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`)
  const errors = []
  for (const target of targets) {
    const manifestPath = join(target, nativeHostManifestFilename())
    if (!existsSync(manifestPath)) {
      errors.push(`manifest is missing: ${manifestPath}`)
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.name !== ACCRUI_NATIVE_HOST_NAME) errors.push(`${manifestPath} has an unexpected host name`)
      if (manifest.type !== 'stdio') errors.push(`${manifestPath} has an unexpected host type`)
      if (manifest.path !== launcher) errors.push(`${manifestPath} does not point to the AccrUI launcher`)
      for (const origin of expectedOrigins) {
        if (!Array.isArray(manifest.allowed_origins) || !manifest.allowed_origins.includes(origin)) {
          errors.push(`${origin} is not allowed by ${manifestPath}`)
        }
      }
    } catch (error) {
      errors.push(`manifest is unreadable: ${manifestPath}: ${error.message}`)
    }
  }
  if (existsSync(launcher)) {
    const launcherSource = await readFile(launcher, 'utf8')
    for (const [name, value] of [['DSH_ROOT', activeHarnessRoot], ['DSH_HOME', profile], ['DSH_CONNECTOR_STATE_DIR', join(installRoot, 'connector-state')]]) {
      if (value !== undefined && !launcherSource.includes(`export ${name}=${shellQuote(value)}`)) errors.push(`launcher does not export the expected ${name}`)
    }
  } else {
    errors.push(`launcher is missing: ${launcher}`)
  }
  if (errors.length > 0) {
    console.error(`Native Messaging host is forbidden for the requested extension:\n${errors.join('\n')}`)
    process.exit(1)
  }
  console.log(`Native Messaging origins verified: ${expectedOrigins.join(', ')}`)
  process.exit(0)
}

if (!explicitHarnessRoot && !explicitHarnessCli && inferredHarnessRoot === undefined) {
  console.error(`Generated product Harness is missing or not built: ${generatedHarnessRoot}. Run pnpm build:harness-product first, or set ACCRUI_HARNESS_ROOT/ACCRUI_HARNESS_CLI_PATH for this product runtime.`)
  process.exit(2)
}

const launcherLines = [
  '#!/bin/sh',
  'unset DSH_ROOT DSH_CLI_PATH DSH_HOME DSH_CWD DSH_NATIVE_LOG DSH_HARNESS_RUNTIME_PLUGIN DSH_HARNESS_TRACKING_PLUGIN DSH_DEFAULT_WORKSPACE_PLUGIN DSH_PRODUCT_OFFICE_SKILLS_PLUGIN DSH_PRODUCT_PLUGIN_ROOT DSH_PRODUCT_SKILLS_ROOT DSH_CONNECTOR_STATE_DIR',
  `exec ${shellQuote(process.execPath)} ${shellQuote(join(nativeServer, 'bin.mjs'))}`,
]
for (const [name, value] of [
  ['DSH_ROOT', explicitHarnessRoot ?? inferredHarnessRoot],
  ['DSH_CLI_PATH', explicitHarnessCli],
  ['DSH_HOME', profile],
  ['ACCRUI_CONNECTOR_STATE_DIR', join(installRoot, 'connector-state')],
  ['DSH_CONNECTOR_STATE_DIR', join(installRoot, 'connector-state')],
  ['DSH_CWD', process.env.ACCRUI_HARNESS_CWD?.trim() || join(installRoot, 'workspace')],
  ['DSH_NATIVE_LOG', process.env.ACCRUI_NATIVE_LOG?.trim()],
  ['DSH_HARNESS_RUNTIME_PLUGIN', process.env.ACCRUI_HARNESS_RUNTIME_PLUGIN?.trim()],
  ['DSH_HARNESS_TRACKING_PLUGIN', process.env.ACCRUI_HARNESS_TRACKING_PLUGIN?.trim()],
  ['ACCR_PRODUCT_VERSION', process.env.ACCRUI_PRODUCT_VERSION?.trim()],
]) {
  if (value !== undefined && value !== '') launcherLines.splice(2, 0, `export ${name}=${shellQuote(value)}`)
}
function productManifest() {
  return {
    name: ACCRUI_NATIVE_HOST_NAME,
    description: 'AccrUI Harness Native Messaging host',
    path: launcher,
    type: 'stdio',
    // Do not inherit origins from an old manifest: the file is product-owned
    // and an unknown origin would bridge a different extension into AccrUI.
    allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
  }
}

async function writeManifestAtomically(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, manifestPath)
}

async function replaceDirectory(source, destination, prepare) {
  const staging = `${destination}.${process.pid}.staging`
  const backup = `${destination}.${process.pid}.backup`
  await rm(staging, { recursive: true, force: true })
  await rm(backup, { recursive: true, force: true })
  // pnpm dependencies are symlinks. Dereference them so the installed host is
  // self-contained and a later install never follows an old link back into the source tree.
  await cp(source, staging, { recursive: true, dereference: true })
  if (prepare !== undefined) await prepare(staging)

  const hadPrevious = existsSync(destination)
  try {
    if (hadPrevious) await rename(destination, backup)
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (hadPrevious && !existsSync(destination) && existsSync(backup)) {
      await rename(backup, destination)
    }
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

async function installProductPlugins(destination) {
  for (const packageName of PRODUCT_UI_PLUGIN_DIRECTORIES) {
    const source = resolve(productPluginsSource, packageName)
    for (const required of ['package.json', 'lib/index.js', 'lib/client.js']) {
      if (!existsSync(resolve(source, required))) {
        throw new Error(`Product Harness UI package is not built: ${resolve(source, required)}. Run pnpm build:harness-client-plugins.`)
      }
    }
    const target = resolve(destination, packageName)
    await mkdir(target, { recursive: true })
    await cp(resolve(source, 'package.json'), resolve(target, 'package.json'))
    await cp(resolve(source, 'lib'), resolve(target, 'lib'), { recursive: true, dereference: true })
  }
}

await mkdir(installRoot, { recursive: true })
await replaceDirectory(nativeServerSource, nativeServer, async (staging) => {
  await bundleHarnessRuntimePlugin({ outfile: join(staging, 'harness-runtime.mjs'), projectRoot })
  await bundleHarnessTrackingPlugin({ outfile: join(staging, 'harness-tracking.mjs'), projectRoot })
  await bundleHarnessDefaultWorkspacePlugin({ outfile: join(staging, 'harness-default-workspace.mjs'), projectRoot })
  await installProductPlugins(join(staging, 'product-plugins'))
  if (activeHarnessRoot !== undefined && existsSync(join(activeHarnessRoot, '.harness-product.json'))) {
    const runtimeIdentity = await createRuntimeIdentity({
      harnessRoot: activeHarnessRoot,
      assetRoots: [staging],
      pluginRoots: PRODUCT_UI_PLUGIN_DIRECTORIES.map((directory) => join(staging, 'product-plugins', directory, 'lib')),
      bootEntries: PRODUCT_UI_PLUGIN_PACKAGE_NAMES.map((id) => ({ id })),
      productBootEntries: PRODUCT_UI_PLUGIN_PACKAGE_NAMES,
    })
    await writeFile(join(staging, 'runtime-manifest.json'), `${JSON.stringify({ ...runtimeIdentity, installRoot }, null, 2)}\n`, 'utf8')
  }
})
await replaceDirectory(skillsSource, skills)
await writeFile(launcher, `${launcherLines.join('\n')}\n`, 'utf8')
await chmod(launcher, 0o755)
for (const target of targets) {
  await mkdir(target, { recursive: true })
  const manifestPath = join(target, nativeHostManifestFilename())
  await writeManifestAtomically(manifestPath, productManifest())
  console.log(`Manifest: ${manifestPath}`)
}
console.log(`Registered ${ACCRUI_NATIVE_HOST_NAME}`)
console.log(`Launcher: ${launcher}`)
