param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir 'install.ps1'
$payloadZip = Join-Path $scriptDir 'payload.zip'
$progressPath = Join-Path $env:TEMP ('accr-ui-harness-progress-' + [guid]::NewGuid().ToString('N') + '.txt')
$launcherLog = Join-Path $scriptDir 'install-launch.log'
$defaultInstallDir = Join-Path $env:LOCALAPPDATA 'accr-ui-harness'
$productKey = 'HKCU:\Software\accr-ui\Lite'
$script:requirementsReady = $false
$script:isInstalling = $false
$script:installFinished = $false
$script:worker = $null

function Write-LauncherLog([string]$Message) {
  $line = ('{0:s} {1}' -f [DateTime]::Now, $Message)
  Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
}

function Get-InstalledDir {
  try {
    $value = Get-ItemPropertyValue -Path $productKey -Name InstallDir -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  } catch {}
  return $defaultInstallDir
}

function Find-Browser([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
    if (Test-Path -LiteralPath $expanded -PathType Leaf) { return $expanded }
  }
  return $null
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Harness UI 安装程序'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(760, 590)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 252)

$title = New-Object System.Windows.Forms.Label
$title.Text = '安装 Harness UI'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 23, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(32, 25)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = '检查运行环境，选择安装位置，然后一键安装或升级。已有工作区和用户数据会保留。'
$subtitle.AutoSize = $true
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(86, 96, 112)
$subtitle.Location = New-Object System.Drawing.Point(35, 72)
$form.Controls.Add($subtitle)

function New-RequirementRow([string]$Name, [int]$Top) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Location = New-Object System.Drawing.Point(34, $Top)
  $panel.Size = New-Object System.Drawing.Size(692, 66)
  $panel.BackColor = [System.Drawing.Color]::White
  $panel.BorderStyle = 'FixedSingle'
  $nameLabel = New-Object System.Windows.Forms.Label
  $nameLabel.Text = $Name
  $nameLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $nameLabel.Location = New-Object System.Drawing.Point(16, 10)
  $nameLabel.AutoSize = $true
  $panel.Controls.Add($nameLabel)
  $detail = New-Object System.Windows.Forms.Label
  $detail.Location = New-Object System.Drawing.Point(17, 35)
  $detail.Size = New-Object System.Drawing.Size(530, 22)
  $detail.ForeColor = [System.Drawing.Color]::FromArgb(86, 96, 112)
  $panel.Controls.Add($detail)
  $badge = New-Object System.Windows.Forms.Label
  $badge.Location = New-Object System.Drawing.Point(575, 17)
  $badge.Size = New-Object System.Drawing.Size(92, 30)
  $badge.TextAlign = 'MiddleCenter'
  $badge.BorderStyle = 'FixedSingle'
  $panel.Controls.Add($badge)
  $form.Controls.Add($panel)
  return @{ Detail = $detail; Badge = $badge }
}

$nodeRow = New-RequirementRow 'Node.js 22+' 105
$browserRow = New-RequirementRow 'Chrome / Edge' 180

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = '安装位置'
$pathLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$pathLabel.AutoSize = $true
$pathLabel.Location = New-Object System.Drawing.Point(36, 266)
$form.Controls.Add($pathLabel)

$pathTextBox = New-Object System.Windows.Forms.TextBox
$pathTextBox.Location = New-Object System.Drawing.Point(35, 292)
$pathTextBox.Size = New-Object System.Drawing.Size(548, 30)
$pathTextBox.Text = Get-InstalledDir
$form.Controls.Add($pathTextBox)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = '浏览...'
$browseButton.Location = New-Object System.Drawing.Point(598, 290)
$browseButton.Size = New-Object System.Drawing.Size(128, 33)
$form.Controls.Add($browseButton)

$recheckButton = New-Object System.Windows.Forms.Button
$recheckButton.Text = '重新检查'
$recheckButton.Location = New-Object System.Drawing.Point(35, 341)
$recheckButton.Size = New-Object System.Drawing.Size(116, 34)
$form.Controls.Add($recheckButton)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(35, 397)
$progress.Size = New-Object System.Drawing.Size(691, 20)
$progress.Minimum = 0
$progress.Maximum = 100
$form.Controls.Add($progress)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(36, 430)
$status.Size = New-Object System.Drawing.Size(690, 44)
$status.ForeColor = [System.Drawing.Color]::FromArgb(86, 96, 112)
$status.Text = '正在检查环境...'
$form.Controls.Add($status)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = '开始安装'
$installButton.Location = New-Object System.Drawing.Point(35, 500)
$installButton.Size = New-Object System.Drawing.Size(691, 46)
$installButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$installButton.Enabled = $false
$form.Controls.Add($installButton)

function Set-Badge($Row, [bool]$Ok, [string]$Text) {
  $Row.Detail.Text = $Text
  $Row.Badge.Text = if ($Ok) { '通过' } else { '未通过' }
  $Row.Badge.BackColor = if ($Ok) { [System.Drawing.Color]::FromArgb(225, 246, 236) } else { [System.Drawing.Color]::FromArgb(255, 235, 235) }
  $Row.Badge.ForeColor = if ($Ok) { [System.Drawing.Color]::FromArgb(12, 117, 76) } else { [System.Drawing.Color]::FromArgb(184, 47, 47) }
}

