import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ACCR_UI_EXTENSION_ID,
  ACCR_UI_EXTENSION_MANIFEST_KEY,
  ACCR_UI_WINDOWS_PACKAGE_NAME,
  HARNESS_RUNTIME_MARKER,
  LEGACY_NATIVE_HOST_NAME,
  NATIVE_HOST_NAME,
  assertAccrUiReplacementVersion,
  buildWindowsRelease,
  parseWindowsReleaseArgs,
  validateHarnessRuntime,
  validateWindowsRelease,
} from '../release/windows-lite/windows-release.mjs'

async function writeFixture(root, relativePath, content = '') {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  return target
}

function readZipUtf16Le(zipPath, entry) {
  const content = execFileSync('unzip', ['-p', zipPath, entry])
  return content.subarray(content[0] === 0xff && content[1] === 0xfe ? 2 : 0).toString('utf16le')
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-windows-release-'))
  const extensionDir = path.join(root, 'extension')
  const nativeServerDir = path.join(root, 'native-server')
  const harnessRuntimeDir = path.join(root, 'harness-runtime')
  await writeFixture(extensionDir, 'manifest.json', JSON.stringify({ manifest_version: 3, name: 'fixture', version: '0.1.0' }))
  await writeFixture(nativeServerDir, 'bin.mjs', 'console.log("native")\n')
  await writeFixture(harnessRuntimeDir, 'package.json', JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  await writeFixture(harnessRuntimeDir, HARNESS_RUNTIME_MARKER, JSON.stringify({
    format: 'deepseek-harness-windows-runtime-v1',
    platform: 'win32',
    arch: 'x64',
    revision: 'fixture-revision',
    entrypoint: 'apps/cli/lib/bin.js',
    closureComplete: true,
  }))
  await writeFixture(harnessRuntimeDir, 'apps/cli/lib/bin.js', 'console.log("dsh")\n')
  await writeFixture(harnessRuntimeDir, 'apps/web/dist/index.html', '<!doctype html>')
  for (const packageName of ['dsh-app-boot', 'dsh-web-app', 'dsh-web-frontend']) {
    await writeFixture(harnessRuntimeDir, `node_modules/@deepseek-ai/${packageName}/package.json`, JSON.stringify({ name: `@deepseek-ai/${packageName}` }))
  }
  return { root, extensionDir, nativeServerDir, harnessRuntimeDir }
}

test('rejects a missing or incomplete Harness runtime instead of silently packaging a sibling checkout', async () => {
  await assert.rejects(validateHarnessRuntime(), /Missing Harness runtime/)
  const root = await mkdtemp(path.join(tmpdir(), 'harness-runtime-missing-'))
  await assert.rejects(validateHarnessRuntime(root), /missing harness-runtime\.json/)
  await mkdir(path.join(root, '.git'))
  await assert.rejects(validateHarnessRuntime(root), /materialized runtime closure, not a source checkout/)
})

test('rejects a runtime that lacks the Windows closure marker even when its files look plausible', async () => {
  const fixture = await createFixture()
  await writeFile(path.join(fixture.harnessRuntimeDir, HARNESS_RUNTIME_MARKER), JSON.stringify({
    format: 'deepseek-harness-windows-runtime-v1', platform: 'darwin', arch: 'arm64', revision: '', entrypoint: 'bin.js', closureComplete: false,
  }), 'utf8')
  await assert.rejects(validateHarnessRuntime(fixture.harnessRuntimeDir), /Harness runtime marker is invalid: platform, arch, revision, entrypoint, closureComplete/)
})

test('buildWindowsRelease creates the AccrUI updater contract with the fixed extension identity', async () => {
  const fixture = await createFixture()
  const releaseDir = path.join(fixture.root, 'release')
  const result = await buildWindowsRelease({ ...fixture, releaseDir, version: '1.1.63' })

  assert.equal(result.valid, true)
  assert.equal(result.extensionId, ACCR_UI_EXTENSION_ID)
  assert.equal(result.version, '1.1.63')
  const payloadZip = path.join(result.packageDir, 'payload.zip')
  const manifest = JSON.parse(execFileSync('unzip', ['-p', payloadZip, 'extension/manifest.json'], { encoding: 'utf8' }))
  assert.equal(manifest.key, ACCR_UI_EXTENSION_MANIFEST_KEY)
  assert.equal(manifest.version, '1.1.63')
  assert.equal(manifest.name, 'accr-ui Harness UI')
  const launcher = execFileSync('unzip', ['-p', payloadZip, 'runtime/run_native_host.bat'], { encoding: 'utf8' })
  assert.match(launcher, /DSH_ROOT=%PACKAGE_DIR%harness/)
  assert.match(launcher, /DSH_CLI_PATH=%DSH_ROOT%\\apps\\cli\\lib\\bin\.js/)
  assert.equal(execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).includes(`${ACCR_UI_WINDOWS_PACKAGE_NAME}/install.ps1`), true)
  assert.equal(execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).includes(`${ACCR_UI_WINDOWS_PACKAGE_NAME}/payload/extension/manifest.json`), false)
  const validation = await validateWindowsRelease({ packageDir: result.packageDir, zipPath: result.zipPath })
  assert.deepEqual(validation, { valid: true, errors: [], extensionId: ACCR_UI_EXTENSION_ID, version: '1.1.63' })
})

