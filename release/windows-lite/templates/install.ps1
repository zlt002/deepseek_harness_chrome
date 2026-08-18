param([switch]$Rollback, [switch]$Interactive)

# AccrUI-compatible Harness Windows Lite installer and rollback manager.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadZip = Join-Path $scriptDir 'payload.zip'
$installRoot = Join-Path $env:LOCALAPPDATA 'accr-ui-harness'
$rollbackRoot = Join-Path $installRoot 'rollback'
$managedNames = @('extension', 'runtime', 'release.json')
$installLog = Join-Path $env:TEMP 'accr-ui-harness-install.log'

trap {
  $errorText = ($_ | Out-String).Trim()
  $message = "Harness UI 安装失败：$errorText"
  [System.IO.File]::WriteAllText($installLog, $message + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  Write-Host "错误日志：$installLog" -ForegroundColor Yellow
  if ($Interactive) { Read-Host '按 Enter 键关闭安装窗口' | Out-Null }
  exit 1
}

function Assert-ReleaseTree([string]$Root) {
  $extensionManifest = Join-Path $Root 'extension\manifest.json'
  $cli = Join-Path $Root 'runtime\harness\apps\cli\lib\server.mjs'
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
  if (-not (Test-Path -LiteralPath $extensionManifest -PathType Leaf)) { throw "安装内容不完整：缺少 $extensionManifest" }
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "安装内容不完整：缺少 $cli" }
  if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) { throw "安装内容不完整：缺少 $registerScript" }
  return (Get-Content -LiteralPath $extensionManifest -Raw | ConvertFrom-Json)
}

function Move-ManagedTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in $managedNames) {
    $sourcePath = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
    $destinationPath = Join-Path $Destination $name
    if (Test-Path -LiteralPath $destinationPath) { Remove-Item -LiteralPath $destinationPath -Recurse -Force }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
  }
}

function Register-ReleaseTree([string]$Root) {
  $registerScript = Join-Path $Root 'runtime\register-native-host.ps1'
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
  New-Item -ItemType Directory -Path $swapRoot -Force | Out-Null
  try {
    Move-ManagedTree $installRoot $swapRoot
    Move-ManagedTree $rollbackRoot $installRoot
    try {
      Register-ReleaseTree $installRoot
      Write-ProductState $installRoot
    } catch {
      Move-ManagedTree $installRoot $rollbackRoot
      Move-ManagedTree $swapRoot $installRoot
      Register-ReleaseTree $installRoot
      Write-ProductState $installRoot
      throw
    }
    Move-ManagedTree $swapRoot $rollbackRoot
    Write-Host 'Harness UI 已回滚；再次运行 -Rollback 可切换回刚才的版本。'
  } finally {
    if (Test-Path -LiteralPath $swapRoot) { Remove-Item -LiteralPath $swapRoot -Recurse -Force }
  }
}

if ($Rollback) {
  Restore-Rollback
  exit 0
}

if (-not (Test-Path -LiteralPath $payloadZip -PathType Leaf)) { throw '缺少 payload.zip 安装包。' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '未检测到 Node.js；Harness UI 需要 Node.js 22 或更高版本。' }
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node.js 路径无效：$nodePath" }
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch '^v?(?<major>\d+)' -or [int]$Matches.major -lt 22) { throw "Node.js $nodeVersion 版本过低；Harness UI 需要 Node.js 22 或更高版本。" }

$stagingRoot = Join-Path $env:TEMP ('accr-ui-harness-stage-' + [guid]::NewGuid().ToString('N'))
$previousRoot = Join-Path $env:TEMP ('accr-ui-harness-previous-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path $previousRoot -Force | Out-Null
try {
  Expand-Archive -LiteralPath $payloadZip -DestinationPath $stagingRoot -Force
  Assert-ReleaseTree $stagingRoot | Out-Null
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  # Preserve user-owned workspace, logs, .webmcp, and the last rollback tree.
  Move-ManagedTree $installRoot $previousRoot
  try {
    Move-ManagedTree $stagingRoot $installRoot
    foreach ($name in @('workspace', 'logs', '.webmcp', 'guide-state.json')) {
      $sourcePath = Join-Path $stagingRoot $name
      $destinationPath = Join-Path $installRoot $name
      if ((Test-Path -LiteralPath $sourcePath) -and -not (Test-Path -LiteralPath $destinationPath)) {
        Move-Item -LiteralPath $sourcePath -Destination $destinationPath
      }
    }
    Register-ReleaseTree $installRoot
    Write-ProductState $installRoot
  } catch {
    foreach ($name in $managedNames) {
      $failedPath = Join-Path $installRoot $name
      if (Test-Path -LiteralPath $failedPath) { Remove-Item -LiteralPath $failedPath -Recurse -Force }
    }
    Move-ManagedTree $previousRoot $installRoot
    if (Test-Path -LiteralPath (Join-Path $installRoot 'runtime\register-native-host.ps1')) {
      Register-ReleaseTree $installRoot
      Write-ProductState $installRoot
    }
    throw
  }
  if ((Get-ChildItem -LiteralPath $previousRoot -Force | Measure-Object).Count -gt 0) {
    if (Test-Path -LiteralPath $rollbackRoot) { Remove-Item -LiteralPath $rollbackRoot -Recurse -Force }
    Move-Item -LiteralPath $previousRoot -Destination $rollbackRoot
  }
  Copy-Item -LiteralPath $MyInvocation.MyCommand.Path -Destination (Join-Path $installRoot 'manage-install.ps1') -Force
  Write-Host 'Harness UI 已安装。请在 chrome://extensions 或 edge://extensions 重新加载 AccrUI 扩展。'
} finally {
  if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
  if (Test-Path -LiteralPath $previousRoot) { Remove-Item -LiteralPath $previousRoot -Recurse -Force }
}
