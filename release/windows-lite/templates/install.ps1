param(
  [switch]$Rollback,
  [switch]$Interactive,
  [string]$InstallRoot = '',
  [string]$ProgressPath = ''
)

# AccrUI-compatible Harness Windows Lite installer and rollback manager.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadZip = Join-Path $scriptDir 'payload.zip'
$defaultInstallRoot = Join-Path $env:LOCALAPPDATA 'accr-ui-harness'
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $installedScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  if ((Split-Path -Leaf $MyInvocation.MyCommand.Path) -eq 'manage-install.ps1' -and
      (Test-Path -LiteralPath (Join-Path $installedScriptRoot 'runtime') -PathType Container)) {
    $InstallRoot = $installedScriptRoot
  } else {
    $InstallRoot = $defaultInstallRoot
  }
}
$installRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$installRootDrive = [System.IO.Path]::GetPathRoot($installRoot)
if ($installRoot.TrimEnd('\') -eq $installRootDrive.TrimEnd('\')) { throw '安装位置不能是磁盘根目录。' }
$rollbackRoot = Join-Path $installRoot 'rollback'
$managedNames = @('extension', 'runtime', 'release.json')
$swappableManagedNames = @('runtime', 'release.json')
$installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
$nativeHostNames = @('com.accrui.harness.chrome')
$legacyAccrUiNativeHostNames = @('com.deepseek.harness.chrome')
$deprecatedNativeHostNames = @('com.chromemcp.nativehost')
$nativeHostRegistryRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
$script:suspendedNativeHostRegistrations = @()
$script:nativeHostRegistrationSuspended = $false
$script:preparedCandidateRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Write-InstallProgress([int]$Percent, [string]$State, [string]$Detail = '') {
  if ([string]::IsNullOrWhiteSpace($ProgressPath)) { return }
  $safeDetail = $Detail.Replace("`r", ' ').Replace("`n", ' ')
  [System.IO.File]::WriteAllText(
    $ProgressPath,
    ($Percent.ToString() + '|' + $State + '|' + $safeDetail),
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Get-AccrUiLegacyNativeHostRegistrations([string[]]$Names = $legacyAccrUiNativeHostNames) {
  $matches = @()
  $expectedLauncher = (Join-Path $installRoot 'runtime\run_native_host.bat')
  foreach ($registryRoot in $nativeHostRegistryRoots) {
    foreach ($nativeHostName in $Names) {
      $key = Join-Path $registryRoot $nativeHostName
      if (-not (Test-Path -LiteralPath $key)) { continue }
      $manifestPath = (Get-Item -LiteralPath $key).GetValue('')
      if ([string]::IsNullOrWhiteSpace($manifestPath) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
      try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { continue }
      if ($manifest.name -eq $nativeHostName -and $manifest.path -eq $expectedLauncher) {
        $matches += [pscustomobject]@{ Path = $key; Value = $manifestPath }
      }
    }
  }
  return $matches
}

function Suspend-NativeHostRegistration {
  if ($script:nativeHostRegistrationSuspended) { return }
  foreach ($registryRoot in $nativeHostRegistryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $key = Join-Path $registryRoot $nativeHostName
      if (-not (Test-Path -LiteralPath $key)) { continue }
      $script:suspendedNativeHostRegistrations += [pscustomobject]@{
        Path = $key
        Value = (Get-Item -LiteralPath $key).GetValue('')
      }
      $script:nativeHostRegistrationSuspended = $true
      Remove-Item -LiteralPath $key -Recurse -Force
    }
  }
  foreach ($registration in @(Get-AccrUiLegacyNativeHostRegistrations)) {
    $script:suspendedNativeHostRegistrations += $registration
    $script:nativeHostRegistrationSuspended = $true
    Remove-Item -LiteralPath $registration.Path -Recurse -Force
  }
  foreach ($registration in @(Get-AccrUiLegacyNativeHostRegistrations $deprecatedNativeHostNames)) {
    $script:suspendedNativeHostRegistrations += $registration
    $script:nativeHostRegistrationSuspended = $true
    Remove-Item -LiteralPath $registration.Path -Recurse -Force
  }
  Write-Host '已暂停 Chrome 和 Edge 自动重启旧 Harness UI。'
}

function Suspend-NewNativeHostRegistration {
  # The old registrations are already captured by Suspend-NativeHostRegistration.
  # A partially completed candidate registration must be removed without replacing
  # that saved state, otherwise Chrome or Edge can respawn the candidate while
  # rollback is trying to release its runtime files.
  foreach ($registryRoot in $nativeHostRegistryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $key = Join-Path $registryRoot $nativeHostName
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop }
    }
  }
  foreach ($registration in @(Get-AccrUiLegacyNativeHostRegistrations)) {
    Remove-Item -LiteralPath $registration.Path -Recurse -Force -ErrorAction Stop
  }
  Write-Host '已暂停部分注册的新 Harness UI。'
}

function Restore-SuspendedNativeHostRegistration {
  if (-not $script:nativeHostRegistrationSuspended) { return }
  foreach ($registration in $script:suspendedNativeHostRegistrations) {
    New-Item -Path $registration.Path -Force | Out-Null
    Set-Item -Path $registration.Path -Value $registration.Value
  }
  $script:suspendedNativeHostRegistrations = @()
  $script:nativeHostRegistrationSuspended = $false
}

function Complete-NativeHostRegistrationTransition {
  $script:suspendedNativeHostRegistrations = @()
  $script:nativeHostRegistrationSuspended = $false
}

trap {
  $errorText = ($_ | Out-String).Trim()
  try {
    Restore-SuspendedNativeHostRegistration
  } catch {
    $errorText += "`n恢复 Native Messaging 注册失败：$($_.Exception.Message)"
  }
  $message = "Harness UI 安装失败：$errorText"
  [System.IO.File]::WriteAllText($installLog, $message + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  Write-InstallProgress 0 'error' $errorText
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  Write-Host "错误日志：$installLog" -ForegroundColor Yellow
  if ($Interactive) { Read-Host '按 Enter 键关闭安装窗口' | Out-Null }
  exit 1
}

function Get-ManifestExtensionResourcePaths([object]$Manifest) {
  $paths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  if ($null -ne $Manifest.background -and -not [string]::IsNullOrWhiteSpace($Manifest.background.service_worker)) {
    [void]$paths.Add($Manifest.background.service_worker)
  }
  if ($null -ne $Manifest.side_panel -and -not [string]::IsNullOrWhiteSpace($Manifest.side_panel.default_path)) {
    [void]$paths.Add($Manifest.side_panel.default_path)
  }
  foreach ($contentScript in @($Manifest.content_scripts)) {
    foreach ($path in @($contentScript.js) + @($contentScript.css)) {
      if (-not [string]::IsNullOrWhiteSpace($path)) { [void]$paths.Add($path) }
    }
  }
  foreach ($webResource in @($Manifest.web_accessible_resources)) {
    foreach ($path in @($webResource.resources)) {
      if (-not [string]::IsNullOrWhiteSpace($path)) { [void]$paths.Add($path) }
    }
  }
  return @($paths)
}

function Assert-ReleaseTree([string]$Root) {
  $extensionManifest = Join-Path $Root 'extension\manifest.json'
  $cli = Join-Path $Root 'runtime\harness\apps\cli\lib\server.mjs'
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) { throw "安装内容不完整：缺少 $extensionManifest" }
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "安装内容不完整：缺少 $cli" }
  if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) { throw "安装内容不完整：缺少 $registerScript" }
  $manifest = Get-Content -LiteralPath $extensionManifest -Raw | ConvertFrom-Json
  foreach ($relativePath in @(Get-ManifestExtensionResourcePaths $manifest)) {
    $resourcePath = Join-Path $Root ('extension\' + $relativePath)
    if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) { throw "安装内容不完整：扩展清单引用的资源缺失 $resourcePath" }
  }
  return $manifest
}

