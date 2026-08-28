param(
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath($PackageDir)
$installer = Join-Path $packageRoot 'install.ps1'
$installerUi = Join-Path $packageRoot 'install-ui.ps1'
$installLauncher = Join-Path $packageRoot 'install.vbs'
$payloadZip = Join-Path $packageRoot 'payload.zip'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing installer: $installer" }
if (-not (Test-Path -LiteralPath $installerUi -PathType Leaf)) { throw "Missing installer UI: $installerUi" }
if (-not (Test-Path -LiteralPath $installLauncher -PathType Leaf)) { throw "Missing VBS installer: $installLauncher" }
if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) { throw "Missing payload: $payloadZip" }

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$acceptanceRoot = Join-Path $env:RUNNER_TEMP 'accrui-harness-windows-acceptance'
$env:LOCALAPPDATA = Join-Path $acceptanceRoot 'localappdata'
$installRoot = Join-Path $env:LOCALAPPDATA 'accr-ui-harness'
$seedRoot = Join-Path $acceptanceRoot 'previous-release'
$productKey = 'HKCU:\Software\accr-ui\Lite'
$nativeHostNames = @('com.deepseek.harness.chrome', 'com.chromemcp.nativehost')
$registryRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)

function Read-Version([string]$Root) {
  return (Get-Content -LiteralPath (Join-Path $Root 'extension\manifest.json') -Raw | ConvertFrom-Json).version
}

function Assert-ExtensionResources([string]$Root) {
  $extensionRoot = Join-Path $Root 'extension'
  $manifestPath = Join-Path $extensionRoot 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $resources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  if ($null -ne $manifest.background -and -not [string]::IsNullOrWhiteSpace($manifest.background.service_worker)) { [void]$resources.Add($manifest.background.service_worker) }
  if ($null -ne $manifest.side_panel -and -not [string]::IsNullOrWhiteSpace($manifest.side_panel.default_path)) { [void]$resources.Add($manifest.side_panel.default_path) }
  foreach ($contentScript in @($manifest.content_scripts)) {
    foreach ($resource in @($contentScript.js) + @($contentScript.css)) {
      if (-not [string]::IsNullOrWhiteSpace($resource)) { [void]$resources.Add($resource) }
    }
  }
  foreach ($webResource in @($manifest.web_accessible_resources)) {
    foreach ($resource in @($webResource.resources)) {
      if (-not [string]::IsNullOrWhiteSpace($resource)) { [void]$resources.Add($resource) }
    }
  }
  foreach ($resource in @($resources)) {
    $resourcePath = Join-Path $extensionRoot $resource
    if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) { throw "Installed extension resource is missing: $resourcePath" }
  }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message Expected=$Expected Actual=$Actual" }
}

function Convert-SeedToLegacyRelease {
  $runtimeRoot = Join-Path $installRoot 'runtime'
  $smokeScript = Join-Path $runtimeRoot 'native-message-smoke.mjs'
  Remove-Item -LiteralPath $smokeScript -Force -ErrorAction SilentlyContinue
  $legacyRegisterScript = @'
param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$runtimeDir = $PSScriptRoot
$launcher = Join-Path $runtimeDir 'run_native_host.bat'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Missing Node.js.' }
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v?(?<major>\d+)' -or [int]$Matches.major -lt 22) { throw 'Node.js 22+ is required.' }
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $runtimeDir 'node-path.txt'), $nodePath + [Environment]::NewLine, $utf8NoBom)
$manifestDir = Join-Path $InstallRoot 'native-messaging'
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
$registryRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)
foreach ($nativeHostName in @('com.deepseek.harness.chrome', 'com.chromemcp.nativehost')) {
  $templatePath = Join-Path $runtimeDir ($nativeHostName + '.json')
  $manifest = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
  $manifest.path = $launcher
  $installedManifestPath = Join-Path $manifestDir ($nativeHostName + '.json')
  [System.IO.File]::WriteAllText($installedManifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)
  foreach ($registryRoot in $registryRoots) {
    $registryKey = Join-Path $registryRoot $nativeHostName
    New-Item -Path $registryKey -Force | Out-Null
    Set-Item -Path $registryKey -Value $installedManifestPath
  }
}
'@
  [System.IO.File]::WriteAllText((Join-Path $runtimeRoot 'register-native-host.ps1'), $legacyRegisterScript, [System.Text.UTF8Encoding]::new($true))
  if (Test-Path -LiteralPath $smokeScript -PathType Leaf) { throw 'Seed release still contains the new Native Host smoke script.' }
  if ((Get-Content -LiteralPath (Join-Path $runtimeRoot 'register-native-host.ps1') -Raw) -match 'PrepareOnly|PublishOnly') { throw 'Seed release still supports the new Native Host registration protocol.' }
}

function Invoke-NativeMessageSmoke {
  & node (Join-Path $PSScriptRoot 'native-message-smoke.mjs') --launcher (Join-Path $installRoot 'runtime\run_native_host.bat')
  if ($LASTEXITCODE -ne 0) { throw "Native Messaging smoke failed with exit code $LASTEXITCODE." }
}

