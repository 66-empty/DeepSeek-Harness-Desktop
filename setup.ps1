# DeepSeek Harness Desktop — one-shot install script for other machines
# (English / 中文)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -RepoPath "D:\code\deepseek-harness"
#
# Prerequisites / 前置条件: Node.js >= 22.19 installed; a deepseek-harness
# checkout that already ran `pnpm install && pnpm run build`.
param(
  [string]$RepoPath = ""
)

$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Install dir / 安装目录: $appDir"

# 1) Locate the deepseek-harness checkout
function Test-Repo([string]$path) {
  return (Test-Path (Join-Path $path 'apps\cli\src\bin.ts')) `
     -and (Test-Path (Join-Path $path 'node_modules\tsx'))
}

$candidates = @()
if ($RepoPath) { $candidates += $RepoPath }
if ($env:DSH_DESKTOP_REPO) { $candidates += $env:DSH_DESKTOP_REPO }
$sibling = Join-Path (Split-Path -Parent $appDir) 'deepseek-harness'
$candidates += $sibling

$repo = $candidates | Where-Object { Test-Repo $_ } | Select-Object -First 1
if (-not $repo) {
  Write-Host ""
  Write-Host "No usable deepseek-harness checkout found (needs apps/cli/src/bin.ts and pnpm install)."
  Write-Host "没有自动找到 deepseek-harness 仓库(要求包含 apps/cli/src/bin.ts 且已 pnpm install)。"
  Write-Host "Pass the checkout path with -RepoPath, e.g.: / 请用 -RepoPath 参数指定仓库绝对路径,例如:"
  Write-Host '  powershell -ExecutionPolicy Bypass -File setup.ps1 -RepoPath "D:\code\deepseek-harness"'
  exit 1
}
$repo = (Resolve-Path $repo).Path
Write-Host "Using checkout / 使用仓库: $repo"

# 2) Check Node/npm
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "node not found. Install Node.js >= 22.19 first: https://nodejs.org/"
  Write-Host "未找到 node,请先安装 Node.js >= 22.19: https://nodejs.org/"; exit 1
}

# 3) Install Electron (~200 MB, needs network)
if (-not (Test-Path (Join-Path $appDir 'node_modules\electron\dist\electron.exe'))) {
  Write-Host "Installing Electron (a few minutes, needs network)… / 正在安装 Electron,需要几分钟与网络……"
  Push-Location $appDir
  try { npm install; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
  finally { Pop-Location }
} else {
  Write-Host "Electron already present, skipping npm install (to update: cd here and run npm install)."
  Write-Host "Electron 已存在,跳过 npm install(如需更新: cd 到本目录执行 npm install)"
}

# 4) Write settings.json (only the checkout path; everything else defaults)
$settings = @{ repoPath = $repo }
Set-Content -Path (Join-Path $appDir 'settings.json') -Value ($settings | ConvertTo-Json) -Encoding UTF8
Write-Host "Wrote settings.json: repoPath = $repo / 已写入 settings.json: repoPath = $repo"

# 5) Icon + shortcuts (desktop & Start Menu)
powershell -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\make-icon.ps1')
powershell -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\create-shortcuts.ps1')

# 6) Done
Write-Host ""
Write-Host "Installation finished. Double-click the DeepSeek Harness desktop icon to start."
Write-Host "安装完成!现在可以双击桌面的「DeepSeek Harness」启动。"
Write-Host "Note: the Settings -> General 'Start at login' switch needs the optional checkout patch"
Write-Host "提示: 窗口内 设置 -> 通用设置 的「开机自启」开关需要仓库包含配套改动"
Write-Host "      (share/dsh-settings-autostart-row.patch, then pnpm run build:lib:client && pnpm run build:web)."
Write-Host "      (share/dsh-settings-autostart-row.patch,git apply 后 pnpm run build:lib:client 与 build:web)。"
Write-Host "      Without it the app works normally; only that switch is missing (the tray toggle is equivalent)."
Write-Host "      没有该改动也能正常使用桌面版,只是缺少这一行开关(仍可用托盘菜单切换开机自启)。"