test('the in-place updater start script re-registers both native-host names through one Node-gated script', async () => {
  const fixture = await createFixture()
  const result = await buildWindowsRelease({ ...fixture, releaseDir: path.join(fixture.root, 'release') })
  const payloadZip = path.join(result.packageDir, 'payload.zip')
  const payloadEntries = execFileSync('unzip', ['-Z1', payloadZip], { encoding: 'utf8' })
  for (const requiredPath of [
    'runtime/start.vbs',
    'runtime/register-native-host.ps1',
    `runtime/${NATIVE_HOST_NAME}.json`,
    `runtime/${LEGACY_NATIVE_HOST_NAME}.json`,
  ]) assert.ok(payloadEntries.includes(requiredPath))
  const startScript = readZipUtf16Le(payloadZip, 'runtime/start.vbs')
  const registerScript = execFileSync('unzip', ['-p', payloadZip, 'runtime/register-native-host.ps1'], { encoding: 'utf8' })
  const launcher = execFileSync('unzip', ['-p', payloadZip, 'runtime/run_native_host.bat'], { encoding: 'utf8' })
  const installer = await readFile(path.join(result.packageDir, 'install.ps1'), 'utf8')
  assert.match(startScript, /register-native-host\.ps1/)
  assert.match(startScript, / 0, False/)
  assert.match(registerScript, new RegExp(NATIVE_HOST_NAME.replaceAll('.', '\\.')))
  assert.match(registerScript, new RegExp(LEGACY_NATIVE_HOST_NAME.replaceAll('.', '\\.')))
  assert.match(registerScript, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/)
  assert.match(registerScript, /HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts/)
  assert.match(registerScript, /-lt 22/)
  assert.match(registerScript, /node-path\.txt/)
  assert.match(registerScript, /UTF8Encoding\]::new\(\$false\)/)
  assert.match(launcher, /NODE_PATH_FILE=%PACKAGE_DIR%node-path\.txt/)
  assert.match(launcher, /set \/p "NODE_EXEC=" < "%NODE_PATH_FILE%"/)
  assert.match(launcher, /"%NODE_EXEC%" "%PACKAGE_DIR%native-server\\bin\.mjs"/)
  assert.equal(launcher.includes('node "%PACKAGE_DIR%native-server'), false)
  assert.match(installer, /& \$registerScript -InstallRoot \$installRoot/)
  assert.equal(installer.includes('NativeMessagingHosts'), false)
  assert.equal(installer.includes('Remove-Item -LiteralPath $installRoot -Recurse -Force'), false)
  assert.match(installer, /workspace, logs, and \.webmcp/)
  assert.match(installer, /@\('extension', 'runtime'\)/)
})

test('version policy prevents a package that Chrome would treat as older than the AccrUI replacement', () => {
  assert.equal(assertAccrUiReplacementVersion('1.1.63'), '1.1.63')
  assert.throws(() => assertAccrUiReplacementVersion('1.1.62'), /below the first AccrUI replacement version/)
  assert.throws(() => assertAccrUiReplacementVersion('harness'), /Chrome-compatible/)
})

test('release CLI requires an explicit runtime input', () => {
  assert.deepEqual(parseWindowsReleaseArgs(['--harness-runtime', 'C:\\harness-runtime', '--version', '1.1.63']), {
    harnessRuntimeDir: 'C:\\harness-runtime', version: '1.1.63',
  })
  assert.throws(() => parseWindowsReleaseArgs(['--runtime', 'C:\\harness-runtime']), /Unknown argument/)
})