function Invoke-ProductUiSmoke {
  & node (Join-Path $PSScriptRoot 'product-ui-smoke.mjs') --launcher (Join-Path $installRoot 'runtime\run_native_host.bat')
  if ($LASTEXITCODE -ne 0) { throw "Product UI activation smoke failed with exit code $LASTEXITCODE." }
}

function Invoke-DirectoryPickerSmoke {
  $nodeExecutable = (Get-Content -LiteralPath (Join-Path $installRoot 'runtime\node-path.txt') -Raw).Trim()
  $worker = Join-Path $installRoot 'runtime\harness\apps\cli\lib\directory-picker-worker.cjs'
  & node (Join-Path $PSScriptRoot 'directory-picker-worker-smoke.mjs') --node $nodeExecutable --worker $worker
  if ($LASTEXITCODE -ne 0) { throw "Directory-picker worker smoke failed with exit code $LASTEXITCODE." }
}

function Invoke-WindowsAclRunnerSmoke {
  $nodeExecutable = (Get-Content -LiteralPath (Join-Path $installRoot 'runtime\node-path.txt') -Raw).Trim()
  $runner = Join-Path $installRoot 'runtime\harness\apps\cli\lib\windows-acl-runner.cjs'
  $outside = Join-Path $acceptanceRoot 'acl-outside'
  & node (Join-Path $PSScriptRoot 'acl-runner-smoke.mjs') --node $nodeExecutable --runner $runner --workspace (Join-Path $installRoot 'workspace') --outside $outside
  if ($LASTEXITCODE -ne 0) { throw "Windows ACL runner Pwsh smoke failed with exit code $LASTEXITCODE." }
}

function Invoke-InstallerUiSmoke {
  $probePath = Join-Path $env:RUNNER_TEMP 'accrui-harness-installer-ui-visible.txt'
  Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_INSTALL_NONINTERACTIVE -ErrorAction SilentlyContinue
  $env:DSH_INSTALL_UI_PROBE_PATH = $probePath
  $process = Start-Process -FilePath cscript.exe -ArgumentList @('//NoLogo', ('"' + $installLauncher + '"')) -PassThru
  try {
    if (-not $process.WaitForExit(15000)) { throw 'Interactive installer did not show and close within 15 seconds.' }
    if ($process.ExitCode -ne 0) { throw "Interactive installer exited with code $($process.ExitCode)." }
    if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) { throw 'Interactive installer did not report its window visibility.' }
    Assert-Equal (Get-Content -LiteralPath $probePath -Raw) 'visible' 'Interactive installer window was hidden.'
    Write-Host 'Interactive installer window reported visible.'
  } finally {
    if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    Remove-Item Env:DSH_INSTALL_UI_PROBE_PATH -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
  }
}

function Read-ReleaseUpdateProgress([string]$ProgressPath) {
  if (-not (Test-Path -LiteralPath $ProgressPath -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $ProgressPath -Raw).Trim() } catch { return $null }
}

function Read-ReleaseUpdateInstallLog([string]$InstallLog) {
  if (-not (Test-Path -LiteralPath $InstallLog -PathType Leaf)) { return 'absent' }
  try { return (Get-Content -LiteralPath $InstallLog -Raw).Trim() } catch { return "unreadable: $($_.Exception.Message)" }
}

