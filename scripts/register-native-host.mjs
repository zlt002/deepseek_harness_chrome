#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises'
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

const target = platform() === 'darwin'
  ? join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
  : platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Google/Chrome/NativeMessagingHosts')
    : join(homedir(), '.config/google-chrome/NativeMessagingHosts')
const installRoot = platform() === 'darwin'
  ? join(homedir(), 'Library/Application Support/DeepSeekHarness')
  : platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'DeepSeekHarness')
    : join(homedir(), '.local/share/DeepSeekHarness')
const nativeServer = join(installRoot, 'native-server')
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
const manifestPath = join(target, 'com.deepseek.harness.chrome.json')
const manifest = {
  name: 'com.deepseek.harness.chrome',
  description: 'DeepSeek Harness Native Messaging host',
  path: launcher,
  type: 'stdio',
  allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
}

await mkdir(target, { recursive: true })
await mkdir(installRoot, { recursive: true })
await cp(nativeServerSource, nativeServer, { recursive: true })
await writeFile(launcher, `${launcherLines.join('\n')}\n`, 'utf8')
await chmod(launcher, 0o755)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Registered ${manifest.name}`)
console.log(`Manifest: ${manifestPath}`)
console.log(`Launcher: ${launcher}`)
