param(
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path ([System.IO.Path]::GetFullPath($StageRoot)) 'eric-task-master'
$manifestPath = Join-Path $runtimeRoot 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing staged release manifest: $manifestPath" }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.target -ne 'windows-x64') { throw "Expected windows-x64 stage, found $($manifest.target)" }

$destination = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$portable = Join-Path $destination "eric-task-master-v$($manifest.version)-windows-x64-portable.zip"
$installer = Join-Path $destination "eric-task-master-v$($manifest.version)-windows-x64-setup.exe"
Remove-Item -LiteralPath $portable,$installer -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $runtimeRoot -DestinationPath $portable -CompressionLevel Optimal

$compilerCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$compilerPath = if ($compilerCommand) { $compilerCommand.Source } else { $null }
if (-not $compilerPath) {
  $candidates = @(@(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if ($candidates.Count -gt 0) { $compilerPath = $candidates[0] }
}
if (-not $compilerPath) { throw 'Inno Setup 6 is required to build the Windows installer (ISCC.exe was not found).' }
$script = Join-Path $PSScriptRoot '..\install\windows\installer.iss'
& $compilerPath "/DSourceRoot=$runtimeRoot" "/DProductVersion=$($manifest.version)" "/DOutputDirectory=$destination" $script
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installer)) { throw 'Inno Setup installer build failed' }

[ordered]@{
  ok = $true
  target = $manifest.target
  signed = $false
  assets = @($portable, $installer)
} | ConvertTo-Json -Depth 4 -Compress
