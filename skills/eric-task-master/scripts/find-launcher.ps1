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
    $recognized = $health.ok -eq $true -and $health.service -eq 'eric-task-master' -and $health.apiVersion -eq 3 -and
      $health.pid -is [int] -and $health.pid -gt 0 -and $health.stateId -like 'state_*'
    if (-not $recognized) { return [pscustomobject]@{ state = 'unknown' } }
    $launcher = $null
    try {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($health.pid)" -OperationTimeoutSec 5 -ErrorAction Stop
      $executable = [string]$process.ExecutablePath
      $runtime = [System.IO.Path]::GetDirectoryName($executable)
      if ([System.IO.Path]::GetFileName($executable) -ieq 'node.exe' -and
          [System.IO.Path]::GetFileName($runtime) -ieq 'runtime') {
        $root = [System.IO.Path]::GetDirectoryName($runtime)
        $package = Get-Content -LiteralPath ([System.IO.Path]::Combine($root, 'app', 'package.json')) -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $candidate = [System.IO.Path]::Combine($root, 'bin', 'taskmaster.cmd')
        if ($package.name -eq 'eric-task-master' -and $package.version -eq $health.version -and
            (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction Stop)) {
          $launcher = [System.IO.Path]::GetFullPath($candidate)
        }
      }
    } catch { }
    [pscustomobject]@{ state = 'present'; launcher = $launcher; pid = $health.pid; version = $health.version }
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

function Get-TaskMasterSharedLocation {
  $file = [System.IO.Path]::Combine($env:USERPROFILE, '.eric-task-master', 'default-state.json')
  try {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf -ErrorAction Stop)) {
      return [pscustomobject]@{ recorded = $false; unknown = $false }
    }
    $record = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($record.version -ne 1 -or ($record.port -isnot [int] -and $record.port -isnot [long]) -or
        $record.port -lt 1 -or $record.port -gt 65535 -or
        -not [System.IO.Path]::IsPathRooted($record.stateDir) -or
        -not [System.IO.Path]::IsPathRooted($record.identityDir)) { throw 'Invalid shared location' }
    $candidate = $null
    if ($record.launcher) {
      if (-not [System.IO.Path]::IsPathRooted($record.launcher)) { throw 'Invalid selected launcher' }
      $candidate = [System.IO.Path]::GetFullPath($record.launcher)
      if ([System.IO.Path]::GetFileName($candidate) -ine 'taskmaster.cmd' -or
          [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($candidate)) -ine 'bin') { throw 'Invalid selected launcher' }
      $root = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($candidate))
      $package = Get-Content -LiteralPath ([System.IO.Path]::Combine($root, 'app', 'package.json')) -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($package.name -ne 'eric-task-master' -or -not (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction Stop)) {
        throw 'Selected application is missing'
      }
    }
    [pscustomobject]@{ recorded = $true; unknown = $false; launcher = $candidate; port = [int]$record.port }
  } catch { [pscustomobject]@{ recorded = $true; unknown = $true } }
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
    [scriptblock]$ReadSharedLocation = { Get-TaskMasterSharedLocation },
    [scriptblock]$ReadManager = {
      param([int]$Port = 19946)
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
  try { $sharedLocation = & $ReadSharedLocation } catch { $sharedLocation = [pscustomobject]@{ recorded = $true; unknown = $true } }
  if ($sharedLocation.unknown -eq $true) {
    return [pscustomobject]@{ status = 'unresolved'; launcher = $null; nextAction = 'report_locator_error'; canFreshInstall = $false }
  }
  $recorded = $sharedLocation.recorded -eq $true
  $probePort = if ($sharedLocation.port) { [int]$sharedLocation.port } else { 19946 }
  try { $manager = & $ReadManager $probePort } catch { $manager = [pscustomobject]@{ state = 'unknown' } }
  # A live Manager identifies the runtime actually in use, even without registration.
  if ($manager.state -eq 'present') {
    try {
      if ($manager.launcher -and [System.IO.Path]::IsPathRooted($manager.launcher) -and
          (& $PathExists $manager.launcher 'Leaf')) {
        return [pscustomobject]@{
          status = 'found'; launcher = [System.IO.Path]::GetFullPath($manager.launcher); source = 'running-manager'
          nextAction = 'verify_existing_launcher'; canFreshInstall = $false
        }
      }
    } catch { }
    return [pscustomobject]@{
      status = 'unresolved'; launcher = $null; managerState = 'present'
      nextAction = 'report_locator_error'; canFreshInstall = $false
    }
  }
  if ($sharedLocation.launcher) {
    try {
      if (& $PathExists $sharedLocation.launcher 'Leaf') {
        return [pscustomobject]@{ status = 'found'; launcher = $sharedLocation.launcher; source = 'shared-location'
          nextAction = 'verify_existing_launcher'; canFreshInstall = $false }
      }
    } catch { }
    return [pscustomobject]@{ status = 'unresolved'; launcher = $null; nextAction = 'report_locator_error'; canFreshInstall = $false }
  }
  try {
    $installations = & $ReadInstallations
    $recorded = $recorded -or $installations.recorded -eq $true
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