function Get-InstalledProductProcesses([string]$Root) {
  $runtimeRoot = (Join-Path ([System.IO.Path]::GetFullPath($Root)) 'runtime').TrimEnd('\') + '\'
  $allowedNames = @('node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe')
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    $processes = @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue)
  }
  return @($processes | Where-Object {
    $commandLineReferencesRuntime = -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
      $_.CommandLine.IndexOf($runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $executableIsInRuntime = -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      $_.ExecutablePath.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)
    $_.ProcessId -ne $PID -and
    (($allowedNames -contains $_.Name.ToLowerInvariant() -and $commandLineReferencesRuntime) -or $executableIsInRuntime)
  })
}

function Stop-InstalledProductProcess([int]$processId) {
  if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
  try {
    Start-Process -FilePath taskkill.exe -ArgumentList @('/PID', $processId, '/T') -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop | Out-Null
  } catch {
    # The process may exit between enumeration and the graceful taskkill request.
  }
  $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(2)
  while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $gracefulDeadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
  try {
    Start-Process -FilePath taskkill.exe -ArgumentList @('/PID', $processId, '/T', '/F') -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop | Out-Null
  } catch {
    # A process can disappear after enumeration. The liveness check below decides whether that is benign.
  }
  if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

function Stop-InstalledProductProcesses([string]$Root) {
  # Chrome can race the registration removal by starting one last Native Host
  # after our first process snapshot. Drain every newly observed process and
  # require a short quiet window before moving the runtime directory.
  $stoppedIds = [System.Collections.Generic.HashSet[int]]::new()
  $quietPasses = 0
  $remaining = @()
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $processes = @(Get-InstalledProductProcesses $Root)
    if ($processes.Count -eq 0) {
      $quietPasses += 1
      if ($quietPasses -ge 3) { break }
      Start-Sleep -Milliseconds 200
      continue
    }
    $quietPasses = 0
    $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
    $roots = @($processes | Where-Object { $ids -notcontains [int]$_.ParentProcessId })
    foreach ($process in $roots) {
      [void]$stoppedIds.Add([int]$process.ProcessId)
      Stop-InstalledProductProcess $process.ProcessId
    }
    foreach ($processId in $ids) {
      [void]$stoppedIds.Add([int]$processId)
      Stop-InstalledProductProcess $processId
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  $remaining = @(Get-InstalledProductProcesses $Root)
  if ($remaining.Count -gt 0) {
    $details = ($remaining | ForEach-Object { "$($_.Name) PID=$($_.ProcessId)" }) -join ', '
    throw "无法停止正在使用旧 Harness UI 文件的进程：$details。请关闭 Harness UI 侧边栏后重试。"
  }
  if ($stoppedIds.Count -gt 0) { Write-Host "已停止 $($stoppedIds.Count) 个旧 Harness UI 进程。" }
}

function New-ExtensionInUseError([string]$ExtensionPath, [object]$Cause) {
  $causeText = if ($null -eq $Cause) { '未知系统错误。' } else { $Cause.Exception.Message }
  return [System.IO.IOException]::new(
    "无法替换扩展目录：$ExtensionPath。Chrome 或 Edge 正在加载这个 unpacked 扩展。请在 chrome://extensions 或 edge://extensions 中暂时停用从此目录加载的 ACCRUI 扩展，然后重新运行安装；无需关闭整个浏览器。旧版本未被替换，仍可继续使用。原始系统错误：$causeText",
    $Cause.Exception
  )
}

function Move-ManagedPathWithRetry([string]$SourcePath, [string]$DestinationPath, [string]$ExtensionLockMessage = '') {
  $lastError = $null
  foreach ($delayMs in @(0, 200, 400, 800, 1200, 2000)) {
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    try {
      if (Test-Path -LiteralPath $DestinationPath) { Remove-Item -LiteralPath $DestinationPath -Recurse -Force -ErrorAction Stop }
      Move-Item -LiteralPath $SourcePath -Destination $DestinationPath -ErrorAction Stop
      return
    } catch {
      $lastError = $_
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($ExtensionLockMessage)) {
    throw (New-ExtensionInUseError $SourcePath $lastError)
  }
  throw $lastError
}

function Remove-ManagedPathWithRetry([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $lastError = $null
  foreach ($delayMs in @(0, 200, 400, 800, 1200, 2000)) {
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      $lastError = $_
    }
  }
  throw $lastError
}

function Move-ManagedTree([string]$Source, [string]$Destination, [switch]$ExplainLockedExtension, [string[]]$Names = $managedNames, [System.Collections.Generic.List[string]]$MovedNames = $null) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in $Names) {
    $sourcePath = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
    $destinationPath = Join-Path $Destination $name
    $extensionLockMessage = if ($ExplainLockedExtension -and $name -eq 'extension') { 'extension lock' } else { '' }
    Move-ManagedPathWithRetry $sourcePath $destinationPath $extensionLockMessage
    if ($null -ne $MovedNames) { [void]$MovedNames.Add($name) }
  }
}

function Copy-ExtensionTree([string]$SourceRoot, [string]$DestinationRoot, [switch]$ExplainLockedExtension) {
  $source = Join-Path $SourceRoot 'extension'
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { return }
  $destination = Join-Path $DestinationRoot 'extension'
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  try {
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force -ErrorAction Stop
  } catch {
    if ($ExplainLockedExtension) { throw (New-ExtensionInUseError $source $_) }
    throw
  }
}

function Copy-ExtensionFileAtomically([System.IO.FileInfo]$Source, [string]$Destination) {
  $destinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  $temporary = Join-Path $destinationDirectory ('.accrui-extension-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $replacementBackup = Join-Path $destinationDirectory ('.accrui-extension-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    Copy-Item -LiteralPath $Source.FullName -Destination $temporary -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
      [System.IO.File]::Replace($temporary, $Destination, $replacementBackup)
    } else {
      [System.IO.File]::Move($temporary, $Destination)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $replacementBackup -PathType Leaf) { Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue }
  }
}