function Wait-ReleaseUpdateTerminalStatus([string]$StatusPath, [string]$ProgressPath) {
  $deadline = [DateTime]::UtcNow.AddSeconds(300)
  $lastStatus = $null
  $lastProgress = $null
  do {
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
      try { $lastStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $lastStatus = $null }
      if ($null -ne $lastStatus -and ($lastStatus.state -eq 'succeeded' -or $lastStatus.state -eq 'failed')) { return $lastStatus }
    }
    $progress = Read-ReleaseUpdateProgress $ProgressPath
    if ($null -ne $progress -and $progress -ne $lastProgress) {
      $lastProgress = $progress
      Write-Host "Online updater progress: $progress"
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  $lastStatusText = if ($null -eq $lastStatus) { 'absent' } else { $lastStatus | ConvertTo-Json -Compress }
  $lastProgressText = if ($null -eq $lastProgress) { 'absent' } else { $lastProgress }
  $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
  $installLogText = Read-ReleaseUpdateInstallLog $installLog
  if ($installLogText.Length -gt 4096) { $installLogText = $installLogText.Substring(0, 4096) }
  throw "Timed out waiting for the detached online updater status. Last status: $lastStatusText Last progress: $lastProgressText Installer log: $installLogText"
}

function Wait-ReleaseUpdatePendingStatus([string]$StatusPath) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $lastStatus = $null
  $lastReadError = $null
  do {
    if (Test-Path -LiteralPath $StatusPath -PathType Leaf) {
      try {
        $lastStatus = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
        $lastReadError = $null
      } catch {
        $lastReadError = $_.Exception.Message
      }
      if ($null -ne $lastStatus) {
        if ($lastStatus.state -eq 'pending') { return }
        if ($lastStatus.state -eq 'failed') {
          throw "Detached failed-update handoff failed before pending status: $($lastStatus.error)"
        }
        if ($lastStatus.state -eq 'succeeded') {
          throw 'Detached failed-update handoff succeeded before pending status.'
        }
      }
    }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($null -eq $lastStatus -and $null -eq $lastReadError) {
    throw 'Detached failed-update handoff status was absent after 30 seconds.'
  }
  if ($null -ne $lastReadError) {
    throw "Detached failed-update handoff status was unreadable after 30 seconds: $lastReadError"
  }
  throw "Detached failed-update handoff did not persist pending status after 30 seconds; last state=$($lastStatus.state) error=$($lastStatus.error)"
}

function Invoke-ReleaseUpdateHandoff {
  $statusPath = Join-Path $installRoot '.accrui-update-status.json'
  $progressPath = Join-Path $installRoot '.accrui-update-progress.txt'
  $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
  Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $progressPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $installLog -PathType Leaf) { Remove-Item -LiteralPath $installLog -Force -ErrorAction Stop }
  & node (Join-Path $PSScriptRoot 'release-update-handoff-smoke.mjs') --package-dir $packageRoot --install-root $installRoot --expected-version $ExpectedVersion
  if ($LASTEXITCODE -ne 0) { throw "Online update handoff helper failed with exit code $LASTEXITCODE." }
  $status = Wait-ReleaseUpdateTerminalStatus $statusPath $progressPath
  if ($status.state -eq 'succeeded') {
    Write-Host 'Detached online updater completed successfully.'
    return
  }
  $installLogText = Read-ReleaseUpdateInstallLog $installLog
  if ($installLogText -ne 'absent' -and -not [string]::IsNullOrWhiteSpace($installLogText)) {
    Write-Host 'Online updater installer error log:'
    $installLogText | Write-Host
  }
  throw "Detached online updater failed: $($status.error)"
}

function Assert-FailedReleaseUpdateHandoffStatus {
  $fakePackageRoot = Join-Path $acceptanceRoot 'failed-update-package'
  $fakeInstallRoot = Join-Path $acceptanceRoot 'failed-update-install'
  $fakeInstaller = Join-Path $fakePackageRoot 'install.ps1'
  $statusPath = Join-Path $fakeInstallRoot '.accrui-update-status.json'
  $progressPath = Join-Path $fakeInstallRoot '.accrui-update-progress.txt'
  $pendingMarker = Join-Path $fakeInstallRoot 'pending-observed.marker'
  New-Item -ItemType Directory -Path $fakePackageRoot, $fakeInstallRoot -Force | Out-Null
  $fakeInstallerSource = @'
param([string]$InstallRoot, [string]$ProgressPath)
$pendingMarker = Join-Path $InstallRoot 'pending-observed.marker'
if (-not [string]::IsNullOrWhiteSpace($ProgressPath)) { [System.IO.File]::WriteAllText($ProgressPath, '15|fake|waiting for pending observation', [System.Text.UTF8Encoding]::new($false)) }
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while (-not (Test-Path -LiteralPath $pendingMarker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
if (-not (Test-Path -LiteralPath $pendingMarker)) { exit 24 }
exit 23
'@
  [System.IO.File]::WriteAllText($fakeInstaller, $fakeInstallerSource, [System.Text.UTF8Encoding]::new($false))
  & node (Join-Path $PSScriptRoot 'release-update-handoff-smoke.mjs') --package-dir $fakePackageRoot --install-root $fakeInstallRoot --expected-version '0.0.1'
  if ($LASTEXITCODE -ne 0) { throw "Failed-update handoff helper failed with exit code $LASTEXITCODE." }

  Wait-ReleaseUpdatePendingStatus $statusPath
  [System.IO.File]::WriteAllText($pendingMarker, 'observed', [System.Text.UTF8Encoding]::new($false))

  $status = Wait-ReleaseUpdateTerminalStatus $statusPath $progressPath
  if ($status.state -ne 'failed') { throw "Detached failed-update handoff ended in unexpected state: $($status.state)" }
  if ([string]$status.error -notmatch '安装程序退出码：23') { throw "Detached failed-update handoff lost installer exit code: $($status.error)" }
  Write-Host 'Detached failed-update handoff persisted installer exit code 23.'
}

function Start-ExtensionLockHolder {
  $readyPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-extension-lock-ready.txt'
  $lockScriptPath = Join-Path $acceptanceRoot 'extension-lock-holder.ps1'
  $targetPath = Join-Path $installRoot 'extension\manifest.json'
  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
  $lockSource = @'
param([string]$TargetPath, [string]$ReadyPath)
$handle = [System.IO.File]::Open($TargetPath, 'Open', 'Read', 'None')
try {
  [System.IO.File]::WriteAllText($ReadyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 120
} finally {
  $handle.Dispose()
}
'@
  [System.IO.File]::WriteAllText($lockScriptPath, $lockSource, [System.Text.UTF8Encoding]::new($true))
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $lockScriptPath + '"'), '-TargetPath', ('"' + $targetPath + '"'), '-ReadyPath', ('"' + $readyPath + '"'))
  $process = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'Failed to start the unpacked extension lock holder.' }
  return $process
}

