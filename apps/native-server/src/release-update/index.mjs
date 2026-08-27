import { access, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
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

export async function launchPreparedUpdate(prepared, { installRoot, nativePid, spawnImpl, platform = process.platform, handshakeTimeoutMs: requestedHandshakeTimeoutMs, writeFileImpl = writeFile, renameImpl = rename } = {}) {
  if (platform !== 'win32') throw new Error('在线更新仅支持 Windows Lite')
  if (!prepared?.extractRoot || !prepared?.version || !installRoot || !Number.isInteger(nativePid)) throw new Error('更新启动参数无效')
  const escapedRoot = String(installRoot).replaceAll("'", "''")
  const escapedScript = join(prepared.extractRoot, 'install.ps1').replaceAll("'", "''")
  const escapedVersion = String(prepared.version).replaceAll("'", "''")
  const handshakeTimeoutMs = Number.isInteger(requestedHandshakeTimeoutMs) && requestedHandshakeTimeoutMs >= 1
    ? requestedHandshakeTimeoutMs
    : 10_000
  const handoffRoot = await mkdtemp(join(prepared.extractRoot, '.accrui-release-update-handoff-'))
  const updaterScriptPath = join(handoffRoot, 'updater.ps1')
  const launcherPath = join(handoffRoot, 'launch-updater.cmd')
  const cmdStartedPath = join(handoffRoot, 'cmd-started')
  const readyPath = join(handoffRoot, 'ready')
  const goPath = join(handoffRoot, 'go')
  const goPendingPath = `${goPath}.pending`
  const cancelPath = join(handoffRoot, 'cancel')
  const errorPath = join(handoffRoot, 'error')
  const stderrPath = join(handoffRoot, 'stderr')
  const escapePowerShell = value => String(value).replaceAll("'", "''")
  const command = `$ErrorActionPreference = 'Stop'
$installRoot = '${escapedRoot}'
$targetVersion = '${escapedVersion}'
$statusPath = Join-Path $installRoot '.accrui-update-status.json'
$installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
$readyPath = '${escapePowerShell(readyPath)}'
$goPath = '${escapePowerShell(goPath)}'
$cancelPath = '${escapePowerShell(cancelPath)}'
$errorPath = '${escapePowerShell(errorPath)}'
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
  [System.IO.File]::WriteAllText($readyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  $handoffDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $goPath -PathType Leaf) -and -not (Test-Path -LiteralPath $cancelPath -PathType Leaf) -and [DateTime]::UtcNow -lt $handoffDeadline) { Start-Sleep -Milliseconds 50 }
  if (Test-Path -LiteralPath $cancelPath -PathType Leaf) { throw 'Native Host 未确认更新交接，安装已取消。' }
  if (-not (Test-Path -LiteralPath $goPath -PathType Leaf)) { throw 'Native Host 未在时限内确认更新交接，安装已取消。' }
  $nativeDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id ${nativePid} -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $nativeDeadline) { Start-Sleep -Milliseconds 200 }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${escapedScript}' -InstallRoot $installRoot
  if ($LASTEXITCODE -ne 0) { throw "安装程序退出码：$LASTEXITCODE" }
  Write-UpdateStatus 'succeeded'
} catch {
  $safeError = Get-SafeUpdateError $_
  try { [System.IO.File]::WriteAllText($errorPath, $safeError, [System.Text.UTF8Encoding]::new($false)) } catch {}
  Write-UpdateStatus 'failed' $safeError
  exit 1
}`
  await writeFileImpl(updaterScriptPath, Buffer.from(`\uFEFF${command}`, 'utf8'))
  const launcher = [
    '@echo off',
    '> "%~dp0cmd-started" echo started',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0updater.ps1"',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
  await writeFileImpl(launcherPath, Buffer.from(launcher, 'ascii'))
  return await new Promise((resolvePromise, rejectPromise) => {
    let child
    let settled = false
    let committing = false
    let pollTimer
    let timeout
    let stderrFd
    const closeStderr = () => {
      if (stderrFd === undefined) return
      const fd = stderrFd
      stderrFd = undefined
      try { closeSync(fd) } catch {}
    }
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      child?.removeListener?.('spawn', onSpawn)
      child?.removeListener?.('error', onError)
      child?.removeListener?.('exit', onExit)
      callback(value)
    }
    const cancel = async error => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      child?.removeListener?.('spawn', onSpawn)
      child?.removeListener?.('error', onError)
      child?.removeListener?.('exit', onExit)
      try {
        await writeFileImpl(cancelPath, 'cancel', 'utf8')
        rejectPromise(error)
      } catch (cancelError) {
        const primary = error instanceof Error ? error.message : String(error)
        const secondary = cancelError instanceof Error ? cancelError.message : String(cancelError)
        rejectPromise(new Error(`${primary}；取消标记写入失败：${secondary}`))
      }
    }
    const onError = error => { void cancel(error) }
    const onExit = exitCode => {
      const readHandoffError = path => {
        try { return readFileSync(path, 'utf8').replace(/[\r\n]+/g, ' ').trim().slice(0, 2_048) } catch { return undefined }
      }
      const updaterError = readHandoffError(errorPath) || readHandoffError(stderrPath)
      const exitDetail = `exit code ${exitCode ?? 'unknown'}；cmd${existsSync(cmdStartedPath) ? '已启动' : '未启动'}`
      void cancel(new Error(updaterError ? `${updaterError}（${exitDetail}）` : `更新启动器在就绪握手前退出（${exitDetail}）。`))
    }
    const onReady = async () => {
      if (settled || committing) return
      committing = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      try {
        child?.unref?.()
        await writeFileImpl(goPendingPath, 'go', 'utf8')
        if (!settled) await renameImpl(goPendingPath, goPath)
        if (!settled) settle(resolvePromise, true)
      } catch (error) {
        if (!settled) await cancel(error)
      } finally {
        committing = false
      }
    }
    const pollReady = () => {
      void access(readyPath).then(onReady).catch(() => {})
    }
    const onSpawn = () => {
      pollReady()
      pollTimer = setInterval(pollReady, 25)
      timeout = setTimeout(() => { void cancel(new Error(`更新启动器未在 ${handshakeTimeoutMs}ms 内完成就绪握手。`)) }, handshakeTimeoutMs)
    }
    try {
      stderrFd = openSync(stderrPath, 'a')
      try {
        child = (spawnImpl ?? spawn)('cmd.exe', ['/d', '/s', '/c', launcherPath], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', stderrFd] })
      } finally {
        closeStderr()
      }
      if (!child?.once) throw new Error('更新启动器未返回子进程')
      child.once('spawn', onSpawn)
      child.once('error', onError)
      child.once('exit', onExit)
    } catch (error) {
      closeStderr()
      settle(rejectPromise, error)
    }
  })
}