function Install-ExtensionTree([string]$Source, [string]$Destination) {
  $sourceDirectory = Get-Item -LiteralPath $Source
  $manifestPath = Join-Path $sourceDirectory.FullName 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "安装内容不完整：缺少 $manifestPath" }
  $manifestFile = Get-Item -LiteralPath $manifestPath
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $destinationDirectory = Get-Item -LiteralPath $Destination
  $sourcePrefix = $sourceDirectory.FullName.TrimEnd('\') + '\'
  $destinationPrefix = $destinationDirectory.FullName.TrimEnd('\') + '\'
  $sourceFiles = @(Get-ChildItem -LiteralPath $sourceDirectory.FullName -Recurse -File | Sort-Object FullName)
  $expected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $sourceFiles) {
    $relativePath = $file.FullName.Substring($sourcePrefix.Length)
    [void]$expected.Add($relativePath)
    if ($relativePath -ieq 'manifest.json') { continue }
    Copy-ExtensionFileAtomically $file (Join-Path $destinationDirectory.FullName $relativePath)
  }
  # Once all resources are in place, make the candidate manifest visible. Stale
  # files may survive an interruption, but they cannot break either manifest.
  Copy-ExtensionFileAtomically $manifestFile (Join-Path $Destination 'manifest.json')
  foreach ($file in @(Get-ChildItem -LiteralPath $destinationDirectory.FullName -Recurse -File)) {
    $relativePath = $file.FullName.Substring($destinationPrefix.Length)
    if (-not $expected.Contains($relativePath)) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop }
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $Destination -Recurse -Directory | Sort-Object FullName -Descending)) {
    if ((Get-ChildItem -LiteralPath $directory.FullName -Force | Measure-Object).Count -eq 0) { Remove-Item -LiteralPath $directory.FullName -Force -ErrorAction Stop }
  }
}