function Stop-ExtensionLockHolder([System.Diagnostics.Process]$Process) {
  $Process.Refresh()
  if ($Process.HasExited) { return }
  & taskkill.exe /PID $Process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to terminate unpacked extension lock holder PID=$($Process.Id)." }
  if (-not $Process.WaitForExit(10000)) { throw "Timed out waiting for unpacked extension lock holder PID=$($Process.Id) to release manifest.json." }
  $Process.Refresh()
  if (-not $Process.HasExited) { throw "Unpacked extension lock holder PID=$($Process.Id) did not exit." }
}

function Assert-LockedExtensionUpgradeFailsSafely {
  $lockHolder = Start-ExtensionLockHolder
  try {
    $env:DSH_INSTALL_NONINTERACTIVE = '1'
    & cscript.exe //NoLogo $installLauncher 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) { throw 'Locked unpacked extension upgrade unexpectedly succeeded.' }
    $lockHolder.Refresh()
    if ($lockHolder.HasExited) { throw 'Locked unpacked extension process was terminated by the installer.' }
    Stop-ExtensionLockHolder $lockHolder
    $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
    if (-not (Test-Path -LiteralPath $installLog -PathType Leaf)) { throw 'Locked unpacked extension upgrade did not produce an installer error log.' }
    $errorText = Get-Content -LiteralPath $installLog -Raw
    if ($errorText -notmatch 'Chrome 或 Edge 正在加载这个 unpacked 扩展' -or $errorText -notmatch '无需关闭整个浏览器') {
      throw "Locked unpacked extension upgrade did not explain how to recover: $errorText"
    }
    Assert-Equal (Read-Version $installRoot) '1.1.62' 'Locked unpacked extension upgrade replaced the old version.'
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\harness\apps\cli\lib\server.mjs') -PathType Leaf)) {
      throw 'Locked unpacked extension upgrade did not retain the old runnable runtime.'
    }
    foreach ($registryRoot in $registryRoots) {
      foreach ($nativeHostName in $nativeHostNames) {
        $registryKey = Join-Path $registryRoot $nativeHostName
        if (-not (Test-Path -LiteralPath $registryKey)) { throw "Locked unpacked extension upgrade did not restore Native Messaging registration: $registryKey" }
        $manifestPath = (Get-Item -LiteralPath $registryKey).GetValue('')
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        Assert-Equal $manifest.path (Join-Path $installRoot 'runtime\run_native_host.bat') 'Locked unpacked extension upgrade left Native Messaging pointed away from the old release.'
      }
    }
  } finally {
    try {
      Stop-ExtensionLockHolder $lockHolder
    } catch {
      Write-Host "Failed to clean up unpacked extension lock holder: $($_.Exception.Message)"
    }
  }
}

function Start-NativeHostRespawnSupervisor {
  $readyPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-runtime-lock-ready.txt'
  $suspendedPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-native-registration-suspended.txt'
  $lockScriptPath = Join-Path $acceptanceRoot 'installer-lock-holder.ps1'
  $supervisorScriptPath = Join-Path $acceptanceRoot 'native-host-respawn-supervisor.ps1'
  $configPath = Join-Path $acceptanceRoot 'native-host-respawn-config.json'
  $targetPath = Join-Path $installRoot 'runtime\harness\apps\cli\lib\server.mjs'
  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $suspendedPath -Force -ErrorAction SilentlyContinue
  $lockSource = @'
param([string]$TargetPath, [string]$ReadyPath)
$handle = [System.IO.File]::Open($TargetPath, 'Open', 'Read', 'None')
try {
  [System.IO.File]::WriteAllText($ReadyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 120
} finally {
  $handle.Dispose()
}
'@
  $supervisorSource = @'
param([string]$ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$child = $null
try {
  while ($true) {
    if (-not (Test-Path -LiteralPath $config.RegistryKey)) {
      [System.IO.File]::WriteAllText($config.SuspendedPath, 'suspended', [System.Text.UTF8Encoding]::new($false))
      break
    }
    if ($null -eq $child -or $child.HasExited) {
      $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $config.LockScriptPath + '"'),
        '-TargetPath', ('"' + $config.TargetPath + '"'), '-ReadyPath', ('"' + $config.ReadyPath + '"')
      )
      $child = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    }
    Start-Sleep -Milliseconds 50
    $child.Refresh()
  }
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (-not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null }
  }
}
'@
  [System.IO.File]::WriteAllText($lockScriptPath, $lockSource, [System.Text.UTF8Encoding]::new($true))
  [System.IO.File]::WriteAllText($supervisorScriptPath, $supervisorSource, [System.Text.UTF8Encoding]::new($true))
  $config = @{
    RegistryKey = (Join-Path $registryRoots[0] $nativeHostNames[0])
    TargetPath = $targetPath
    ReadyPath = $readyPath
    SuspendedPath = $suspendedPath
    LockScriptPath = $lockScriptPath
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $supervisorScriptPath + '"'), '-ConfigPath', ('"' + $configPath + '"'))
  $process = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'Failed to start the Native Host respawn supervisor.' }
  return @{ Process = $process; SuspendedPath = $suspendedPath }
}

