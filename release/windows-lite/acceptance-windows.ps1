param(
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath($PackageDir)
$installer = Join-Path $packageRoot 'install.ps1'
$installLauncher = Join-Path $packageRoot 'install.vbs'
$payloadZip = Join-Path $packageRoot 'payload.zip'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing installer: $installer" }
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
  Invoke-NativeMessageSmoke

  $manager = Join-Path $installRoot 'manage-install.ps1'
  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) '1.1.62' 'Rollback did not restore the previous version.'
  Assert-Equal (Read-Version (Join-Path $installRoot 'rollback')) $ExpectedVersion 'Rollback did not retain the candidate for recovery.'
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) '1.1.62' 'Product registry version is stale after rollback.'
  Invoke-NativeMessageSmoke

  & $manager -Rollback
  Assert-Equal (Read-Version $installRoot) $ExpectedVersion 'Second rollback did not restore the candidate.'
  Assert-Equal (Get-ItemPropertyValue -Path $productKey -Name Version) $ExpectedVersion 'Product registry version is stale after restoring the candidate.'
  Write-Host 'Windows install, Native Messaging, upgrade, rollback, and restore acceptance passed.'
} finally {
  foreach ($registryRoot in $registryRoots) {
    foreach ($nativeHostName in $nativeHostNames) {
      $key = Join-Path $registryRoot $nativeHostName
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    }
  }
  if (Test-Path -LiteralPath $productKey) { Remove-Item -LiteralPath $productKey -Recurse -Force }
}
