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

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message Expected=$Expected Actual=$Actual" }
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

$respawnSupervisor = $null
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
  foreach ($relativePath in @('workspace\user.txt', 'logs\user.txt', '.webmcp\user.txt')) {
    $sentinel = Join-Path $installRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $sentinel) -Force | Out-Null
    Set-Content -LiteralPath $sentinel -Value 'preserve-me' -NoNewline
  }

  & (Join-Path $installRoot 'runtime\register-native-host.ps1') -InstallRoot $installRoot

  Invoke-InstallerUiSmoke
  Assert-LockedExtensionUpgradeFailsSafely
  $respawnSupervisor = Start-NativeHostRespawnSupervisor
  $env:DSH_INSTALL_NONINTERACTIVE = '1'
  $vbsOutput = & cscript.exe //NoLogo $installLauncher 2>&1
  $vbsExitCode = $LASTEXITCODE
  $vbsOutput | ForEach-Object { Write-Host $_ }
  if ($vbsExitCode -ne 0) {
    $installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'
    if (Test-Path -LiteralPath $installLog -PathType Leaf) {
      Write-Host 'VBS installer error log:'
      Get-Content -LiteralPath $installLog | Write-Host
    } else {
      Write-Host 'VBS installer created no error log; probing install.ps1 with Windows PowerShell directly.'
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
      Write-Host "Direct Windows PowerShell installer exit code: $LASTEXITCODE"
    }
    throw "VBS installer failed with exit code $vbsExitCode."
  }
  $respawnSupervisor.Process.Refresh()
  if (-not $respawnSupervisor.Process.HasExited) { throw 'Native Host respawn supervisor did not stop after registration was suspended.' }
  if (-not (Test-Path -LiteralPath $respawnSupervisor.SuspendedPath -PathType Leaf)) { throw 'Installer never suspended Native Messaging registration during upgrade.' }
  Write-Host 'Browser-style Native Host respawn stopped after registration was suspended.'
  Assert-Equal (Read-Version $installRoot) $ExpectedVersion 'Upgrade did not install the candidate.'
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

  $manager = Join-Path $installRoot 'manage-install.ps1'
  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) '1.1.62' 'Rollback did not restore the previous version.'
  Assert-Equal (Read-Version (Join-Path $installRoot 'rollback')) $ExpectedVersion 'Rollback did not retain the candidate for recovery.'
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) '1.1.62' 'Product registry version is stale after rollback.'
  Invoke-NativeMessageSmoke

  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) $ExpectedVersion 'Second rollback did not restore the candidate.'
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) $ExpectedVersion 'Product registry version is stale after restoring the candidate.'
  Invoke-ProductUiSmoke
  Write-Host 'Windows install, Native Messaging, upgrade, rollback, and restore acceptance passed.'
} finally {
  if ($null -ne $respawnSupervisor) {
    $respawnSupervisor.Process.Refresh()
    if (-not $respawnSupervisor.Process.HasExited) { & taskkill.exe /PID $respawnSupervisor.Process.Id /T /F | Out-Null }
  }
  foreach ($registryRoot in $registryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $key = Join-Path $registryRoot $nativeHostName
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
  }
  if (Test-Path -LiteralPath $productKey) { Remove-Item -LiteralPath $productKey -Recurse -Force }
}