function Start-CandidateRegistrationFailureSupervisor {
  $readyPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-candidate-runtime-lock-ready.txt'
  $stoppedPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-candidate-runtime-lock-stopped.txt'
  $lockScriptPath = Join-Path $acceptanceRoot 'candidate-runtime-lock-holder.ps1'
  $supervisorScriptPath = Join-Path $acceptanceRoot 'candidate-registration-failure-supervisor.ps1'
  $configPath = Join-Path $acceptanceRoot 'candidate-registration-failure-config.json'
  $targetPath = Join-Path $installRoot 'runtime\harness\apps\cli\lib\server.mjs'
  Remove-Item -LiteralPath $readyPath, $stoppedPath -Force -ErrorAction SilentlyContinue
  $lockSource = @'
param([string]$TargetPath, [string]$ReadyPath)
$handle = [System.IO.File]::Open($TargetPath, 'Open', 'Read', 'None')
try {
  [System.IO.File]::WriteAllText($ReadyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 120
} finally {
  $handle.Dispose()
}
'@
  $supervisorSource = @'
param([string]$ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$sawSuspendedRegistration = $false
$child = $null
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-Path -LiteralPath $config.RegistryKey)) {
      $sawSuspendedRegistration = $true
    } elseif ($sawSuspendedRegistration -and $null -eq $child) {
      $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $config.LockScriptPath + '"'),
        '-TargetPath', ('"' + $config.TargetPath + '"'), '-ReadyPath', ('"' + $config.ReadyPath + '"')
      )
      $child = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    }
    if ($null -ne $child) {
      $child.Refresh()
      if ($child.HasExited) {
        [System.IO.File]::WriteAllText($config.StoppedPath, 'stopped', [System.Text.UTF8Encoding]::new($false))
        exit 0
      }
    }
    Start-Sleep -Milliseconds 50
  }
  throw 'Candidate registration supervisor timed out before the installer stopped the candidate runtime lock.'
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (-not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null }
  }
}
'@
  [System.IO.File]::WriteAllText($lockScriptPath, $lockSource, [System.Text.UTF8Encoding]::new($true))
  [System.IO.File]::WriteAllText($supervisorScriptPath, $supervisorSource, [System.Text.UTF8Encoding]::new($true))
  $config = @{
    RegistryKey = (Join-Path $registryRoots[0] $nativeHostNames[0])
    TargetPath = $targetPath
    ReadyPath = $readyPath
    StoppedPath = $stoppedPath
    LockScriptPath = $lockScriptPath
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $supervisorScriptPath + '"'), '-ConfigPath', ('"' + $configPath + '"'))
  $process = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  return @{ Process = $process; ReadyPath = $readyPath; StoppedPath = $stoppedPath }
}

