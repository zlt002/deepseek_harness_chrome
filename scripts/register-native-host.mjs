#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionIds = [...new Set(
  (process.env.DEEPSEEK_HARNESS_EXTENSION_ID ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)]
const nativeServerSource = resolve(projectRoot, 'native-server')
const skillsSource = resolve(projectRoot, 'skills')
const explicitHarnessRoot = process.env.DSH_ROOT?.trim() || undefined
const explicitHarnessCli = process.env.DSH_CLI_PATH?.trim() || undefined
const siblingHarnessRoot = resolve(projectRoot, '../deepseek-harness')
const inferredHarnessRoot = !explicitHarnessRoot && !explicitHarnessCli
  && existsSync(join(siblingHarnessRoot, 'apps/cli/lib/bin.js'))
  ? siblingHarnessRoot
  : undefined
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

await mkdir(installRoot, { recursive: true })
await cp(nativeServerSource, nativeServer, { recursive: true })
await cp(skillsSource, skills, { recursive: true })
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