function Refresh-Requirements {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodeReady = $false
  $nodeText = '未检测到 Node.js，请先安装 Node.js 22 或更高版本。'
  if ($node) {
    try {
      $version = (& $node.Source --version).Trim()
      if ($version -match '^v?(?<major>\d+)' -and [int]$Matches.major -ge 22) {
        $nodeReady = $true
        $nodeText = "已检测到 $version：$($node.Source)"
      } else { $nodeText = "检测到 $version，但版本低于 22。" }
    } catch { $nodeText = "Node.js 检测失败：$($_.Exception.Message)" }
  }
  Set-Badge $nodeRow $nodeReady $nodeText

  $chrome = Find-Browser @('%ProgramFiles%\Google\Chrome\Application\chrome.exe', '%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe', '%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe')
  $edge = Find-Browser @('%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe', '%ProgramFiles%\Microsoft\Edge\Application\msedge.exe')
  $browserReady = $null -ne $chrome -or $null -ne $edge
  $browserNames = @()
  if ($chrome) { $browserNames += 'Chrome' }
  if ($edge) { $browserNames += 'Edge' }
  Set-Badge $browserRow $browserReady ($(if ($browserReady) { '已检测到 ' + ($browserNames -join ' / ') } else { '未检测到 Chrome 或 Edge。' }))

  $script:requirementsReady = $nodeReady -and $browserReady -and (Test-Path -LiteralPath $installer -PathType Leaf) -and (Test-Path -LiteralPath $payloadZip -PathType Leaf)
  if (-not $script:isInstalling) { $installButton.Enabled = $script:requirementsReady }
  $status.Text = if ($script:requirementsReady) { '环境检查通过，可以开始安装。' } else { '环境检查未通过，请先处理上方提示。' }
}

function Set-Busy([bool]$Busy) {
  $script:isInstalling = $Busy
  $browseButton.Enabled = -not $Busy
  $recheckButton.Enabled = -not $Busy
  $pathTextBox.Enabled = -not $Busy
  $installButton.Enabled = (-not $Busy) -and ($script:requirementsReady -or $script:installFinished)
}

$browseButton.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '请选择 Harness UI 安装位置'
  $dialog.ShowNewFolderButton = $true
  if (Test-Path -LiteralPath $pathTextBox.Text -PathType Container) { $dialog.SelectedPath = $pathTextBox.Text }
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $pathTextBox.Text = $dialog.SelectedPath }
  $dialog.Dispose()
})

$recheckButton.Add_Click({ Refresh-Requirements })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  if (-not (Test-Path -LiteralPath $progressPath -PathType Leaf)) { return }
  try {
    $parts = ([System.IO.File]::ReadAllText($progressPath, [System.Text.Encoding]::UTF8)).Split('|')
    $percent = 0
    [void][int]::TryParse($parts[0], [ref]$percent)
    $progress.Value = [Math]::Max(0, [Math]::Min(100, $percent))
    $state = if ($parts.Length -gt 1) { $parts[1] } else { '' }
    $detail = if ($parts.Length -gt 2) { $parts[2..($parts.Length - 1)] -join '|' } else { '' }
    $status.Text = if ($detail) { $detail } else { "安装进度 $percent%" }
    if ($state -eq 'complete') {
      $timer.Stop(); $script:installFinished = $true; Set-Busy $false
      $installButton.Text = '完成'
      [System.Windows.Forms.MessageBox]::Show('安装完成。请在 Chrome 或 Edge 的扩展管理页加载或重载扩展。', 'Harness UI', 'OK', 'Information') | Out-Null
    } elseif ($state -eq 'error') {
      $timer.Stop(); Set-Busy $false
      [System.Windows.Forms.MessageBox]::Show(($detail + "`r`n`r`n错误日志：" + (Join-Path $env:TEMP 'accr-ui-harness-install.log')), 'Harness UI 安装失败', 'OK', 'Error') | Out-Null
    }
  } catch {}
})

$installButton.Add_Click({
  if ($script:installFinished) { $form.Close(); return }
  if (-not $script:requirementsReady) { Refresh-Requirements; return }
  try {
    $selectedDir = [System.IO.Path]::GetFullPath($pathTextBox.Text.Trim())
    $root = [System.IO.Path]::GetPathRoot($selectedDir)
    if ($selectedDir.TrimEnd('\') -eq $root.TrimEnd('\')) { throw '安装位置不能是磁盘根目录。' }
    if ([System.IO.Directory]::Exists($selectedDir) -and [System.IO.Directory]::GetFileSystemEntries($selectedDir).Length -gt 0) {
      $answer = [System.Windows.Forms.MessageBox]::Show("目录中已有内容。安装器只替换程序文件，并保留工作区、日志和用户配置。是否继续？`r`n`r`n$selectedDir", 'Harness UI 安装程序', 'YesNo', 'Question')
      if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }
    if (Test-Path -LiteralPath $progressPath) { Remove-Item -LiteralPath $progressPath -Force }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installer + '"'), '-InstallRoot', ('"' + $selectedDir + '"'), '-ProgressPath', ('"' + $progressPath + '"'))
    Write-LauncherLog "install start target=$selectedDir"
    $script:worker = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $progress.Value = 2; $status.Text = '正在启动安装程序...'; Set-Busy $true; $timer.Start()
  } catch {
    $status.Text = $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Harness UI 安装程序', 'OK', 'Warning') | Out-Null
  }
})

$form.Add_Shown({ Refresh-Requirements })
$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($script:isInstalling) {
    $eventArgs.Cancel = $true
    $status.Text = '安装正在进行，请等待完成后再关闭。'
  }
})
$form.Add_FormClosed({
  $timer.Stop()
  if (Test-Path -LiteralPath $progressPath) { Remove-Item -LiteralPath $progressPath -Force -ErrorAction SilentlyContinue }
})

Write-LauncherLog 'installer UI shown'
[void]$form.ShowDialog()
