#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionId = process.env.DEEPSEEK_HARNESS_EXTENSION_ID?.trim()
const nativeServer = resolve(projectRoot, 'native-server/bin.mjs')
const launcher = resolve(projectRoot, 'native-host/com.deepseek.harness.chrome')
if (!extensionId) {
  console.error('Set DEEPSEEK_HARNESS_EXTENSION_ID to the unpacked or published Chrome extension id.')
  process.exit(2)
}
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error(`Invalid Chrome extension id: ${extensionId}`)
  process.exit(2)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const launcherLines = [
  '#!/bin/sh',
  `exec ${shellQuote(process.execPath)} ${shellQuote(nativeServer)}`,
]
for (const [name, value] of [
  ['DSH_ROOT', process.env.DSH_ROOT?.trim()],
  ['DSH_CLI_PATH', process.env.DSH_CLI_PATH?.trim()],
  ['DSH_CWD', process.env.DSH_CWD?.trim()],
  ['DSH_NATIVE_LOG', process.env.DSH_NATIVE_LOG?.trim()],
]) {
  if (value !== undefined && value !== '') launcherLines.splice(1, 0, `export ${name}=${shellQuote(value)}`)
}

const target = platform() === 'darwin'
  ? join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
  : platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Google/Chrome/NativeMessagingHosts')
    : join(homedir(), '.config/google-chrome/NativeMessagingHosts')
const manifestPath = join(target, 'com.deepseek.harness.chrome.json')
const manifest = {
  name: 'com.deepseek.harness.chrome',
  description: 'DeepSeek Harness Native Messaging host',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}

await mkdir(target, { recursive: true })
await mkdir(dirname(launcher), { recursive: true })
await writeFile(launcher, `${launcherLines.join('\n')}\n`, 'utf8')
await chmod(launcher, 0o755)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Registered ${manifest.name}`)
console.log(`Manifest: ${manifestPath}`)
console.log(`Launcher: ${launcher}`)
