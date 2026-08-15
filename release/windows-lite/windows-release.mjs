/**
 * AccrUI-compatible Windows Lite release module.
 *
 * External interface: buildWindowsRelease() and validateWindowsRelease().
 * The implementation owns the compatibility layout, extension identity,
 * runtime closure checks, installer generation, and archive validation.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..')

export const ACCR_UI_WINDOWS_PACKAGE_NAME = 'accr-ui-windows-lite-x64'
export const ACCR_UI_EXTENSION_MANIFEST_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtjVzlR9cE9zV44l999YtraoKbQ77NfaFgwJmpeABPL2HxUK82pD0DFRSv/7FfZ4nEZRDlgZz1zj1yIF4HLnftCZyf/xYIrwhXDojQfYULE8miIGufKEJf/IUBkpFdFKHgfKgowV0M72wNzqaYd27MdR6DczCR5PQKwi5G2JKUJxx4xc2+KD3GOUjpE8DrhzliD3gYcwEZ8lphtOuCUIx5kI97etKEiixqrwFGRoUbHFLXT14+Fqg7jmSu/HaUVWbl/Dx1VbI1hgVZdnJI//UJY+T0qMLV8hcfHPpwBum0lf1rfP+FQwnqoV2wf4k+6f70dE/Xrlckddpkl0IWDSEdwIDAQAB'
export const ACCR_UI_EXTENSION_ID = 'cmgjacoohdgjedoekbdbhbelpmboankg'
export const ACCR_UI_REPLACEMENT_MIN_VERSION = '1.1.63'
export const NATIVE_HOST_NAME = 'com.deepseek.harness.chrome'
export const LEGACY_NATIVE_HOST_NAME = 'com.chromemcp.nativehost'
export const HARNESS_RUNTIME_MARKER = 'harness-runtime.json'

const REQUIRED_HARNESS_PATHS = [
  'package.json',
  'apps/cli/lib/bin.js',
  'apps/web/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot',
  'node_modules/@deepseek-ai/dsh-web-app',
  'node_modules/@deepseek-ai/dsh-web-frontend',
]

function chromeExtensionIdFromManifestKey(manifestKey) {
  const digest = createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest()
  return Array.from(digest.subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0').replace(/[0-9a-f]/g, (char) =>
      String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(char, 16)),
    ),
  ).join('')
}

function normalizeVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Windows Lite extension version must be Chrome-compatible x.y.z: ${version}`)
  }
  return version.split('.').map(Number)
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left)
  const rightParts = normalizeVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

export function assertAccrUiReplacementVersion(version) {
  normalizeVersion(version)
  if (compareVersions(version, ACCR_UI_REPLACEMENT_MIN_VERSION) < 0) {
    throw new Error(
      `Harness Windows Lite version ${version} is below the first AccrUI replacement version ${ACCR_UI_REPLACEMENT_MIN_VERSION}.`,
    )
  }
  return version
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
}

async function copyDereferenced(source, destination) {
  await cp(source, destination, { recursive: true, dereference: true, force: true })
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

export async function validateHarnessRuntime(harnessRuntimeDir) {
  if (!harnessRuntimeDir) {
    throw new Error(
      'Missing Harness runtime. Pass --harness-runtime <fully materialized DeepSeek Harness runtime directory>; a sibling source path is never inferred.',
    )
  }
  const root = path.resolve(harnessRuntimeDir)
  if (existsSync(path.join(root, '.git'))) {
    throw new Error('Harness runtime must be a materialized runtime closure, not a source checkout.')
  }
  const markerPath = path.join(root, HARNESS_RUNTIME_MARKER)
  if (!existsSync(markerPath)) {
    throw new Error(`Harness runtime is missing ${HARNESS_RUNTIME_MARKER}; package a Windows x64 runtime closure first.`)
  }
  const marker = await readJson(markerPath)
  const markerErrors = []
  if (marker.format !== 'deepseek-harness-windows-runtime-v1') markerErrors.push('format')
  if (marker.platform !== 'win32') markerErrors.push('platform')
  if (marker.arch !== 'x64') markerErrors.push('arch')
  if (typeof marker.revision !== 'string' || marker.revision.trim() === '') markerErrors.push('revision')
  if (marker.entrypoint !== 'apps/cli/lib/bin.js') markerErrors.push('entrypoint')
  if (marker.closureComplete !== true) markerErrors.push('closureComplete')
  if (markerErrors.length > 0) {
    throw new Error(`Harness runtime marker is invalid: ${markerErrors.join(', ')}`)
  }
  const missing = REQUIRED_HARNESS_PATHS.filter((relativePath) => !existsSync(path.join(root, relativePath)))
  if (missing.length > 0) {
    throw new Error(`Harness runtime is incomplete: missing ${missing.join(', ')}`)
  }
  const manifest = await readJson(path.join(root, 'package.json'))
  if (manifest.name !== '@deepseek-ai/dsh-root') {
    throw new Error(`Harness runtime package.json must identify @deepseek-ai/dsh-root, received ${String(manifest.name)}`)
  }
  return root
}

function nativeHostBat() {
  return `@echo off\r\nsetlocal\r\nset "PACKAGE_DIR=%~dp0"\r\nset "NODE_PATH_FILE=%PACKAGE_DIR%node-path.txt"\r\nif not exist "%NODE_PATH_FILE%" (\r\n  echo ERROR: Verified Node.js path is missing. Re-run install.ps1 or runtime\\register-native-host.ps1. 1>&2\r\n  exit /b 1\r\n)\r\nset /p "NODE_EXEC=" < "%NODE_PATH_FILE%"\r\nif "%NODE_EXEC%"=="" (\r\n  echo ERROR: Verified Node.js path is empty. Re-run install.ps1. 1>&2\r\n  exit /b 1\r\n)\r\nif not exist "%NODE_EXEC%" (\r\n  echo ERROR: Verified Node.js executable no longer exists: %NODE_EXEC% 1>&2\r\n  exit /b 1\r\n)\r\nset "DSH_ROOT=%PACKAGE_DIR%harness"\r\nset "DSH_CLI_PATH=%DSH_ROOT%\\apps\\cli\\lib\\bin.js"\r\nset "DSH_CWD=%PACKAGE_DIR%..\\workspace"\r\nset "DSH_NATIVE_LOG=%PACKAGE_DIR%..\\logs\\native-host.log"\r\n"%NODE_EXEC%" "%PACKAGE_DIR%native-server\\bin.mjs"\r\n`
}

function nativeHostManifest(nativeHostName) {
  return `${JSON.stringify({
    name: nativeHostName,
    description: 'DeepSeek Harness Native Messaging host',
    path: '__REGISTERED_NATIVE_HOST_LAUNCHER__',
    type: 'stdio',
    allowed_origins: [`chrome-extension://${ACCR_UI_EXTENSION_ID}/`],
  }, null, 2)}\n`
}

function registerNativeHostPs1() {
  return `param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$runtimeDir = $PSScriptRoot
$launcher = Join-Path $runtimeDir 'run_native_host.bat'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未检测到 Node.js；Harness UI 需要 Node.js 22 或更高版本。' }
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node.js 路径无效：$nodePath" }
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v?(?<major>\\d+)') { throw "无法读取 Node.js 版本：$nodeVersion" }
if ([int]$Matches.major -lt 22) { throw "Node.js $nodeVersion 版本过低；Harness UI 需要 Node.js 22 或更高版本。" }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "缺少 Native Host launcher：$launcher" }
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$nodePathFile = Join-Path $runtimeDir 'node-path.txt'
[System.IO.File]::WriteAllText($nodePathFile, $nodePath + [Environment]::NewLine, $utf8NoBom)
$manifestDir = Join-Path $InstallRoot 'native-messaging'
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
$registryRoots = @(
  'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts'
)
foreach ($nativeHostName in @('${NATIVE_HOST_NAME}', '${LEGACY_NATIVE_HOST_NAME}')) {
  $templatePath = Join-Path $runtimeDir ($nativeHostName + '.json')
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw "缺少 Native Host manifest 模板：$templatePath" }
  $manifest = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
  if ($manifest.name -ne $nativeHostName) { throw "Native Host manifest 名称不匹配：$templatePath" }
  $manifest.path = $launcher
  $installedManifestPath = Join-Path $manifestDir ($nativeHostName + '.json')
  [System.IO.File]::WriteAllText($installedManifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)
  foreach ($registryRoot in $registryRoots) {
    $registryKey = Join-Path $registryRoot $nativeHostName
    New-Item -Path $registryKey -Force | Out-Null
    Set-Item -Path $registryKey -Value $installedManifestPath
  }
}
`
}

function installPs1(extensionId) {
  return `# AccrUI-compatible Harness Windows Lite installer
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadZip = Join-Path $scriptDir 'payload.zip'
$installRoot = Join-Path $env:LOCALAPPDATA 'accr-ui-harness'

if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) { throw '缺少 payload.zip 安装包。' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未检测到 Node.js；Harness UI 需要 Node.js 22 或更高版本。' }
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node.js 路径无效：$nodePath" }
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v?(?<major>\\d+)' -or [int]$Matches.major -lt 22) { throw "Node.js $nodeVersion 版本过低；Harness UI 需要 Node.js 22 或更高版本。" }
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
# Preserve user-owned workspace, logs, and .webmcp; only release-owned trees are replaced.
foreach ($replaceableName in @('extension', 'runtime')) {
  $replaceablePath = Join-Path $installRoot $replaceableName
  if (Test-Path -LiteralPath $replaceablePath) { Remove-Item -LiteralPath $replaceablePath -Recurse -Force }
}
Expand-Archive -LiteralPath $payloadZip -DestinationPath $installRoot -Force
$extensionManifest = Join-Path $installRoot 'extension\\manifest.json'
$cli = Join-Path $installRoot 'runtime\\harness\\apps\\cli\\lib\\bin.js'
$registerScript = Join-Path $installRoot 'runtime\\register-native-host.ps1'
if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) { throw '安装包不完整：缺少 extension\\manifest.json。' }
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw '安装包不完整：缺少 Harness runtime。' }
if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) { throw '安装包不完整：缺少 Native Host 注册脚本。' }
& $registerScript -InstallRoot $installRoot
New-Item -Path 'HKCU:\\Software\\accr-ui\\Lite' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\accr-ui\\Lite' -Name InstallDir -Value $installRoot
Set-ItemProperty -Path 'HKCU:\\Software\\accr-ui\\Lite' -Name Product -Value 'Harness UI'
Write-Host "Harness UI 已安装。请在 chrome://extensions 或 edge://extensions 重新加载 AccrUI 扩展。"
`
}

function installVbs() {
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & Replace(WScript.ScriptFullName, "install.vbs", "install.ps1") & """", 1, False\r\n`
}

function startVbs() {
  return `Set shell = CreateObject("WScript.Shell")\r\nruntimeDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)\r\ninstallRoot = CreateObject("Scripting.FileSystemObject").GetParentFolderName(runtimeDir)\r\nshell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & runtimeDir & "\\register-native-host.ps1"" -InstallRoot """ & installRoot & """", 0, False\r\n`
}

function releaseReadme(version) {
  return `# AccrUI Harness UI Windows Lite\n\n这是一个 AccrUI 更新器兼容的 Harness UI 候选包。\n\n- 扩展 ID：\`${ACCR_UI_EXTENSION_ID}\`（与正式 AccrUI 一致）\n- 扩展版本：\`${version}\`\n- 不包含旧的 AccrUI Agent Backend。\n- 安装后请重新加载原有 AccrUI 扩展；首次灰度必须在真实 Windows 机器验证 Native Messaging、Harness 启动和回滚。\n`
}

function runZip(cwd, outputPath, input) {
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-a', '-c', '-f', outputPath, input], { cwd, stdio: 'pipe' })
    return
  }
  execFileSync('zip', ['-qr', outputPath, input], { cwd, stdio: 'pipe' })
}

function archiveEntries(zipPath, requiredEntries) {
  try {
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$required = @($env:DSH_ZIP_ENTRIES | ConvertFrom-Json)',
        '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP_PATH)',
        "try { foreach ($entry in $archive.Entries) { $name = $entry.FullName -replace '^\\./', ''; if ($required -contains $name) { [Console]::Out.WriteLine($name) } } } finally { $archive.Dispose() }",
      ].join('; ')
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        env: { ...process.env, DSH_ZIP_PATH: zipPath, DSH_ZIP_ENTRIES: JSON.stringify(requiredEntries) },
      }).split(/\r?\n/).filter(Boolean)
    }
    return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch (error) {
    throw new Error(`Unable to inspect ZIP ${zipPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readZipBuffer(zipPath, entry) {
  try {
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP_PATH)',
        '$stream = $null',
        'try {',
        '  $zipEntry = $archive.GetEntry($env:DSH_ZIP_ENTRY)',
        "  if ($null -eq $zipEntry) { throw ('Missing ZIP entry: ' + $env:DSH_ZIP_ENTRY) }",
        '  $stream = $zipEntry.Open()',
        '  $memory = [System.IO.MemoryStream]::new()',
        '  $stream.CopyTo($memory)',
        '  $bytes = $memory.ToArray()',
        '  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)',
        '} finally { if ($null -ne $stream) { $stream.Dispose() }; $archive.Dispose() }',
      ].join(' ')
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, DSH_ZIP_PATH: zipPath, DSH_ZIP_ENTRY: entry },
      })
    }
    return execFileSync('unzip', ['-p', zipPath, entry])
  } catch (error) {
    throw new Error(`Unable to read ${entry} from ${zipPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizedArchiveEntries(zipPath, requiredEntries) {
  return archiveEntries(zipPath, requiredEntries).map((entry) => entry.replace(/^\.\//, ''))
}

function readZipText(zipPath, entry) {
  return readZipBuffer(zipPath, entry).toString('utf8')
}

function readZipUtf16Le(zipPath, entry) {
  const content = readZipBuffer(zipPath, entry)
  return content.subarray(content[0] === 0xff && content[1] === 0xfe ? 2 : 0).toString('utf16le')
}

export async function validateWindowsRelease({ packageDir, zipPath = path.join(path.dirname(packageDir), `${path.basename(packageDir)}.zip`) }) {
  const errors = []
  const requiredTopLevel = ['install.ps1', 'install.vbs', 'payload.zip', 'README.zh-CN.md']
  for (const relativePath of requiredTopLevel) {
    if (!existsSync(path.join(packageDir, relativePath))) errors.push(`missing ${relativePath}`)
  }
  const payloadZipPath = path.join(packageDir, 'payload.zip')
  const manifestEntry = 'extension/manifest.json'
  const runtimeCliEntry = 'runtime/harness/apps/cli/lib/bin.js'
  const nativeLauncherEntry = 'runtime/run_native_host.bat'
  const registerNativeHostEntry = 'runtime/register-native-host.ps1'
  const startEntry = 'runtime/start.vbs'
  const nativeManifestEntries = [
    `runtime/${NATIVE_HOST_NAME}.json`,
    `runtime/${LEGACY_NATIVE_HOST_NAME}.json`,
  ]
  const requiredPayloadEntries = [manifestEntry, runtimeCliEntry, nativeLauncherEntry, registerNativeHostEntry, startEntry, ...nativeManifestEntries]
  let payloadEntries = []
  if (existsSync(payloadZipPath)) {
    payloadEntries = normalizedArchiveEntries(payloadZipPath, requiredPayloadEntries)
    for (const requiredPath of requiredPayloadEntries) {
      if (!payloadEntries.includes(requiredPath)) errors.push(`payload.zip is missing ${requiredPath}`)
    }
  }
  let manifest
  if (payloadEntries.includes(manifestEntry)) {
    manifest = JSON.parse(readZipText(payloadZipPath, manifestEntry))
    if (manifest.key !== ACCR_UI_EXTENSION_MANIFEST_KEY) errors.push('extension manifest does not carry the fixed AccrUI manifest key')
    if (chromeExtensionIdFromManifestKey(manifest.key ?? '') !== ACCR_UI_EXTENSION_ID) errors.push('extension manifest key does not resolve to the AccrUI extension ID')
    try {
      assertAccrUiReplacementVersion(manifest.version)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (payloadEntries.includes(registerNativeHostEntry)) {
    const registerScript = readZipText(payloadZipPath, registerNativeHostEntry)
    for (const requiredText of [
      NATIVE_HOST_NAME,
      LEGACY_NATIVE_HOST_NAME,
      'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts',
      'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
      'Set-Item -Path $registryKey -Value $installedManifestPath',
      '-lt 22',
      "$nodePathFile = Join-Path $runtimeDir 'node-path.txt'",
      '[System.Text.UTF8Encoding]::new($false)',
    ]) {
      if (!registerScript.includes(requiredText)) errors.push(`register-native-host.ps1 is missing ${requiredText}`)
    }
  }
  if (payloadEntries.includes(nativeLauncherEntry)) {
    const launcher = readZipText(payloadZipPath, nativeLauncherEntry)
    for (const requiredText of ['NODE_PATH_FILE=%PACKAGE_DIR%node-path.txt', 'set /p "NODE_EXEC=" < "%NODE_PATH_FILE%"', '"%NODE_EXEC%" "%PACKAGE_DIR%native-server\\bin.mjs"']) {
      if (!launcher.includes(requiredText)) errors.push(`run_native_host.bat is missing ${requiredText}`)
    }
    if (launcher.includes('node "%PACKAGE_DIR%native-server')) errors.push('run_native_host.bat must not fall back to Chrome PATH node')
  }
  if (payloadEntries.includes(startEntry)) {
    const startScript = readZipUtf16Le(payloadZipPath, startEntry)
    if (!startScript.includes('register-native-host.ps1') || !startScript.includes(' 0, False')) {
      errors.push('runtime/start.vbs does not silently re-register the Native Host')
    }
  }
  for (const [nativeHostName, entry] of [[NATIVE_HOST_NAME, nativeManifestEntries[0]], [LEGACY_NATIVE_HOST_NAME, nativeManifestEntries[1]]]) {
    if (!payloadEntries.includes(entry)) continue
    const nativeManifest = JSON.parse(readZipText(payloadZipPath, entry))
    if (nativeManifest.name !== nativeHostName || nativeManifest.path !== '__REGISTERED_NATIVE_HOST_LAUNCHER__' || nativeManifest.type !== 'stdio') {
      errors.push(`${entry} is not a valid ${nativeHostName} template`)
    }
    if (JSON.stringify(nativeManifest.allowed_origins) !== JSON.stringify([`chrome-extension://${ACCR_UI_EXTENSION_ID}/`])) {
      errors.push(`${entry} does not allow the fixed AccrUI extension identity`)
    }
  }
  const installerPath = path.join(packageDir, 'install.ps1')
  if (existsSync(installerPath)) {
    const installer = await readFile(installerPath, 'utf8')
    if (!installer.includes('& $registerScript -InstallRoot $installRoot') || !installer.includes('-lt 22')) {
      errors.push('install.ps1 does not validate Node 22+ and reuse the runtime registration script')
    }
    if (installer.includes('NativeMessagingHosts')) {
      errors.push('install.ps1 must not duplicate Native Messaging registration logic')
    }
    if (installer.includes('Remove-Item -LiteralPath $installRoot -Recurse -Force')) {
      errors.push('install.ps1 must preserve the install root user data')
    }
    for (const retainedPath of ['workspace', 'logs', '.webmcp']) {
      if (!installer.includes(retainedPath)) errors.push(`install.ps1 does not document preservation of ${retainedPath}`)
    }
  }
  if (existsSync(zipPath)) {
    const root = `${path.basename(packageDir)}/`
    const requiredOuterPaths = ['install.ps1', 'install.vbs', 'payload.zip']
    const entries = normalizedArchiveEntries(zipPath, requiredOuterPaths.map((requiredPath) => `${root}${requiredPath}`))
    for (const requiredPath of requiredOuterPaths) {
      if (!entries.includes(`${root}${requiredPath}`)) errors.push(`outer ZIP is missing ${requiredPath}`)
    }
  } else {
    errors.push(`missing outer ZIP ${path.basename(zipPath)}`)
  }
  return { valid: errors.length === 0, errors, extensionId: manifest?.key ? chromeExtensionIdFromManifestKey(manifest.key) : null, version: manifest?.version ?? null }
}

/** Build an AccrUI-updater compatible Windows package from explicit, local artifacts. */
export async function buildWindowsRelease({
  projectRoot = PROJECT_ROOT,
  releaseDir = path.join(projectRoot, 'release'),
  extensionDir = path.join(projectRoot, '.output', 'chrome-mv3'),
  nativeServerDir = path.join(projectRoot, 'native-server'),
  harnessRuntimeDir,
  version = ACCR_UI_REPLACEMENT_MIN_VERSION,
} = {}) {
  assertAccrUiReplacementVersion(version)
  const runtimeSource = await validateHarnessRuntime(harnessRuntimeDir)
  if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`Missing extension build output: ${path.join(extensionDir, 'manifest.json')}. Run pnpm build first.`)
  }
  if (!existsSync(path.join(nativeServerDir, 'bin.mjs'))) {
    throw new Error(`Missing native-server entry: ${path.join(nativeServerDir, 'bin.mjs')}`)
  }

  const packageDir = path.join(releaseDir, ACCR_UI_WINDOWS_PACKAGE_NAME)
  const payloadDir = path.join(releaseDir, '.tmp', ACCR_UI_WINDOWS_PACKAGE_NAME, 'payload')
  const runtimeDir = path.join(payloadDir, 'runtime')
  const zipPath = path.join(releaseDir, `${ACCR_UI_WINDOWS_PACKAGE_NAME}.zip`)
  await resetDirectory(packageDir)
  await resetDirectory(payloadDir)
  await rm(zipPath, { force: true })

  await copyDereferenced(extensionDir, path.join(payloadDir, 'extension'))
  const manifestPath = path.join(payloadDir, 'extension', 'manifest.json')
  const sourceManifest = await readJson(manifestPath)
  const packagedManifest = {
    ...sourceManifest,
    name: 'accr-ui Harness UI',
    version,
    key: ACCR_UI_EXTENSION_MANIFEST_KEY,
  }
  await writeFile(manifestPath, `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8')

  await copyDereferenced(nativeServerDir, path.join(runtimeDir, 'native-server'))
  await copyDereferenced(runtimeSource, path.join(runtimeDir, 'harness'))
  await mkdir(path.join(payloadDir, 'logs'), { recursive: true })
  await mkdir(path.join(payloadDir, 'workspace'), { recursive: true })
  await writeFile(path.join(runtimeDir, 'run_native_host.bat'), nativeHostBat(), 'utf8')
  await writeFile(path.join(runtimeDir, 'register-native-host.ps1'), registerNativeHostPs1(), 'utf8')
  await writeFile(path.join(runtimeDir, 'start.vbs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(startVbs(), 'utf16le')]))
  await writeFile(path.join(runtimeDir, `${NATIVE_HOST_NAME}.json`), nativeHostManifest(NATIVE_HOST_NAME), 'utf8')
  await writeFile(path.join(runtimeDir, `${LEGACY_NATIVE_HOST_NAME}.json`), nativeHostManifest(LEGACY_NATIVE_HOST_NAME), 'utf8')
  await writeFile(path.join(payloadDir, 'guide-state.json'), '{\n  "completed": false\n}\n', 'utf8')
  await writeFile(path.join(payloadDir, 'release.json'), `${JSON.stringify({
    format: 'accr-ui-windows-lite-v1',
    product: 'harness-ui',
    extensionId: ACCR_UI_EXTENSION_ID,
    extensionVersion: version,
    nativeHostName: NATIVE_HOST_NAME,
    legacyAgentBackend: false,
  }, null, 2)}\n`, 'utf8')

  await mkdir(releaseDir, { recursive: true })
  runZip(payloadDir, path.join(packageDir, 'payload.zip'), '.')
  await writeFile(path.join(packageDir, 'install.ps1'), installPs1(ACCR_UI_EXTENSION_ID), 'utf8')
  await writeFile(path.join(packageDir, 'install.vbs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(installVbs(), 'utf16le')]))
  await writeFile(path.join(packageDir, 'README.zh-CN.md'), releaseReadme(version), 'utf8')
  runZip(releaseDir, zipPath, ACCR_UI_WINDOWS_PACKAGE_NAME)

  const validation = await validateWindowsRelease({ packageDir, zipPath })
  if (!validation.valid) throw new Error(`Windows release validation failed: ${validation.errors.join('; ')}`)
  await rm(path.dirname(payloadDir), { recursive: true, force: true })
  return { packageDir, zipPath, ...validation }
}

export function parseWindowsReleaseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--harness-runtime' || argument === '--version' || argument === '--out') {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${argument}`)
      options[{ '--harness-runtime': 'harnessRuntimeDir', '--version': 'version', '--out': 'releaseDir' }[argument]] = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

async function main() {
  const options = parseWindowsReleaseArgs(process.argv.slice(2))
  const result = await buildWindowsRelease(options)
  console.log(`Created ${result.zipPath}`)
  console.log(`AccrUI extension ID: ${result.extensionId}; version: ${result.version}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
