param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
function Invoke-InstallerProcess([string]$FilePath, [string[]]$Arguments) {
  # Start-Process -Wait waits for the whole process tree, including the new
  # long-lived Manager. Wait for this installer process only.
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    throw "Installer process timed out: $FilePath"
  }
  $process.Refresh()
  return $process
}
$installerPath = [System.IO.Path]::GetFullPath($Installer)
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
$allowedPrefix = $runnerTemp.TrimEnd('\') + '\'
if (-not $root.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallRoot must be inside RUNNER_TEMP: $root"
}
$artifactRoot = Join-Path (Get-Location) 'artifacts'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$installLog = Join-Path $artifactRoot 'windows-installer-first-install.log'
$upgradeLog = Join-Path $artifactRoot 'windows-installer-upgrade.log'
$state = Join-Path $runnerTemp 'eric-task-master-installed-smoke-state'
$job = (Resolve-Path (Join-Path $PSScriptRoot '..\build\fixtures\bare-playwright-task.mjs')).Path
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$originalProcessPath = $env:Path
$originalSkillDirectory = $env:ERIC_TASK_MASTER_SKILL_DIR
$originalTaskMasterHome = $env:ERIC_TASK_MASTER_HOME
$originalTaskMasterPort = $env:ERIC_TASK_MASTER_PORT
$testSkill = Join-Path $runnerTemp 'taskmaster-agent-fixture/eric-task-master'
if (Test-Path -LiteralPath $testSkill) { throw 'Skill test fixture already exists; refusing to replace it' }
New-Item -ItemType Directory -Path (Join-Path $testSkill 'scripts') -Force | Out-Null
@('---', 'name: eric-task-master', 'metadata: { version: "4.0.1" }', '---', 'previous-fixture-skill') |
  Set-Content -LiteralPath (Join-Path $testSkill 'SKILL.md') -Encoding Ascii
Set-Content -LiteralPath (Join-Path $testSkill 'LICENSE') -Value 'old-fixture-license' -Encoding Ascii
Set-Content -LiteralPath (Join-Path $testSkill 'scripts/find-launcher.ps1') -Value 'old-fixture-locator' -Encoding Ascii
$env:ERIC_TASK_MASTER_SKILL_DIR = $testSkill
$env:ERIC_TASK_MASTER_HOME = $state
$env:ERIC_TASK_MASTER_PORT = '29846'
$legacyRoot = "$root v3"
$legacyBin = Join-Path $legacyRoot 'bin'
if (Test-Path -LiteralPath $legacyRoot) { throw 'Legacy test fixture already exists; refusing to replace it' }
New-Item -ItemType Directory -Path $legacyBin,(Join-Path $legacyRoot 'app') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $legacyRoot 'release-manifest.json') -Value '{"product":"eric-task-master","version":"3.1.11"}' -Encoding Ascii
Set-Content -LiteralPath (Join-Path $legacyRoot 'app/package.json') -Value '{"name":"eric-task-master","version":"3.1.11"}' -Encoding Ascii
Set-Content -LiteralPath (Join-Path $legacyBin 'taskmaster.cmd') -Value '@echo retired-legacy' -Encoding Ascii
Set-Content -LiteralPath (Join-Path $legacyRoot 'user-sentinel.txt') -Value 'preserve-legacy-file' -NoNewline
$staleLauncherDir = Join-Path $runnerTemp 'eric-task-master-stale-launcher'
New-Item -ItemType Directory -Force -Path $staleLauncherDir | Out-Null
Set-Content -LiteralPath (Join-Path $staleLauncherDir 'taskmaster.cmd') -Value '@echo stale-taskmaster' -Encoding Ascii
[Environment]::SetEnvironmentVariable('Path', "$staleLauncherDir;$originalUserPath", 'User')
try {
Remove-Item -LiteralPath $root,$state -Recurse -Force -ErrorAction SilentlyContinue

$install = Invoke-InstallerProcess -FilePath $installerPath -Arguments @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$installLog`""
)
if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }

$cli = Join-Path $root 'bin\taskmaster.cmd'
if (-not (Test-Path -LiteralPath $cli)) { throw "Installed CLI is missing: $cli" }
$legacyCli = Join-Path $legacyBin 'taskmaster.cmd'
$env:Path = "$legacyBin;$originalProcessPath"
$legacyHelp = @(& taskmaster --help)
$expectedVersion = (Get-Content -LiteralPath (Join-Path $root 'release-manifest.json') -Raw | ConvertFrom-Json).version
if ($LASTEXITCODE -ne 0 -or $legacyHelp[0] -ne "Eric Task Master $expectedVersion") {
  throw 'Inherited legacy PATH did not invoke the current launcher'
}
if (Test-Path -LiteralPath (Join-Path $legacyRoot 'release-manifest.json')) { throw 'Legacy runtime remains callable at its old path' }
$retired = @(Get-ChildItem -LiteralPath (Split-Path $root) -Directory -Force | Where-Object { $_.Name -like ('.' + (Split-Path $root -Leaf) + '-retired-*') })
if ($retired.Count -ne 1 -or (Get-Content -LiteralPath (Join-Path $retired[0].FullName 'user-sentinel.txt') -Raw) -ne 'preserve-legacy-file') {
  throw 'Legacy application backup did not preserve its existing files'
}
$activeVersion = @(& $cli manager status --json | ForEach-Object { $_ | ConvertFrom-Json }) | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or $activeVersion.manager.version -ne $expectedVersion) { throw 'Upgrade installer did not activate the current Manager' }
if ((Get-FileHash -LiteralPath (Join-Path $testSkill 'SKILL.md')).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $root 'app/skills/eric-task-master/SKILL.md')).Hash) {
  throw 'Upgrade installer did not replace the selected installed Skill'
}
$installedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($installedUserPath -split ';')[0].TrimEnd('\') -ine (Join-Path $root 'bin')) {
  throw 'Installed launcher was not placed before the stale user PATH entry'
}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $installedUserPath
$resolvedLaunchers = @(& where.exe taskmaster)
if (-not $resolvedLaunchers.Count -or $resolvedLaunchers[0] -ine $cli) {
  throw 'A fresh PATH still resolves an old taskmaster before the installed launcher'
}
$env:NODE_OPTIONS = '--require=__eric_task_master_host_injection_must_not_load__'
$env:NODE_PATH = Join-Path $runnerTemp '__host_node_path_must_not_be_used__'
& $cli --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI help failed' }
& $cli status --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Installed Manager status failed' }

$upgradeProfileOutput = @(& $cli profiles create 'Upgrade preserved' --json)
if ($LASTEXITCODE -ne 0) { throw 'Pre-upgrade Profile creation failed' }
$upgradeProfileRecord = @($upgradeProfileOutput | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.profile }) | Select-Object -Last 1
if (-not $upgradeProfileRecord) { throw 'Pre-upgrade Profile response is missing' }
$upgradeProfileId = $upgradeProfileRecord.profile.id
$stateSentinel = Join-Path $state 'upgrade-state-sentinel.txt'
Set-Content -LiteralPath $stateSentinel -Value 'preserve-user-state' -NoNewline
$staleMcp = Join-Path $root 'app\src\mcp\stale-v2.mjs'
$stalePack = Join-Path $root 'app\task-packs\stale-v2-pack.mjs'
New-Item -ItemType Directory -Force -Path (Split-Path $staleMcp),(Split-Path $stalePack) | Out-Null
Set-Content -LiteralPath $staleMcp -Value 'stale-v2-mcp' -NoNewline
Set-Content -LiteralPath $stalePack -Value 'stale-v2-task-pack' -NoNewline
$managerFile = Join-Path $state 'manager.json'
if (-not (Test-Path -LiteralPath $managerFile)) { throw 'Pre-upgrade Manager PID file is missing' }
$preUpgradeManagerProcessId = (Get-Content -LiteralPath $managerFile -Raw | ConvertFrom-Json).pid
& $cli profiles open $upgradeProfileId --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create an occupied Profile for the upgrade-choice test' }

$blockedUpgrade = Invoke-InstallerProcess -FilePath $installerPath -Arguments @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$upgradeLog.blocked`""
)
if ($blockedUpgrade.ExitCode -eq 0) { throw 'Upgrade must refuse a live shared runtime' }
if (-not (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue)) { throw 'Refused upgrade stopped another Agent Manager' }
if (-not (Test-Path -LiteralPath $staleMcp)) { throw 'Refused upgrade changed application files' }
& $cli profiles close $upgradeProfileId --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not close the occupied Profile after the refused upgrade' }