function Test-SupportsPreparedNativeHostRegistration([string]$Root) {
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) { return $false }
  $source = Get-Content -LiteralPath $registerScript -Raw
  return $source.Contains('[switch]$PrepareOnly') -and $source.Contains('[switch]$PublishOnly')
}

function Assert-CandidateReleaseTree([string]$Root) {
  Assert-ReleaseTree $Root | Out-Null
  $smokeScript = Join-Path $Root 'runtime\native-message-smoke.mjs'
  if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) { throw "候选版本安装内容不完整：缺少 $smokeScript" }
  if (-not (Test-SupportsPreparedNativeHostRegistration $Root)) { throw "候选版本不支持安全 Native Host 注册协议：$Root" }
}

function Prepare-ReleaseTree([string]$Root) {
  Assert-CandidateReleaseTree $Root
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  & $registerScript -InstallRoot $Root -PrepareOnly
  Assert-NativeHostStartup $Root
  [void]$script:preparedCandidateRoots.Add(([System.IO.Path]::GetFullPath($Root)).TrimEnd('\'))
}

function Assert-NativeHostStartup([string]$Root) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw '未检测到 Node.js；无法执行 Native Host 启动检查。' }
  $nodePath = [System.IO.Path]::GetFullPath($node.Source)
  $smokeScript = Join-Path $Root 'runtime\native-message-smoke.mjs'
  $launcher = Join-Path $Root 'runtime\run_native_host.bat'
  if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) { throw "缺少 Native Host 启动检查脚本：$smokeScript" }
  & $nodePath $smokeScript --launcher $launcher
  if ($LASTEXITCODE -ne 0) { throw "Native Host 启动检查失败：$Root。新版尚未发布 Native Messaging 注册。" }
}

