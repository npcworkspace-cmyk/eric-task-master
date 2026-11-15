param(
  [Parameter(Mandatory = $true)][string]$AppRoot,
  [Parameter(Mandatory = $true)][string]$NewVersion,
  [Parameter(Mandatory = $true)][ValidateSet('Validate', 'Apply')][string]$Mode
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($AppRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$parent = [IO.Path]::GetDirectoryName($root)
$name = [IO.Path]::GetFileName($root)
if (-not [IO.Path]::IsPathRooted($AppRoot) -or -not $parent -or
    $parent -eq [IO.Path]::GetPathRoot($root) -or $name -notmatch '^[A-Za-z0-9 ._-]+$' -or
    $root -match '[%!\r\n]' -or $NewVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Unsafe application root or version' }
$legacy = "$root v3"
$marker = Join-Path $legacy '.taskmaster-legacy.json'
$launcher = Join-Path $legacy 'bin/taskmaster.cmd'
$lines = @(
  '@echo off',
  'setlocal DisableDelayedExpansion',
  ('set "TASKMASTER_CURRENT=%~dp0..\..\' + $name + '\bin\taskmaster.cmd"'),
  'if not exist "%TASKMASTER_CURRENT%" (',
  '  echo Eric Task Master current installation is missing; the retired launcher will not run an old version. 1>&2',
  '  exit /b 1',
  ')',
  '"%TASKMASTER_CURRENT%" %*'
)
$expectedLauncher = ($lines -join "`n") + "`n"

if (Test-Path -LiteralPath $root) {
  $entry = Get-Item -LiteralPath $root -Force
  if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Application root is not a normal directory'
  }
  $manifestPath = Join-Path $root 'release-manifest.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.product -ne 'eric-task-master' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
      throw 'Existing application identity is not recognized'
    }
    if ([version]$manifest.version -gt [version]$NewVersion) { throw 'Refusing to downgrade an installed Task Master' }
  } elseif (@(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) {
    throw 'Existing application directory is not a recognized Task Master installation'
  }
}

try { $legacyItem = Get-Item -LiteralPath $legacy -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { exit 0 }
if (-not $legacyItem.PSIsContainer -or ($legacyItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Legacy application path is not a normal directory'
}
if (Test-Path -LiteralPath $marker -PathType Leaf) {
  $alias = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $actual = (Get-Content -LiteralPath $launcher -Raw).Replace("`r`n", "`n")
  if ($alias.product -ne 'eric-task-master' -or $alias.schemaVersion -ne 1 -or
      [IO.Path]::GetFullPath([string]$alias.target) -ine $root -or $actual -cne $expectedLauncher) {
    throw 'Legacy compatibility launcher is not recognized'
  }
  $rootEntries = @(Get-ChildItem -LiteralPath $legacy -Force | Select-Object -ExpandProperty Name | Sort-Object)
  $binEntries = @(Get-ChildItem -LiteralPath (Join-Path $legacy 'bin') -Force | Select-Object -ExpandProperty Name)
  if (($rootEntries -join '|') -cne '.taskmaster-legacy.json|bin' -or ($binEntries -join '|') -cne 'taskmaster.cmd') {
    throw 'Legacy compatibility directory contains unexpected files'
  }
  exit 0
}
$legacyManifest = Get-Content -LiteralPath (Join-Path $legacy 'release-manifest.json') -Raw | ConvertFrom-Json
$legacyPackage = Get-Content -LiteralPath (Join-Path $legacy 'app/package.json') -Raw | ConvertFrom-Json
if ($legacyManifest.product -ne 'eric-task-master' -or $legacyPackage.name -ne 'eric-task-master' -or
    $legacyManifest.version -notmatch '^\d+\.\d+\.\d+$' -or $legacyPackage.version -ne $legacyManifest.version) {
  throw 'Legacy application identity is not recognized'
}
if ([version]$legacyManifest.version -gt [version]$NewVersion) { throw 'Refusing to replace a newer legacy application' }
if ($Mode -eq 'Validate') { exit 0 }

$backup = Join-Path $parent ('.' + $name + '-retired-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $backup) { throw 'Legacy backup destination already exists' }
Move-Item -LiteralPath $legacy -Destination $backup
try {
  New-Item -ItemType Directory -Path (Join-Path $legacy 'bin') -ErrorAction Stop | Out-Null
  [IO.File]::WriteAllText($launcher, $expectedLauncher.Replace("`n", "`r`n"), [Text.Encoding]::ASCII)
  $record = [ordered]@{ schemaVersion = 1; product = 'eric-task-master'; target = $root }
  [IO.File]::WriteAllText($marker, ($record | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
} catch {
  if (Test-Path -LiteralPath $launcher -PathType Leaf) { Remove-Item -LiteralPath $launcher -Force }
  if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $marker -Force }
  if (Test-Path -LiteralPath (Join-Path $legacy 'bin')) { Remove-Item -LiteralPath (Join-Path $legacy 'bin') -Force }
  if (Test-Path -LiteralPath $legacy) { Remove-Item -LiteralPath $legacy -Force }
  Move-Item -LiteralPath $backup -Destination $legacy
  throw
}
[ordered]@{ ok = $true; legacy = $legacy; target = $root; backup = $backup } | ConvertTo-Json -Compress