function New-CandidateRegistrationFailurePackage {
  $packageRoot = Join-Path $acceptanceRoot 'candidate-registration-failure-package'
  $payloadRoot = Join-Path $acceptanceRoot 'candidate-registration-failure-payload'
  if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
  if (Test-Path -LiteralPath $payloadRoot) { Remove-Item -LiteralPath $payloadRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $packageRoot, $payloadRoot -Force | Out-Null
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadRoot -Force
  $registerScriptPath = Join-Path $payloadRoot 'runtime\register-native-host.ps1'
  $realRegisterScriptPath = Join-Path $payloadRoot 'runtime\register-native-host-real.ps1'
  Copy-Item -LiteralPath $registerScriptPath -Destination $realRegisterScriptPath -Force
  $registerScript = @'
param(
  [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$PrepareOnly,
  [switch]$PublishOnly
)
$ErrorActionPreference = 'Stop'
if ($PrepareOnly -and $PublishOnly) { throw 'Invalid injected Native Host mode.' }
if ($PrepareOnly) {
  & (Join-Path $PSScriptRoot 'register-native-host-real.ps1') -InstallRoot $InstallRoot -PrepareOnly
  return
}
$registryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.deepseek.harness.chrome'
New-Item -Path $registryKey -Force | Out-Null
Set-Item -Path $registryKey -Value (Join-Path $InstallRoot 'native-messaging\com.deepseek.harness.chrome.json')
$readyPath = $env:ACCRUI_TEST_CANDIDATE_LOCK_READY
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while (([string]::IsNullOrWhiteSpace($readyPath) -or -not (Test-Path -LiteralPath $readyPath)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
if ([string]::IsNullOrWhiteSpace($readyPath) -or -not (Test-Path -LiteralPath $readyPath)) { throw 'Injected candidate registration did not observe the candidate runtime lock.' }
throw 'Injected candidate registration failure after Chrome Native Messaging was published.'
'@
  [System.IO.File]::WriteAllText($registerScriptPath, $registerScript, [System.Text.UTF8Encoding]::new($true))
  Compress-Archive -Path (Join-Path $payloadRoot '*') -DestinationPath (Join-Path $packageRoot 'payload.zip') -Force
  Copy-Item -LiteralPath $installer -Destination (Join-Path $packageRoot 'install.ps1') -Force
  return $packageRoot
}

function Assert-CandidateRegistrationFailureRollsBack {
  $packageRoot = New-CandidateRegistrationFailurePackage
  $statusPath = Join-Path $installRoot '.accrui-update-status.json'
  $progressPath = Join-Path $installRoot '.accrui-update-progress.txt'
  $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
  Remove-Item -LiteralPath $statusPath, $progressPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $installLog -PathType Leaf) { Remove-Item -LiteralPath $installLog -Force -ErrorAction Stop }
  $supervisor = Start-CandidateRegistrationFailureSupervisor
  $env:ACCRUI_TEST_CANDIDATE_LOCK_READY = $supervisor.ReadyPath
  try {
    & node (Join-Path $PSScriptRoot 'release-update-handoff-smoke.mjs') --package-dir $packageRoot --install-root $installRoot --expected-version $ExpectedVersion
    if ($LASTEXITCODE -ne 0) { throw "Candidate registration failure handoff helper failed with exit code $LASTEXITCODE." }
    $status = Wait-ReleaseUpdateTerminalStatus $statusPath $progressPath
    if ($status.state -ne 'failed') { throw "Candidate registration failure unexpectedly ended in state: $($status.state)" }
    if (-not (Test-Path -LiteralPath $supervisor.ReadyPath -PathType Leaf)) { throw 'Candidate registration did not start a process holding the new runtime.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $supervisor.StoppedPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $supervisor.StoppedPath -PathType Leaf)) { throw 'Failed registration rollback did not stop the process holding the new runtime.' }
    Assert-Equal (Read-Version $installRoot) '1.1.62' 'Failed candidate registration did not restore the previous version.'
    Assert-ExtensionResources $installRoot
    foreach ($registryRoot in $registryRoots) {
      foreach ($nativeHostName in $nativeHostNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $registryRoot $nativeHostName))) { throw "Failed candidate registration did not restore Native Messaging: $nativeHostName" }
      }
    }
    $logText = Read-ReleaseUpdateInstallLog $installLog
    $primaryError = 'Injected candidate registration failure after Chrome Native Messaging was published.'
    if ($logText -notmatch [regex]::Escape($primaryError)) { throw "Failed candidate registration log lost its original error: $logText" }
    if ($logText -match '无法删除.*runtime') { throw "Failed candidate registration log was masked by runtime cleanup: $logText" }
    Write-Host 'Failed candidate registration stopped the new runtime, restored the old release, and retained the original error.'
  } finally {
    Remove-Item Env:ACCRUI_TEST_CANDIDATE_LOCK_READY -ErrorAction SilentlyContinue
    $supervisor.Process.Refresh()
    if (-not $supervisor.Process.HasExited) { & taskkill.exe /PID $supervisor.Process.Id /T /F | Out-Null }
  }
}

function New-CandidateStartupFailurePackage {
  $packageRoot = Join-Path $acceptanceRoot 'candidate-startup-failure-package'
  $payloadRoot = Join-Path $acceptanceRoot 'candidate-startup-failure-payload'
  if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
  if (Test-Path -LiteralPath $payloadRoot) { Remove-Item -LiteralPath $payloadRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $packageRoot, $payloadRoot -Force | Out-Null
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $payloadRoot -Force
  $launcherPath = Join-Path $payloadRoot 'runtime\run_native_host.bat'
  $brokenLauncher = "@echo off`r`necho ERROR: injected candidate Native Host startup failure 1>&2`r`nexit /b 19`r`n"
  [System.IO.File]::WriteAllText($launcherPath, $brokenLauncher, [System.Text.UTF8Encoding]::new($false))
  Compress-Archive -Path (Join-Path $payloadRoot '*') -DestinationPath (Join-Path $packageRoot 'payload.zip') -Force
  Copy-Item -LiteralPath $installer -Destination (Join-Path $packageRoot 'install.ps1') -Force
  return $packageRoot
}

function Assert-CandidateStartupFailureRollsBack {
  $packageRoot = New-CandidateStartupFailurePackage
  $statusPath = Join-Path $installRoot '.accrui-update-status.json'
  $progressPath = Join-Path $installRoot '.accrui-update-progress.txt'
  $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
  Remove-Item -LiteralPath $statusPath, $progressPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $installLog -PathType Leaf) { Remove-Item -LiteralPath $installLog -Force -ErrorAction Stop }
  & node (Join-Path $PSScriptRoot 'release-update-handoff-smoke.mjs') --package-dir $packageRoot --install-root $installRoot --expected-version $ExpectedVersion
  if ($LASTEXITCODE -ne 0) { throw "Candidate startup failure handoff helper failed with exit code $LASTEXITCODE." }
  $status = Wait-ReleaseUpdateTerminalStatus $statusPath $progressPath
  if ($status.state -ne 'failed') { throw "Candidate startup failure unexpectedly ended in state: $($status.state)" }
  Assert-Equal (Read-Version $installRoot) '1.1.62' 'Candidate Native Host startup failure did not restore the previous version.'
  Assert-ExtensionResources $installRoot
  foreach ($registryRoot in $registryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      if (-not (Test-Path -LiteralPath (Join-Path $registryRoot $nativeHostName))) { throw "Candidate Native Host startup failure did not restore Native Messaging: $nativeHostName" }
    }
  }
  $logText = Read-ReleaseUpdateInstallLog $installLog
  if ($logText -notmatch 'Native Host 启动检查失败') { throw "Candidate startup failure log does not identify the failed Native Host check: $logText" }
  Write-Host 'Failed Native Host startup did not publish the candidate and restored the old release.'
}

