import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  ACCRUI_INSTALL_DIRECTORY,
  ACCRUI_NATIVE_HOST_NAME,
  nativeHostManifestFilename,
} from '../apps/native-server/src/runtime/product-runtime-identity.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(projectRoot, 'scripts/native/register-native-host.mjs')
const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const devExtensionId = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function platformPaths(home) {
  if (platform() === 'win32') {
    const appData = join(home, 'AppData', 'Roaming')
    return { appData, manifestPaths: [join(appData, 'Google/Chrome/NativeMessagingHosts', nativeHostManifestFilename())] }
  }
  if (platform() === 'darwin') return {
    appData: undefined,
    manifestPaths: [
      join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', nativeHostManifestFilename()),
      join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', nativeHostManifestFilename()),
    ],
  }
  return { appData: undefined, manifestPaths: [join(home, '.config/google-chrome/NativeMessagingHosts', nativeHostManifestFilename())] }
}

function installRoot(home) {
  if (platform() === 'darwin') return join(home, 'Library/Application Support', ACCRUI_INSTALL_DIRECTORY)
  if (platform() === 'win32') return join(platformPaths(home).appData, ACCRUI_INSTALL_DIRECTORY)
  return join(home, '.local/share', ACCRUI_INSTALL_DIRECTORY)
}

function runRegister(home, overrides = {}, args = []) {
  return new Promise((resolvePromise, reject) => {
    const { appData } = platformPaths(home)
    const env = {
      ...process.env,
      HOME: home,
      ...(appData === undefined ? {} : { APPDATA: appData }),
      DEEPSEEK_HARNESS_EXTENSION_ID: extensionId,
      ...overrides,
    }
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name]
    const child = spawn(process.execPath, [script, ...args], { env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, stderr }))
  })
}

test('registers only the AccrUI-owned native host, install root, profile, and requested origins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'accrui-harness-home-'))
  const expectedInstallRoot = installRoot(home)
  try {
    const result = await runRegister(home, {
      DSH_ROOT: '/must-not-be-inherited',
      DSH_CLI_PATH: '/must-not-be-inherited/server.mjs',
      DSH_HOME: '/must-not-be-inherited/home',
      DEEPSEEK_HARNESS_EXTENSION_ID: `${extensionId},${devExtensionId}`,
    })
    assert.equal(result.code, 0, result.stderr)
    await stat(join(expectedInstallRoot, ACCRUI_NATIVE_HOST_NAME))
    for (const manifestPath of platformPaths(home).manifestPaths) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      assert.deepEqual(manifest, {
        name: ACCRUI_NATIVE_HOST_NAME,
        description: 'AccrUI Harness Native Messaging host',
        path: join(expectedInstallRoot, ACCRUI_NATIVE_HOST_NAME),
        type: 'stdio',
        allowed_origins: [
          `chrome-extension://${extensionId}/`,
          `chrome-extension://${devExtensionId}/`,
        ],
      })
    }
    const launcher = await readFile(join(expectedInstallRoot, ACCRUI_NATIVE_HOST_NAME), 'utf8')
    assert.match(launcher, new RegExp(`export DSH_ROOT='${resolve(projectRoot, '.generated/harness-product').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.match(launcher, new RegExp(`export DSH_HOME='${join(expectedInstallRoot, 'profile').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.doesNotMatch(launcher, /must-not-be-inherited/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('replaces unknown origins in the product-owned manifest instead of inheriting them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'accrui-harness-home-'))
  const manifestPath = platformPaths(home).manifestPaths[0]
  try {
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({
      name: ACCRUI_NATIVE_HOST_NAME,
      allowed_origins: ['chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/', 'https://unknown.invalid/'],
    }))
    const result = await runRegister(home)
    assert.equal(result.code, 0, result.stderr)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('check command rejects a missing requested AccrUI origin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'accrui-harness-home-'))
  try {
    const registered = await runRegister(home)
    assert.equal(registered.code, 0, registered.stderr)
    const rejected = await runRegister(home, { DEEPSEEK_HARNESS_EXTENSION_ID: devExtensionId }, ['--check'])
    assert.equal(rejected.code, 1)
    assert.match(rejected.stderr, /is not allowed/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('check command rejects a forged host identity, launcher path, type, or profile export', async () => {
  const home = await mkdtemp(join(tmpdir(), 'accrui-harness-home-'))
  const launcherPath = join(installRoot(home), ACCRUI_NATIVE_HOST_NAME)
  try {
    const registered = await runRegister(home)
    assert.equal(registered.code, 0, registered.stderr)
    const manifestPaths = platformPaths(home).manifestPaths
    const originalManifests = await Promise.all(manifestPaths.map((manifestPath) => readFile(manifestPath, 'utf8')))
    for (const [field, value, expected] of [
      ['name', 'com.deepseek.harness.chrome', /unexpected host name/],
      ['type', 'socket', /unexpected host type/],
      ['path', '/another-harness/launcher', /does not point to the AccrUI launcher/],
    ]) {
      const forged = JSON.parse(originalManifests[0])
      forged[field] = value
      await writeFile(manifestPaths[0], JSON.stringify(forged))
      const rejected = await runRegister(home, {}, ['--check'])
      assert.equal(rejected.code, 1)
      assert.match(rejected.stderr, expected)
      await writeFile(manifestPaths[0], originalManifests[0])
    }

    const launcher = await readFile(launcherPath, 'utf8')
    await writeFile(launcherPath, launcher.replace(/^export DSH_HOME=.*$/m, "export DSH_HOME='/another-harness/profile'"))
    const rejectedLauncher = await runRegister(home, {}, ['--check'])
    assert.equal(rejectedLauncher.code, 1)
    assert.match(rejectedLauncher.stderr, /launcher does not export the expected DSH_HOME/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
