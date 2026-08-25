import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { encodeNativeMessage, smokeNativeMessageChild } from '../release/windows-lite/native-message-smoke.mjs'
import { EXPECTED_PRODUCT_CLIENT_IDS, verifyProductUiBoot } from '../release/windows-lite/product-ui-smoke.mjs'
import {
  assertDirectoryPickerWorkerContract,
  assertWindowsAclRunnerContract,
  buildWindowsStaticHarnessRuntime,
  bundleWindowsAclRunner,
  parseStaticRuntimeArgs,
  patchBundledWindowsAclRunnerPath,
} from '../release/windows-lite/build-static-harness-runtime.mjs'
import {
  PRODUCT_UI_PLUGIN_PACKAGES,
  bundleDirectoryPickerWorker,
  directoryPickerKoffiShimSource,
  nativeResolverBanner,
  patchBundledWorkerPaths,
  staticBundleAliases,
  staticPackageSource,
} from '../release/mac-lite/build-mac-production.mjs'

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

function decodeMessage(frame) {
  const length = frame.readUInt32LE(0)
  return JSON.parse(frame.subarray(4, 4 + length).toString('utf8'))
}

function fakeStream() {
  const stream = new EventEmitter()
  stream.destroyedBySmoke = false
  stream.destroy = () => { stream.destroyedBySmoke = true }
  stream.setEncoding = () => {}
  return stream
}

function fakeNativeChild({ onEnd } = {}) {
  const child = new EventEmitter()
  child.pid = 1234
  child.exitCode = null
  child.signalCode = null
  child.stdin = fakeStream()
  child.stdout = fakeStream()
  child.stderr = fakeStream()
  child.frames = []
  child.killedByFallback = false
  child.unrefCalled = false
  child.stdin.write = (frame) => { child.frames.push(Buffer.from(frame)); return true }
  child.stdin.end = (frame) => {
    child.frames.push(Buffer.from(frame))
    onEnd?.(child)
  }
  child.kill = () => { child.killedByFallback = true; return true }
  child.unref = () => { child.unrefCalled = true }
  child.close = (code = 0, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('close', code, signal)
  }
  return child
}

function timerHarness() {
  let nextId = 0
  const active = new Map()
  return {
    active,
    setTimer(callback) { const id = ++nextId; active.set(id, callback); return id },
    clearTimer(id) { active.delete(id) },
    fire() {
      const latest = [...active].at(-1)
      assert.notEqual(latest, undefined, 'expected an active timer')
      active.delete(latest[0])
      latest[1]()
    },
  }
}

function assertSmokeClean(child, timers) {
  assert.equal(timers.active.size, 0)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdin.listenerCount('error'), 0)
  assert.equal(child.stdin.listenerCount('finish'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(child.stdin.destroyedBySmoke, true)
  assert.equal(child.stdout.destroyedBySmoke, true)
  assert.equal(child.stderr.destroyedBySmoke, true)
  assert.equal(child.unrefCalled, true)
}

function runFakeSmoke(child, timers, killTree = () => ({ ok: true })) {
  return smokeNativeMessageChild({
    child,
    killTree,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-windows-release-'))
  const extensionDir = path.join(root, 'extension')
  const harnessRuntimeDir = path.join(root, 'harness-runtime')
  await writeFixture(extensionDir, 'manifest.json', JSON.stringify({ manifest_version: 3, name: 'fixture', version: '0.1.0' }))
  await writeFixture(harnessRuntimeDir, HARNESS_RUNTIME_MARKER, JSON.stringify({
    format: 'deepseek-harness-windows-static-web-v1',
    platform: 'win32',
    arch: 'x64',
    revision: 'fixture-revision',
    entrypoint: 'harness/apps/cli/lib/server.mjs',
    bundled: true,
    nodeModulesIncluded: false,
  }))
  await writeFixture(harnessRuntimeDir, 'harness/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  await writeFixture(harnessRuntimeDir, 'harness/apps/cli/lib/server.mjs', 'console.log("dsh")\n')
  await writeFixture(harnessRuntimeDir, 'harness/apps/cli/lib/plugin-manager.mjs', 'console.log("plugin")\n')
  await writeFixture(harnessRuntimeDir, 'harness/apps/web/dist/index.html', '<!doctype html>')
  await writeFixture(harnessRuntimeDir, 'native-server/runtime.mjs', 'console.log("native")\n')
  await writeFixture(harnessRuntimeDir, 'native-server/harness-runtime.mjs', 'export {}\n')
  await writeFixture(harnessRuntimeDir, 'native-server/harness-tracking.mjs', 'export {}\n')
  for (const relativePath of ['native/node-pty/prebuilds/win32-x64/pty.node', 'native/sharp/sharp.node', 'native/koffi/koffi.node', 'native/ripgrep/rg.exe']) await writeFixture(harnessRuntimeDir, relativePath, 'native')
  return { root, extensionDir, harnessRuntimeDir }
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
    format: 'deepseek-harness-windows-static-web-v1', platform: 'darwin', arch: 'arm64', revision: '', entrypoint: 'bin.js', bundled: false, nodeModulesIncluded: true,
  }), 'utf8')
  await assert.rejects(validateHarnessRuntime(fixture.harnessRuntimeDir), /Harness runtime marker is invalid: platform, arch, revision, entrypoint, bundled, nodeModulesIncluded/)
})