Set-Content -LiteralPath (Join-Path $testSkill 'SKILL.md') -Value 'unrecognized fixture Skill' -Encoding Ascii
$failedActivation = Invoke-InstallerProcess -FilePath $installerPath -Arguments @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$upgradeLog.activation-failed`""
)
if ($failedActivation.ExitCode -ne 20) { throw "Incomplete activation must return exit 20, got $($failedActivation.ExitCode)" }
if (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue) { throw 'Idle Manager was not stopped automatically before replacement' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Incomplete activation rolled back the installed application' }
if ((Get-Content -LiteralPath (Join-Path $testSkill 'SKILL.md') -Raw).Trim() -ne 'unrecognized fixture Skill') {
  throw 'Incomplete activation modified an unrecognized Skill'
}
Copy-Item -LiteralPath (Join-Path $root 'app/skills/eric-task-master/SKILL.md') -Destination (Join-Path $testSkill 'SKILL.md') -Force

$upgrade = Invoke-InstallerProcess -FilePath $installerPath -Arguments @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$upgradeLog`""
)
if ($upgrade.ExitCode -ne 0) { throw "Upgrade installer exited with $($upgrade.ExitCode)" }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue) { throw 'Explicit idle stop did not release the runtime' }
if (Test-Path -LiteralPath $staleMcp) { throw 'Upgrade retained a stale v2 MCP application file' }
if (Test-Path -LiteralPath $stalePack) { throw 'Upgrade retained a stale v2 Task Pack application file' }
if ((Get-Content -LiteralPath $stateSentinel -Raw) -ne 'preserve-user-state') { throw 'Upgrade modified external user state' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Upgrade did not install the new CLI' }
$profileListOutput = @(& $cli profiles list --json)
if ($LASTEXITCODE -ne 0) { throw 'Post-upgrade Profile listing failed' }
$profileListRecord = @($profileListOutput | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.profiles }) | Select-Object -Last 1
if (-not @($profileListRecord.profiles | Where-Object { $_.id -eq $upgradeProfileId }).Count) {
  throw 'Upgrade did not preserve the Profile stored outside the application root'
}