function Assert-NativeHostRegistrationReadback([string]$Root) {
  $launcher = Join-Path $Root 'runtime\run_native_host.bat'
  $manifestRoot = Join-Path $Root 'native-messaging'
  $registeredHostNames = @($nativeHostNames + $legacyAccrUiNativeHostNames)
  foreach ($registryRoot in $nativeHostRegistryRoots) {
    foreach ($nativeHostName in $registeredHostNames) {
      $registryKey = Join-Path $registryRoot $nativeHostName
      if (-not (Test-Path -LiteralPath $registryKey)) { throw "Native Messaging 注册缺失：$registryKey" }
      $actualManifestPath = (Get-Item -LiteralPath $registryKey).GetValue('')
      $expectedManifestPath = Join-Path $manifestRoot ($nativeHostName + '.json')
      if ([string]::IsNullOrWhiteSpace($actualManifestPath) -or
          [System.IO.Path]::GetFullPath($actualManifestPath) -ne [System.IO.Path]::GetFullPath($expectedManifestPath)) {
        throw "Native Messaging 注册路径不正确：$registryKey"
      }
      if (-not (Test-Path -LiteralPath $actualManifestPath -PathType Leaf)) { throw "Native Messaging manifest 缺失：$actualManifestPath" }
      $manifest = Get-Content -LiteralPath $actualManifestPath -Raw | ConvertFrom-Json
      if ($manifest.name -ne $nativeHostName -or $manifest.path -ne $launcher) { throw "Native Messaging manifest 内容不正确：$actualManifestPath" }
    }
  }
}

function Migrate-AccrUiRoamingProfile([string]$Root) {
  $legacyProfile = Join-Path $env:APPDATA 'accr-ui-harness\profile'
  $profile = Join-Path $Root 'profile'
  if (-not (Test-Path -LiteralPath $legacyProfile -PathType Container)) { return }
  if (-not (Test-Path -LiteralPath $profile)) {
    Copy-Item -LiteralPath $legacyProfile -Destination $profile -Recurse -Force -ErrorAction Stop
    Write-Host '已复制旧版 ACCRUI 设置到本安装目录的 profile。'
    return
  }

  # A prior launch or interrupted upgrade may already have created the new
  # profile. Merge only paths that are still absent so user-installed plugins
  # survive without rolling current settings back to legacy values.
  $legacyPrefix = ([System.IO.Path]::GetFullPath($legacyProfile)).TrimEnd('\') + '\'
  $copied = 0
  foreach ($directory in @(Get-ChildItem -LiteralPath $legacyProfile -Recurse -Directory -Force)) {
    $relativePath = $directory.FullName.Substring($legacyPrefix.Length)
    $destinationPath = Join-Path $profile $relativePath
    if (-not (Test-Path -LiteralPath $destinationPath)) {
      New-Item -ItemType Directory -Path $destinationPath -Force -ErrorAction Stop | Out-Null
    }
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $legacyProfile -Recurse -File -Force)) {
    $relativePath = $file.FullName.Substring($legacyPrefix.Length)
    $destinationPath = Join-Path $profile $relativePath
    if (-not (Test-Path -LiteralPath $destinationPath)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force -ErrorAction Stop | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destinationPath -Force -ErrorAction Stop
      $copied += 1
    }
  }
  if ($copied -gt 0) {
    Write-Host "已合并 $copied 个旧版 ACCRUI profile 文件，现有设置保持不变。"
  }
}

