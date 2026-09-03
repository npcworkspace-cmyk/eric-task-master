param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
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
Remove-Item -LiteralPath $root,$state -Recurse -Force -ErrorAction SilentlyContinue

$install = Start-Process -FilePath $installerPath -ArgumentList @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$installLog`""
) -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)" }

$cli = Join-Path $root 'bin\taskmaster.cmd'
if (-not (Test-Path -LiteralPath $cli)) { throw "Installed CLI is missing: $cli" }
$env:ERIC_TASK_MASTER_HOME = $state
$env:ERIC_TASK_MASTER_PORT = '29846'
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

$upgrade = Start-Process -FilePath $installerPath -ArgumentList @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$root`"", "/LOG=`"$upgradeLog`""
) -Wait -PassThru
if ($upgrade.ExitCode -ne 0) { throw "Upgrade installer exited with $($upgrade.ExitCode)" }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $preUpgradeManagerProcessId -ErrorAction SilentlyContinue) { throw 'Upgrade did not stop the previous Manager' }
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
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
if (Test-Path -LiteralPath (Join-Path $root 'bin\taskmaster.cmd')) { throw 'Application files remain after uninstall' }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $managerProcessId -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $managerProcessId -ErrorAction SilentlyContinue) { throw 'Uninstaller did not stop the Manager' }
Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
[ordered]@{ ok = $true; installedRuntime = 'bundled-node'; nativeUpgrade = 'passed'; staleV2PayloadRemoved = $true; userStatePreserved = $true; hostNodeInjectionIsolated = $true; barePlaywrightTask = 'passed'; uninstallStoppedManager = $true; uninstalled = $true } | ConvertTo-Json -Compress
