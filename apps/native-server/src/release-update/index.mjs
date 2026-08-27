import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fetchRelease, resolveReleaseSource } from './release-source.mjs'
import { extractZip, verifyWindowsLitePackage } from './package-verifier.mjs'

export async function checkUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl)
  try {
    const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256 })
    return { available: true, ...verified, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('未高于当前版本')) throw error
    const verified = verifyWindowsLitePackage(bytes, { expectedSha256: source.expectedSha256 })
    return { available: false, ...verified, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
  }
}

export async function prepareUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl)
  const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256 })
  const root = await mkdtemp(join(tmpdir(), 'accrui-release-update-'))
  const packagePath = join(root, 'accr-ui-windows-lite-x64.zip')
  await writeFile(packagePath, bytes)
  const extractRoot = join(root, 'package')
  await extractZip(bytes, extractRoot, { stripCommonRoot: true })
  return { ...verified, packagePath, extractRoot, packageUrl: source.packageUrl, ...(etag === undefined ? {} : { etag }) }
}

export async function launchPreparedUpdate(prepared, { installRoot, nativePid, spawnImpl, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('在线更新仅支持 Windows Lite')
  if (!prepared?.extractRoot || !prepared?.version || !installRoot || !Number.isInteger(nativePid)) throw new Error('更新启动参数无效')
  const escapedRoot = String(installRoot).replaceAll("'", "''")
  const escapedScript = join(prepared.extractRoot, 'install.ps1').replaceAll("'", "''")
  const escapedVersion = String(prepared.version).replaceAll("'", "''")
  const command = `$ErrorActionPreference = 'Stop'
$installRoot = '${escapedRoot}'
$targetVersion = '${escapedVersion}'
$statusPath = Join-Path $installRoot '.accrui-update-status.json'
$installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
function Get-SafeUpdateError([object]$Cause) {
  $text = if ($null -eq $Cause) { '安装程序未返回错误详情。' } elseif ($Cause.Exception) { $Cause.Exception.Message } else { [string]$Cause }
  $safe = ([string]$text).Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($safe.Length -gt 2048) { return $safe.Substring(0, 2048) }
  return $safe
}
function Write-UpdateStatus([string]$State, [string]$ErrorText = '') {
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  $status = [ordered]@{ state = $State; version = $targetVersion; updatedAt = [DateTime]::UtcNow.ToString('o') }
  if (-not [string]::IsNullOrWhiteSpace($ErrorText)) { $status.error = (Get-SafeUpdateError $ErrorText); $status.logPath = $installLog }
  $temporary = $statusPath + '.' + $PID + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText($temporary, ($status | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
try {
  Write-UpdateStatus 'pending'
  $nativeDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id ${nativePid} -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $nativeDeadline) { Start-Sleep -Milliseconds 200 }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${escapedScript}' -InstallRoot $installRoot
  if ($LASTEXITCODE -ne 0) { throw "安装程序退出码：$LASTEXITCODE" }
  Write-UpdateStatus 'succeeded'
} catch {
  Write-UpdateStatus 'failed' (Get-SafeUpdateError $_)
  exit 1
}`
  return await new Promise((resolvePromise, rejectPromise) => {
    let child
    const settle = (callback, value) => {
      child?.removeListener?.('spawn', onSpawn)
      child?.removeListener?.('error', onError)
      callback(value)
    }
    const onError = error => settle(rejectPromise, error)
    const onSpawn = () => {
      try {
        child.unref()
        settle(resolvePromise, true)
      } catch (error) { settle(rejectPromise, error) }
    }
    try {
      child = (spawnImpl ?? spawn)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command], { detached: true, stdio: 'ignore' })
      if (!child?.once) throw new Error('更新启动器未返回子进程')
      child.once('spawn', onSpawn)
      child.once('error', onError)
    } catch (error) { settle(rejectPromise, error) }
  })
}