function Register-ReleaseTree([string]$Root) {
  $normalizedRoot = ([System.IO.Path]::GetFullPath($Root)).TrimEnd('\')
  if (-not $script:preparedCandidateRoots.Contains($normalizedRoot)) { throw "拒绝发布未完成 Native Host 启动检查的候选版本：$Root" }
  Migrate-AccrUiRoamingProfile $Root
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  & $registerScript -InstallRoot $Root -PublishOnly
  Assert-NativeHostRegistrationReadback $Root
  [void]$script:preparedCandidateRoots.Remove($normalizedRoot)
}

function Restore-NativeHostRegistration([string]$Root) {
  Assert-ReleaseTree $Root | Out-Null
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  if (Test-SupportsPreparedNativeHostRegistration $Root) {
    Prepare-ReleaseTree $Root
    Register-ReleaseTree $Root
    return
  }
  # Pre-protocol releases cannot provide a smoke script or mode switches. This
  # path is only for restoring the already-known previous release or -Rollback.
  & $registerScript -InstallRoot $Root
}

function Write-ProductState([string]$Root) {
  $manifest = Assert-ReleaseTree $Root
  New-Item -Path 'HKCU:\Software\accr-ui\Lite' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\accr-ui\Lite' -Name InstallDir -Value $Root
  Set-ItemProperty -Path 'HKCU:\Software\accr-ui\Lite' -Name Product -Value 'Harness UI'
  Set-ItemProperty -Path 'HKCU:\Software\accr-ui\Lite' -Name Version -Value $manifest.version
}

function Restore-Rollback {
  Assert-ReleaseTree $rollbackRoot | Out-Null
  $swapRoot = Join-Path $env:TEMP ('accr-ui-harness-rollback-' + [guid]::NewGuid().ToString('N'))
  $installedToSwap = [System.Collections.Generic.List[string]]::new()
  $preserveSwapRoot = $false
  New-Item -ItemType Directory -Path $swapRoot -Force | Out-Null
  try {
    Copy-ExtensionTree $installRoot $swapRoot
    Move-ManagedTree $installRoot $swapRoot -Names $swappableManagedNames -MovedNames $installedToSwap
    Move-ManagedTree $rollbackRoot $installRoot -Names $swappableManagedNames
    Install-ExtensionTree (Join-Path $rollbackRoot 'extension') (Join-Path $installRoot 'extension')
    Write-ProductState $installRoot
    Restore-NativeHostRegistration $installRoot
    Copy-ExtensionTree $swapRoot $rollbackRoot
    Move-ManagedTree $swapRoot $rollbackRoot -Names $swappableManagedNames
    Complete-NativeHostRegistrationTransition
    Write-Host 'Harness UI 已回滚；再次运行 -Rollback 可切换回刚才的版本。'
  } catch {
    $rollbackError = $_
    try {
      Suspend-NewNativeHostRegistration
      Stop-InstalledProductProcesses $installRoot
      foreach ($name in $installedToSwap) {
        $swapPath = Join-Path $swapRoot $name
        $rollbackPath = Join-Path $rollbackRoot $name
        $restoreSource = if (Test-Path -LiteralPath $swapPath) { $swapPath } elseif (Test-Path -LiteralPath $rollbackPath) { $rollbackPath } else { throw "无法找到原版本 $name 的安全备份" }
        Move-ManagedPathWithRetry $restoreSource (Join-Path $installRoot $name)
      }
      if (Test-Path -LiteralPath (Join-Path $swapRoot 'extension\manifest.json') -PathType Leaf) {
        Install-ExtensionTree (Join-Path $swapRoot 'extension') (Join-Path $installRoot 'extension')
      }
      Write-ProductState $installRoot
      Restore-NativeHostRegistration $installRoot
      Complete-NativeHostRegistrationTransition
    } catch {
      $preserveSwapRoot = $true
      throw "回滚失败且无法恢复原版本；安全备份保留在 $swapRoot。原始错误：$($rollbackError.Exception.Message)。恢复错误：$($_.Exception.Message)"
    }
    throw $rollbackError
  } finally {
    if (-not $preserveSwapRoot -and (Test-Path -LiteralPath $swapRoot)) { Remove-Item -LiteralPath $swapRoot -Recurse -Force }
  }
}

if ($Rollback) {
  Write-InstallProgress 10 'rollback' '正在回滚到上一版本...'
  Suspend-NativeHostRegistration
  Stop-InstalledProductProcesses $installRoot
  Restore-Rollback
  Write-InstallProgress 100 'complete' '回滚完成。'
  exit 0
}

if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) { throw '缺少 payload.zip 安装包。' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未检测到 Node.js；Harness UI 需要 Node.js 22.19.x 或 24+。' }
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node.js 路径无效：$nodePath" }
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)' -or -not (([int]$Matches.major -eq 22 -and [int]$Matches.minor -ge 19) -or [int]$Matches.major -ge 24)) { throw "Node.js $nodeVersion 不受支持；Harness UI 需要 Node.js 22.19.x 或 24+。" }
Write-InstallProgress 8 'preparing' "已检测到 Node.js $nodeVersion。"

