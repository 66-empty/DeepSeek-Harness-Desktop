# Creates (or refreshes) desktop + Start Menu shortcuts for the desktop shell.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1 [-Force]
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $appDir 'assets\icon.ico'

if (-not (Test-Path $electron)) { Write-Error "electron not installed yet — run: npm install (in $appDir)"; exit 1 }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DeepSeek Harness.lnk')
)
foreach ($lnk in $targets) {
  if ((Test-Path $lnk) -and -not $Force) { Write-Host "exists: $lnk (use -Force to refresh)"; continue }
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $electron
  $s.Arguments = '"' + $appDir + '"'
  $s.WorkingDirectory = $appDir
  if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
  $s.Description = 'DeepSeek Harness — 独立桌面窗口 (自动启动 dsh web 服务)'
  $s.Save()
  Write-Host "created: $lnk"
}
Write-Host 'done.'
