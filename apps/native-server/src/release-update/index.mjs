import { access, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fetchRelease, resolveReleaseSource } from './release-source.mjs'
import { compareVersion, extractZip, verifyWindowsLitePackage } from './package-verifier.mjs'

function updateIdentity(source) {
  if (typeof source.expectedVersion !== 'string') return undefined
  return Object.freeze({ version: source.expectedVersion, sha256: source.expectedSha256, packageUrl: source.packageUrl })
}

function sameUpdateIdentity(left, right) {
  return left?.version === right?.version && left?.sha256 === right?.sha256 && left?.packageUrl === right?.packageUrl
}

export async function checkUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const identity = updateIdentity(source)
  if (identity !== undefined) {
    const available = options.currentVersion === undefined || compareVersion(identity.version, options.currentVersion) > 0
    return { available, ...identity, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }) }
  }
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl, options)
  try {
    const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256, expectedVersion: source.expectedVersion })
    return { available: true, ...verified, packageUrl: source.packageUrl, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }), ...(etag === undefined ? {} : { etag }) }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('未高于当前版本')) throw error
    const verified = verifyWindowsLitePackage(bytes, { expectedSha256: source.expectedSha256, expectedVersion: source.expectedVersion })
    return { available: false, ...verified, packageUrl: source.packageUrl, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }), ...(etag === undefined ? {} : { etag }) }
  }
}

export async function prepareUpdate(options = {}) {
  const source = await resolveReleaseSource(options)
  const identity = updateIdentity(source)
  if (options.candidate !== undefined && identity !== undefined && !sameUpdateIdentity(identity, options.candidate)) throw new Error('更新候选已变化；请重新检查更新后再安装')
  if (options.candidate !== undefined && identity === undefined && (source.expectedSha256 !== options.candidate.sha256 || source.packageUrl !== options.candidate.packageUrl)) throw new Error('更新候选已变化；请重新检查更新后再安装')
  const { bytes, etag } = await fetchRelease(source, options.fetchImpl, options)
  const verified = verifyWindowsLitePackage(bytes, { currentVersion: options.currentVersion, expectedSha256: source.expectedSha256, expectedVersion: source.expectedVersion })
  if (options.candidate !== undefined && !sameUpdateIdentity({ version: verified.version, sha256: verified.sha256, packageUrl: source.packageUrl }, options.candidate)) throw new Error('下载的更新包与已检查候选不一致；已拒绝安装')
  const root = await mkdtemp(join(tmpdir(), 'accrui-release-update-'))
  const packagePath = join(root, 'accr-ui-windows-lite-x64.zip')
  await writeFile(packagePath, bytes)
  const extractRoot = join(root, 'package')
  await extractZip(bytes, extractRoot, { stripCommonRoot: true })
  return { ...verified, packagePath, extractRoot, packageUrl: source.packageUrl, ...(source.releaseUrl === undefined ? {} : { releaseUrl: source.releaseUrl }), ...(etag === undefined ? {} : { etag }) }
}

export async function launchPreparedUpdate(prepared, { installRoot, nativePid, spawnImpl, platform = process.platform, handshakeTimeoutMs: requestedHandshakeTimeoutMs, writeFileImpl = writeFile, renameImpl = rename, signal, onCommitted } = {}) {
  if (platform !== 'win32') throw new Error('在线更新仅支持 Windows Lite')
  if (!prepared?.extractRoot || !prepared?.version || !installRoot || !Number.isInteger(nativePid)) throw new Error('更新启动参数无效')
  if (signal?.aborted) throw signal.reason ?? new Error('在线更新请求已取消')
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
$progressPath = Join-Path $installRoot '.accrui-update-progress.txt'
$installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
$readyPath = '${escapePowerShell(readyPath)}'
$goPath = '${escapePowerShell(goPath)}'
$cancelPath = '${escapePowerShell(cancelPath)}'
$errorPath = '${escapePowerShell(errorPath)}'
$mutex = $null
$mutexHeld = $false
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
  $mutexHasher = [System.Security.Cryptography.SHA256]::Create()
  try { $mutexHash = $mutexHasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($installRoot.ToLowerInvariant())) } finally { $mutexHasher.Dispose() }
  $mutexName = 'Local\\AccrUIReleaseUpdate-' + ([System.BitConverter]::ToString($mutexHash).Replace('-', ''))
  $mutex = [System.Threading.Mutex]::new($false, $mutexName)
  if (-not $mutex.WaitOne(0)) { throw '另一个在线更新正在安装此目录；本次请求未接管 Native Host。' }
  $mutexHeld = $true
  Remove-Item -LiteralPath $progressPath -Force -ErrorAction SilentlyContinue
  Write-UpdateStatus 'pending'
  [System.IO.File]::WriteAllText($readyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  $handoffDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $goPath -PathType Leaf) -and -not (Test-Path -LiteralPath $cancelPath -PathType Leaf) -and [DateTime]::UtcNow -lt $handoffDeadline) { Start-Sleep -Milliseconds 50 }
  if (Test-Path -LiteralPath $cancelPath -PathType Leaf) { throw 'Native Host 未确认更新交接，安装已取消。' }
  if (-not (Test-Path -LiteralPath $goPath -PathType Leaf)) { throw 'Native Host 未在时限内确认更新交接，安装已取消。' }
  $nativeDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id ${nativePid} -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $nativeDeadline) { Start-Sleep -Milliseconds 200 }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${escapedScript}' -InstallRoot $installRoot -ProgressPath $progressPath
  if ($LASTEXITCODE -ne 0) { throw "安装程序退出码：$LASTEXITCODE" }
  Write-UpdateStatus 'succeeded'
} catch {
  $safeError = Get-SafeUpdateError $_
  try { [System.IO.File]::WriteAllText($errorPath, $safeError, [System.Text.UTF8Encoding]::new($false)) } catch {}
  if ($mutexHeld) { Write-UpdateStatus 'failed' $safeError }
  exit 1
} finally {
  if ($mutexHeld) { try { $mutex.ReleaseMutex() } catch {} }
  if ($null -ne $mutex) { $mutex.Dispose() }
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
    let onAbort
    let handoffDecision = 'pending'
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
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const cancel = async (error, { force = false } = {}) => {
      if (settled || (handoffDecision === 'go' && !force)) return
      handoffDecision = 'cancel'
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      child?.removeListener?.('spawn', onSpawn)
      child?.removeListener?.('error', onError)
      child?.removeListener?.('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
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
      if (settled || committing || handoffDecision !== 'pending') return
      committing = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      try {
        child?.unref?.()
        await writeFileImpl(goPendingPath, 'go', 'utf8')
        if (settled || handoffDecision !== 'pending') return
        handoffDecision = 'go'
        await renameImpl(goPendingPath, goPath)
        onCommitted?.()
        settle(resolvePromise, true)
      } catch (error) {
        if (!settled) await cancel(error, { force: true })
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
      onAbort = () => { void cancel(signal.reason ?? new Error('在线更新请求已取消')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { void cancel(signal.reason ?? new Error('在线更新请求已取消')); return }
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
