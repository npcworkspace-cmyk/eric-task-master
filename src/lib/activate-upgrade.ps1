param(
  [Parameter(Mandatory = $true)][string]$AppRoot,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
try {
  if (-not [IO.Path]::IsPathRooted($AppRoot) -or $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Invalid application path or version'
  }
  $launcher = [IO.Path]::Combine([IO.Path]::GetFullPath($AppRoot), 'bin', 'taskmaster.cmd')
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Installed launcher is missing' }
  $output = @(& $launcher manager start --upgrade --json)
  if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { throw 'Manager and Skill activation did not complete' }
  $result = $output[0] | ConvertFrom-Json
  if ($result.ok -ne $true -or $result.manager.version -ne $ExpectedVersion -or
      $result.skill.state -notin @('current', 'replaced', 'not-installed')) {
    throw 'Manager or Skill activation result is incomplete'
  }
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine('Task Master files were installed, but Manager and Skill activation is incomplete. Preserve user state; run the new launcher with manager start --upgrade --json after resolving the reported condition.')
  exit 20
}
