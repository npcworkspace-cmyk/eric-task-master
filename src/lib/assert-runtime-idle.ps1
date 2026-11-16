param([Parameter(Mandatory = $true)][string]$AppRoot)

$ErrorActionPreference = 'Stop'
try {
  if (-not [System.IO.Path]::IsPathRooted($AppRoot)) { throw 'Application root must be absolute' }
  $runtime = [System.IO.Path]::Combine([System.IO.Path]::GetFullPath($AppRoot), 'runtime', 'node.exe')
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 10 -ErrorAction Stop)
  foreach ($runtimeProcess in $processes) {
    if (-not $runtimeProcess.ExecutablePath) { throw 'A Node runtime process could not be identified safely' }
    if ([System.IO.Path]::GetFullPath($runtimeProcess.ExecutablePath) -ieq $runtime) {
      [Console]::Error.WriteLine('Eric Task Master runtime is still in use. Keep all Agent tasks running; retry after an explicit idle-only Manager stop.')
      exit 10
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('Eric Task Master runtime inspection failed. No process was stopped and no application files may be replaced.')
  exit 11
}
