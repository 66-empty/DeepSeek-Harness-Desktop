# 移除桌面与开始菜单快捷方式,并清理开机自启注册表项。
# 用法: powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
foreach ($lnk in @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\DeepSeek Harness.lnk')
)) {
  if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "removed: $lnk" }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $runKey) {
  $props = Get-ItemProperty $runKey
  foreach ($name in $props.PSObject.Properties.Name) {
    $value = [string]$props.$name
    if ($value -like "*$appDir*") {
      Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
      Write-Host "removed autostart entry: $name"
    }
  }
}
Write-Host '卸载清理完成。如需删除整个应用目录,请手动删除本文件夹。'