$stagingRoot = Join-Path $env:TEMP ('accr-ui-harness-stage-' + [guid]::NewGuid().ToString('N'))
$previousRoot = Join-Path $env:TEMP ('accr-ui-harness-previous-' + [guid]::NewGuid().ToString('N'))
$preservePreviousRoot = $false
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path $previousRoot -Force | Out-Null
try {
  # Do this before extraction: a running old Host can otherwise be restarted
  # by Chrome/Edge while the candidate is being unpacked.
  Suspend-NativeHostRegistration
  Write-InstallProgress 15 'extracting' '正在解压安装包...'
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $stagingRoot -Force
  Assert-ReleaseTree $stagingRoot | Out-Null
  Write-InstallProgress 65 'configuring' '正在保存现有版本并安装新版本...'
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Stop-InstalledProductProcesses $installRoot
  # Preserve user-owned workspace, logs, .webmcp, and the last rollback tree.
  Copy-ExtensionTree $installRoot $previousRoot -ExplainLockedExtension
  try {
    Move-ManagedTree $installRoot $previousRoot -Names $swappableManagedNames
    Move-ManagedTree $stagingRoot $installRoot -Names $swappableManagedNames
    Install-ExtensionTree (Join-Path $stagingRoot 'extension') (Join-Path $installRoot 'extension')
    foreach ($name in @('workspace', 'logs', '.webmcp', 'guide-state.json')) {
      $sourcePath = Join-Path $stagingRoot $name
      $destinationPath = Join-Path $installRoot $name
      if ((Test-Path -LiteralPath $sourcePath) -and -not (Test-Path -LiteralPath $destinationPath)) {
        Move-Item -LiteralPath $sourcePath -Destination $destinationPath
      }
    }
    # Do every validation and local state write that cannot wake the browser
    # before publishing the Native Messaging registrations.
    Write-ProductState $installRoot
    Prepare-ReleaseTree $installRoot
    Write-InstallProgress 90 'registering' '正在注册 Chrome 和 Edge Native Messaging...'
    Register-ReleaseTree $installRoot
    Complete-NativeHostRegistrationTransition
  } catch {
    $upgradeError = $_
    $recoveryErrors = [System.Collections.Generic.List[string]]::new()
    try {
      # Register-ReleaseTree may have created one registry key before failing.
      # Remove that candidate registration and stop the candidate process before
      # touching runtime, otherwise it can lock the directory during rollback.
      Suspend-NewNativeHostRegistration
      Stop-InstalledProductProcesses $installRoot
      foreach ($name in $swappableManagedNames) {
        $failedPath = Join-Path $installRoot $name
        Remove-ManagedPathWithRetry $failedPath
      }
      Move-ManagedTree $previousRoot $installRoot -Names $swappableManagedNames
      if (Test-Path -LiteralPath (Join-Path $previousRoot 'extension\manifest.json') -PathType Leaf) {
        Install-ExtensionTree (Join-Path $previousRoot 'extension') (Join-Path $installRoot 'extension')
      }
      if (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\register-native-host.ps1')) {
        Write-ProductState $installRoot
        Restore-NativeHostRegistration $installRoot
        Complete-NativeHostRegistrationTransition
      }
    } catch {
      [void]$recoveryErrors.Add($_.Exception.Message)
    }
    if ($recoveryErrors.Count -gt 0) {
      $preservePreviousRoot = $true
      throw "新版本安装失败。原始错误：$($upgradeError.Exception.Message)。恢复错误：$($recoveryErrors -join '；')。旧版本安全备份保留在 $previousRoot。"
    }
    throw $upgradeError
  }
  if ((Get-ChildItem -LiteralPath $previousRoot -Force | Measure-Object).Count -gt 0) {
    if (Test-Path -LiteralPath $rollbackRoot) { Remove-Item -LiteralPath $rollbackRoot -Recurse -Force }
    Move-Item -LiteralPath $previousRoot -Destination $rollbackRoot
  }
  Copy-Item -LiteralPath $MyInvocation.MyCommand.Path -Destination (Join-Path $installRoot 'manage-install.ps1') -Force
  Write-InstallProgress 100 'complete' "安装完成：$installRoot"
  Write-Host 'Harness UI 已安装。请在 chrome://extensions 或 edge://extensions 重新加载 AccrUI 扩展。'
} finally {
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $preservePreviousRoot -and (Test-Path -LiteralPath $previousRoot)) { Remove-Item -LiteralPath $previousRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
