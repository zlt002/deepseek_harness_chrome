#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleHarnessRuntimePlugin } from './bundle-harness-runtime-plugin.mjs'

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
const productPluginNames = [
  'harness-ui-agent-preset',
  'harness-ui-browser-target',
  'harness-ui-knowledge-scope',
  'harness-skill-settings',
]
const explicitHarnessRoot = process.env.DSH_ROOT?.trim() || undefined
const explicitHarnessCli = process.env.DSH_CLI_PATH?.trim() || undefined
const generatedHarnessRoot = resolve(projectRoot, '.generated/harness-product')
const inferredHarnessRoot = !explicitHarnessRoot && !explicitHarnessCli
  && existsSync(join(generatedHarnessRoot, '.harness-product.json'))
  && existsSync(join(generatedHarnessRoot, 'apps/cli/lib/bin.js'))
  ? generatedHarnessRoot
  : undefined
const activeHarnessRoot = explicitHarnessRoot ?? inferredHarnessRoot
const generatedHarnessManifest = activeHarnessRoot !== generatedHarnessRoot
  ? undefined
  : JSON.parse(await readFile(join(generatedHarnessRoot, '.harness-product.json'), 'utf8'))
const hasLegacyUiOverlay = generatedHarnessManifest?.compatibilityOverlay !== undefined
if (extensionIds.length === 0) {
  console.error('Set DEEPSEEK_HARNESS_EXTENSION_ID to one or more comma-separated Chrome extension ids.')
  process.exit(2)
}
const invalidExtensionId = extensionIds.find((value) => !/^[a-p]{32}$/.test(value))
if (invalidExtensionId !== undefined) {
  console.error(`Invalid Chrome extension id: ${invalidExtensionId}`)
  process.exit(2)
}
if (!explicitHarnessRoot && !explicitHarnessCli && inferredHarnessRoot === undefined) {
  console.error(`Generated product Harness is missing or not built: ${generatedHarnessRoot}. Run pnpm build:harness-product first, or set DSH_ROOT/DSH_CLI_PATH explicitly for a different Harness checkout.`)
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
  ? join(homedir(), 'Library/Application Support/DeepSeekHarness')
  : platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'DeepSeekHarness')
    : join(homedir(), '.local/share/DeepSeekHarness')
const nativeServer = join(installRoot, 'native-server')
const skills = join(installRoot, 'skills')
const launcher = join(installRoot, 'com.deepseek.harness.chrome')
const launcherLines = [
  '#!/bin/sh',
  `exec ${shellQuote(process.execPath)} ${shellQuote(join(nativeServer, 'bin.mjs'))}`,
]
for (const [name, value] of [
  ['DSH_ROOT', explicitHarnessRoot ?? inferredHarnessRoot],
  ['DSH_CLI_PATH', explicitHarnessCli],
  ['DSH_CWD', process.env.DSH_CWD?.trim()],
  ['DSH_NATIVE_LOG', process.env.DSH_NATIVE_LOG?.trim()],
  ['DSH_HARNESS_RUNTIME_PLUGIN', process.env.DSH_HARNESS_RUNTIME_PLUGIN?.trim()],
  ['DSH_LEGACY_UI_OVERLAY', process.env.DSH_LEGACY_UI_OVERLAY?.trim()
    || (hasLegacyUiOverlay ? '1' : undefined)],
  ['DSH_ENABLE_KNOWLEDGE_SCOPE_UI', process.env.DSH_ENABLE_KNOWLEDGE_SCOPE_UI?.trim()
    || ((explicitHarnessRoot ?? inferredHarnessRoot) === generatedHarnessRoot ? '1' : undefined)],
  ['DSH_ENABLE_SKILL_SETTINGS_UI', process.env.DSH_ENABLE_SKILL_SETTINGS_UI?.trim()
    || ((explicitHarnessRoot ?? inferredHarnessRoot) === generatedHarnessRoot ? '1' : undefined)],
]) {
  if (value !== undefined && value !== '') launcherLines.splice(1, 0, `export ${name}=${shellQuote(value)}`)
}
async function mergedManifest(manifestPath) {
  let existingManifest = {}
  if (existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`Unable to read existing Native Messaging manifest ${manifestPath}: ${error.message}`)
    }
    if (existingManifest === null || typeof existingManifest !== 'object' || Array.isArray(existingManifest)) {
      throw new Error(`Existing Native Messaging manifest ${manifestPath} must contain a JSON object`)
    }
  }
  const existingOrigins = existingManifest.allowed_origins ?? []
  if (!Array.isArray(existingOrigins) || existingOrigins.some((origin) => typeof origin !== 'string')) {
    throw new Error(`Existing Native Messaging manifest ${manifestPath} has invalid allowed_origins`)
  }
  return {
    ...existingManifest,
    name: 'com.deepseek.harness.chrome',
    description: 'DeepSeek Harness Native Messaging host',
    path: launcher,
    type: 'stdio',
    allowed_origins: [...new Set([
      ...existingOrigins,
      ...extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
    ])],
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
  for (const packageName of productPluginNames) {
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
  await installProductPlugins(join(staging, 'product-plugins'))
})
await replaceDirectory(skillsSource, skills)
await writeFile(launcher, `${launcherLines.join('\n')}\n`, 'utf8')
await chmod(launcher, 0o755)
for (const target of targets) {
  await mkdir(target, { recursive: true })
  const manifestPath = join(target, 'com.deepseek.harness.chrome.json')
  await writeManifestAtomically(manifestPath, await mergedManifest(manifestPath))
  console.log(`Manifest: ${manifestPath}`)
}
console.log('Registered com.deepseek.harness.chrome')
console.log(`Launcher: ${launcher}`)
