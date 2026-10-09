param([string[]]$PortableRoot = @())

function Get-TaskMasterInstallations {
  $locations = @()
  $recorded = $false
  $unknown = $false
  foreach ($key in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2DE24E8C-971F-4E00-9E32-9F66822B9CB7}_is1',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2DE24E8C-971F-4E00-9E32-9F66822B9CB7}_is1'
  )) {
    try {
      if (Test-Path -LiteralPath $key -ErrorAction Stop) {
        $recorded = $true
        $record = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        if ($record.InstallLocation) { $locations += [string]$record.InstallLocation }
      }
    } catch { $unknown = $true }
  }
  [pscustomobject]@{ recorded = $recorded; locations = $locations; unknown = $unknown }
}

function Get-TaskMasterManager {
  param([int]$Port = 19946)
  if ($Port -lt 1 -or $Port -gt 65535) { return [pscustomobject]@{ state = 'unknown' } }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/health" -TimeoutSec 5 -ErrorAction Stop
    $recognized = $health.ok -eq $true -and $health.apiVersion -eq 3 -and
      $health.pid -gt 0 -and $health.stateId -like 'state_*'
    [pscustomobject]@{ state = $(if ($recognized) { 'present' } else { 'unknown' }) }
  } catch {
    $refused = $false
    $cause = $_.Exception
    while ($cause) {
      if ($cause -is [System.Net.Sockets.SocketException] -and
          $cause.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused) { $refused = $true }
      $cause = $cause.InnerException
    }
    [pscustomobject]@{ state = $(if ($refused) { 'absent' } else { 'unknown' }) }
  }
}

function Find-TaskMasterLauncher {
  param(
    [string[]]$PortableRoot = @(),
    [string]$DefaultRoot = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'Eric Task Master'),
    [scriptblock]$ReadInstallations = { Get-TaskMasterInstallations },
    [scriptblock]$ReadCommands = {
      try { @(Get-Command taskmaster -CommandType Application -ErrorAction Stop | Select-Object -ExpandProperty Source) }
      catch [System.Management.Automation.CommandNotFoundException] { @() }
    },
    [scriptblock]$PathExists = { param($target, $kind) Test-Path -LiteralPath $target -PathType $kind -ErrorAction Stop },
    [scriptblock]$ReadManager = {
      $port = 19946
      if ($env:ERIC_TASK_MASTER_PORT -and -not [int]::TryParse($env:ERIC_TASK_MASTER_PORT, [ref]$port)) {
        return [pscustomobject]@{ state = 'unknown' }
      }
      Get-TaskMasterManager -Port $port
    }
  )
  $recorded = $false
  $unknown = $false
  $roots = @()
  $candidates = @()
  try {
    $installations = & $ReadInstallations
    $recorded = $installations.recorded -eq $true
    $unknown = $installations.unknown -eq $true
    foreach ($location in $installations.locations) {
      $roots += [pscustomobject]@{ path = $location; source = 'registry' }
    }
  } catch { $unknown = $true }
  # Registry locations take precedence over a PATH inherited by an older Agent host.
  foreach ($root in $roots) {
    try {
      if (-not [System.IO.Path]::IsPathRooted($root.path)) { throw 'InstallLocation is not absolute' }
      $candidates += [pscustomobject]@{ path = [System.IO.Path]::Combine($root.path, 'bin', 'taskmaster.cmd'); source = $root.source }
      $candidates += [pscustomobject]@{ path = [System.IO.Path]::Combine($root.path, 'eric-task-master', 'bin', 'taskmaster.cmd'); source = $root.source }
    } catch { $unknown = $true }
  }
  try {
    foreach ($command in (& $ReadCommands)) {
      $recorded = $true
      $candidates += [pscustomobject]@{ path = $command; source = 'PATH' }
    }
  } catch { $unknown = $true }
  foreach ($location in @($PortableRoot) + @($DefaultRoot)) {
    try {
      if (-not [System.IO.Path]::IsPathRooted($location)) { throw 'Launcher root is not absolute' }
      $roots += [pscustomobject]@{ path = $location; source = 'known-directory' }
      $candidates += [pscustomobject]@{ path = [System.IO.Path]::Combine($location, 'bin', 'taskmaster.cmd'); source = 'known-directory' }
      $candidates += [pscustomobject]@{ path = [System.IO.Path]::Combine($location, 'eric-task-master', 'bin', 'taskmaster.cmd'); source = 'known-directory' }
    } catch { $unknown = $true }
  }
  foreach ($candidate in $candidates) {
    try {
      if ([System.IO.Path]::IsPathRooted($candidate.path) -and (& $PathExists $candidate.path 'Leaf')) {
        return [pscustomobject]@{
          status = 'found'; launcher = [System.IO.Path]::GetFullPath($candidate.path); source = $candidate.source
          nextAction = 'verify_existing_launcher'; canFreshInstall = $false
        }
      }
    } catch { $unknown = $true }
  }
  foreach ($root in $roots) {
    try { if (& $PathExists $root.path 'Container') { $recorded = $true } }
    catch { $unknown = $true }
  }
  try { $manager = & $ReadManager } catch { $manager = [pscustomobject]@{ state = 'unknown' } }
  if ($recorded -or $unknown -or $manager.state -ne 'absent') {
    return [pscustomobject]@{
      status = 'unresolved'; launcher = $null; managerState = $manager.state
      nextAction = 'report_locator_error'; canFreshInstall = $false
    }
  }
  [pscustomobject]@{
    status = 'absent'; launcher = $null; managerState = 'absent'
    nextAction = 'fresh_install_if_requested'; canFreshInstall = $true
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Find-TaskMasterLauncher -PortableRoot $PortableRoot
  $result | ConvertTo-Json -Depth 4 -Compress
  if ($result.status -eq 'unresolved') { exit 1 }
}