function Start-OrphanRuntimeLockHolder {
  $readyPath = Join-Path $env:RUNNER_TEMP 'accrui-harness-orphan-runtime-lock-ready.txt'
  $lockScriptPath = Join-Path $acceptanceRoot 'orphan-runtime-lock-holder.ps1'
  $targetPath = Join-Path $installRoot 'runtime\harness\apps\cli\lib\server.mjs'
  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
  $lockSource = @'
param([string]$TargetPath, [string]$ReadyPath)
$handle = [System.IO.File]::Open($TargetPath, 'Open', 'Read', 'None')
try {
  [System.IO.File]::WriteAllText($ReadyPath, 'ready', [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 120
} finally {
  $handle.Dispose()
}
'@
  [System.IO.File]::WriteAllText($lockScriptPath, $lockSource, [System.Text.UTF8Encoding]::new($true))
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $lockScriptPath + '"'), '-TargetPath', ('"' + $targetPath + '"'), '-ReadyPath', ('"' + $readyPath + '"'))
  $process = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'Failed to start the orphan process holding the installed runtime.' }
  return $process
}

$respawnSupervisor = $null
$orphanRuntimeLockHolder = $null
try {
  if (Test-Path -LiteralPath $acceptanceRoot) { Remove-Item -LiteralPath $acceptanceRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $seedRoot -Force | Out-Null
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $seedRoot -Force

  # Seed a valid previous AccrUI-compatible install so this is a real upgrade,
  # not merely a clean install with hand-written placeholder files.
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Move-Item -LiteralPath (Join-Path $seedRoot 'extension') -Destination (Join-Path $installRoot 'extension')
  Move-Item -LiteralPath (Join-Path $seedRoot 'runtime') -Destination (Join-Path $installRoot 'runtime')
  $oldManifestPath = Join-Path $installRoot 'extension\manifest.json'
  $oldManifest = Get-Content -LiteralPath $oldManifestPath -Raw | ConvertFrom-Json
  $oldManifest.version = '1.1.62'
  [System.IO.File]::WriteAllText($oldManifestPath, ($oldManifest | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
  Convert-SeedToLegacyRelease
  foreach ($relativePath in @('workspace\user.txt', 'logs\user.txt', '.webmcp\user.txt')) {
    $sentinel = Join-Path $installRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force | Out-Null
    Set-Content -LiteralPath $sentinel -Value 'preserve-me' -NoNewline
  }

  & (Join-Path $installRoot 'runtime\register-native-host.ps1') -InstallRoot $installRoot

  Invoke-InstallerUiSmoke
  Assert-LockedExtensionUpgradeFailsSafely
  Assert-FailedReleaseUpdateHandoffStatus
  Assert-CandidateRegistrationFailureRollsBack
  Assert-CandidateStartupFailureRollsBack
  $respawnSupervisor = Start-NativeHostRespawnSupervisor
  $orphanRuntimeLockHolder = Start-OrphanRuntimeLockHolder
  $env:DSH_INSTALL_NONINTERACTIVE = '1'
  Invoke-ReleaseUpdateHandoff
  $orphanRuntimeLockHolder.Refresh()
  if (-not $orphanRuntimeLockHolder.HasExited) { throw 'Online updater did not stop the orphan process holding the installed runtime.' }
  $respawnSupervisor.Process.Refresh()
  if (-not $respawnSupervisor.Process.HasExited) { throw 'Native Host respawn supervisor did not stop after registration was suspended.' }
  if (-not (Test-Path -LiteralPath $respawnSupervisor.SuspendedPath -PathType Leaf)) { throw 'Installer never suspended Native Messaging registration during upgrade.' }
  Write-Host 'Browser-style Native Host respawn stopped after registration was suspended.'
  Assert-Equal (Read-Version $installRoot) $ExpectedVersion 'Upgrade did not install the candidate.'
  Assert-ExtensionResources $installRoot
  Assert-Equal (Read-Version (Join-Path $installRoot 'rollback')) '1.1.62' 'Previous version was not retained for rollback.'
  foreach ($relativePath in @('workspace\user.txt', 'logs\user.txt', '.webmcp\user.txt')) {
    Assert-Equal (Get-Content -LiteralPath (Join-Path $installRoot $relativePath) -Raw) 'preserve-me' "User data was not preserved: $relativePath"
  }
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) $ExpectedVersion 'Product registry version is stale after upgrade.'

  foreach ($registryRoot in $registryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $manifestPath = (Get-Item -LiteralPath (Join-Path $registryRoot $nativeHostName)).GetValue('')
      if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Native Messaging manifest is missing: $manifestPath" }
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      Assert-Equal $manifest.name $nativeHostName 'Native Messaging manifest name mismatch.'
      Assert-Equal $manifest.path (Join-Path $installRoot 'runtime\run_native_host.bat') 'Native Messaging launcher path mismatch.'
    }
  }
  $productSkill = Join-Path $installRoot 'runtime\skills\pmd-prd\SKILL.md'
  if (-not (Test-Path -LiteralPath $productSkill -PathType Leaf)) { throw "Product skill is missing: $productSkill" }
  $skillBody = Get-Content -LiteralPath $productSkill -Raw
  if ($skillBody -notmatch 'Harness Workspace 是唯一用户界面') { throw 'Installed /pmd-prd is not the product-owned skill.' }
  if ($skillBody -match 'pmd-workspace|clarification\.md') { throw 'Installed /pmd-prd looks like the legacy Claude skill.' }
  $prototypeSkill = Join-Path $installRoot 'runtime\skills\product-prototype\SKILL.md'
  if (-not (Test-Path -LiteralPath $prototypeSkill -PathType Leaf)) { throw "Product prototype skill is missing: $prototypeSkill" }
  if ((Get-Content -LiteralPath $prototypeSkill -Raw) -notmatch 'name:\s*product-prototype') { throw 'Installed /product-prototype is not the product-owned skill.' }
  foreach ($officeSkill in @('pptx', 'xlsx', 'docx', 'pdf')) {
    $officeSkillPath = Join-Path $installRoot ('runtime\skills\' + $officeSkill + '\SKILL.md')
    if (-not (Test-Path -LiteralPath $officeSkillPath -PathType Leaf)) { throw "Product office skill is missing: $officeSkillPath" }
    $officeSkillBody = Get-Content -LiteralPath $officeSkillPath -Raw
    if ($officeSkillBody -notmatch ('name:\s*' + $officeSkill)) { throw "Installed /$officeSkill is not the product-owned office skill." }
  }
  $officePlugin = Join-Path $installRoot 'runtime\native-server\product-office-skills.mjs'
  if (-not (Test-Path -LiteralPath $officePlugin -PathType Leaf)) { throw "Product office skill plugin is missing: $officePlugin" }
  $launcher = Get-Content -LiteralPath (Join-Path $installRoot 'runtime\run_native_host.bat') -Raw
  if ($launcher -notmatch 'DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills') { throw 'Native Host launcher does not pin DSH_PRODUCT_SKILLS_ROOT to the packaged skills root.' }
  Invoke-NativeMessageSmoke
  Invoke-ProductUiSmoke
  Invoke-DirectoryPickerSmoke
  Invoke-WindowsAclRunnerSmoke

  $manager = Join-Path $installRoot 'manage-install.ps1'
  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) '1.1.62' 'Rollback did not restore the previous version.'
  Assert-ExtensionResources $installRoot
  Assert-Equal (Read-Version (Join-Path $installRoot 'rollback')) $ExpectedVersion 'Rollback did not retain the candidate for recovery.'
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) '1.1.62' 'Product registry version is stale after rollback.'
  Invoke-NativeMessageSmoke

  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) $ExpectedVersion 'Second rollback did not restore the candidate.'
  Assert-ExtensionResources $installRoot
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) $ExpectedVersion 'Product registry version is stale after restoring the candidate.'
  Invoke-ProductUiSmoke
  Write-Host 'Windows install, Native Messaging, upgrade, rollback, and restore acceptance passed.'
} finally {
  if ($null -ne $respawnSupervisor) {
    $respawnSupervisor.Process.Refresh()
    if (-not $respawnSupervisor.Process.HasExited) { & taskkill.exe /PID $respawnSupervisor.Process.Id /T /F | Out-Null }
  }
  if ($null -ne $orphanRuntimeLockHolder) {
    $orphanRuntimeLockHolder.Refresh()
    if (-not $orphanRuntimeLockHolder.HasExited) { & taskkill.exe /PID $orphanRuntimeLockHolder.Id /T /F | Out-Null }
  }
  foreach ($registryRoot in $registryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $key = Join-Path $registryRoot $nativeHostName
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
  }
  if (Test-Path -LiteralPath $productKey) { Remove-Item -LiteralPath $productKey -Recurse -Force }
}
