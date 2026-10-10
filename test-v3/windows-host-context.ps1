param([Parameter(Mandatory = $true)][string]$Payload, [switch]$Breakaway, [switch]$Packaged)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class TaskMasterHostContext {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  public static string PackageName(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { uint length = 0; int code = GetPackageFullName(handle, ref length, null);
      if (code == 15700) return null; if (code != 122) throw new Win32Exception(code);
      var name = new StringBuilder((int)length);
      code = GetPackageFullName(handle, ref length, name);
      if (code != 0) throw new Win32Exception(code); return name.ToString();
    } finally { CloseHandle(handle); }
  }
}
'@

$configuration = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
if ($Breakaway -or $Packaged) {
  $ancestor = $PID
  $packageName = $null
  for ($index = 0; $index -lt 12 -and $ancestor -gt 0; $index++) {
    try { $packageName = [TaskMasterHostContext]::PackageName($ancestor) }
    catch {
      # Service ancestors on an unpackaged CI host can deny limited inspection.
      # Only access denial is tolerated; other API failures remain test failures.
      if ($_.Exception.InnerException -isnot [ComponentModel.Win32Exception] -or
          $_.Exception.InnerException.NativeErrorCode -ne 5) { throw }
    }
    if ($packageName) { break }
    $ancestor = (Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor" -ErrorAction Stop).ParentProcessId
  }
  if ($packageName) {
    $package = Get-AppxPackage | Where-Object { $_.PackageFullName -eq $packageName } | Select-Object -First 1
    if (-not $package) { throw 'The calling Agent package is not accessible to this user' }
    $manifest = [xml](Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml') -Raw)
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.EntryPoint -eq 'Windows.FullTrustApplication' }) | Select-Object -First 1
    if (-not $application) { throw 'The calling Agent package has no full-trust desktop application' }
    $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Payload ' + $Payload
    # Official Windows diagnostic API; no package files or running Agent are changed.
    # PreventBreakaway keeps descendants packaged; omitting it creates an unpackaged CLI.
    # https://learn.microsoft.com/en-us/powershell/module/appx/invoke-commandindesktoppackage
    Invoke-CommandInDesktopPackage -PackageFamilyName $package.PackageFamilyName -AppId $application.Id -Command $powershellPath -Args $arguments -PreventBreakaway:$Packaged | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not (Test-Path -LiteralPath $configuration.output) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path -LiteralPath $configuration.output)) { throw 'Packaged fixture did not return within 60 seconds' }
    exit 0
  }
  if ($Packaged) {
    [IO.File]::WriteAllText($configuration.output, '{"exitCode":0,"packaged":false,"unsupported":true,"stdout":"","stderr":""}')
    exit 0
  }
}
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $configuration.node
$start.WorkingDirectory = $configuration.cwd
$start.Arguments = (@($configuration.cli) + @($configuration.arguments) | ForEach-Object {
  if ([string]$_ -match '["\r\n]') { throw 'Fixture arguments must not contain quotes or line breaks' }
  '"' + [string]$_ + '"'
}) -join ' '
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($property in $configuration.environment.PSObject.Properties) {
  if ($null -eq $property.Value) { $start.EnvironmentVariables.Remove($property.Name) }
  else { $start.EnvironmentVariables[$property.Name] = [string]$property.Value }
}
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $start
if (-not $child.Start()) { throw 'Fixture CLI did not start' }
$nodePackaged = [bool][TaskMasterHostContext]::PackageName($child.Id)
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
if (-not $child.WaitForExit(55000)) { throw 'Fixture CLI exceeded its bounded wait' }
$record = [ordered]@{ exitCode = $child.ExitCode; packaged = $nodePackaged; stdout = $stdout.Result; stderr = $stderr.Result }
[IO.File]::WriteAllText($configuration.output, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
$child.Dispose()