& $cli profiles create 'Installed smoke' --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Installed Profile creation failed' }
$taskOutput = @(& $cli run $job --label 'Installed bare Playwright smoke' --json)
if ($LASTEXITCODE -ne 0) { throw 'Installed task command failed' }
$records = @($taskOutput | ForEach-Object { $_ | ConvertFrom-Json })
$finished = @($records | Where-Object { $_.task -and $_.task.state -eq 'finished' }) | Select-Object -Last 1
if (-not $finished -or
  $finished.task.result.barePlaywrightImport -ne $true -or
  $finished.task.result.hostNodeInjectionIsolated -ne $true) {
  throw 'Installed task did not resolve bare Playwright in an isolated Node environment'
}
if (-not (Test-Path -LiteralPath $managerFile)) { throw 'Installed Manager PID file is missing' }
$managerProcessId = (Get-Content -LiteralPath $managerFile -Raw | ConvertFrom-Json).pid

$uninstaller = Join-Path $root 'unins000.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing' }
$blockedUninstall = Invoke-InstallerProcess -FilePath $uninstaller -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
if ($blockedUninstall.ExitCode -eq 0) { throw 'Uninstall must refuse a live shared runtime' }
if (-not (Get-Process -Id $managerProcessId -ErrorAction SilentlyContinue)) { throw 'Refused uninstall stopped another Agent Manager' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Refused uninstall removed application files' }
& $cli manager stop --if-idle --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Explicit idle-only stop before uninstall failed' }
$uninstall = Invoke-InstallerProcess -FilePath $uninstaller -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
if (Test-Path -LiteralPath (Join-Path $root 'bin\taskmaster.cmd')) { throw 'Application files remain after uninstall' }
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $legacyCli --help 2>$null | Out-Null
$legacyExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
if ($legacyExitCode -eq 0) { throw 'Legacy launcher must fail closed when the current application is absent' }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $managerProcessId -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $managerProcessId -ErrorAction SilentlyContinue) { throw 'Explicit idle stop did not finish before uninstall' }
$remainingUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (@($remainingUserPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq (Join-Path $root 'bin') }).Count) {
  throw 'Uninstaller left its launcher in user PATH'
}
$expectedRemainingPath = (@("$staleLauncherDir;$originalUserPath" -split ';' | Where-Object {
  $_ -ne '' -and $_.TrimEnd('\') -ine (Join-Path $root 'bin')
}) -join ';')
if ($remainingUserPath -cne $expectedRemainingPath) {
  throw 'Uninstaller changed unrelated user PATH entries'
}
Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
[ordered]@{ ok = $true; installedRuntime = 'bundled-node'; nativeUpgrade = 'passed'; managerAndSkillActivation = 'passed'; incompleteActivationExit = 20; liveUpgradeRefused = $true; liveUninstallRefused = $true; launcherPrecedence = 'passed'; legacyPathReplacement = 'passed'; unrelatedPathPreserved = $true; staleV2PayloadRemoved = $true; userStatePreserved = $true; hostNodeInjectionIsolated = $true; barePlaywrightTask = 'passed'; idleStopConfirmed = $true; uninstalled = $true } | ConvertTo-Json -Compress
} finally {
  $ErrorActionPreference = 'Continue'
  if (Test-Path -LiteralPath (Join-Path $root 'bin/taskmaster.cmd')) {
    & (Join-Path $root 'bin/taskmaster.cmd') manager stop --if-idle --json 2>$null | Out-Null
  }
  [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
  $env:Path = $originalProcessPath
  if ($null -eq $originalSkillDirectory) { Remove-Item Env:ERIC_TASK_MASTER_SKILL_DIR -ErrorAction SilentlyContinue } else { $env:ERIC_TASK_MASTER_SKILL_DIR = $originalSkillDirectory }
  if ($null -eq $originalTaskMasterHome) { Remove-Item Env:ERIC_TASK_MASTER_HOME -ErrorAction SilentlyContinue } else { $env:ERIC_TASK_MASTER_HOME = $originalTaskMasterHome }
  if ($null -eq $originalTaskMasterPort) { Remove-Item Env:ERIC_TASK_MASTER_PORT -ErrorAction SilentlyContinue } else { $env:ERIC_TASK_MASTER_PORT = $originalTaskMasterPort }
  Remove-Item -LiteralPath (Join-Path $staleLauncherDir 'taskmaster.cmd') -Force -ErrorAction SilentlyContinue
}
# The missing-current legacy launcher intentionally returned a nonzero exit
# code above. Do not leak that expected result to the CI shell after success.
$global:LASTEXITCODE = 0
