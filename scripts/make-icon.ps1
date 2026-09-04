# Generates assets/icon.ico (multi-size PNG-in-ICO) for the desktop shell.
# The glyph comes from assets/icon-source.svg (DeepSeek whale, same path data as the
# Web GUI favicon in the deepseek-harness checkout: apps/web/public/favicon.svg).
# Requires `npm install` once (electron is the local Chromium rasterizer).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot '..'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$renderer = Join-Path $PSScriptRoot 'render-icon.cjs'
$svg = Join-Path $root 'assets\icon-source.svg'
$outFile = Join-Path $root 'assets\icon.ico'
if (-not (Test-Path $electron)) { throw "electron missing - run 'npm install' first ($electron)" }
if (-not (Test-Path $svg)) { throw "source svg missing: $svg" }

$pngDir = Join-Path $env:TEMP ('dsh-desktop-icon-pngs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $pngDir | Out-Null
try {
  # electron.exe is a GUI-subsystem binary: `&` returns immediately and sets no
  # $LASTEXITCODE, so wait on the process explicitly and surface its exit code.
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $electron
  $psi.Arguments = '"' + $renderer + '" "' + $svg + '" "' + $pngDir + '" B'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  $null = $proc.Start()
  $renderOut = $proc.StandardOutput.ReadToEnd()
  $renderErr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  Write-Host $renderOut
  if ($proc.ExitCode -ne 0) { throw "render-icon.cjs failed (exit $($proc.ExitCode)): $renderErr" }

  $sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
  $pngs = [System.Collections.Generic.List[byte[]]]::new()
  foreach ($s in $sizes) {
    $pngFile = Join-Path $pngDir "icon-$s.png"
    if (-not (Test-Path $pngFile)) { throw "renderer output missing: $pngFile" }
    $pngs.Add([System.IO.File]::ReadAllBytes($pngFile))
  }

  # Pack ICO: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, PNG payloads.
  $fs = [System.IO.File]::Create($outFile)
  $bw = [System.IO.BinaryWriter]::new($fs)
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$pngs.Count)
  $offset = 6 + 16 * $pngs.Count
  for ($i = 0; $i -lt $pngs.Count; $i++) {
    $dim = 0
    if ($sizes[$i] -lt 256) { $dim = $sizes[$i] }
    $bw.Write([byte]$dim)               # width (0 = 256)
    $bw.Write([byte]$dim)               # height
    $bw.Write([byte]0)                  # palette
    $bw.Write([byte]0)                  # reserved
    $bw.Write([uint16]1)                # planes
    $bw.Write([uint16]32)               # bpp
    $bw.Write([uint32]$pngs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($png in $pngs) { $bw.Write($png) }
  $bw.Close(); $fs.Close()
  $totalKb = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
  Write-Host "wrote $outFile ($($pngs.Count) sizes, $totalKb KB)"
} finally {
  Remove-Item -Recurse -Force $pngDir -ErrorAction SilentlyContinue
}