test('rejects temporary build files from the static Windows runtime', async () => {
  const fixture = await createFixture()
  await writeFixture(fixture.harnessRuntimeDir, '.build/server.mjs', 'temporary')
  await assert.rejects(validateHarnessRuntime(fixture.harnessRuntimeDir), /must not contain its temporary build directory/)
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
  const payloadEntries = execFileSync('unzip', ['-Z1', payloadZip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  assert.ok(payloadEntries.includes('runtime/native-server/harness-runtime.mjs'))
  assert.ok(payloadEntries.includes('runtime/native-server/harness-tracking.mjs'))
  assert.ok(payloadEntries.includes('runtime/dsh-plugin.bat'))
  assert.ok(payloadEntries.includes('runtime/skills/product-prototype/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/skills/pmd-prd/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/skills/pptx/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/skills/xlsx/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/skills/docx/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/skills/pdf/SKILL.md'))
  assert.ok(payloadEntries.includes('runtime/native-server/product-office-skills.mjs'))
  assert.equal(payloadEntries.some((entry) => entry.startsWith('runtime/harness/node_modules/')), false)
  assert.match(launcher, /DSH_ROOT=%PACKAGE_DIR%harness/)
  assert.match(launcher, /DSH_CLI_PATH=%DSH_ROOT%\\apps\\cli\\lib\\server\.mjs/)
  assert.match(launcher, /DSH_HOME=%APPDATA%\\accr-ui-harness\\profile/)
  assert.doesNotMatch(launcher, /DSH_(?:LEGACY_UI_OVERLAY|ENABLE_KNOWLEDGE_SCOPE_UI|ENABLE_SKILL_SETTINGS_UI)/)
  assert.match(launcher, /DSH_PRODUCT_PLUGIN_ROOT=%PACKAGE_DIR%product-plugins/)
  assert.match(launcher, /DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills/)
  const packagedReadme = await readFile(path.join(result.packageDir, 'README.zh-CN.md'), 'utf8')
  assert.match(packagedReadme, /DSH_PRODUCT_SKILLS_ROOT/)
  assert.match(packagedReadme, /runtime\/skills/)
  const packagedSkill = execFileSync('unzip', ['-p', payloadZip, 'runtime/skills/pmd-prd/SKILL.md'], { encoding: 'utf8' })
  assert.match(packagedSkill, /Harness Workspace 是唯一用户界面/)
  assert.doesNotMatch(packagedSkill, /pmd-workspace|clarification\.md/)
  assert.match(execFileSync('unzip', ['-p', payloadZip, 'runtime/skills/product-prototype/SKILL.md'], { encoding: 'utf8' }), /name:\s*product-prototype/)
  for (const [entry, expectedName] of [
    ['runtime/skills/pptx/SKILL.md', 'name: pptx'],
    ['runtime/skills/xlsx/SKILL.md', 'name: xlsx'],
    ['runtime/skills/docx/SKILL.md', 'name: docx'],
    ['runtime/skills/pdf/SKILL.md', 'name: pdf'],
  ]) {
    assert.match(execFileSync('unzip', ['-p', payloadZip, entry], { encoding: 'utf8' }), new RegExp(expectedName))
  }
  assert.equal(execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).includes(`${ACCR_UI_WINDOWS_PACKAGE_NAME}/install.ps1`), true)
  assert.equal(execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).includes(`${ACCR_UI_WINDOWS_PACKAGE_NAME}/install-ui.ps1`), true)
  assert.equal(execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' }).includes(`${ACCR_UI_WINDOWS_PACKAGE_NAME}/payload/extension/manifest.json`), false)
  const installLauncher = readZipUtf16Le(result.zipPath, `${ACCR_UI_WINDOWS_PACKAGE_NAME}/install.vbs`)
  const installPowerShell = execFileSync('unzip', ['-p', result.zipPath, `${ACCR_UI_WINDOWS_PACKAGE_NAME}/install.ps1`])
  const registerPowerShell = execFileSync('unzip', ['-p', payloadZip, 'runtime/register-native-host.ps1'])
  assert.deepEqual([...installPowerShell.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.deepEqual([...registerPowerShell.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(installLauncher, /install-ui\.ps1/)
  assert.match(installLauncher, /Else\r?\n\s+scriptPath = fso\.BuildPath\(scriptDir, "install-ui\.ps1"\)\r?\n\s+windowStyle = 1/)
  assert.match(installLauncher, /shell\.Run\(command, windowStyle, True\)/)
  assert.match(installLauncher, /DSH_INSTALL_NONINTERACTIVE/)
  assert.match(installLauncher, /If \(Not nonInteractive\) And exitCode <> 0 Then/)
  assert.doesNotMatch(installLauncher, /If nonInteractive And exitCode <> 0 Then/)
  assert.match(installLauncher, /If Not fso\.FileExists\(scriptPath\) Then\r?\n  If Not nonInteractive Then\r?\n    MsgBox "Harness UI 安装器文件缺失："/)
  assert.match(installLauncher, /MsgBox/)
  assert.match(installLauncher, /WScript\.Quit exitCode/)
  const installUi = execFileSync('unzip', ['-p', result.zipPath, `${ACCR_UI_WINDOWS_PACKAGE_NAME}/install-ui.ps1`], { encoding: 'utf8' })
  assert.match(installUi, /System\.Windows\.Forms\.FolderBrowserDialog/)
  assert.match(installUi, /Node\.js 22\+/)
  assert.match(installUi, /Chrome \/ Edge/)
  assert.match(installUi, /-InstallRoot/)
  assert.match(installUi, /-ProgressPath/)
  assert.match(installUi, /Add_Shown\(\{[\s\S]*installer UI visible[\s\S]*BringToFront\(\)/)
  assert.match(installUi, /DSH_INSTALL_UI_PROBE_PATH/)
  assert.match(installUi, /GetConsoleWindow/)
  assert.match(installUi, /ShowWindow\(\$consoleWindow, 0\)/)
  assert.doesNotMatch(installUi, /请不要选择 C 盘|包含中文的安装路径/)
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
  assert.match(launcher, /"%NODE_EXEC%" "%PACKAGE_DIR%native-server\\runtime\.mjs"/)
  assert.match(launcher, /DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills/)
  assert.equal(launcher.includes('node "%PACKAGE_DIR%native-server'), false)
  assert.match(installer, /\[switch\]\$Rollback/)
  assert.match(installer, /\[string\]\$InstallRoot/)
  assert.match(installer, /\[string\]\$ProgressPath/)
  assert.match(installer, /Write-InstallProgress/)
  assert.match(installer, /trap \{/)
  assert.match(installer, /accr-ui-harness-install\.log/)
  assert.match(installer, /if \(\$Interactive\) \{ Read-Host/)
  assert.match(installer, /Register-ReleaseTree \$installRoot/)
  assert.match(installer, /Move-ManagedTree \$installRoot \$previousRoot/)
  assert.match(installer, /Move-ManagedTree \$previousRoot \$installRoot/)
  assert.match(installer, /Move-ManagedTree \$rollbackRoot \$installRoot/)
  assert.match(installer, /function Stop-InstalledProductProcesses/)
  assert.match(installer, /function Suspend-NativeHostRegistration/)
  assert.match(installer, /function Complete-NativeHostRegistrationTransition/)
  assert.match(installer, /NativeMessagingHosts/)
  assert.match(installer, /Get-CimInstance Win32_Process/)
  assert.match(installer, /taskkill\.exe/)
  assert.match(installer, /Stop-Process -Id \$processId -Force/)
  assert.match(installer, /function Stop-InstalledProductProcess/)
  assert.match(installer, /Start-Process -FilePath taskkill\.exe[\s\S]*-Wait -PassThru -ErrorAction Stop/)
  assert.match(installer, /if \(-not \(Get-Process -Id \$processId -ErrorAction SilentlyContinue\)\) \{ return \}/)
  assert.doesNotMatch(installer, /& taskkill\.exe/)
  assert.match(installer, /function Move-ManagedPathWithRetry/)
  assert.match(installer, /function New-ExtensionInUseError/)
  assert.match(installer, /Chrome 或 Edge 正在加载这个 unpacked 扩展/)
  assert.match(installer, /无需关闭整个浏览器/)
  assert.match(installer, /旧版本未被替换，仍可继续使用/)
  assert.match(installer, /Move-ManagedTree \$installRoot \$previousRoot -ExplainLockedExtension/)
  assert.match(installer, /Suspend-NativeHostRegistration[\s\S]*Stop-InstalledProductProcesses \$installRoot[\s\S]*Move-ManagedTree \$installRoot \$previousRoot/)
  assert.match(installer, /Register-ReleaseTree \$installRoot[\s\S]*Complete-NativeHostRegistrationTransition/)
  assert.match(installer, /manage-install\.ps1/)
  assert.equal(installer.includes('Remove-Item -LiteralPath $installRoot -Recurse -Force'), false)
  assert.match(installer, /workspace, logs, \.webmcp/)
  assert.match(installer, /@\('extension', 'runtime', 'release\.json'\)/)
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

test('static Windows runtime uses a bundle, keeps native sidecars, and rejects non-Windows materialization', async () => {
  assert.deepEqual(parseStaticRuntimeArgs(['--source', 'C:\\product', '--out', 'C:\\runtime', '--revision', 'abc']), {
    sourceDir: 'C:\\product', outputDir: 'C:\\runtime', revision: 'abc',
  })
  await assert.rejects(buildWindowsStaticHarnessRuntime({ platform: 'darwin', arch: 'arm64' }), /must build on Windows x64/)
  const banner = nativeResolverBanner('win32-x64')
  assert.match(banner, /node-pty\/prebuilds\/win32-x64\/pty\.node/)
  assert.match(banner, /win32-x64.*\[\^\\\\\/\]\+/s)
  assert.doesNotMatch(banner, /sharp-libvips-win32-x64/)
  const builderSource = await readFile(new URL('../release/windows-lite/build-static-harness-runtime.mjs', import.meta.url), 'utf8')
  assert.match(builderSource, /product-office-skills\.mjs/)
  assert.match(builderSource, /process\.env\.npm_execpath/)
  assert.match(builderSource, /'pnpm\.cmd'/)
  assert.doesNotMatch(builderSource, /run\('pnpm'/)
  assert.match(builderSource, /runPnpm\(\['build:harness-client-plugins'\]/)
  assert.ok(
    builderSource.indexOf("runPnpm(['build:harness-client-plugins']") < builderSource.indexOf('bundleWithHarnessEsbuild({'),
    'product plugins must build before the static server bundle',
  )
  assert.match(builderSource, /path\.join\(koffi, 'win32_x64', 'koffi\.node'\)/)
  assert.match(builderSource, /patchBundledWindowsAclRunnerPath\(bundlePath\)/)
  assert.match(builderSource, /bundleWindowsAclRunner\(/)
  assert.match(builderSource, /assertWindowsAclRunnerContract\(/)
})

test('Windows bundle aliases use concrete product plugin entries and retain package roots for assets', () => {
  const aliases = staticBundleAliases(PRODUCT_UI_PLUGIN_PACKAGES, 'C:\\harness-product')
  for (const name of PRODUCT_UI_PLUGIN_PACKAGES) {
    assert.equal(aliases[name], path.join(staticPackageSource(name, 'C:\\harness-product'), 'lib', 'index.js'))
    assert.match(aliases[name], /lib[/\\\\]index\.js$/)
    assert.doesNotMatch(staticPackageSource(name, 'C:\\harness-product'), /lib[/\\\\]index\.js$/)
  }

  const upstream = '@deepseek-ai/dsh-mcp-client'
  assert.equal(staticBundleAliases([upstream], 'C:\\harness-product')[upstream], staticPackageSource(upstream, 'C:\\harness-product'))
})

test('static runtime rewrites and carries the Win32 directory-picker worker without node_modules', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'directory-picker-worker-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await writeFixture(root, 'server.mjs', `// packages/workflow/workflow-worker-thread/src/host.ts
new URL("./worker.cjs", import.meta.url)
// packages/code-runtime/code-runtime-worker-thread/src/index.ts
import.meta.url.endsWith('.ts') ? "./worker.ts" : "./worker.cjs"
// packages/host/directory-picker-native/lib/index.js
new URL("./worker.cjs", import.meta.url)
`)
  await patchBundledWorkerPaths(server, { includeDirectoryPicker: true })
  const rewritten = await readFile(server, 'utf8')
  assert.match(rewritten, /directory-picker-worker\.cjs/)
  assert.doesNotMatch(rewritten, /node_modules/)
})

test('static runtime carries a self-contained Windows ACL runner and points the server at its relative path', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'windows-acl-runner-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = await writeFixture(root, 'harness/apps/cli/lib/server.mjs', `// packages/sandbox/sandbox-local/lib/index.js
fileURLToPath2(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"))
`)
  const runner = path.join(root, 'harness/apps/cli/lib/windows-acl-runner.cjs')
  await patchBundledWindowsAclRunnerPath(server)
  await bundleWindowsAclRunner({
    harnessRoot: path.join(process.cwd(), '.generated', 'harness-product'),
    outfile: runner,
  })
  const rewritten = await readFile(server, 'utf8')
  const bundledRunner = await readFile(runner, 'utf8')
  assert.match(rewritten, /new URL\("\.\/windows-acl-runner\.cjs", import\.meta\.url\)/)
  assert.doesNotMatch(rewritten, /dsh-sandbox-windows-acl\/runner/)
  assert.doesNotMatch(bundledRunner, /node_modules/)
  assert.match(bundledRunner, /native\/koffi\/koffi\.node/)
  await assertWindowsAclRunnerContract({ serverPath: server, runnerPath: runner })
  await assert.rejects(assertWindowsAclRunnerContract({ serverPath: server, runnerPath: path.join(root, 'missing.cjs') }), /missing Windows ACL runner/)
})

test('Windows acceptance executes the installed ACL runner through Pwsh and retains child failure diagnostics', async () => {
  const [acceptance, smoke] = await Promise.all([
    readFile(new URL('../release/windows-lite/acceptance-windows.ps1', import.meta.url), 'utf8'),
    readFile(new URL('../release/windows-lite/acl-runner-smoke.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(acceptance, /function Invoke-WindowsAclRunnerSmoke/)
  assert.match(acceptance, /acl-runner-smoke\.mjs/)
  assert.match(acceptance, /Invoke-WindowsAclRunnerSmoke/)
  assert.match(smoke, /workspace-write/)
  assert.match(smoke, /read-only/)
  assert.match(smoke, /ACL-PWSH-DENIED/)
  assert.match(smoke, /Write-Output \('ACL-PWSH-DENIED:/)
  assert.doesNotMatch(smoke, /\[Console\]::/)
  assert.match(smoke, /windows-acl-run: unknown mode: invalid/)
})

test('Windows product UI smoke requires every activated product client bundle', async () => {
  const entries = EXPECTED_PRODUCT_CLIENT_IDS.map((id, index) => ({ id, url: `/plugins/product-${index}.js` }))
  const fetched = []
  const fetchImpl = async input => {
    const url = String(input)
    fetched.push(url)
    if (url === 'http://127.0.0.1:43123/') {
      return { ok: true, status: 200, text: async () => `<script>window.__DSH_BOOT__ = ${JSON.stringify({ entries })}</script>` }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  const result = await verifyProductUiBoot('http://127.0.0.1:43123/', fetchImpl)
  assert.equal(result.productClientCount, EXPECTED_PRODUCT_CLIENT_IDS.length)
  assert.equal(fetched.length, EXPECTED_PRODUCT_CLIENT_IDS.length + 1)

  await assert.rejects(
    verifyProductUiBoot('http://127.0.0.1:43123/', async input => {
      if (String(input) === 'http://127.0.0.1:43123/') {
        return { ok: true, status: 200, text: async () => '<script>window.__DSH_BOOT__ = {"entries":[]}</script>' }
      }
      throw new Error('unexpected client fetch')
    }),
    /missing activated product client plugin/,
  )
})

test('directory-picker worker is a standalone CJS bundle with a relative Koffi sidecar loader', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'directory-picker-worker-bundle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worker = path.join(root, 'harness', 'apps', 'cli', 'lib', 'directory-picker-worker.cjs')
  await bundleDirectoryPickerWorker({
    harnessRoot: path.join(process.cwd(), '.generated', 'harness-product'),
    outfile: worker,
  })
  const source = await readFile(worker, 'utf8')
  assert.doesNotMatch(source, /node_modules/)
  assert.match(source, /native\/koffi\/koffi\.node/)
  const server = await writeFixture(root, 'harness/apps/cli/lib/server.mjs', 'new URL("./directory-picker-worker.cjs", import.meta.url)')
  await assertDirectoryPickerWorkerContract({ serverPath: server, workerPath: worker })
  await assert.rejects(assertDirectoryPickerWorkerContract({ serverPath: server, workerPath: path.join(root, 'missing.cjs') }), /missing directory-picker worker/)
})

test('directory-picker Koffi shim restores the official JS introspection helpers', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'directory-picker-koffi-shim-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'fake-native.cjs'), `module.exports = {
    version: 'test',
    introspect(spec) {
      if (spec === 'record') return { primitive: 'Record', size: 16, alignment: 8, members: { value: { offset: 4 } } };
      return { primitive: 'Scalar', size: 8, alignment: 8 };
    },
  }`)
  const shim = await writeFixture(root, 'shim.cjs', directoryPickerKoffiShimSource('./fake-native.cjs'))
  const koffi = createRequire(import.meta.url)(shim)
  assert.equal(koffi.sizeof('void *'), 8)
  assert.equal(koffi.alignof('void *'), 8)
  assert.equal(koffi.offsetof('record', 'value'), 4)
  assert.throws(() => koffi.offsetof('void *', 'value'), /only be used with record types/)
})

test('Windows Native Messaging smoke accepts a fragmented pong, writes stop, and exits cleanly', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild({
    onEnd(target) {
      queueMicrotask(() => {
        target.stdin.emit('finish')
        target.close(0)
      })
    },
  })
  const smoke = runFakeSmoke(child, timers)
  const pong = encodeNativeMessage({ type: 'pong' })
  child.stdout.emit('data', pong.subarray(0, 3))
  child.stdout.emit('data', pong.subarray(3))

  assert.deepEqual(await smoke, { type: 'pong' })
  assert.deepEqual(child.frames.map(decodeMessage), [{ type: 'ping' }, { type: 'stop' }])
  assertSmokeClean(child, timers)
})

test('Windows Native Messaging acceptance preserves cmd launcher quoting and fails closed on smoke errors', async () => {
  const smokeSource = await readFile(new URL('../release/windows-lite/native-message-smoke.mjs', import.meta.url), 'utf8')
  const acceptanceSource = await readFile(new URL('../release/windows-lite/acceptance-windows.ps1', import.meta.url), 'utf8')
  assert.match(smokeSource, /windowsVerbatimArguments:\s*true/)
  assert.match(acceptanceSource, /function Invoke-NativeMessageSmoke/)
  assert.match(acceptanceSource, /cscript\.exe \/\/NoLogo \$installLauncher/)
  assert.match(acceptanceSource, /DSH_INSTALL_NONINTERACTIVE = '1'/)
  assert.match(acceptanceSource, /function Invoke-InstallerUiSmoke/)
  assert.match(acceptanceSource, /Interactive installer window reported visible/)
  assert.match(acceptanceSource, /function Start-NativeHostRespawnSupervisor/)
  assert.match(acceptanceSource, /Browser-style Native Host respawn stopped after registration was suspended/)
  assert.match(acceptanceSource, /Installer never suspended Native Messaging registration during upgrade/)
  assert.match(acceptanceSource, /function Start-ExtensionLockHolder/)
  assert.match(acceptanceSource, /function Stop-ExtensionLockHolder/)
  assert.match(acceptanceSource, /WaitForExit\(10000\)/)
  assert.match(acceptanceSource, /Chrome 或 Edge 正在加载这个 unpacked 扩展/)
  assert.match(acceptanceSource, /Locked unpacked extension upgrade replaced the old version/)
  assert.match(acceptanceSource, /Locked unpacked extension process was terminated by the installer/)
  assert.match(acceptanceSource, /if \(\$lockHolder\.HasExited\) \{ throw 'Locked unpacked extension process was terminated by the installer\.' \}\r?\n\s+Stop-ExtensionLockHolder \$lockHolder\r?\n\s+\$installLog/)
  assert.match(acceptanceSource, /VBS installer error log:/)
  assert.match(acceptanceSource, /accr-ui-harness-install\.log/)
  assert.match(acceptanceSource, /VBS installer created no error log; probing install\.ps1 with Windows PowerShell directly\./)
  assert.match(acceptanceSource, /VBS installer failed with exit code \$vbsExitCode/)
  assert.match(acceptanceSource, /if \(\$LASTEXITCODE -ne 0\) \{ throw "Native Messaging smoke failed with exit code \$LASTEXITCODE\." \}/)
  assert.match(acceptanceSource, /runtime\\skills\\pmd-prd\\SKILL\.md/)
  assert.match(acceptanceSource, /runtime\\skills\\' \+ \$officeSkill \+ '\\SKILL\.md/)
  assert.match(acceptanceSource, /@\('pptx', 'xlsx', 'docx', 'pdf'\)/)
  assert.match(acceptanceSource, /product-office-skills\.mjs/)
  assert.match(acceptanceSource, /DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills/)
  assert.match(acceptanceSource, /Harness Workspace 是唯一用户界面/)
  assert.equal((acceptanceSource.match(/Invoke-NativeMessageSmoke/g) ?? []).length, 3)
})

test('Windows Native Messaging smoke rejects invalid JSON and terminates the tree', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild()
  let kills = 0
  const smoke = runFakeSmoke(child, timers, () => { kills += 1; return { ok: true } })
  const invalid = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('{')])
  child.stdout.emit('data', invalid)

  await assert.rejects(smoke, /invalid JSON/)
  assert.equal(kills, 1)
  assertSmokeClean(child, timers)
})

test('Windows Native Messaging smoke rejects a clean exit before stop finishes writing', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild()
  const smoke = runFakeSmoke(child, timers)
  child.stdout.emit('data', encodeNativeMessage({ type: 'pong' }))
  child.close(0)

  await assert.rejects(smoke, /before the stop frame finished writing/)
  assertSmokeClean(child, timers)
})

test('Windows Native Messaging smoke handles stdin EPIPE without leaving a process handle', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild({ onEnd(target) { queueMicrotask(() => target.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))) } })
  let kills = 0
  const smoke = runFakeSmoke(child, timers, () => { kills += 1; return { ok: true } })
  child.stdout.emit('data', encodeNativeMessage({ type: 'pong' }))

  await assert.rejects(smoke, /stdin failed: broken pipe/)
  assert.equal(kills, 1)
  assertSmokeClean(child, timers)
})

test('Windows Native Messaging smoke bounds a ping timeout', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild()
  let kills = 0
  const smoke = runFakeSmoke(child, timers, () => { kills += 1; return { ok: true } })
  timers.fire()

  await assert.rejects(smoke, /ping timed out/)
  assert.equal(kills, 1)
  assertSmokeClean(child, timers)
})

test('Windows Native Messaging smoke falls back when stop-timeout taskkill fails', async () => {
  const timers = timerHarness()
  const child = fakeNativeChild({ onEnd(target) { queueMicrotask(() => target.stdin.emit('finish')) } })
  const smoke = runFakeSmoke(child, timers, () => ({ ok: false, error: 'access denied' }))
  child.stdout.emit('data', encodeNativeMessage({ type: 'pong' }))
  await new Promise((resolvePromise) => queueMicrotask(resolvePromise))
  timers.fire()

  await assert.rejects(smoke, /process-tree termination failed: access denied/)
  assert.equal(child.killedByFallback, true)
  assertSmokeClean(child, timers)
})
